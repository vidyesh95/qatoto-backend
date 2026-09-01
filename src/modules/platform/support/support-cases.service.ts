import { and, asc, count, desc, eq, gt, isNotNull, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { supportCase, supportCaseMessage, user } from "#src/db/schema.js";
import {
  decodeInstantCursor,
  encodeInstantCursor,
  type InstantCursor,
} from "#src/lib/instant-cursor.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import {
  listPlatformCapabilitiesForRole,
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Support cases — one person's problem, and the staff member who answers it.
 *
 * ## ⚠️ THIS SURFACE CANNOT MOVE MONEY, AND `payment_problem` IS THE REASON TO SAY SO
 *
 * Qatoto holds no funds (docs/ESCROW_LEDGER_STRUCTURE.md). A case about a payment can find
 * out what happened and point at the order, the settlement attestations or a dispute between
 * the two parties. It cannot refund, release or reverse anything, and no message written from
 * here should imply otherwise.
 *
 * ## THE CAPABILITY IS CHECKED INSIDE, BEFORE ANY ID IS READ
 *
 * `handle_support_cases`, the `user-reports.service.ts` posture: a route-level guard makes the
 * capability probeable, an id-first service makes the route an existence oracle, and
 * middleware cannot return a `Result` so it could not join the controller's exhaustive switch
 * anyway. Every staff function here calls `requireSupportStaff` on its first line.
 *
 * ## EVERY WRITE TAKES THE CASE ROW'S `FOR UPDATE` LOCK
 *
 * `nextMessageSequence` reads the highest sequence and then inserts. Two concurrent replies
 * without the lock read the same number and one loses to the unique index — the exact
 * reasoning `addDisputeNote` records. The lock also makes the state check and the state write
 * one decision rather than two, so a reply cannot land on a case somebody resolved meanwhile.
 *
 * ## A NON-OWNER READ IS 404, NEVER 403
 *
 * Owner scoping lives in the WHERE clause, so a case id belonging to somebody else is
 * indistinguishable from one that does not exist. The staff refusal is 403 and that is not an
 * exception: it is decided before any id is read, so it discloses nothing about the resource.
 */

/** The thread cap. Bounded so "the detail read returns the whole timeline" stays a bounded claim. */
const MAXIMUM_MESSAGES_PER_CASE = 200;

/**
 * How many cases one person may have live at once.
 *
 * A WINDOW LIMITER BOUNDS THE RATE; THIS BOUNDS THE BACKLOG. Five is well past the honest
 * ceiling — a payment, an order, an account question and two spares — and it is deliberately
 * a limit on OPEN cases rather than on cases ever filed, so somebody with a long history of
 * resolved problems is never refused.
 */
const MAXIMUM_LIVE_CASES_PER_USER = 5;

/**
 * How long after a verdict the person may reopen by replying.
 *
 * ⚠️ **DERIVED FROM `decided_at`, NOT SWEPT BY A CRON.** The alternative was a nightly job
 * flipping `resolved` to `closed` after the same fourteen days, which is three more job
 * registrations, a scheduled write against a shared database, and a stored value that can
 * disagree with the clock. The window is a comparison, so there is nothing to drift: a
 * `resolved` case simply stops accepting replies once it is old, and `closed` remains what a
 * staff member sets deliberately.
 */
const REOPEN_WINDOW_MILLISECONDS = 14 * 24 * 60 * 60 * 1000;

const DEFAULT_PAGE_SIZE = 20;
const MAXIMUM_PAGE_SIZE = 50;

export type SupportCaseError =
  | { readonly type: "SUPPORT_CASE_NOT_FOUND" }
  | { readonly type: "INVALID_STATE"; readonly message: string }
  | { readonly type: "MESSAGE_LIMIT_REACHED"; readonly limit: number }
  | { readonly type: "LIVE_CASE_LIMIT_REACHED"; readonly limit: number }
  | { readonly type: "REOPEN_WINDOW_CLOSED" }
  | { readonly type: "STAFF_IS_CASE_OPENER" }
  | { readonly type: "INVALID_CURSOR" }
  | {
      readonly type: "PLATFORM_CAPABILITY_REQUIRED";
      readonly capability: "handle_support_cases";
    };

/**
 * One message as both audiences see it.
 *
 * NO AUTHOR ID AND NO AUTHOR NAME, in either projection. The opener learns that staff
 * answered, never which staff member — the same reasoning that keeps a moderator's identity
 * out of `report-history`: naming the person makes a decision personal and hands somebody a
 * target. Staff read the queue to answer a question, not to know which colleague spoke, and
 * the audit chain already names whoever took a verdict.
 */
export interface SupportCaseMessageView {
  readonly id: string;
  readonly sequence: number;
  readonly authorKind: typeof supportCaseMessage.$inferSelect.authorKind;
  readonly body: string;
  readonly createdAt: Date;
}

export interface SupportCaseSummaryView {
  readonly id: string;
  readonly category: typeof supportCase.$inferSelect.category;
  readonly state: typeof supportCase.$inferSelect.state;
  readonly subject: string;
  readonly orderReference: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly decidedAt: Date | null;
}

export interface SupportCaseDetailView extends SupportCaseSummaryView {
  readonly description: string;
  readonly decisionNote: string | null;
  readonly messages: readonly SupportCaseMessageView[];
  /**
   * Whether this case accepts another message from the person who opened it.
   *
   * DERIVED HERE RATHER THAN IN THE CLIENT, because the reopen window is a rule this service
   * enforces and a client computing its own copy would eventually disagree — showing a
   * composer that 409s, or hiding one that would have worked.
   */
  readonly canOpenerReply: boolean;
}

/** The queue row. Adds the opener, which the opener's own projection has no reason to carry. */
export interface StaffSupportCaseSummaryView extends SupportCaseSummaryView {
  readonly openedByUserId: string;
  readonly openerName: string;
  readonly openerHandle: string | null;
}

export interface StaffSupportCaseDetailView extends StaffSupportCaseSummaryView {
  readonly description: string;
  readonly decisionNote: string | null;
  readonly messages: readonly SupportCaseMessageView[];
}

export interface SupportCasePage<TRow> {
  readonly cases: readonly TRow[];
  readonly nextCursor: string | null;
}

/** A `db` handle that may be a transaction — the idiom `project-audit.service.ts` sets. */
type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function requireSupportStaff(
  staffUserId: string,
): Promise<Result<PlatformStaffContext, SupportCaseError>> {
  const capability = await requirePlatformCapability(staffUserId, "handle_support_cases");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "handle_support_cases" },
    };
  }
  return { success: true, value: capability.value };
}

function clampPageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAXIMUM_PAGE_SIZE);
}

function canOpenerReplyTo(row: typeof supportCase.$inferSelect, asOf: Date): boolean {
  switch (row.state) {
    case "open":
    case "awaiting_user":
      return true;
    case "resolved":
      return (
        row.decidedAt !== null &&
        asOf.getTime() - row.decidedAt.getTime() <= REOPEN_WINDOW_MILLISECONDS
      );
    case "closed":
      return false;
    default: {
      const exhaustiveCheck: never = row.state;
      throw new Error(`Unhandled support case state: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function toSummaryView(row: typeof supportCase.$inferSelect): SupportCaseSummaryView {
  return {
    id: row.id,
    category: row.category,
    state: row.state,
    subject: row.subject,
    orderReference: row.orderReference,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
  };
}

async function readMessages(
  executor: DatabaseExecutor | typeof db,
  caseId: string,
): Promise<readonly SupportCaseMessageView[]> {
  return executor
    .select({
      id: supportCaseMessage.id,
      sequence: supportCaseMessage.sequence,
      authorKind: supportCaseMessage.authorKind,
      body: supportCaseMessage.body,
      createdAt: supportCaseMessage.createdAt,
    })
    .from(supportCaseMessage)
    .where(eq(supportCaseMessage.caseId, caseId))
    .orderBy(asc(supportCaseMessage.sequence));
}

/**
 * The next gapless sequence for one case.
 *
 * ONLY EVER CALLED WITH THE CASE ROW LOCKED. Without that lock two concurrent inserts read
 * the same maximum and one loses to `support_case_message_sequence_uidx`.
 */
async function nextMessageSequence(tx: DatabaseExecutor, caseId: string): Promise<number> {
  const [highest] = await tx
    .select({ sequence: supportCaseMessage.sequence })
    .from(supportCaseMessage)
    .where(eq(supportCaseMessage.caseId, caseId))
    .orderBy(desc(supportCaseMessage.sequence))
    .limit(1);

  return (highest?.sequence ?? 0) + 1;
}

async function countMessages(tx: DatabaseExecutor, caseId: string): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(supportCaseMessage)
    .where(eq(supportCaseMessage.caseId, caseId));
  return row?.total ?? 0;
}

/**
 * Every account that can answer a support case.
 *
 * DERIVED FROM THE GRANT TABLE, never from a hardcoded role name. `handle_support_cases` is
 * `admin`-only today; if it is ever widened, the people notified widen with it and nothing
 * here has to be remembered. The staff population is a handful of rows, so filtering in
 * TypeScript through the one exported reader beats duplicating the grant table in SQL.
 */
async function listSupportStaffUserIds(executor: DatabaseExecutor): Promise<readonly string[]> {
  const staffRows = await executor
    .select({ id: user.id, platformRole: user.platformRole })
    .from(user)
    .where(isNotNull(user.platformRole));

  return staffRows
    .filter(
      (row) =>
        row.platformRole !== null &&
        listPlatformCapabilitiesForRole(row.platformRole).includes("handle_support_cases"),
    )
    .map((row) => row.id);
}

/**
 * Opens a case.
 *
 * NO NOTIFICATION TO THE OPENER — they are looking at the confirmation. The fan-out goes to
 * STAFF, and that is the half without which this whole surface would be poll-only: a case
 * nobody is told about is a case that sits unread, which is precisely the failure a support
 * channel exists to fix.
 */
export async function openSupportCase(
  openerUserId: string,
  input: {
    readonly category: typeof supportCase.$inferSelect.category;
    readonly subject: string;
    readonly description: string;
    readonly orderReference?: string | undefined;
  },
): Promise<Result<SupportCaseDetailView, SupportCaseError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [liveCases] = await transaction
      .select({ total: count() })
      .from(supportCase)
      .where(
        and(
          eq(supportCase.openedByUserId, openerUserId),
          or(eq(supportCase.state, "open"), eq(supportCase.state, "awaiting_user")),
        ),
      );

    if ((liveCases?.total ?? 0) >= MAXIMUM_LIVE_CASES_PER_USER) {
      return { status: "too_many_live_cases" as const };
    }

    const [created] = await transaction
      .insert(supportCase)
      .values({
        openedByUserId: openerUserId,
        category: input.category,
        subject: input.subject,
        description: input.description,
        orderReference: input.orderReference ?? null,
      })
      .returning();

    if (!created) {
      // Unreachable: an insert with no conflict target either returns its row or throws.
      // Asserted rather than assumed, so a future `onConflictDoNothing` cannot make this
      // function quietly return a fabricated id.
      throw new Error("Support case insert returned no row.");
    }

    const staffUserIds = await listSupportStaffUserIds(transaction);
    await enqueueNotifications(
      transaction,
      openerUserId,
      staffUserIds.map((staffUserId) => ({
        recipientUserId: staffUserId,
        kind: "support_case_opened" as const,
        payload: { supportCaseId: created.id, category: created.category },
      })),
    );

    return { status: "opened" as const, row: created };
  });

  if (outcome.status === "too_many_live_cases") {
    return {
      success: false,
      error: { type: "LIVE_CASE_LIMIT_REACHED", limit: MAXIMUM_LIVE_CASES_PER_USER },
    };
  }

  return {
    success: true,
    value: {
      ...toSummaryView(outcome.row),
      description: outcome.row.description,
      decisionNote: outcome.row.decisionNote,
      messages: [],
      canOpenerReply: true,
    },
  };
}

/**
 * The opener's own cases, newest first.
 *
 * SCOPED IN THE WHERE CLAUSE to `openerUserId`, which comes from the session. There is no
 * `?userId=` and there must never be one.
 */
export async function listOwnSupportCases(
  openerUserId: string,
  input: {
    readonly state?: typeof supportCase.$inferSelect.state | undefined;
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  },
): Promise<Result<SupportCasePage<SupportCaseSummaryView>, SupportCaseError>> {
  const pageSize = clampPageSize(input.limit);

  const decodedCursor: InstantCursor | null =
    input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const conditions = [eq(supportCase.openedByUserId, openerUserId)];
  if (input.state !== undefined) conditions.push(eq(supportCase.state, input.state));
  if (decodedCursor !== null) {
    // Strictly older, OR the same instant with a smaller id — the two-term row comparison
    // that keeps a page boundary from duplicating or skipping a row.
    conditions.push(
      or(
        lt(supportCase.createdAt, decodedCursor.instant),
        and(eq(supportCase.createdAt, decodedCursor.instant), lt(supportCase.id, decodedCursor.id)),
      ) ?? sql`true`,
    );
  }

  const rows = await db
    .select()
    .from(supportCase)
    .where(and(...conditions))
    .orderBy(desc(supportCase.createdAt), desc(supportCase.id))
    // One extra row, to answer "is there another page?" without a COUNT.
    .limit(pageSize + 1);

  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows.at(-1);
  const hasMore = rows.length > pageSize && lastRow !== undefined;

  return {
    success: true,
    value: {
      cases: pageRows.map(toSummaryView),
      nextCursor: hasMore
        ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.id })
        : null,
    },
  };
}

export async function getOwnSupportCase(
  openerUserId: string,
  caseId: string,
): Promise<Result<SupportCaseDetailView, SupportCaseError>> {
  const [row] = await db
    .select()
    .from(supportCase)
    .where(and(eq(supportCase.id, caseId), eq(supportCase.openedByUserId, openerUserId)))
    .limit(1);

  if (!row) return { success: false, error: { type: "SUPPORT_CASE_NOT_FOUND" } };

  return {
    success: true,
    value: {
      ...toSummaryView(row),
      description: row.description,
      decisionNote: row.decisionNote,
      messages: await readMessages(db, caseId),
      canOpenerReply: canOpenerReplyTo(row, new Date()),
    },
  };
}

/**
 * The opener replies.
 *
 * REPLYING TO A `resolved` CASE REOPENS IT, inside the window. "Resolved" is a claim by one
 * side of a conversation, and the side that asked the question is entitled to say it is not
 * answered — a channel where only staff can decide the matter is settled is a channel that
 * settles nothing. Past the window it is a 409 that says to open a new case, because a thread
 * revived months later is a new problem wearing an old title.
 *
 * The decided triple is cleared in the same statement that sets `open`, which
 * `support_case_decision_ck` requires: a reopened case must not keep a verdict nobody holds.
 */
export async function addOwnSupportCaseMessage(
  openerUserId: string,
  caseId: string,
  input: { readonly body: string },
): Promise<Result<SupportCaseDetailView, SupportCaseError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(supportCase)
      .where(and(eq(supportCase.id, caseId), eq(supportCase.openedByUserId, openerUserId)))
      .limit(1)
      .for("update");

    if (!row) return { status: "missing" as const };
    if (row.state === "closed") return { status: "closed" as const };
    if (!canOpenerReplyTo(row, new Date())) return { status: "reopen_window_closed" as const };

    const messageCount = await countMessages(transaction, row.id);
    if (messageCount >= MAXIMUM_MESSAGES_PER_CASE) return { status: "message_cap" as const };

    await transaction.insert(supportCaseMessage).values({
      caseId: row.id,
      sequence: await nextMessageSequence(transaction, row.id),
      authorKind: "case_opener",
      authorUserId: openerUserId,
      body: input.body,
    });

    await transaction
      .update(supportCase)
      .set({
        state: "open",
        // Cleared together, so a reopened case satisfies `support_case_decision_ck` and no
        // longer displays a verdict that is no longer in force.
        decidedAt: null,
        decidedByUserId: null,
        decisionNote: null,
        updatedAt: new Date(),
      })
      .where(eq(supportCase.id, row.id));

    return { status: "added" as const };
  });

  switch (outcome.status) {
    case "added":
      // Answers the WHOLE case rather than the one message, the `addDisputeNote` posture: the
      // person wants the conversation they just joined, and re-reading through the owner read
      // means the response cannot disagree with what a refresh would show.
      return getOwnSupportCase(openerUserId, caseId);
    case "missing":
      return { success: false, error: { type: "SUPPORT_CASE_NOT_FOUND" } };
    case "closed":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: "This case is closed. Please open a new one.",
        },
      };
    case "reopen_window_closed":
      return { success: false, error: { type: "REOPEN_WINDOW_CLOSED" } };
    case "message_cap":
      return {
        success: false,
        error: { type: "MESSAGE_LIMIT_REACHED", limit: MAXIMUM_MESSAGES_PER_CASE },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled support message outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** The staff queue, oldest first — the longest-waiting person is the most urgent one. */
export async function listSupportCaseQueue(
  staffUserId: string,
  input: {
    readonly state?: typeof supportCase.$inferSelect.state | undefined;
    readonly category?: typeof supportCase.$inferSelect.category | undefined;
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  },
): Promise<Result<SupportCasePage<StaffSupportCaseSummaryView>, SupportCaseError>> {
  const staff = await requireSupportStaff(staffUserId);
  if (!staff.success) return { success: false, error: staff.error };

  const pageSize = clampPageSize(input.limit);

  const decodedCursor: InstantCursor | null =
    input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const conditions = [];
  if (input.state !== undefined) conditions.push(eq(supportCase.state, input.state));
  if (input.category !== undefined) conditions.push(eq(supportCase.category, input.category));
  if (decodedCursor !== null) {
    // Ascending here, so the comparison is the mirror of the opener's list.
    conditions.push(
      or(
        gt(supportCase.createdAt, decodedCursor.instant),
        and(eq(supportCase.createdAt, decodedCursor.instant), gt(supportCase.id, decodedCursor.id)),
      ) ?? sql`true`,
    );
  }

  const rows = await db
    .select({
      supportCaseRow: supportCase,
      openerName: user.name,
      openerHandle: user.handle,
    })
    .from(supportCase)
    // INNER, and it is safe: `opened_by_user_id` is NOT NULL and the anonymization manifest
    // DELETES the case with the account, so there is no such thing as an authorless case.
    .innerJoin(user, eq(user.id, supportCase.openedByUserId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(supportCase.createdAt), asc(supportCase.id))
    .limit(pageSize + 1);

  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows.at(-1);
  const hasMore = rows.length > pageSize && lastRow !== undefined;

  return {
    success: true,
    value: {
      cases: pageRows.map((row) => ({
        ...toSummaryView(row.supportCaseRow),
        openedByUserId: row.supportCaseRow.openedByUserId,
        openerName: row.openerName,
        openerHandle: row.openerHandle,
      })),
      nextCursor: hasMore
        ? encodeInstantCursor({
            instant: lastRow.supportCaseRow.createdAt,
            id: lastRow.supportCaseRow.id,
          })
        : null,
    },
  };
}

export async function getSupportCaseForStaff(
  staffUserId: string,
  caseId: string,
): Promise<Result<StaffSupportCaseDetailView, SupportCaseError>> {
  const staff = await requireSupportStaff(staffUserId);
  if (!staff.success) return { success: false, error: staff.error };

  const [row] = await db
    .select({
      supportCaseRow: supportCase,
      openerName: user.name,
      openerHandle: user.handle,
    })
    .from(supportCase)
    .innerJoin(user, eq(user.id, supportCase.openedByUserId))
    .where(eq(supportCase.id, caseId))
    .limit(1);

  if (!row) return { success: false, error: { type: "SUPPORT_CASE_NOT_FOUND" } };

  return {
    success: true,
    value: {
      ...toSummaryView(row.supportCaseRow),
      openedByUserId: row.supportCaseRow.openedByUserId,
      openerName: row.openerName,
      openerHandle: row.openerHandle,
      description: row.supportCaseRow.description,
      decisionNote: row.supportCaseRow.decisionNote,
      messages: await readMessages(db, caseId),
    },
  };
}

/**
 * Staff answers.
 *
 * MOVES THE CASE TO `awaiting_user` AND NOTIFIES THE OPENER, in the same transaction as the
 * message — a row saying somebody was answered, with nothing queued to tell them, is worse
 * than a failed reply the staff member can retry.
 *
 * A STAFF MEMBER MAY NOT ANSWER THEIR OWN CASE. `MODERATOR_IS_SUBJECT` on a report queue is
 * the same rule: the value of a second party reading it is the whole point.
 */
export async function addStaffSupportCaseMessage(
  staffUserId: string,
  caseId: string,
  input: { readonly body: string },
): Promise<Result<StaffSupportCaseDetailView, SupportCaseError>> {
  const staff = await requireSupportStaff(staffUserId);
  if (!staff.success) return { success: false, error: staff.error };

  const outcome = await db.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(supportCase)
      .where(eq(supportCase.id, caseId))
      .limit(1)
      .for("update");

    if (!row) return { status: "missing" as const };
    if (row.openedByUserId === staffUserId) return { status: "own_case" as const };
    if (row.state === "closed") return { status: "closed" as const };

    const messageCount = await countMessages(transaction, row.id);
    if (messageCount >= MAXIMUM_MESSAGES_PER_CASE) return { status: "message_cap" as const };

    await transaction.insert(supportCaseMessage).values({
      caseId: row.id,
      sequence: await nextMessageSequence(transaction, row.id),
      authorKind: "staff",
      authorUserId: staffUserId,
      body: input.body,
    });

    /**
     * A REPLY ON A `resolved` CASE PUTS IT BACK TO `awaiting_user`, which means clearing the
     * decided triple: staff adding to a case they had closed out have reopened it themselves,
     * and a live conversation must not wear a verdict.
     */
    await transaction
      .update(supportCase)
      .set({
        state: "awaiting_user",
        decidedAt: null,
        decidedByUserId: null,
        decisionNote: null,
        updatedAt: new Date(),
      })
      .where(eq(supportCase.id, row.id));

    await enqueueNotifications(transaction, staffUserId, [
      {
        recipientUserId: row.openedByUserId,
        kind: "support_case_replied",
        // NULL actor: the opener learns that support answered, never which person did.
        actorUserId: null,
        payload: { supportCaseId: row.id },
      },
    ]);

    return { status: "added" as const };
  });

  switch (outcome.status) {
    case "added":
      return getSupportCaseForStaff(staffUserId, caseId);
    case "missing":
      return { success: false, error: { type: "SUPPORT_CASE_NOT_FOUND" } };
    case "own_case":
      return { success: false, error: { type: "STAFF_IS_CASE_OPENER" } };
    case "closed":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: "This case is closed and can no longer be added to.",
        },
      };
    case "message_cap":
      return {
        success: false,
        error: { type: "MESSAGE_LIMIT_REACHED", limit: MAXIMUM_MESSAGES_PER_CASE },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled staff message outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Resolves or closes a case.
 *
 * THE NOTE IS BOTH THE DECISION RECORD AND A MESSAGE IN THE THREAD. Storing it only on the
 * row would make the last thing the person sees a state change with no sentence attached;
 * storing it only as a message would leave the verdict unexplained in the queue. It is one
 * sentence written once and read in both places.
 *
 * THE AUDIT ENTRY IS APPENDED INSIDE THE TRANSACTION, because the chain hashes the row's own
 * fields and a later append would hash a different history. This is also why the route
 * requires an idempotency key: a retried decision that appended a second entry would make the
 * chain claim two decisions were taken.
 */
export async function decideSupportCase(
  staffUserId: string,
  caseId: string,
  input: { readonly decision: "resolved" | "closed"; readonly note: string },
): Promise<Result<StaffSupportCaseDetailView, SupportCaseError>> {
  const staff = await requireSupportStaff(staffUserId);
  if (!staff.success) return { success: false, error: staff.error };
  const staffRoleSnapshot = staff.value.platformRole;

  const outcome = await db.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(supportCase)
      .where(eq(supportCase.id, caseId))
      .limit(1)
      .for("update");

    if (!row) return { status: "missing" as const };
    if (row.openedByUserId === staffUserId) return { status: "own_case" as const };
    if (row.state === "closed") return { status: "closed" as const };

    const messageCount = await countMessages(transaction, row.id);
    if (messageCount >= MAXIMUM_MESSAGES_PER_CASE) return { status: "message_cap" as const };

    const decidedAt = new Date();

    await transaction.insert(supportCaseMessage).values({
      caseId: row.id,
      sequence: await nextMessageSequence(transaction, row.id),
      authorKind: "staff",
      authorUserId: staffUserId,
      body: input.note,
    });

    await transaction
      .update(supportCase)
      .set({
        state: input.decision,
        decidedAt,
        decidedByUserId: staffUserId,
        decisionNote: input.note,
        updatedAt: decidedAt,
      })
      .where(eq(supportCase.id, row.id));

    await appendPlatformAuditEntry(transaction, {
      eventKind: input.decision === "resolved" ? "support_case_resolved" : "support_case_closed",
      actorUserId: staffUserId,
      actorRoleSnapshot: staffRoleSnapshot,
      actionLabel: input.decision === "resolved" ? "support_case_resolved" : "support_case_closed",
      targetLabel: `support_case:${row.id}`,
      detailNote: input.note,
      payload: { supportCaseId: row.id, category: row.category },
      occurredAt: decidedAt,
    });

    await enqueueNotifications(transaction, staffUserId, [
      {
        recipientUserId: row.openedByUserId,
        kind: "support_case_decided",
        actorUserId: null,
        payload: { supportCaseId: row.id, state: input.decision },
      },
    ]);

    return { status: "decided" as const };
  });

  switch (outcome.status) {
    case "decided":
      return getSupportCaseForStaff(staffUserId, caseId);
    case "missing":
      return { success: false, error: { type: "SUPPORT_CASE_NOT_FOUND" } };
    case "own_case":
      return { success: false, error: { type: "STAFF_IS_CASE_OPENER" } };
    case "closed":
      return {
        success: false,
        error: { type: "INVALID_STATE", message: "This case is already closed." },
      };
    case "message_cap":
      return {
        success: false,
        error: { type: "MESSAGE_LIMIT_REACHED", limit: MAXIMUM_MESSAGES_PER_CASE },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled support decision outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
