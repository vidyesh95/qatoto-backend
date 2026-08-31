import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { user, userModerationAction, userReport } from "#src/db/schema.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Reporting a PERSON's profile, and deciding those reports.
 *
 * ## WHAT UPHOLDING A REPORT DOES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * It sets `user.profile_moderation_state = 'hidden_by_moderator'`, which hides the BIO AND LINKS on
 * the channel page. It does not touch the name, the avatar, a single video, or the account's ability
 * to sign in.
 *
 * That narrowness is the design, not a first cut. Those two fields are new, so the channel read is
 * their ONLY public consumer and one enforcement point covers them completely. A platform-wide
 * "hidden user" would need every public read of a person to honour a new predicate — six modules in
 * `home/` alone before the feed, spotlight, store and R&D — and nothing would fail if one were
 * missed. A half-enforced hide is worse than an honest narrow one.
 *
 * It is also NOT `deactivated_at`. That column's invariant is that a live session implies NULL, so a
 * moderator writing it would be undone the next time the person signed in.
 *
 * ## THE CAPABILITY IS CHECKED INSIDE, BEFORE ANY ID IS READ
 *
 * A route-level guard makes the capability probeable, and an id-first service makes the route an
 * existence oracle. Checking it here, first, avoids both — and middleware cannot return a `Result`,
 * so it could not take part in the controller's exhaustive error switch anyway.
 *
 * ## A 201 IS NOT A VERDICT
 *
 * Creating a report writes one row and no audit entry. Deciding one writes a hash-chained audit
 * entry INSIDE the transaction, because the chain hashes the row's own fields and a later append
 * would hash a different history.
 */

export type UserReportError =
  | { readonly type: "USER_REPORT_NOT_FOUND" }
  | { readonly type: "ALREADY_REPORTED" }
  | { readonly type: "REPORT_ALREADY_RESOLVED" }
  | { readonly type: "SELF_REPORT_FORBIDDEN" }
  | { readonly type: "MODERATOR_IS_SUBJECT" }
  | { readonly type: "PROFILE_TEXT_ALREADY_VISIBLE" }
  | { readonly type: "INVALID_CURSOR" }
  | { readonly type: "PLATFORM_CAPABILITY_REQUIRED"; readonly capability: "moderate_content" };

export interface UserReportQueueItem {
  readonly reportId: string;
  readonly reason: typeof userReport.$inferSelect.reason;
  readonly detailText: string | null;
  readonly status: typeof userReport.$inferSelect.status;
  readonly createdAt: Date;
  readonly subject: {
    readonly userId: string;
    readonly handle: string | null;
    readonly name: string;
    readonly bio: string | null;
    readonly profileModerationState: typeof user.$inferSelect.profileModerationState;
  };
  /** Context, never a threshold — see `listUserReports`. */
  readonly openReportCount: number;
}

async function requireProfileModerator(
  userId: string,
): Promise<Result<PlatformStaffContext, UserReportError>> {
  const capability = await requirePlatformCapability(userId, "moderate_content");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
    };
  }
  return { success: true, value: capability.value };
}

/**
 * Files a report.
 *
 * THE SUBJECT MUST EXIST AND HAVE A HANDLE. A creator with no handle has no channel page, so there
 * is no profile to report — and answering `NOT_FOUND` for both that and a bad id keeps the route
 * from confirming which account ids exist.
 *
 * `onConflictDoNothing` AGAINST THE PARTIAL UNIQUE INDEX is what makes `ALREADY_REPORTED` honest:
 * one report per person per subject, so a brigading loop cannot inflate the queue.
 */
export async function createUserReport(
  reporterUserId: string,
  reportedUserId: string,
  input: {
    readonly reason: typeof userReport.$inferSelect.reason;
    readonly detailText?: string | undefined;
  },
): Promise<Result<{ readonly reportId: string }, UserReportError>> {
  if (reporterUserId === reportedUserId) {
    return { success: false, error: { type: "SELF_REPORT_FORBIDDEN" } };
  }

  const [subject] = await db
    .select({ id: user.id, handle: user.handle })
    .from(user)
    .where(and(eq(user.id, reportedUserId), isNull(user.anonymizedAt)))
    .limit(1);
  if (!subject || subject.handle === null) {
    return { success: false, error: { type: "USER_REPORT_NOT_FOUND" } };
  }

  const [created] = await db
    .insert(userReport)
    .values({
      reportedUserId,
      reporterUserId,
      reason: input.reason,
      detailText: input.detailText ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: userReport.id });

  if (!created) return { success: false, error: { type: "ALREADY_REPORTED" } };
  return { success: true, value: { reportId: created.id } };
}

/**
 * The moderator's queue, oldest first, keyset-paginated.
 *
 * `openReportCount` IS CONTEXT, NEVER A THRESHOLD. Nothing in this file hides a profile because a
 * count crossed a line — every hide names a human. A number that could trip an automatic action
 * would make brigading measurable and then effective.
 */
export async function listUserReports(
  moderatorUserId: string,
  input: {
    readonly status?: typeof userReport.$inferSelect.status | undefined;
    readonly limit: number;
    readonly cursor?: string | undefined;
  },
): Promise<
  Result<
    { readonly items: readonly UserReportQueueItem[]; readonly nextCursor: string | null },
    UserReportError
  >
> {
  const moderator = await requireProfileModerator(moderatorUserId);
  if (!moderator.success) return { success: false, error: moderator.error };

  let cursorCondition = sql`true`;
  if (input.cursor !== undefined) {
    /**
     * ⚠️ **SPLIT ON THE FIRST SEPARATOR, WITH THE ID AS THE UNBOUNDED TAIL.**
     * This used to be `const [rawInstant, rawId] = input.cursor.split("_")`, which takes element
     * `[1]` and DISCARDS the rest — so an id containing an underscore paged from a truncated id
     * and returned the WRONG ROWS rather than refusing. A silent wrong answer, not an error.
     * The epoch prefix is digits only and can never contain `_`, so the first separator is always
     * the real one. Same shape as `src/lib/instant-cursor.ts`.
     */
    const separatorIndex = input.cursor.indexOf("_");
    const rawInstant = separatorIndex === -1 ? "" : input.cursor.slice(0, separatorIndex);
    const rawId = separatorIndex === -1 ? "" : input.cursor.slice(separatorIndex + 1);
    const cursorInstant = rawInstant === "" ? Number.NaN : Number(rawInstant);
    if (!Number.isInteger(cursorInstant) || cursorInstant < 0 || rawId === "") {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    const cursorDate = new Date(cursorInstant);
    cursorCondition = sql`(${userReport.createdAt}, ${userReport.id}) > (${cursorDate}, ${rawId})`;
  }

  const rows = await db
    .select({
      reportId: userReport.id,
      reason: userReport.reason,
      detailText: userReport.detailText,
      status: userReport.status,
      createdAt: userReport.createdAt,
      subjectUserId: user.id,
      subjectHandle: user.handle,
      subjectName: user.name,
      subjectBio: user.bio,
      subjectModerationState: user.profileModerationState,
      openReportCount: sql<number>`(
        SELECT COUNT(*)::int FROM user_report AS sibling
         WHERE sibling.reported_user_id = ${userReport.reportedUserId}
           AND sibling.status = 'open'
      )`,
    })
    .from(userReport)
    .innerJoin(user, eq(user.id, userReport.reportedUserId))
    .where(
      and(
        input.status === undefined ? sql`true` : eq(userReport.status, input.status),
        cursorCondition,
      ),
    )
    .orderBy(asc(userReport.createdAt), asc(userReport.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor =
    rows.length > input.limit && lastRow !== undefined
      ? `${String(lastRow.createdAt.getTime())}_${lastRow.reportId}`
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        reportId: row.reportId,
        reason: row.reason,
        detailText: row.detailText,
        status: row.status,
        createdAt: row.createdAt,
        subject: {
          userId: row.subjectUserId,
          handle: row.subjectHandle,
          name: row.subjectName,
          bio: row.subjectBio,
          profileModerationState: row.subjectModerationState,
        },
        openReportCount: row.openReportCount,
      })),
      nextCursor,
    },
  };
}

/**
 * Upholds or dismisses one report.
 *
 * UPHOLDING CLOSES EVERY OPEN REPORT ABOUT THAT PERSON, the same shape the video queue uses — the
 * profile text is now hidden, so every other open report about it describes a state that no longer
 * exists. Note the blast radius is wider than a video's: reports about a person may concern
 * different incidents, which is an argument for keeping the lever narrow rather than for leaving
 * duplicate queue entries behind.
 *
 * DISMISSING RESTORES NOTHING. Nothing hides a profile except a moderator deciding to, so a
 * dismissal has nothing to undo — and quietly un-hiding text a DIFFERENT moderator hid would
 * overturn their decision as a side effect of closing an unrelated report.
 */
export async function decideUserReport(
  moderatorUserId: string,
  reportId: string,
  input: { readonly decision: "actioned" | "dismissed"; readonly note?: string | undefined },
): Promise<Result<{ readonly reportId: string }, UserReportError>> {
  const moderator = await requireProfileModerator(moderatorUserId);
  if (!moderator.success) return { success: false, error: moderator.error };
  const moderatorRoleSnapshot = moderator.value.platformRole;

  const outcome = await db.transaction(async (transaction) => {
    const [report] = await transaction
      .select()
      .from(userReport)
      .where(eq(userReport.id, reportId))
      .for("update");
    if (!report) return { status: "missing" as const };
    if (report.status !== "open") return { status: "already_resolved" as const };
    if (report.reportedUserId === moderatorUserId) {
      return { status: "moderator_is_subject" as const };
    }

    const shouldHide = input.decision === "actioned";
    const occurredAt = new Date();

    if (shouldHide) {
      await transaction
        .update(user)
        .set({ profileModerationState: "hidden_by_moderator" })
        .where(eq(user.id, report.reportedUserId));
    }

    await transaction
      .update(userReport)
      .set({
        status: input.decision,
        resolvedByUserId: moderatorUserId,
        resolvedAt: occurredAt,
        resolutionNote: input.note ?? null,
      })
      .where(
        shouldHide
          ? and(eq(userReport.reportedUserId, report.reportedUserId), eq(userReport.status, "open"))
          : eq(userReport.id, report.id),
      );

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: shouldHide ? "user_profile_text_hidden" : "user_report_dismissed",
      actorUserId: moderatorUserId,
      actorRoleSnapshot: moderatorRoleSnapshot,
      actionLabel: shouldHide ? "user_profile_text_hidden" : "user_report_dismissed",
      targetLabel: `user:${report.reportedUserId}`,
      ...(input.note === undefined ? {} : { detailNote: input.note }),
      payload: { reportedUserId: report.reportedUserId, reportId: report.id },
      occurredAt,
    });

    await transaction.insert(userModerationAction).values({
      actionKind: shouldHide ? "profile_text_hidden" : "report_dismissed",
      subjectUserId: report.reportedUserId,
      reportId: report.id,
      moderatorUserId,
      moderatorRoleSnapshot,
      // NOT NULL on the column, so a decision taken without a note still names its kind rather
      // than failing the insert.
      reasonNote: input.note ?? (shouldHide ? "Profile text hidden." : "Report dismissed."),
      auditEntryId: auditEntry.id,
    });

    return { status: "decided" as const, reportId: report.id };
  });

  switch (outcome.status) {
    case "missing":
      return { success: false, error: { type: "USER_REPORT_NOT_FOUND" } };
    case "already_resolved":
      return { success: false, error: { type: "REPORT_ALREADY_RESOLVED" } };
    case "moderator_is_subject":
      return { success: false, error: { type: "MODERATOR_IS_SUBJECT" } };
    case "decided":
      return { success: true, value: { reportId: outcome.reportId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled decideUserReport outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The reporter's own profile reports — `GET /users/me/profile-reports`.
 *
 * WHY IT EXISTS. `report-history-page.tsx` says it plainly for the video queue: "a report that
 * vanishes is indistinguishable from one nobody read." Profile reporting shipped without this, so a
 * reporter got a 201 and then silence forever — reintroducing exactly the failure that page was
 * built to fix, on the newer of the two surfaces.
 *
 * NO CAPABILITY CHECK AND NO ERROR ARM. It is scoped to `reporterUserId` and answers an empty list
 * to somebody who has reported nothing, which is honest — there is no resource here that can fail
 * to exist.
 *
 * ## WHAT IT DELIBERATELY OMITS, copied from the video projection rather than re-decided
 *
 * The moderator's identity, their resolution note, and how many other people reported the same
 * person. Naming the moderator makes a takedown personal; disclosing the count makes brigading
 * measurable. A reporter learns the outcome of THEIR report and nothing about anyone else's.
 *
 * IT ALSO OMITS THE SUBJECT'S BIO, which the moderator queue does carry. A moderator needs to read
 * the text under complaint; a reporter has no business being re-served text that may since have
 * been hidden — least of all by the machinery that hid it.
 *
 * UNPAGINATED UNDER A HARD CAP, like the video list and the muted-creators list: bounded by how many
 * people one person reported by hand, and capped so a pathological account cannot make it unbounded.
 */
const MY_PROFILE_REPORTS_LIMIT = 200;

export interface MyProfileReportRow {
  readonly id: string;
  readonly reportedUserId: string;
  readonly reportedName: string;
  readonly reportedHandle: string | null;
  readonly reason: typeof userReport.$inferSelect.reason;
  readonly detailText: string | null;
  readonly status: typeof userReport.$inferSelect.status;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export async function listMyProfileReports(
  reporterUserId: string,
): Promise<readonly MyProfileReportRow[]> {
  return db
    .select({
      id: userReport.id,
      reportedUserId: userReport.reportedUserId,
      reportedName: user.name,
      reportedHandle: user.handle,
      reason: userReport.reason,
      detailText: userReport.detailText,
      status: userReport.status,
      createdAt: userReport.createdAt,
      resolvedAt: userReport.resolvedAt,
    })
    .from(userReport)
    .innerJoin(user, eq(user.id, userReport.reportedUserId))
    .where(eq(userReport.reporterUserId, reporterUserId))
    .orderBy(desc(userReport.createdAt))
    .limit(MY_PROFILE_REPORTS_LIMIT);
}

/** Puts a hidden profile's text back. The only path from `hidden_by_moderator` to `visible`. */
export async function restoreUserProfileText(
  moderatorUserId: string,
  input: { readonly reportedUserId: string; readonly reasonNote: string },
): Promise<Result<{ readonly reportedUserId: string }, UserReportError>> {
  const moderator = await requireProfileModerator(moderatorUserId);
  if (!moderator.success) return { success: false, error: moderator.error };
  const moderatorRoleSnapshot = moderator.value.platformRole;

  const outcome = await db.transaction(async (transaction) => {
    const [subject] = await transaction
      .select({ id: user.id, state: user.profileModerationState })
      .from(user)
      .where(eq(user.id, input.reportedUserId))
      .for("update");
    if (!subject) return { status: "missing" as const };
    if (subject.state === "visible") return { status: "already_visible" as const };

    const occurredAt = new Date();
    await transaction
      .update(user)
      .set({ profileModerationState: "visible" })
      .where(eq(user.id, subject.id));

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: "user_profile_text_restored",
      actorUserId: moderatorUserId,
      actorRoleSnapshot: moderatorRoleSnapshot,
      actionLabel: "user_profile_text_restored",
      targetLabel: `user:${subject.id}`,
      detailNote: input.reasonNote,
      payload: { reportedUserId: subject.id },
      occurredAt,
    });

    await transaction.insert(userModerationAction).values({
      actionKind: "profile_text_restored",
      subjectUserId: subject.id,
      moderatorUserId,
      moderatorRoleSnapshot,
      reasonNote: input.reasonNote,
      auditEntryId: auditEntry.id,
    });

    return { status: "restored" as const, reportedUserId: subject.id };
  });

  switch (outcome.status) {
    case "missing":
      return { success: false, error: { type: "USER_REPORT_NOT_FOUND" } };
    case "already_visible":
      return { success: false, error: { type: "PROFILE_TEXT_ALREADY_VISIBLE" } };
    case "restored":
      return { success: true, value: { reportedUserId: outcome.reportedUserId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled restore outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
