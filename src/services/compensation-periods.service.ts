import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  compensationPeriod,
  compensationPeriodLine,
  effortClaim,
  equitySnapshot,
  equitySnapshotShare,
  memberFairMarketRate,
  projectMember,
  projectStats,
  researchProject,
  sliceLedgerEntry,
  user,
} from "#src/db/schema.js";
import {
  canonicalHashHex,
  canonicalizeDocument,
  type CanonicalValue,
} from "#src/lib/canonical-hash.js";
import {
  coveredDaysInPeriod,
  daysInPeriod,
  hasPeriodClosed,
  hourlyGrossCents,
  monthBoundsAt,
  nextMonthBounds,
  type PeriodBounds,
  periodWindow,
  proratedRetainerCents,
} from "#src/lib/compensation-period.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { listAgreementsOverlapping } from "#src/services/compensation-agreements.service.js";
import { enqueueNotifications } from "#src/services/notifications.service.js";
import {
  advanceStatementChainHead,
  allocateCompensationSequenceNumber,
  appendAuditEntry,
  readStatementChainSlot,
  STATEMENT_GENESIS_PREVIOUS_HASH,
} from "#src/services/project-audit.service.js";
import {
  type ProjectAccessError,
  resolveSecondSignatoryStanding,
} from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Compensation periods and payout statements — the core of §7A
 * (R_AND_D_BACKEND_STRUCTURE.md §7A.3, §7A.4, §7A.5, §11g).
 *
 * THE PRODUCT FOUNDERS ACTUALLY ASKED FOR: "tell me what I owe each person this month."
 * Not a payment rail — a number, with its working shown, that a founder can act on and an
 * employee can trust. Qatoto computes it, freezes it, and records what the parties settled
 * between themselves. It never holds a rupee, a euro or a cent, and it charges nobody.
 *
 * ═══ THE RULE WITH A STATUTE BEHIND IT ═══════════════════════════════════════════════
 *
 * CASH IS NEVER GATED ON A VERDICT (§0, §7A.6 item 2). Grep this file for
 * `effortVerificationStatus` and you will find it in exactly one place:
 * {@link buildVerificationNotes}, whose return value reaches `verificationNote` and
 * nothing else. It takes no amount as an argument and returns no number, so it
 * STRUCTURALLY cannot change one.
 *
 * The minutes query below filters on `contributionKind` and on the window. It does NOT
 * filter on a verdict, and it must never learn how. Conditioning earned wages on an
 * algorithm passing is unlawful withholding under the FLSA and state timely-payment law
 * in the US, under national wage statutes across the EU, and under §18 of India's Code on
 * Wages 2019, whose list of permitted deductions is exhaustive and does not include "the
 * AI found no commit". §9 withholds SLICES — that is what its dispute window is for. It
 * does not withhold wages, and a flagged claim changes only the `equity_delta` line.
 *
 * ═══ THE THREE OTHER INVARIANTS ══════════════════════════════════════════════════════
 *
 *  1. THE DRAFT IS IDEMPOTENT. {@link draftPeriodLines} upserts on
 *     `(periodId, memberId, kind)` and re-running it produces byte-identical rows. §17
 *     step 5b runs it 100 times with rows shuffled and asserts exactly that — which is
 *     also why every `ORDER BY` here ends in a unique column and every division goes
 *     through src/lib/money.ts.
 *  2. FINALIZE FREEZES, AND THE FREEZE IS HASHED. One transaction, one
 *     `project_chain_head` lock: recompute, freeze, hash, advance the statement head,
 *     append ONE audit entry. `qatoto_compensation_period_freeze` then makes it stick
 *     against a psql prompt, because a record the application merely declines to edit is
 *     not evidence.
 *  3. CORRECTIONS SUPERSEDE; THEY NEVER EDIT. There is no `PATCH` on a period or a line
 *     anywhere in this domain, and {@link supersedePeriod} is the only way a wrong number
 *     is put right.
 */

/** Bumping this changes future statement hashes without invalidating history (§4c). */
export const STATEMENT_HASH_ALGORITHM_VERSION = "sha256-jcs-v1";

/** The typed phrase `POST …/compensation-periods/:id/finalize` requires. */
export const FINALIZE_ACKNOWLEDGEMENT = "FINALIZE";

export type CompensationPeriodStatus = (typeof compensationPeriod.$inferSelect)["status"];
export type CompensationPeriodLineKind = (typeof compensationPeriodLine.$inferSelect)["kind"];

export type CompensationPeriodError =
  | ProjectAccessError
  | { type: "PERIOD_NOT_FOUND"; periodId: string }
  | { type: "LINE_NOT_FOUND"; lineId: string }
  | { type: "PERIOD_NOT_READY"; periodEndDate: string }
  | { type: "PERIOD_ALREADY_FINALIZED" }
  | { type: "PERIOD_NOT_FINALIZED"; status: CompensationPeriodStatus }
  | { type: "PERIOD_ALREADY_COUNTERSIGNED" }
  | { type: "PERIOD_ALREADY_SUPERSEDED" }
  | { type: "RATE_NOT_LOCKED"; memberUserIds: readonly string[] }
  | { type: "SELF_COUNTERSIGN_FORBIDDEN" }
  | { type: "COUNTERSIGNER_NOT_AUTHORIZED" }
  | { type: "ACKNOWLEDGEMENT_MISMATCH"; expected: string }
  | {
      type: "STATEMENT_CHAIN_BROKEN";
      sequenceNumber: number;
      reason: "hash-mismatch" | "link-mismatch" | "sequence-gap";
    };

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Reading a period
// ---------------------------------------------------------------------------

export interface CompensationPeriodLineView {
  readonly id: string;
  readonly kind: CompensationPeriodLineKind;
  readonly memberId: string;
  readonly memberUserId: string;
  readonly memberName: string;
  /** Decimal STRING, never a JS number: a bigint past 2^53 loses precision (§4b). */
  readonly grossAmountInCents: string | null;
  readonly currency: string | null;
  readonly effortMinutes: number | null;
  readonly sourceAgreementId: string | null;
  readonly sourceRateId: string | null;
  readonly equityBasisPointsAtStart: number | null;
  readonly equityBasisPointsAtEnd: number | null;
  /** SIGNED. A member's share falls when others out-contribute them (§7A.3). */
  readonly equityBasisPointsDelta: number | null;
  /**
   * The ONLY place a verdict touches a cash line, and it changes no number (§0). Clients
   * render it as an annotation beside the amount, never as a reason the amount is lower.
   */
  readonly verificationNote: string | null;
}

export interface CompensationPeriodView {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly periodStartDate: string;
  readonly periodEndDate: string;
  readonly timeZone: string;
  readonly status: CompensationPeriodStatus;
  /**
   * Returned on an OPEN period so no client can imply a frozen number. NULL means the
   * nightly draft has not run yet, which is different from "everyone is owed zero".
   */
  readonly lastDraftedAt: Date | null;
  readonly finalizedAt: Date | null;
  readonly finalizedByUserId: string | null;
  readonly countersignedAt: Date | null;
  readonly countersignedByUserId: string | null;
  /** Full 64 hex chars, always. The short form a UI shows is a rendering (§4c). */
  readonly statementHash: string | null;
  readonly previousStatementHash: string | null;
  readonly hashVersion: string | null;
  readonly supersededByPeriodId: string | null;
  /**
   * Qatoto computes GROSS and no withholding. Carried in-band on every statement read so
   * no client can present it as a payslip (§7A.6 item 3).
   */
  readonly grossOnlyNotice: string;
  readonly lines: readonly CompensationPeriodLineView[];
}

/**
 * The notice §7A.6 item 3 requires to travel WITH the numbers rather than live in a
 * frontend string table where one client can drop it.
 */
export const GROSS_ONLY_NOTICE =
  "Gross amounts only. No tax, withholding or social contribution has been computed. " +
  "Qatoto is not a payroll processor and this is not payroll or tax advice.";

type PeriodRow = typeof compensationPeriod.$inferSelect;

function toBounds(period: PeriodRow): PeriodBounds {
  return {
    periodStartDate: period.periodStartDate,
    periodEndDate: period.periodEndDate,
    timeZone: period.timeZone,
  };
}

function toPeriodView(
  period: PeriodRow,
  lines: readonly CompensationPeriodLineView[],
): CompensationPeriodView {
  return {
    id: period.id,
    sequenceNumber: period.sequenceNumber,
    periodStartDate: period.periodStartDate,
    periodEndDate: period.periodEndDate,
    timeZone: period.timeZone,
    status: period.status,
    lastDraftedAt: period.lastDraftedAt,
    finalizedAt: period.finalizedAt,
    finalizedByUserId: period.finalizedByUserId,
    countersignedAt: period.countersignedAt,
    countersignedByUserId: period.countersignedByUserId,
    statementHash: period.statementHash,
    previousStatementHash: period.previousStatementHash,
    hashVersion: period.hashVersion,
    supersededByPeriodId: period.supersededByPeriodId,
    grossOnlyNotice: GROSS_ONLY_NOTICE,
    lines,
  };
}

async function readLines(periodId: string): Promise<readonly CompensationPeriodLineView[]> {
  const rows = await db
    .select({
      line: compensationPeriodLine,
      memberUserId: projectMember.userId,
      memberName: user.name,
    })
    .from(compensationPeriodLine)
    .innerJoin(projectMember, eq(projectMember.id, compensationPeriodLine.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(eq(compensationPeriodLine.periodId, periodId))
    // THE CANONICAL ORDER, and it is not cosmetic: it is the order the statement hash is
    // computed over (§7A.5). Compared in BYTE order so the hash never depends on the
    // database's collation, exactly as §9.4 orders its apportionment input.
    .orderBy(sql`${projectMember.userId} COLLATE "C"`, asc(compensationPeriodLine.kind));

  return rows.map((row) => ({
    id: row.line.id,
    kind: row.line.kind,
    memberId: row.line.memberId,
    memberUserId: row.memberUserId,
    memberName: row.memberName,
    grossAmountInCents: row.line.grossAmountInCents?.toString() ?? null,
    currency: row.line.currency,
    effortMinutes: row.line.effortMinutes,
    sourceAgreementId: row.line.sourceAgreementId,
    sourceRateId: row.line.sourceRateId,
    equityBasisPointsAtStart: row.line.equityBasisPointsAtStart,
    equityBasisPointsAtEnd: row.line.equityBasisPointsAtEnd,
    equityBasisPointsDelta: row.line.equityBasisPointsDelta,
    verificationNote: row.line.verificationNote,
  }));
}

/** `GET …/compensation-periods/:periodId`. */
export async function getPeriod(
  projectId: string,
  periodId: string,
): Promise<Result<CompensationPeriodView, CompensationPeriodError>> {
  const [period] = await db
    .select()
    .from(compensationPeriod)
    // BOTH columns: a period id from another project must be indistinguishable from a
    // nonexistent one, or this becomes a cross-tenant probe.
    .where(and(eq(compensationPeriod.id, periodId), eq(compensationPeriod.projectId, projectId)));

  if (!period) {
    return { success: false, error: { type: "PERIOD_NOT_FOUND", periodId } };
  }
  return { success: true, value: toPeriodView(period, await readLines(periodId)) };
}

const DEFAULT_PERIOD_PAGE_SIZE = 24;
const MAXIMUM_PERIOD_PAGE_SIZE = 120;

/** `GET …/compensation-periods` — newest first, without the lines. */
export async function listPeriods(
  projectId: string,
  options: {
    readonly status?: CompensationPeriodStatus | undefined;
    readonly limit?: number | undefined;
    /** Keyset: return periods strictly BELOW this sequence number. */
    readonly beforeSequenceNumber?: number | undefined;
  } = {},
): Promise<readonly Omit<CompensationPeriodView, "lines">[]> {
  const limit = Math.min(options.limit ?? DEFAULT_PERIOD_PAGE_SIZE, MAXIMUM_PERIOD_PAGE_SIZE);

  const filters = [eq(compensationPeriod.projectId, projectId)];
  if (options.status !== undefined) {
    filters.push(eq(compensationPeriod.status, options.status));
  }
  if (options.beforeSequenceNumber !== undefined) {
    filters.push(lt(compensationPeriod.sequenceNumber, options.beforeSequenceNumber));
  }

  const rows = await db
    .select()
    .from(compensationPeriod)
    .where(and(...filters))
    // Keyset on `sequenceNumber`, which is unique per project — never on a date, because
    // two periods cannot share one but a cursor on a non-unique column skips rows (§4c
    // rule 4).
    .orderBy(desc(compensationPeriod.sequenceNumber))
    .limit(limit);

  return rows.map((period) => {
    const { lines: _discarded, ...withoutLines } = toPeriodView(period, []);
    return withoutLines;
  });
}

/**
 * Every period still open — usually one, occasionally two.
 *
 * TWO IS NORMAL, NOT A BUG. §7A.5's close job stops a period accruing without freezing it,
 * so a founder who has not finalized March yet accrues April beside it. Both are `open`;
 * only one of them is still growing.
 */
export async function listOpenPeriods(projectId: string): Promise<readonly PeriodRow[]> {
  return db
    .select()
    .from(compensationPeriod)
    .where(and(eq(compensationPeriod.projectId, projectId), eq(compensationPeriod.status, "open")))
    .orderBy(asc(compensationPeriod.sequenceNumber));
}

/** The project's newest period by sequence, whatever its status. */
async function findNewestPeriod(projectId: string): Promise<PeriodRow | null> {
  const [row] = await db
    .select()
    .from(compensationPeriod)
    .where(eq(compensationPeriod.projectId, projectId))
    .orderBy(desc(compensationPeriod.sequenceNumber))
    .limit(1);

  return row ?? null;
}

/** The open period whose window contains `asOf` — the one still accruing. */
export async function findAccruingPeriod(projectId: string, asOf: Date): Promise<PeriodRow | null> {
  const open = await listOpenPeriods(projectId);
  return open.find((period) => !hasPeriodClosed(toBounds(period), asOf)) ?? null;
}

// ---------------------------------------------------------------------------
// Opening a period
// ---------------------------------------------------------------------------

/**
 * Opens a period, allocating its sequence number under the chain-head lock (§7A.3).
 *
 * MUST run inside a transaction — the caller's, so opening the next period and closing the
 * last one are one atomic act. A project whose open period vanished between the two writes
 * would silently stop accruing.
 *
 * IDEMPOTENT AGAINST A CONCURRENT OPEN. The partial unique index permits exactly one open
 * period per project; a loser on that race gets its insert rejected and this returns the
 * period that won, because two callers both wanting "the open period to exist" is agreement
 * rather than conflict.
 */
export async function openPeriod(
  tx: DatabaseExecutor,
  projectId: string,
  bounds: PeriodBounds,
  actorUserId: string | null,
  actorRoleSnapshot: string,
  occurredAt: Date,
): Promise<PeriodRow> {
  // CHECKED BEFORE THE SEQUENCE IS ALLOCATED, and that ordering is the whole reason this
  // read exists rather than a bare insert with conflict recovery: a burned sequence number
  // is a GAP, and §7A.3 says the sequence is gapless. The verifier counts.
  const [alreadyOpen] = await tx
    .select()
    .from(compensationPeriod)
    .where(
      and(
        eq(compensationPeriod.projectId, projectId),
        eq(compensationPeriod.periodStartDate, bounds.periodStartDate),
        eq(compensationPeriod.status, "open"),
      ),
    );

  if (alreadyOpen) {
    return alreadyOpen;
  }

  const sequenceNumber = await allocateCompensationSequenceNumber(tx, projectId);

  let inserted: PeriodRow | undefined;
  try {
    // INSIDE A SAVEPOINT, and that is load-bearing rather than defensive. A failed
    // statement aborts the WHOLE transaction in Postgres — every later query returns
    // `25P02 current transaction is aborted` — so a bare try/catch here would swallow the
    // real error and then fail the recovery read with a message about the wrong thing.
    // Drizzle's nested `transaction` compiles to SAVEPOINT / ROLLBACK TO SAVEPOINT, which
    // leaves the outer transaction usable.
    await tx.transaction(async (savepoint) => {
      [inserted] = await savepoint
        .insert(compensationPeriod)
        .values({
          projectId,
          sequenceNumber,
          periodStartDate: bounds.periodStartDate,
          periodEndDate: bounds.periodEndDate,
          // Snapshotted at open so a later zone change cannot silently re-slice a month
          // somebody has already signed (§7A.3).
          timeZone: bounds.timeZone,
          status: "open",
        })
        .returning();
    });
  } catch (error: unknown) {
    // The read above races another transaction that had not committed when we looked, or
    // a period already holds this sequence number. Both wanted the period to exist, which
    // is agreement rather than conflict — but anything else is a real fault.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    inserted = undefined;
  }

  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(compensationPeriod)
      .where(
        and(
          eq(compensationPeriod.projectId, projectId),
          eq(compensationPeriod.periodStartDate, bounds.periodStartDate),
          eq(compensationPeriod.status, "open"),
        ),
      );
    if (!existing) {
      throw new Error(
        `openPeriod: project ${projectId} could not open ${bounds.periodStartDate} and has no ` +
          `existing open period for it — sequence ${sequenceNumber} is probably already taken, ` +
          "which means project_chain_head disagrees with compensation_period",
      );
    }
    return existing;
  }

  await appendAuditEntry(tx, {
    projectId,
    eventKind: "compensation_period_opened",
    actorUserId,
    actorRoleSnapshot,
    actionLabel: "Opened a compensation period",
    targetLabel: `period ${inserted.id}`,
    payload: {
      periodId: inserted.id,
      sequenceNumber: BigInt(sequenceNumber),
      periodStartDate: bounds.periodStartDate,
      periodEndDate: bounds.periodEndDate,
      timeZone: bounds.timeZone,
    },
    occurredAt,
  });

  return inserted;
}

/** A project cannot be more than this many months behind before someone should look. */
const MAXIMUM_PERIODS_OPENED_PER_RUN = 24;

/**
 * `close-compensation-period` — makes sure a period exists that covers `asOf`, walking
 * forward a month at a time from wherever the project currently is (§7A.5).
 *
 * NOTHING IS FROZEN HERE. The elapsed period keeps `status = 'open'` — it simply stops
 * growing, because a newer period now absorbs the effort. A founder has not looked at it
 * yet, and freezing a statement nobody has seen would make the finalize step ceremonial.
 *
 * WALKS RATHER THAN JUMPS, deliberately. A worker that was down for a quarter must produce
 * three periods, not one three-month period — the month boundaries are the product, and
 * skipping to `monthBoundsAt(asOf)` would silently merge two months of somebody's wages
 * into one statement. Bounded at {@link MAXIMUM_PERIODS_OPENED_PER_RUN} so a project with
 * a corrupt date cannot spin.
 *
 * Idempotent: the second run of the same tick finds the periods already there and opens
 * nothing.
 */
export async function ensurePeriodCovering(
  projectId: string,
  asOf: Date,
): Promise<{ readonly accruing: PeriodRow; readonly openedPeriodIds: readonly string[] }> {
  const newest = await findNewestPeriod(projectId);

  if (!newest) {
    const [stats] = await db
      .select({ projectTimeZone: projectStats.projectTimeZone })
      .from(projectStats)
      .where(eq(projectStats.projectId, projectId));

    const bounds = monthBoundsAt(asOf, stats?.projectTimeZone ?? "UTC");
    const opened = await db.transaction((tx) =>
      openPeriod(tx, projectId, bounds, null, "system", asOf),
    );
    return { accruing: opened, openedPeriodIds: [opened.id] };
  }

  const openedPeriodIds: string[] = [];
  let current = newest;
  let bounds = toBounds(current);

  for (let step = 0; step < MAXIMUM_PERIODS_OPENED_PER_RUN; step += 1) {
    if (!hasPeriodClosed(bounds, asOf)) {
      break;
    }
    bounds = nextMonthBounds(bounds);
    // eslint-disable-next-line no-await-in-loop -- each month depends on the last
    const opened = await db.transaction((tx) =>
      openPeriod(tx, projectId, bounds, null, "system", asOf),
    );
    if (opened.id !== current.id) {
      openedPeriodIds.push(opened.id);
    }
    current = opened;
    bounds = toBounds(current);
  }

  return { accruing: current, openedPeriodIds };
}

// ---------------------------------------------------------------------------
// Drafting the lines — the §7A.4 math
// ---------------------------------------------------------------------------

interface AccruingMember {
  readonly memberId: string;
  readonly memberUserId: string;
}

/**
 * Everyone who could be owed something for this period.
 *
 * INCLUDES DEPARTED MEMBERS whose stint overlapped the window. Someone who left on the
 * 20th is owed for the first twenty days, and a roster filtered to `active` would silently
 * drop them from the statement — which is not a rounding error, it is an unpaid wage.
 */
async function listAccruingMembers(
  projectId: string,
  window: { readonly startsAt: Date; readonly endsAt: Date },
): Promise<readonly AccruingMember[]> {
  const rows = await db
    .select({ memberId: projectMember.id, memberUserId: projectMember.userId })
    .from(projectMember)
    .where(
      and(
        eq(projectMember.projectId, projectId),
        // Joined before the window ended. Departure is handled by the agreement's own
        // effective dating and by the ledger window, both of which already stop accruing.
        lte(projectMember.joinedAt, window.endsAt),
      ),
    )
    // BYTE order on the user id — the canonical key the statement hash is ordered by.
    .orderBy(sql`${projectMember.userId} COLLATE "C"`);

  return rows;
}

/**
 * Verified minutes per member inside the window (§7A.4).
 *
 * ═══ READ THE `where` CLAUSE. THERE IS NO VERDICT FILTER, AND THERE MUST NEVER BE ═══
 *
 * `contributionKind = 'time'` and the window. That is all. A `flagged_for_review` claim
 * contributes exactly the same minutes as a `verified` one, because §0's first added rule
 * says a verdict may annotate a cash line and may never change its number.
 *
 * BOTH `entryKind` VALUES ARE INCLUDED. A reversal carries negative minutes, and it was
 * reversed for a reason the arithmetic must reflect. The sum is clamped at zero by the
 * caller: a period cannot owe negative wages, and an over-payment is corrected by
 * superseding the period rather than by a negative line.
 *
 * SQL SUMS RAW INTEGERS AND DOES NO DIVISION (§4c rule 1). Pricing happens in TypeScript.
 */
async function sumEffortMinutesByMember(
  projectId: string,
  window: { readonly startsAt: Date; readonly endsAt: Date },
): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .select({
      memberId: sliceLedgerEntry.memberId,
      minutes: sql<string>`COALESCE(SUM(${sliceLedgerEntry.effortMinutes}), 0)`,
    })
    .from(sliceLedgerEntry)
    .where(
      and(
        eq(sliceLedgerEntry.projectId, projectId),
        eq(sliceLedgerEntry.contributionKind, "time"),
        gte(sliceLedgerEntry.occurredAt, window.startsAt),
        lt(sliceLedgerEntry.occurredAt, window.endsAt),
      ),
    )
    .groupBy(sliceLedgerEntry.memberId);

  return new Map(rows.map((row) => [row.memberId, Number(row.minutes)]));
}

/**
 * The snapshot in force at an instant — the last one computed at or before it.
 *
 * Returns null when the project has no snapshot that old, which happens for a member's
 * first period and is correct rather than a special case: their share at the start was
 * zero because they had none.
 */
async function findSnapshotAt(
  projectId: string,
  at: Date,
): Promise<{ readonly snapshotId: string; readonly shares: ReadonlyMap<string, number> } | null> {
  const [snapshot] = await db
    .select({ id: equitySnapshot.id })
    .from(equitySnapshot)
    .where(and(eq(equitySnapshot.projectId, projectId), lte(equitySnapshot.asOf, at)))
    // The newest snapshot that had already been taken. Ends in a unique column so a
    // redraw a year later resolves the same row (§4c rule 4).
    .orderBy(desc(equitySnapshot.asOf), desc(equitySnapshot.id))
    .limit(1);

  if (!snapshot) {
    return null;
  }

  const shares = await db
    .select({
      memberId: equitySnapshotShare.memberId,
      equityBasisPoints: equitySnapshotShare.equityBasisPoints,
    })
    .from(equitySnapshotShare)
    .where(eq(equitySnapshotShare.snapshotId, snapshot.id));

  return {
    snapshotId: snapshot.id,
    shares: new Map(shares.map((share) => [share.memberId, share.equityBasisPoints])),
  };
}

/**
 * The annotation, and ONLY the annotation (§0).
 *
 * Takes no amount, returns no number, and its result is written to `verificationNote` and
 * to nothing else. A member whose claims were flagged sees WHY their equity line moved
 * less than they expected, on the same statement — which is the transparency §9 promises
 * — without any of it touching what they are paid.
 */
async function buildVerificationNotes(
  projectId: string,
  memberIds: readonly string[],
  bounds: PeriodBounds,
): Promise<ReadonlyMap<string, string>> {
  if (memberIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      memberId: effortClaim.memberId,
      verificationStatus: effortClaim.verificationStatus,
      claimCount: sql<string>`COUNT(*)`,
    })
    .from(effortClaim)
    .where(
      and(
        eq(effortClaim.projectId, projectId),
        inArray(effortClaim.memberId, memberIds),
        // `claimedForDate` is a CALENDAR DAY, not an instant, so it is compared against
        // the period's own day bounds rather than against the ledger's UTC window. The
        // two agree by construction: a claim for the 1st belongs to the month that starts
        // on the 1st, whatever hour that is in the project's zone.
        gte(effortClaim.claimedForDate, bounds.periodStartDate),
        lt(effortClaim.claimedForDate, bounds.periodEndDate),
      ),
    )
    .groupBy(effortClaim.memberId, effortClaim.verificationStatus);

  const withheldByMember = new Map<string, number>();
  for (const row of rows) {
    if (
      row.verificationStatus !== "flagged_for_review" &&
      row.verificationStatus !== "unverified"
    ) {
      continue;
    }
    withheldByMember.set(
      row.memberId,
      (withheldByMember.get(row.memberId) ?? 0) + Number(row.claimCount),
    );
  }

  const notes = new Map<string, string>();
  for (const [memberId, count] of withheldByMember) {
    notes.set(
      memberId,
      `${count} effort claim${count === 1 ? "" : "s"} in this period are flagged or unverified. ` +
        "This withholds equity slices only. It does not reduce, delay or affect any cash " +
        "amount on this statement.",
    );
  }
  return notes;
}

export interface DraftResult {
  readonly periodId: string;
  readonly lineCount: number;
  readonly asOf: Date;
}

/**
 * `recompute-compensation-draft` — redraws every line of an open period from scratch.
 *
 * IDEMPOTENT, AND THAT IS THE TEST RATHER THAN AN ASPIRATION (§17 step 5b): run it 100
 * times with input rows shuffled and the lines are byte-identical. Three things buy that:
 * every read orders on a unique column, every division goes through src/lib/money.ts, and
 * the writes are upserts keyed on `(periodId, memberId, kind)` rather than
 * delete-then-insert — which would churn ids and break any client holding one.
 *
 * A line that should no longer exist (a member with no agreement and no minutes) is
 * DELETED rather than zeroed. A zero is a claim that someone is owed nothing; an absent
 * line says the question does not arise.
 */
export async function draftPeriodLines(
  projectId: string,
  periodId: string,
  asOf: Date,
): Promise<Result<DraftResult, CompensationPeriodError>> {
  const [period] = await db
    .select()
    .from(compensationPeriod)
    .where(and(eq(compensationPeriod.id, periodId), eq(compensationPeriod.projectId, projectId)));

  if (!period) {
    return { success: false, error: { type: "PERIOD_NOT_FOUND", periodId } };
  }
  if (period.status !== "open") {
    return { success: false, error: { type: "PERIOD_ALREADY_FINALIZED" } };
  }

  const [project] = await db
    .select({ currency: researchProject.currency })
    .from(researchProject)
    .where(eq(researchProject.id, projectId));
  const currency = project?.currency ?? "USD";

  const bounds = toBounds(period);
  const window = periodWindow(bounds);
  const totalDays = daysInPeriod(bounds);

  const members = await listAccruingMembers(projectId, window);
  const minutesByMember = await sumEffortMinutesByMember(projectId, window);
  const startSnapshot = await findSnapshotAt(projectId, window.startsAt);
  const endSnapshot = await findSnapshotAt(projectId, window.endsAt);
  const notesByMember = await buildVerificationNotes(
    projectId,
    members.map((member) => member.memberId),
    bounds,
  );

  const desiredLines: (typeof compensationPeriodLine.$inferInsert)[] = [];

  for (const member of members) {
    const agreements = await listAgreementsOverlapping(
      member.memberId,
      window.startsAt,
      window.endsAt,
    );
    const verificationNote = notesByMember.get(member.memberId) ?? null;

    // --- cash_retainer. Summed across every agreement that covered part of the period,
    // --- so a mid-month raise pays part at the old amount and part at the new one.
    let retainerCents = 0n;
    let retainerAgreementId: string | null = null;
    for (const agreement of agreements) {
      if (agreement.monthlyAmountInCents === null) {
        continue;
      }
      const covered = coveredDaysInPeriod(bounds, {
        effectiveFrom: agreement.effectiveFrom,
        effectiveUntil: agreement.effectiveUntil,
      });
      if (covered <= 0) {
        continue;
      }
      retainerCents += proratedRetainerCents(agreement.monthlyAmountInCents, covered, totalDays);
      // The LAST covering agreement is the one cited: it is the one in force at the end of
      // the period, which is what a reader expects "the agreement behind this line" to
      // mean. The full history is one click away in `GET …/compensation-agreements`.
      retainerAgreementId = agreement.agreementId;
    }

    if (retainerAgreementId !== null) {
      desiredLines.push({
        periodId,
        projectId,
        memberId: member.memberId,
        kind: "cash_retainer",
        grossAmountInCents: retainerCents,
        currency,
        sourceAgreementId: retainerAgreementId,
        verificationNote,
      });
    }

    // --- cash_hourly. NO VERDICT REACHES THIS BLOCK. The minutes are clamped at zero
    // --- because a reversal-inclusive sum can go negative and a period cannot owe
    // --- negative wages (§7A.4).
    const hourlyAgreement = agreements.findLast(
      (agreement) => agreement.hourlyRateCentsPerHour !== null,
    );
    const rawMinutes = minutesByMember.get(member.memberId) ?? 0;
    const clampedMinutes = Math.max(rawMinutes, 0);

    if (hourlyAgreement?.hourlyRateCentsPerHour != null && clampedMinutes > 0) {
      desiredLines.push({
        periodId,
        projectId,
        memberId: member.memberId,
        kind: "cash_hourly",
        grossAmountInCents: hourlyGrossCents(
          clampedMinutes,
          hourlyAgreement.hourlyRateCentsPerHour,
        ),
        currency,
        effortMinutes: clampedMinutes,
        sourceAgreementId: hourlyAgreement.agreementId,
        verificationNote,
      });
    }

    // --- equity_delta. A subtraction and nothing more: §9.4 already guarantees each
    // --- snapshot's shares sum to exactly 10000, so no apportionment happens here.
    const atStart = startSnapshot?.shares.get(member.memberId) ?? 0;
    const atEnd = endSnapshot?.shares.get(member.memberId) ?? 0;
    if (startSnapshot !== null || endSnapshot !== null) {
      desiredLines.push({
        periodId,
        projectId,
        memberId: member.memberId,
        kind: "equity_delta",
        equityBasisPointsAtStart: atStart,
        equityBasisPointsAtEnd: atEnd,
        // SIGNED. A negative delta is the model working, not a bug (§7A.3).
        equityBasisPointsDelta: atEnd - atStart,
        startSnapshotId: startSnapshot?.snapshotId ?? null,
        endSnapshotId: endSnapshot?.snapshotId ?? null,
        verificationNote,
      });
    }
  }

  await db.transaction(async (tx) => {
    for (const line of desiredLines) {
      await tx
        .insert(compensationPeriodLine)
        .values(line)
        .onConflictDoUpdate({
          target: [
            compensationPeriodLine.periodId,
            compensationPeriodLine.memberId,
            compensationPeriodLine.kind,
          ],
          set: {
            grossAmountInCents: line.grossAmountInCents ?? null,
            currency: line.currency ?? null,
            effortMinutes: line.effortMinutes ?? null,
            sourceAgreementId: line.sourceAgreementId ?? null,
            sourceRateId: line.sourceRateId ?? null,
            equityBasisPointsAtStart: line.equityBasisPointsAtStart ?? null,
            equityBasisPointsAtEnd: line.equityBasisPointsAtEnd ?? null,
            equityBasisPointsDelta: line.equityBasisPointsDelta ?? null,
            startSnapshotId: line.startSnapshotId ?? null,
            endSnapshotId: line.endSnapshotId ?? null,
            verificationNote: line.verificationNote ?? null,
          },
        });
    }

    // Anything the redraw did not produce no longer belongs on the statement. Deleted
    // rather than zeroed — see the header.
    const survivingKeys = new Set(desiredLines.map((line) => `${line.memberId}:${line.kind}`));
    const existing = await tx
      .select({
        id: compensationPeriodLine.id,
        memberId: compensationPeriodLine.memberId,
        kind: compensationPeriodLine.kind,
      })
      .from(compensationPeriodLine)
      .where(eq(compensationPeriodLine.periodId, periodId));

    const orphanIds = existing
      .filter((row) => !survivingKeys.has(`${row.memberId}:${row.kind}`))
      .map((row) => row.id);

    if (orphanIds.length > 0) {
      await tx.delete(compensationPeriodLine).where(inArray(compensationPeriodLine.id, orphanIds));
    }

    await tx
      .update(compensationPeriod)
      .set({ lastDraftedAt: asOf })
      .where(eq(compensationPeriod.id, periodId));
  });

  return { success: true, value: { periodId, lineCount: desiredLines.length, asOf } };
}

// ---------------------------------------------------------------------------
// The statement hash
// ---------------------------------------------------------------------------

/**
 * The hashed document, in the FIXED DECLARED ORDER of §4c.
 *
 * The key ORDER in this literal is documentation — RFC 8785 sorts keys itself — but the
 * key SET is the contract. Adding a field silently changes every hash computed afterwards,
 * which is what `hashVersion` exists to make visible.
 *
 * DELIBERATELY EXCLUDED: `id` (a random UUID makes the chain unreproducible from
 * semantics), `createdAt` and `lastDraftedAt` (write time is not statement content), and
 * the countersignature (it happens AFTER the freeze, so hashing it would make every
 * finalized statement's hash change when a second person signs).
 *
 * LINES ARE SORTED BY `(memberUserId, kind)` IN BYTE ORDER before serialization, which is
 * what makes the hash independent of the order Postgres returned them in.
 */
function buildStatementDocument(fields: {
  readonly projectId: string;
  readonly sequenceNumber: number;
  readonly periodStartDate: string;
  readonly periodEndDate: string;
  readonly timeZone: string;
  readonly finalizedAt: Date;
  readonly finalizedByUserId: string;
  readonly previousStatementHash: string;
  readonly hashVersion: string;
  readonly lines: readonly CompensationPeriodLineView[];
}): CanonicalValue {
  return {
    projectId: fields.projectId,
    // `bigint`: canonicalize refuses plain numbers outright, because JCS's double
    // serialization is easy to get subtly wrong across platforms.
    sequenceNumber: BigInt(fields.sequenceNumber),
    periodStartDate: fields.periodStartDate,
    periodEndDate: fields.periodEndDate,
    timeZone: fields.timeZone,
    finalizedAt: fields.finalizedAt,
    finalizedByUserId: fields.finalizedByUserId,
    previousStatementHash: fields.previousStatementHash,
    hashVersion: fields.hashVersion,
    lines: fields.lines.map((line) => ({
      memberUserId: line.memberUserId,
      kind: line.kind,
      // '' and null are DIFFERENT DOCUMENTS and hash differently, so every optional field
      // is emitted explicitly as null rather than omitted.
      grossAmountInCents: line.grossAmountInCents === null ? null : BigInt(line.grossAmountInCents),
      currency: line.currency,
      effortMinutes: line.effortMinutes === null ? null : BigInt(line.effortMinutes),
      sourceAgreementId: line.sourceAgreementId,
      sourceRateId: line.sourceRateId,
      equityBasisPointsAtStart:
        line.equityBasisPointsAtStart === null ? null : BigInt(line.equityBasisPointsAtStart),
      equityBasisPointsAtEnd:
        line.equityBasisPointsAtEnd === null ? null : BigInt(line.equityBasisPointsAtEnd),
      equityBasisPointsDelta:
        line.equityBasisPointsDelta === null ? null : BigInt(line.equityBasisPointsDelta),
      verificationNote: line.verificationNote,
    })),
  };
}

function sortLinesCanonically(
  lines: readonly CompensationPeriodLineView[],
): readonly CompensationPeriodLineView[] {
  return lines.toSorted((left, right) => {
    if (left.memberUserId !== right.memberUserId) {
      return left.memberUserId < right.memberUserId ? -1 : 1;
    }
    if (left.kind === right.kind) return 0;
    return left.kind < right.kind ? -1 : 1;
  });
}

// ---------------------------------------------------------------------------
// Finalize, countersign, supersede
// ---------------------------------------------------------------------------

/**
 * Every member with a `cash_hourly` line whose §9 rate is not locked (§7A.5).
 *
 * `409 RATE_NOT_LOCKED` rather than a silent zero: an hourly line priced against an
 * unlocked rate is priced against a number the founder can still edit, and freezing that
 * into a hash-chained statement would give it an authority it has not earned.
 *
 * Note what this does NOT gate: a retainer line, or an equity line, or anything else. The
 * check is scoped to the one kind of line whose number depends on §9's rate.
 */
async function findMembersWithUnlockedRates(
  projectId: string,
  periodId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({
      memberId: compensationPeriodLine.memberId,
      memberUserId: projectMember.userId,
      lockedRateId: memberFairMarketRate.id,
    })
    .from(compensationPeriodLine)
    .innerJoin(projectMember, eq(projectMember.id, compensationPeriodLine.memberId))
    .leftJoin(
      memberFairMarketRate,
      and(
        eq(memberFairMarketRate.memberId, compensationPeriodLine.memberId),
        eq(memberFairMarketRate.status, "locked"),
      ),
    )
    .where(
      and(
        eq(compensationPeriodLine.periodId, periodId),
        eq(compensationPeriodLine.projectId, projectId),
        eq(compensationPeriodLine.kind, "cash_hourly"),
      ),
    )
    .orderBy(sql`${projectMember.userId} COLLATE "C"`);

  const unlocked = new Set<string>();
  const locked = new Set<string>();
  for (const row of rows) {
    if (row.lockedRateId === null) {
      unlocked.add(row.memberUserId);
    } else {
      locked.add(row.memberUserId);
    }
  }
  for (const userId of locked) {
    unlocked.delete(userId);
  }
  return [...unlocked];
}

/**
 * `POST …/compensation-periods/:periodId/finalize` — founder only, and irreversible.
 *
 * ONE TRANSACTION, ONE LOCK. Recompute synchronously one last time, freeze every line,
 * hash the canonical statement, advance the statement head, and append ONE
 * `project_audit_entry` — all under the `project_chain_head` lock the audit append already
 * takes. An audit trail that can lag the thing it records is worse than none: it produces
 * a record that looks complete and is not.
 *
 * The typed acknowledgement is required for the same reason `pie-bake` requires one: this
 * is the moment a computed number becomes the permanent record of what someone was owed,
 * and an accidental double-click must not be able to reach it.
 */
export async function finalizePeriod(
  context: { readonly projectId: string },
  periodId: string,
  acknowledgement: string,
  finalizedByUserId: string,
  actorRoleSnapshot: string,
  asOf: Date,
): Promise<Result<CompensationPeriodView, CompensationPeriodError>> {
  if (acknowledgement !== FINALIZE_ACKNOWLEDGEMENT) {
    return {
      success: false,
      error: { type: "ACKNOWLEDGEMENT_MISMATCH", expected: FINALIZE_ACKNOWLEDGEMENT },
    };
  }

  const [period] = await db
    .select()
    .from(compensationPeriod)
    .where(
      and(eq(compensationPeriod.id, periodId), eq(compensationPeriod.projectId, context.projectId)),
    );

  if (!period) {
    return { success: false, error: { type: "PERIOD_NOT_FOUND", periodId } };
  }
  if (period.status !== "open") {
    return { success: false, error: { type: "PERIOD_ALREADY_FINALIZED" } };
  }
  if (!hasPeriodClosed(toBounds(period), asOf)) {
    return {
      success: false,
      error: { type: "PERIOD_NOT_READY", periodEndDate: period.periodEndDate },
    };
  }

  // The last redraw before the freeze. Deliberately synchronous and deliberately here: a
  // founder must not be able to finalize a statement that is one nightly job stale.
  const redraw = await draftPeriodLines(context.projectId, periodId, asOf);
  if (!redraw.success) {
    return redraw;
  }

  const unlockedRateUserIds = await findMembersWithUnlockedRates(context.projectId, periodId);
  if (unlockedRateUserIds.length > 0) {
    return {
      success: false,
      error: { type: "RATE_NOT_LOCKED", memberUserIds: unlockedRateUserIds },
    };
  }

  const lines = sortLinesCanonically(await readLines(periodId));

  const frozen = await db.transaction(async (tx) => {
    const slot = await readStatementChainSlot(tx, context.projectId);
    const finalizedAt = asOf;

    const statementHash = canonicalHashHex(
      buildStatementDocument({
        projectId: context.projectId,
        sequenceNumber: period.sequenceNumber,
        periodStartDate: period.periodStartDate,
        periodEndDate: period.periodEndDate,
        timeZone: period.timeZone,
        finalizedAt,
        finalizedByUserId,
        previousStatementHash: slot.previousStatementHash,
        hashVersion: STATEMENT_HASH_ALGORITHM_VERSION,
        lines,
      }),
    );

    const [next] = await tx
      .update(compensationPeriod)
      .set({
        status: "finalized",
        finalizedAt,
        finalizedByUserId,
        statementHash,
        previousStatementHash: slot.previousStatementHash,
        hashVersion: STATEMENT_HASH_ALGORITHM_VERSION,
      })
      .where(
        // Re-asserted inside the transaction: a concurrent finalize would otherwise hit
        // the freeze trigger and surface as a 500 rather than a 409.
        and(eq(compensationPeriod.id, periodId), eq(compensationPeriod.status, "open")),
      )
      .returning();

    if (!next) {
      return null;
    }

    await advanceStatementChainHead(tx, context.projectId, { periodId, statementHash });

    // EVERY MEMBER WITH A LINE. This is the product's headline output — a statement of
    // exactly what a person is owed — and until now the only way to learn it existed was
    // to open the page and look (§11l.2). Distinct user ids, because a member with a cash
    // line and an equity line has two lines and one statement.
    await enqueueNotifications(
      tx,
      finalizedByUserId,
      [...new Set(lines.map((line) => line.memberUserId))].map((memberUserId) => ({
        recipientUserId: memberUserId,
        kind: "compensation_period_finalized" as const,
        projectId: context.projectId,
        // Ids and dates only. The AMOUNT is deliberately absent: it is on the statement,
        // behind membership, and a payload is a thing that ends up in logs and push
        // previews (§7A.6, §11h).
        payload: {
          periodId,
          periodStartDate: period.periodStartDate,
          periodEndDate: period.periodEndDate,
        },
      })),
    );

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "compensation_period_finalized",
      actorUserId: finalizedByUserId,
      actorRoleSnapshot,
      actionLabel: "Finalized a compensation statement",
      targetLabel: `period ${periodId}`,
      detailNote: `${lines.length} line${lines.length === 1 ? "" : "s"}, ${period.periodStartDate} to ${period.periodEndDate}`,
      payload: {
        periodId,
        sequenceNumber: BigInt(period.sequenceNumber),
        periodStartDate: period.periodStartDate,
        periodEndDate: period.periodEndDate,
        timeZone: period.timeZone,
        lineCount: BigInt(lines.length),
        statementHash,
        previousStatementHash: slot.previousStatementHash,
        hashVersion: STATEMENT_HASH_ALGORITHM_VERSION,
        acknowledgement,
      },
      occurredAt: finalizedAt,
    });

    // Once the month is frozen, the next one has to exist or the project silently stops
    // accruing. Same transaction: a project with no open period is a project losing data.
    const nextBounds = nextMonthBounds(toBounds(period));
    await openPeriod(tx, context.projectId, nextBounds, finalizedByUserId, actorRoleSnapshot, asOf);

    return next;
  });

  if (!frozen) {
    return { success: false, error: { type: "PERIOD_ALREADY_FINALIZED" } };
  }

  return { success: true, value: toPeriodView(frozen, await readLines(periodId)) };
}

/**
 * `POST …/compensation-periods/:periodId/countersign` — the SECOND pair of eyes (§7A.5).
 *
 * `422 SELF_COUNTERSIGN_FORBIDDEN` if it is the finalizer, EVEN FOR A FOUNDER. The column
 * CHECK says the same thing, but failing here names the rule instead of surfacing a
 * constraint violation as a 500.
 *
 * `403` if the caller holds `admin` with no recorded grantor — see
 * {@link resolveSecondSignatoryStanding}. Four eyes bought by a founder handing themselves
 * the second role is one pair of eyes with extra steps.
 */
export async function countersignPeriod(
  context: { readonly projectId: string },
  periodId: string,
  countersignedByUserId: string,
  actorRoleSnapshot: string,
  note: string | null,
): Promise<Result<CompensationPeriodView, CompensationPeriodError>> {
  const [period] = await db
    .select()
    .from(compensationPeriod)
    .where(
      and(eq(compensationPeriod.id, periodId), eq(compensationPeriod.projectId, context.projectId)),
    );

  if (!period) {
    return { success: false, error: { type: "PERIOD_NOT_FOUND", periodId } };
  }
  if (period.status === "open") {
    return { success: false, error: { type: "PERIOD_NOT_FINALIZED", status: period.status } };
  }
  if (period.countersignedAt !== null) {
    return { success: false, error: { type: "PERIOD_ALREADY_COUNTERSIGNED" } };
  }
  if (period.finalizedByUserId === countersignedByUserId) {
    return { success: false, error: { type: "SELF_COUNTERSIGN_FORBIDDEN" } };
  }

  const standing = await resolveSecondSignatoryStanding(context.projectId, countersignedByUserId);
  if (!standing.authorized) {
    return { success: false, error: { type: "COUNTERSIGNER_NOT_AUTHORIZED" } };
  }

  const signed = await db.transaction(async (tx) => {
    const countersignedAt = new Date();
    const [next] = await tx
      .update(compensationPeriod)
      .set({ countersignedAt, countersignedByUserId, countersignNote: note })
      .where(
        and(
          eq(compensationPeriod.id, periodId),
          // Re-asserted: a concurrent countersign would otherwise hit the once-only
          // trigger and surface as a 500.
          sql`${compensationPeriod.countersignedAt} IS NULL`,
        ),
      )
      .returning();

    if (!next) {
      return null;
    }

    // The finalizer, who is never the countersigner — `SELF_COUNTERSIGN_FORBIDDEN` is
    // checked above, so this fan-out cannot be a self-notification.
    if (period.finalizedByUserId !== null) {
      await enqueueNotifications(tx, countersignedByUserId, [
        {
          recipientUserId: period.finalizedByUserId,
          kind: "compensation_period_countersigned",
          projectId: context.projectId,
          payload: { periodId },
        },
      ]);
    }

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "compensation_period_countersigned",
      actorUserId: countersignedByUserId,
      actorRoleSnapshot,
      actionLabel: "Countersigned a compensation statement",
      targetLabel: `period ${periodId}`,
      detailNote: note ?? undefined,
      payload: {
        periodId,
        sequenceNumber: BigInt(period.sequenceNumber),
        statementHash: period.statementHash,
        countersignBasis: standing.basis,
        finalizedByUserId: period.finalizedByUserId,
      },
      occurredAt: countersignedAt,
    });

    return next;
  });

  if (!signed) {
    return { success: false, error: { type: "PERIOD_ALREADY_COUNTERSIGNED" } };
  }

  return { success: true, value: toPeriodView(signed, await readLines(periodId)) };
}

/**
 * `POST …/compensation-periods/:periodId/supersede` — the ONLY way a wrong number is
 * corrected (§7A.5, §4f).
 *
 * A finalized period whose numbers turn out wrong is NOT reopened. A new period is created
 * over the same window with `supersededByPeriodId` pointing back, the audit chain records
 * both, and the member can see exactly what changed and when. A record that can be quietly
 * rewritten is not evidence of anything.
 *
 * The successor opens as a normal `open` period, so the nightly draft redraws it from
 * whatever the corrected inputs now say — which is the point: superseding fixes the INPUTS
 * and lets the formula produce the number, rather than letting a human type one.
 */
export async function supersedePeriod(
  context: { readonly projectId: string },
  periodId: string,
  reasonNote: string,
  actorUserId: string,
  actorRoleSnapshot: string,
  asOf: Date,
): Promise<Result<CompensationPeriodView, CompensationPeriodError>> {
  const [period] = await db
    .select()
    .from(compensationPeriod)
    .where(
      and(eq(compensationPeriod.id, periodId), eq(compensationPeriod.projectId, context.projectId)),
    );

  if (!period) {
    return { success: false, error: { type: "PERIOD_NOT_FOUND", periodId } };
  }
  if (period.status === "open") {
    return { success: false, error: { type: "PERIOD_NOT_FINALIZED", status: period.status } };
  }
  if (period.status === "superseded") {
    return { success: false, error: { type: "PERIOD_ALREADY_SUPERSEDED" } };
  }

  // Read OUTSIDE the transaction, and only to address the notification: the superseded
  // period's lines are frozen, so nothing can change between this read and the write.
  const supersededLines = await readLines(periodId);

  const replacement = await db.transaction(async (tx) => {
    const successor = await openPeriod(
      tx,
      context.projectId,
      toBounds(period),
      actorUserId,
      actorRoleSnapshot,
      asOf,
    );

    const [marked] = await tx
      .update(compensationPeriod)
      .set({
        status: "superseded",
        supersededByPeriodId: successor.id,
        supersedeReasonNote: reasonNote,
      })
      .where(and(eq(compensationPeriod.id, periodId), eq(compensationPeriod.status, "finalized")))
      .returning();

    if (!marked) {
      return null;
    }

    // Everyone who had a line on the statement being corrected. A supersede rewrites what
    // a person was told they were owed, which is the one correction they must not learn
    // about by noticing the number changed (§4f — corrections supersede, never edit).
    await enqueueNotifications(
      tx,
      actorUserId,
      [...new Set(supersededLines.map((line) => line.memberUserId))].map((memberUserId) => ({
        recipientUserId: memberUserId,
        kind: "compensation_period_superseded" as const,
        projectId: context.projectId,
        payload: { periodId, supersededByPeriodId: successor.id },
      })),
    );

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "compensation_period_superseded",
      actorUserId,
      actorRoleSnapshot,
      actionLabel: "Superseded a compensation statement",
      targetLabel: `period ${periodId}`,
      detailNote: reasonNote,
      payload: {
        periodId,
        supersededByPeriodId: successor.id,
        sequenceNumber: BigInt(period.sequenceNumber),
        successorSequenceNumber: BigInt(successor.sequenceNumber),
        statementHash: period.statementHash,
        reasonNote,
      },
      occurredAt: asOf,
    });

    return successor;
  });

  if (!replacement) {
    return { success: false, error: { type: "PERIOD_ALREADY_SUPERSEDED" } };
  }

  return { success: true, value: toPeriodView(replacement, await readLines(replacement.id)) };
}

// ---------------------------------------------------------------------------
// Verifying the chain
// ---------------------------------------------------------------------------

export interface StatementChainSummary {
  readonly periodsChecked: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly headStatementHash: string | null;
}

/**
 * `GET …/compensation-periods/:periodId/verify` — re-walks the statement chain.
 *
 * THREE CHECKS PER PERIOD, and the third is the one that is easy to omit and impossible to
 * do without: the hash recomputes from its own columns, the link matches its predecessor,
 * and the finalized sequence has no gap. A DELETED row leaves every surviving hash
 * self-consistent, so a chain missing its middle verifies perfectly unless someone counts.
 *
 * A break is a `Result` failure the controller renders as **409 STATEMENT_CHAIN_BROKEN**,
 * never `200 {valid:false}` — the same rule §9's audit verifier follows, for the same
 * reason: a verification endpoint that answers "no" with a success status will be polled
 * by a dashboard that renders a green tick for a 200.
 *
 * THE HONEST PART. Without external anchoring of the head hash under a separate
 * credential, anyone with database write access can recompute the chain from any point
 * forward and every check here still passes. A hash chain is tamper-evident AGAINST
 * OUTSIDERS ONLY, and `project_chain_head.lastAnchoredHash` is where that anchor lands.
 */
export async function verifyStatementChain(
  projectId: string,
): Promise<Result<StatementChainSummary, CompensationPeriodError>> {
  const periods = await db
    .select()
    .from(compensationPeriod)
    .where(eq(compensationPeriod.projectId, projectId))
    .orderBy(asc(compensationPeriod.sequenceNumber));

  const finalized = periods.filter((period) => period.statementHash !== null);

  let expectedPreviousHash = STATEMENT_GENESIS_PREVIOUS_HASH;
  let previousSequence: number | null = null;

  for (const period of finalized) {
    // Finalized periods must run consecutively in sequence order. A gap means a finalized
    // statement was removed, which no surviving hash can reveal on its own.
    if (previousSequence !== null && period.sequenceNumber <= previousSequence) {
      return {
        success: false,
        error: {
          type: "STATEMENT_CHAIN_BROKEN",
          sequenceNumber: period.sequenceNumber,
          reason: "sequence-gap",
        },
      };
    }

    if (period.previousStatementHash !== expectedPreviousHash) {
      return {
        success: false,
        error: {
          type: "STATEMENT_CHAIN_BROKEN",
          sequenceNumber: period.sequenceNumber,
          reason: "link-mismatch",
        },
      };
    }

    if (period.finalizedAt === null || period.finalizedByUserId === null) {
      return {
        success: false,
        error: {
          type: "STATEMENT_CHAIN_BROKEN",
          sequenceNumber: period.sequenceNumber,
          reason: "hash-mismatch",
        },
      };
    }

    const recomputed = canonicalHashHex(
      buildStatementDocument({
        projectId: period.projectId,
        sequenceNumber: period.sequenceNumber,
        periodStartDate: period.periodStartDate,
        periodEndDate: period.periodEndDate,
        timeZone: period.timeZone,
        finalizedAt: period.finalizedAt,
        finalizedByUserId: period.finalizedByUserId,
        previousStatementHash: period.previousStatementHash ?? STATEMENT_GENESIS_PREVIOUS_HASH,
        hashVersion: period.hashVersion ?? STATEMENT_HASH_ALGORITHM_VERSION,
        lines: sortLinesCanonically(await readLines(period.id)),
      }),
    );

    if (recomputed !== period.statementHash) {
      return {
        success: false,
        error: {
          type: "STATEMENT_CHAIN_BROKEN",
          sequenceNumber: period.sequenceNumber,
          reason: "hash-mismatch",
        },
      };
    }

    expectedPreviousHash = period.statementHash;
    previousSequence = period.sequenceNumber;
  }

  const firstFinalized = finalized[0];
  const lastFinalized = finalized.at(-1);

  return {
    success: true,
    value: {
      periodsChecked: finalized.length,
      firstSequence: firstFinalized?.sequenceNumber ?? null,
      lastSequence: lastFinalized?.sequenceNumber ?? null,
      headStatementHash: lastFinalized?.statementHash ?? null,
    },
  };
}

/**
 * RFC 4180 quoting. Every free-text field goes through it, including member names — a
 * name containing a comma is ordinary, and one containing a quote is not an attack but
 * would still corrupt the row.
 */
function escapeCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * `GET …/compensation-periods/:periodId/export` — the bytes a founder's payroll provider
 * consumes.
 *
 * GROSS ONLY, AND THE NOTICE TRAVELS WITH THE DATA (§7A.6 item 3). Qatoto computes no
 * withholding, no tax and no social contribution; a CSV that arrives without saying so is
 * one paste away from being treated as a payslip.
 *
 * Returned as a string rather than streamed: a month's statement for a team is tens of
 * rows, and a streaming export would buy nothing but a harder-to-test code path.
 */
export function buildPeriodExport(
  period: CompensationPeriodView,
  format: "csv" | "json",
): { readonly contentType: string; readonly body: string } {
  if (format === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      body: canonicalizeDocument({
        periodId: period.id,
        sequenceNumber: BigInt(period.sequenceNumber),
        periodStartDate: period.periodStartDate,
        periodEndDate: period.periodEndDate,
        timeZone: period.timeZone,
        status: period.status,
        statementHash: period.statementHash,
        notice: GROSS_ONLY_NOTICE,
        lines: period.lines.map((line) => ({
          memberUserId: line.memberUserId,
          memberName: line.memberName,
          kind: line.kind,
          grossAmountInCents:
            line.grossAmountInCents === null ? null : BigInt(line.grossAmountInCents),
          currency: line.currency,
          effortMinutes: line.effortMinutes === null ? null : BigInt(line.effortMinutes),
          equityBasisPointsDelta:
            line.equityBasisPointsDelta === null ? null : BigInt(line.equityBasisPointsDelta),
          verificationNote: line.verificationNote,
        })),
      }),
    };
  }

  const header = [
    "member_user_id",
    "member_name",
    "line_kind",
    "gross_amount_in_cents",
    "currency",
    "effort_minutes",
    "equity_basis_points_delta",
    "verification_note",
  ].join(",");

  const rows = period.lines.map((line) =>
    [
      escapeCsv(line.memberUserId),
      escapeCsv(line.memberName),
      escapeCsv(line.kind),
      line.grossAmountInCents ?? "",
      line.currency ?? "",
      line.effortMinutes ?? "",
      line.equityBasisPointsDelta ?? "",
      escapeCsv(line.verificationNote ?? ""),
    ].join(","),
  );

  return {
    contentType: "text/csv; charset=utf-8",
    // The notice is a leading comment row rather than a trailing one: a spreadsheet import
    // that drops the last line is common, and one that drops the first is not.
    body: [`# ${GROSS_ONLY_NOTICE}`, header, ...rows].join("\n"),
  };
}
