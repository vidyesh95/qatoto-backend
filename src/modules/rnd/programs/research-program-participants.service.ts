import { and, asc, count, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  researchContributionLedgerEntry,
  researchEffortLog,
  researchProgramParticipant,
  user,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  PROGRAM_AUTHOR_COLUMNS,
  toProgramAuthorView,
  type ProgramAccessError,
  type ProgramAuthorView,
} from "#src/modules/rnd/programs/research-program-access.service.js";
import type { Result } from "#src/types/index.js";

/**
 * §10 participants, logged effort and recorded contributions
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * NONE OF THIS IS EQUITY, AND NONE OF IT IS MONEY MOVING. That is the single most
 * important thing about this file. §9's Slicing Pie ledger is project-scoped, verified
 * against artifacts, and mints ownership; a program's contribution tracking is
 * self-reported and mints nothing. §10 says so, and it is why these are separate tables
 * from `effort_claim` and `slice_ledger_entry` rather than a nullable `programId` on them.
 *
 * `role` AUTHORIZES NOTHING. It is a self-declared statement of HOW someone contributes
 * (researcher, supplier, venture capitalist), and `PATCH …/contributors/me` lets a person
 * change their own. Treating it as authority would mean granting yourself authority is a
 * PATCH away — see `research-program-access.service.ts`.
 *
 * `totalEffortMinutes` IS A SUM, NEVER A COLUMN. A denormalized total that can disagree
 * with the logs it summarizes is a number nobody can defend, and this surface exists to be
 * defensible. It is computed here on read, and separately by the stats job.
 *
 * THE TWO WRITE PATHS BOTH TAKE A CLIENT-MINTED `idempotencyKey`, and the unique index
 * `(participantId, idempotencyKey)` is what makes a retried submit return the first row
 * instead of double-counting. It is deliberately NOT derived from the contents: two
 * identical honest logs on the same day are two logs.
 */

export type ResearchProgramParticipantRole =
  (typeof researchProgramParticipant.$inferSelect)["role"];
export type ResearchContributionKind =
  (typeof researchContributionLedgerEntry.$inferSelect)["kind"];
export type CompensationPreference =
  (typeof researchProgramParticipant.$inferSelect)["compensationPreference"];

export type ResearchParticipantError =
  | ProgramAccessError
  | { type: "ALREADY_A_PARTICIPANT" }
  | { type: "NOT_A_PARTICIPANT" }
  | { type: "BRANCH_NOT_FOUND"; branchId: string }
  | { type: "EFFORT_DATE_IN_FUTURE"; loggedForDate: string }
  | { type: "TRANCHE_ROLE_MISMATCH" }
  | { type: "CASH_AMOUNT_REQUIRED" }
  | { type: "CASH_AMOUNT_FORBIDDEN" };

/**
 * One contributor as read back.
 *
 * The two tranche fields and `totalEffortMinutes` are the mock's single `effortLabel`
 * pulled apart — it held "312 hrs logged" on nine rows and "Funding tranche 2 of 4" on two,
 * which §10 calls the trap. They are separate facts now, and a client renders whichever
 * applies.
 */
export interface ResearchProgramParticipantView {
  readonly participantId: string;
  readonly participant: ProgramAuthorView;
  readonly role: ResearchProgramParticipantRole;
  readonly compensationPreference: CompensationPreference;
  readonly contributionSummary: string | null;
  readonly totalEffortMinutes: number;
  readonly fundingTrancheIndex: number | null;
  readonly fundingTrancheTotal: number | null;
  readonly isViewer: boolean;
  readonly joinedAt: Date;
}

/**
 * Effort minutes per participant, as a correlated subquery.
 *
 * One query for the whole roster rather than one per contributor. COALESCE in SQL because a
 * participant with no logs yet has no rows to sum, and `SUM` over nothing is NULL — a
 * JS-side `?? 0` would work but would put the zero in a different place from where the
 * stats job puts it.
 */
const EFFORT_MINUTES_SUBQUERY = sql<number>`(
  SELECT COALESCE(SUM(participant_effort.minutes), 0)::int
  FROM research_effort_log AS participant_effort
  WHERE participant_effort.participant_id = research_program_participant.id
)`;

const PARTICIPANT_SELECT_COLUMNS = {
  participantId: researchProgramParticipant.id,
  participantUserId: researchProgramParticipant.userId,
  role: researchProgramParticipant.role,
  compensationPreference: researchProgramParticipant.compensationPreference,
  contributionSummary: researchProgramParticipant.contributionSummary,
  fundingTrancheIndex: researchProgramParticipant.fundingTrancheIndex,
  fundingTrancheTotal: researchProgramParticipant.fundingTrancheTotal,
  joinedAt: researchProgramParticipant.joinedAt,
  totalEffortMinutes: EFFORT_MINUTES_SUBQUERY,
  ...PROGRAM_AUTHOR_COLUMNS,
} as const;

interface RawParticipantRow {
  readonly participantId: string;
  readonly participantUserId: string;
  readonly role: ResearchProgramParticipantRole;
  readonly compensationPreference: CompensationPreference;
  readonly contributionSummary: string | null;
  readonly fundingTrancheIndex: number | null;
  readonly fundingTrancheTotal: number | null;
  readonly joinedAt: Date;
  readonly totalEffortMinutes: number;
  readonly authorUserId: string | null;
  readonly authorName: string | null;
  readonly authorHandle: string | null;
  readonly authorAvatarImageUrl: string | null;
  readonly authorLocationLabel: string | null;
}

function toParticipantView(
  row: RawParticipantRow,
  viewerUserId: string | null,
): ResearchProgramParticipantView {
  return {
    participantId: row.participantId,
    participant: toProgramAuthorView(row),
    role: row.role,
    compensationPreference: row.compensationPreference,
    contributionSummary: row.contributionSummary,
    totalEffortMinutes: row.totalEffortMinutes,
    fundingTrancheIndex: row.fundingTrancheIndex,
    fundingTrancheTotal: row.fundingTrancheTotal,
    isViewer: viewerUserId !== null && row.participantUserId === viewerUserId,
    joinedAt: row.joinedAt,
  };
}

/**
 * The contributors roster, optionally filtered by role.
 *
 * FILTERED IN SQL. The mock's role chips filtered a fetched array; on a program with
 * thousands of participants that is the whole roster over the wire to render five rows,
 * which CLAUDE.md's thin-client rule exists to prevent.
 *
 * Ordered newest-joined last, ending in a unique column so the roster is stable between
 * reads.
 */
export async function listProgramParticipants(input: {
  readonly programId: string;
  readonly viewerUserId: string | null;
  readonly role?: ResearchProgramParticipantRole | undefined;
  readonly limit: number;
  readonly offset: number;
}): Promise<{
  readonly rows: readonly ResearchProgramParticipantView[];
  readonly total: number;
}> {
  const conditions = [eq(researchProgramParticipant.programId, input.programId)];
  if (input.role !== undefined) {
    conditions.push(eq(researchProgramParticipant.role, input.role));
  }
  const whereClause = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(PARTICIPANT_SELECT_COLUMNS)
      .from(researchProgramParticipant)
      .innerJoin(user, eq(user.id, researchProgramParticipant.userId))
      .where(whereClause)
      .orderBy(asc(researchProgramParticipant.joinedAt), asc(researchProgramParticipant.id))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ total: count() }).from(researchProgramParticipant).where(whereClause),
  ]);

  return {
    rows: (rows as RawParticipantRow[]).map((row) => toParticipantView(row, input.viewerUserId)),
    total: totalRow?.total ?? 0,
  };
}

/**
 * `POST …/contributors/me` — joins a program.
 *
 * The unique index `(programId, userId)` is the guard, and a 23505 becomes
 * `409 ALREADY_A_PARTICIPANT` rather than being swallowed: unlike a branch claim, joining
 * twice is not the same request repeated — the second call usually carries a DIFFERENT role
 * or compensation preference, and silently ignoring it would look like an accepted edit.
 * `PATCH` is the way to change those.
 */
export async function joinResearchProgram(input: {
  readonly programId: string;
  readonly userId: string;
  readonly role: ResearchProgramParticipantRole;
  readonly compensationPreference: CompensationPreference;
  readonly contributionSummary: string | null;
  readonly fundingTrancheIndex: number | null;
  readonly fundingTrancheTotal: number | null;
}): Promise<Result<{ readonly participantId: string }, ResearchParticipantError>> {
  const trancheCheck = validateTranche(input);
  if (trancheCheck !== null) return { success: false, error: trancheCheck };

  try {
    const [created] = await db
      .insert(researchProgramParticipant)
      .values({
        programId: input.programId,
        userId: input.userId,
        role: input.role,
        compensationPreference: input.compensationPreference,
        contributionSummary: input.contributionSummary,
        fundingTrancheIndex: input.fundingTrancheIndex,
        fundingTrancheTotal: input.fundingTrancheTotal,
      })
      .returning({ id: researchProgramParticipant.id });

    if (!created) throw new Error("joinResearchProgram: insert returned no row");
    return { success: true, value: { participantId: created.id } };
  } catch (insertError: unknown) {
    if (isUniqueViolation(insertError)) {
      return { success: false, error: { type: "ALREADY_A_PARTICIPANT" } };
    }
    throw insertError;
  }
}

/** `PATCH …/contributors/me` — edits your own participation. Nobody else's. */
export async function updateOwnParticipation(input: {
  readonly programId: string;
  readonly userId: string;
  readonly role?: ResearchProgramParticipantRole | undefined;
  readonly compensationPreference?: CompensationPreference | undefined;
  readonly contributionSummary?: string | null | undefined;
  readonly fundingTrancheIndex?: number | null | undefined;
  readonly fundingTrancheTotal?: number | null | undefined;
}): Promise<Result<{ readonly participantId: string }, ResearchParticipantError>> {
  const [existing] = await db
    .select({
      id: researchProgramParticipant.id,
      role: researchProgramParticipant.role,
      fundingTrancheIndex: researchProgramParticipant.fundingTrancheIndex,
      fundingTrancheTotal: researchProgramParticipant.fundingTrancheTotal,
    })
    .from(researchProgramParticipant)
    .where(
      and(
        eq(researchProgramParticipant.programId, input.programId),
        eq(researchProgramParticipant.userId, input.userId),
      ),
    );

  if (!existing) return { success: false, error: { type: "NOT_A_PARTICIPANT" } };

  // The tranche rule is checked against the MERGED state, not the patch: sending only a
  // tranche while already being a researcher, or only a role while already holding a
  // tranche, are both ways to reach an invalid row one field at a time.
  const mergedRole = input.role ?? existing.role;
  const mergedIndex =
    input.fundingTrancheIndex === undefined
      ? existing.fundingTrancheIndex
      : input.fundingTrancheIndex;
  const mergedTotal =
    input.fundingTrancheTotal === undefined
      ? existing.fundingTrancheTotal
      : input.fundingTrancheTotal;

  const trancheCheck = validateTranche({
    role: mergedRole,
    fundingTrancheIndex: mergedIndex,
    fundingTrancheTotal: mergedTotal,
  });
  if (trancheCheck !== null) return { success: false, error: trancheCheck };

  await db
    .update(researchProgramParticipant)
    .set({
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.compensationPreference === undefined
        ? {}
        : { compensationPreference: input.compensationPreference }),
      ...(input.contributionSummary === undefined
        ? {}
        : { contributionSummary: input.contributionSummary }),
      ...(input.fundingTrancheIndex === undefined
        ? {}
        : { fundingTrancheIndex: input.fundingTrancheIndex }),
      ...(input.fundingTrancheTotal === undefined
        ? {}
        : { fundingTrancheTotal: input.fundingTrancheTotal }),
    })
    .where(eq(researchProgramParticipant.id, existing.id));

  return { success: true, value: { participantId: existing.id } };
}

/**
 * The tranche columns belong to a funder.
 *
 * The CHECK already enforces both-or-neither and index <= total. This adds the semantic
 * half a CHECK cannot see: a `researcher` with "tranche 2 of 4" is not a constraint
 * violation, it is a category error, and it would render as funding progress beside
 * somebody who has funded nothing.
 */
function validateTranche(input: {
  readonly role: ResearchProgramParticipantRole;
  readonly fundingTrancheIndex: number | null;
  readonly fundingTrancheTotal: number | null;
}): ResearchParticipantError | null {
  const hasTranche = input.fundingTrancheIndex !== null || input.fundingTrancheTotal !== null;
  if (hasTranche && input.role !== "venture_capitalist") {
    return { type: "TRANCHE_ROLE_MISMATCH" };
  }
  return null;
}

/**
 * `POST …/effort-logs` — records self-reported time.
 *
 * A FUTURE DATE IS REFUSED. `minutes` is bounded by a CHECK and the date by this: logging
 * tomorrow's work is either a timezone bug or a claim about work not yet done, and neither
 * belongs in a record other people read as history.
 *
 * A retried submit with the same key returns the FIRST row's id rather than 409 — the
 * caller's intent ("record this log") is already satisfied, and a 409 would push a client
 * into deciding whether to retry something that already succeeded.
 */
export async function logResearchEffort(input: {
  readonly programId: string;
  readonly participantId: string;
  readonly branchId: string | null;
  readonly minutes: number;
  readonly loggedForDate: string;
  readonly note: string;
  readonly idempotencyKey: string;
  /** Injected so a test can pin "today" rather than racing the clock at midnight. */
  readonly today?: string | undefined;
}): Promise<
  Result<{ readonly effortLogId: string; readonly wasReplay: boolean }, ResearchParticipantError>
> {
  const todayIsoDate = input.today ?? new Date().toISOString().slice(0, 10);
  if (input.loggedForDate > todayIsoDate) {
    // String comparison is correct for `YYYY-MM-DD` and avoids constructing a Date, which
    // would reinterpret the value in the server's zone.
    return {
      success: false,
      error: { type: "EFFORT_DATE_IN_FUTURE", loggedForDate: input.loggedForDate },
    };
  }

  try {
    const [created] = await db
      .insert(researchEffortLog)
      .values({
        programId: input.programId,
        participantId: input.participantId,
        branchId: input.branchId,
        minutes: input.minutes,
        loggedForDate: input.loggedForDate,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: researchEffortLog.id });

    if (!created) throw new Error("logResearchEffort: insert returned no row");
    return { success: true, value: { effortLogId: created.id, wasReplay: false } };
  } catch (insertError: unknown) {
    if (!isUniqueViolation(insertError)) throw insertError;

    const [existing] = await db
      .select({ id: researchEffortLog.id })
      .from(researchEffortLog)
      .where(
        and(
          eq(researchEffortLog.participantId, input.participantId),
          eq(researchEffortLog.idempotencyKey, input.idempotencyKey),
        ),
      );

    if (!existing) {
      // A unique violation with no matching row means a DIFFERENT constraint fired, which
      // is a bug rather than a replay — rethrowing is the honest answer.
      throw insertError;
    }
    return { success: true, value: { effortLogId: existing.id, wasReplay: true } };
  }
}

/**
 * `POST …/contributions` — records a non-time contribution.
 *
 * A RECORD OF INTENT. `cash_commitment` carries an amount; nothing is held, nothing is
 * transferred, and no response built on this may imply otherwise. The mock's "$250K
 * escrowed" is "$250K committed" here, because escrow left this codebase (§7) and
 * re-implying it is the one lie this surface cannot afford.
 */
export async function recordResearchContribution(input: {
  readonly programId: string;
  readonly participantId: string;
  readonly kind: ResearchContributionKind;
  readonly amountInCents: number | null;
  readonly currencyCode: string | null;
  readonly description: string;
  readonly idempotencyKey: string;
}): Promise<
  Result<{ readonly contributionId: string; readonly wasReplay: boolean }, ResearchParticipantError>
> {
  const isCash = input.kind === "cash_commitment";
  if (isCash && (input.amountInCents === null || input.currencyCode === null)) {
    return { success: false, error: { type: "CASH_AMOUNT_REQUIRED" } };
  }
  if (!isCash && (input.amountInCents !== null || input.currencyCode !== null)) {
    // An amount on a `material` or `data` contribution has no defined meaning, and the
    // CHECK would refuse it — failing here names the field instead of the constraint.
    return { success: false, error: { type: "CASH_AMOUNT_FORBIDDEN" } };
  }

  try {
    const [created] = await db
      .insert(researchContributionLedgerEntry)
      .values({
        programId: input.programId,
        participantId: input.participantId,
        kind: input.kind,
        amountInCents: input.amountInCents,
        currencyCode: input.currencyCode,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: researchContributionLedgerEntry.id });

    if (!created) throw new Error("recordResearchContribution: insert returned no row");
    return { success: true, value: { contributionId: created.id, wasReplay: false } };
  } catch (insertError: unknown) {
    if (!isUniqueViolation(insertError)) throw insertError;

    const [existing] = await db
      .select({ id: researchContributionLedgerEntry.id })
      .from(researchContributionLedgerEntry)
      .where(
        and(
          eq(researchContributionLedgerEntry.participantId, input.participantId),
          eq(researchContributionLedgerEntry.idempotencyKey, input.idempotencyKey),
        ),
      );

    if (!existing) throw insertError;
    return { success: true, value: { contributionId: existing.id, wasReplay: true } };
  }
}

/** Total logged minutes across a program, for the stats job. */
export async function sumProgramEffortMinutes(programId: string): Promise<number> {
  const [row] = await db
    .select({
      totalMinutes: sql<number>`COALESCE(SUM(${researchEffortLog.minutes}), 0)::int`,
    })
    .from(researchEffortLog)
    .where(eq(researchEffortLog.programId, programId));

  // `::bigint` would arrive as a STRING from node-postgres (a bigint does not fit a JS
  // number safely), which is why the cast below is `::int` rather than `::bigint`: total
  // logged minutes will not approach the int4 ceiling of ~4 billion minutes (8,000 years)
  // for any real program, and an int comes back as a number. The `total_effort_minutes`
  // COLUMN is still bigint — a stored total should not inherit a query's convenience.
  return row?.totalMinutes ?? 0;
}

/** Counts a program's participants, for the stats job. */
export async function countProgramParticipants(programId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(researchProgramParticipant)
    .where(eq(researchProgramParticipant.programId, programId));

  return row?.total ?? 0;
}
