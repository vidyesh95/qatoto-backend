import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { projectMember, sliceLedgerEntry, user } from "#src/db/schema.js";
import {
  appendAuditEntry,
  allocateLedgerSequenceNumber,
} from "#src/modules/rnd/projects/project-audit.service.js";
import { computeSlicesAwarded } from "#src/modules/rnd/slice-math.js";
import type { Result } from "#src/types/index.js";

/**
 * THE LEDGER (R_AND_D_BACKEND_STRUCTURE.md §9.1 enforcement 1, §9.3).
 *
 * THIS FILE IS THE ONLY WRITER OF `slice_ledger_entry`, AND IT ONLY EVER WRITES
 * `computeSlicesAwarded` OUTPUT. Nothing in verification.service.ts may write here — that
 * is §9.1's first enforcement, and it is the reason the two files exist separately at all:
 * one produces JUDGEMENTS a human can override, the other produces NUMBERS nobody can
 * touch.
 *
 * If you are about to add a parameter to {@link writeLedgerEntry} that lets a caller pass
 * a slice count, stop. The formula takes minutes and a rate, or cents, and produces the
 * count itself. A caller-supplied number is the founder-fiat failure mode arriving through
 * a function signature.
 *
 * THREE INVARIANTS:
 *
 *  1. GAPLESS SEQUENCE, allocated under the `project_chain_head` lock, so the audit trail
 *     and the ledger advance together and a reader can prove nothing was removed.
 *  2. ONE ENTRY PER SETTLED PROPOSAL, enforced by a partial unique index — which is what
 *     makes re-running the expiry sweep a genuine no-op rather than a duplicate award.
 *  3. AN ENTRY IS WRITTEN EVEN AT ZERO (§9.3's anti-dust rule). A claim that rounds to
 *     nothing, a flagged verdict, a voided dispute — all three still post. Skipping them
 *     leaves a hole in `sequenceNumber` and breaks the audit story, which is worse than a
 *     row of zeroes.
 */

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The inputs the formula needs, as a discriminated union — never a bag of optional
 * numbers. A `time` contribution without a rate and a `cash` contribution with one are
 * both unrepresentable here, and the CHECK constraint says the same thing at the column
 * level (CLAUDE.md §3.2).
 */
export type LedgerContribution =
  | {
      readonly kind: "time";
      readonly effortMinutes: number;
      readonly unpaidRateCentsPerHour: bigint;
      readonly fairMarketRateId: string;
    }
  | { readonly kind: "cash"; readonly cashInCents: bigint };

export interface WriteLedgerEntryInput {
  readonly projectId: string;
  readonly memberId: string;
  readonly claimId: string | null;
  readonly proposalId: string | null;
  /**
   * The numerator the FORMULA produced, over SLICE_DENOMINATOR. Passed in rather than
   * recomputed because the proposal froze it at verdict time and settling must pay the
   * frozen number, not a number re-derived from rows that may have moved since (§9.8).
   */
  readonly sliceNumerator: bigint;
  readonly contribution: LedgerContribution;
  /** When the CONTRIBUTION is credited, not when this row is written. */
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorRoleSnapshot: string;
  readonly auditActionLabel: string;
  readonly auditDetailNote?: string | undefined;
}

export interface LedgerEntryRecord {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly slicesAwarded: number;
  readonly sliceNumerator: bigint;
}

/**
 * Appends one entry and its audit record, in ONE transaction the caller supplies.
 *
 * The caller supplies the transaction because a ledger write never happens alone: it is
 * always the settlement of a proposal, whose status flips in the same commit. An audit
 * trail that can lag the ledger is worse than none (§9.9), and so is a proposal that says
 * `locked` while the entry it points at rolled back.
 */
export async function writeLedgerEntry(
  tx: DatabaseExecutor,
  input: WriteLedgerEntryInput,
): Promise<LedgerEntryRecord> {
  // ROUNDED HERE AND NOWHERE ELSE (§9.3 rule 1). Everything downstream sums integers that
  // are already final.
  const slicesAwarded = computeSlicesAwarded(input.sliceNumerator);
  const sequenceNumber = await allocateLedgerSequenceNumber(tx, input.projectId);

  const [inserted] = await tx
    .insert(sliceLedgerEntry)
    .values({
      projectId: input.projectId,
      sequenceNumber,
      memberId: input.memberId,
      entryKind: "award",
      contributionKind: input.contribution.kind,
      claimId: input.claimId,
      proposalId: input.proposalId,
      sliceNumerator: input.sliceNumerator,
      slicesAwarded,
      ...(input.contribution.kind === "time"
        ? {
            fairMarketRateId: input.contribution.fairMarketRateId,
            unpaidRateCentsPerHour: input.contribution.unpaidRateCentsPerHour,
            effortMinutes: input.contribution.effortMinutes,
          }
        : { cashInCents: input.contribution.cashInCents }),
      occurredAt: input.occurredAt,
    })
    .returning({ id: sliceLedgerEntry.id });

  if (!inserted) {
    throw new Error("writeLedgerEntry: insert returned no row");
  }

  await appendAuditEntry(tx, {
    projectId: input.projectId,
    eventKind: "slices_awarded",
    actorUserId: input.actorUserId,
    actorRoleSnapshot: input.actorRoleSnapshot,
    actionLabel: input.auditActionLabel,
    targetLabel: `ledger entry ${sequenceNumber}`,
    ...(input.auditDetailNote === undefined ? {} : { detailNote: input.auditDetailNote }),
    payload: {
      ledgerEntryId: inserted.id,
      ledgerSequenceNumber: BigInt(sequenceNumber),
      memberId: input.memberId,
      claimId: input.claimId,
      proposalId: input.proposalId,
      contributionKind: input.contribution.kind,
      sliceNumerator: input.sliceNumerator,
      slicesAwarded: BigInt(slicesAwarded),
      ...(input.contribution.kind === "time"
        ? {
            effortMinutes: BigInt(input.contribution.effortMinutes),
            unpaidRateCentsPerHour: input.contribution.unpaidRateCentsPerHour,
          }
        : { cashInCents: input.contribution.cashInCents }),
    },
    occurredAt: input.occurredAt,
  });

  return {
    id: inserted.id,
    sequenceNumber,
    slicesAwarded,
    sliceNumerator: input.sliceNumerator,
  };
}

export type LedgerError = { type: "LEDGER_ENTRY_NOT_FOUND"; entryId: string };

/**
 * Appends a REVERSAL — the only correction mechanism this domain has (§9.1).
 *
 * Not an UPDATE, not a DELETE: the original entry stays exactly as written and a second
 * entry carries the negated numerator. An auditor reading the ledger sees both the mistake
 * and its correction, which is the whole point.
 */
export async function writeReversalEntry(
  tx: DatabaseExecutor,
  input: {
    readonly projectId: string;
    readonly reversalOfEntryId: string;
    readonly actorUserId: string | null;
    readonly actorRoleSnapshot: string;
    readonly reason: string;
    readonly occurredAt: Date;
  },
): Promise<Result<LedgerEntryRecord, LedgerError>> {
  const [original] = await tx
    .select()
    .from(sliceLedgerEntry)
    .where(
      and(
        eq(sliceLedgerEntry.id, input.reversalOfEntryId),
        eq(sliceLedgerEntry.projectId, input.projectId),
      ),
    );

  if (!original) {
    return {
      success: false,
      error: { type: "LEDGER_ENTRY_NOT_FOUND", entryId: input.reversalOfEntryId },
    };
  }

  const reversedNumerator = -original.sliceNumerator;
  const slicesAwarded = computeSlicesAwarded(reversedNumerator);
  const sequenceNumber = await allocateLedgerSequenceNumber(tx, input.projectId);

  const [inserted] = await tx
    .insert(sliceLedgerEntry)
    .values({
      projectId: input.projectId,
      sequenceNumber,
      memberId: original.memberId,
      entryKind: "reversal",
      contributionKind: original.contributionKind,
      claimId: original.claimId,
      // Deliberately NOT the original's proposalId: the partial unique index allows one
      // entry per proposal, and a reversal is a second entry about the same settlement.
      proposalId: null,
      sliceNumerator: reversedNumerator,
      slicesAwarded,
      fairMarketRateId: original.fairMarketRateId,
      unpaidRateCentsPerHour: original.unpaidRateCentsPerHour,
      // Negated too, so the reversal's own inputs read as the mirror of what it undoes
      // rather than as a second positive contribution.
      effortMinutes: original.effortMinutes === null ? null : -original.effortMinutes,
      cashInCents: original.cashInCents === null ? null : -original.cashInCents,
      reversalOfEntryId: original.id,
      occurredAt: input.occurredAt,
    })
    .returning({ id: sliceLedgerEntry.id });

  if (!inserted) {
    throw new Error("writeReversalEntry: insert returned no row");
  }

  await appendAuditEntry(tx, {
    projectId: input.projectId,
    eventKind: "slices_reversed",
    actorUserId: input.actorUserId,
    actorRoleSnapshot: input.actorRoleSnapshot,
    actionLabel: "Reversed a ledger entry",
    targetLabel: `ledger entry ${sequenceNumber}`,
    detailNote: input.reason,
    payload: {
      ledgerEntryId: inserted.id,
      ledgerSequenceNumber: BigInt(sequenceNumber),
      reversalOfEntryId: original.id,
      reversalOfSequenceNumber: BigInt(original.sequenceNumber),
      memberId: original.memberId,
      sliceNumerator: reversedNumerator,
      slicesAwarded: BigInt(slicesAwarded),
    },
    occurredAt: input.occurredAt,
  });

  return {
    success: true,
    value: { id: inserted.id, sequenceNumber, slicesAwarded, sliceNumerator: reversedNumerator },
  };
}

export interface MemberSliceTotal {
  readonly memberId: string;
  readonly memberUserId: string;
  readonly memberName: string;
  readonly slices: bigint;
}

/**
 * Per-member slice totals over a ledger PREFIX.
 *
 * `throughSequenceNumber` is what makes a snapshot reproducible: recomputing "as of
 * sequence 412" a year later reads the same rows even though hundreds have been appended
 * since. Without it, "run it 1,000 times and assert byte-identical output" is only true
 * when nothing else is happening.
 *
 * SQL SUMS RAW INTEGERS AND DOES NO DIVISION (§4c rule 1). Apportionment to basis points
 * happens in TypeScript, over these totals.
 */
export async function sumSlicesByMember(
  projectId: string,
  throughSequenceNumber: number,
): Promise<readonly MemberSliceTotal[]> {
  const rows = await db
    .select({
      memberId: sliceLedgerEntry.memberId,
      memberUserId: projectMember.userId,
      memberName: user.name,
      slices: sql<string>`SUM(${sliceLedgerEntry.slicesAwarded})`,
    })
    .from(sliceLedgerEntry)
    .innerJoin(projectMember, eq(projectMember.id, sliceLedgerEntry.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(
      and(
        eq(sliceLedgerEntry.projectId, projectId),
        sql`${sliceLedgerEntry.sequenceNumber} <= ${throughSequenceNumber}`,
      ),
    )
    .groupBy(sliceLedgerEntry.memberId, projectMember.userId, user.name)
    // Canonical ordering by the tie-break key itself, in BYTE order, so the apportionment
    // input never depends on the order Postgres happened to return groups in (§9.4).
    .orderBy(sql`${projectMember.userId} COLLATE "C"`);

  return rows.map((row) => ({
    memberId: row.memberId,
    memberUserId: row.memberUserId,
    memberName: row.memberName,
    // SUM over an integer column returns `bigint` as a string from node-postgres. Parsed
    // here rather than anywhere downstream, so no float ever sees it.
    slices: BigInt(row.slices),
  }));
}

/** The highest sequence number written for a project, or 0 when the ledger is empty. */
export async function findLatestLedgerSequenceNumber(projectId: string): Promise<number> {
  const [row] = await db
    .select({ sequenceNumber: sliceLedgerEntry.sequenceNumber })
    .from(sliceLedgerEntry)
    .where(eq(sliceLedgerEntry.projectId, projectId))
    .orderBy(desc(sliceLedgerEntry.sequenceNumber))
    .limit(1);

  return row?.sequenceNumber ?? 0;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly memberId: string;
  readonly memberName: string;
  readonly entryKind: (typeof sliceLedgerEntry.$inferSelect)["entryKind"];
  readonly contributionKind: (typeof sliceLedgerEntry.$inferSelect)["contributionKind"];
  readonly claimId: string | null;
  /** The exact rational, retained so an auditor can see where the half-slice went. */
  readonly sliceNumerator: string;
  readonly slicesAwarded: number;
  readonly effortMinutes: number | null;
  readonly cashInCents: string | null;
  readonly unpaidRateCentsPerHour: string | null;
  readonly occurredAt: Date;
}

const DEFAULT_LEDGER_PAGE_SIZE = 50;
const MAXIMUM_LEDGER_PAGE_SIZE = 200;

export interface LedgerPage {
  readonly rows: readonly LedgerEntryView[];
  /** The `fromSequence` to ask for next, or null at the end of the ledger. */
  readonly nextSequence: number | null;
}

/**
 * A page of the ledger, ordered by `sequenceNumber` ASC — never `createdAt`, because two
 * rows share a millisecond and replica clocks skew (§9.4).
 *
 * KEYSET BY `fromSequence`, WITH `page` KEPT (§11l.2 item 4). The sequence is gapless and
 * monotonic by construction, so it is a better cursor than any timestamp — and this is an
 * APPEND-ONLY table, which is precisely the shape where OFFSET drifts: an entry inserted
 * between two page fetches shifts every subsequent page by one and a reader silently skips
 * a row. On a slice ledger that row is somebody's equity.
 *
 * `page` still works, unchanged, because the frontend calls this read today and §11l is
 * additive by rule. When both are supplied `fromSequence` wins, because a caller sending a
 * cursor has decided which mode it is in.
 */
export async function listLedgerEntries(
  projectId: string,
  options: {
    readonly page?: number | undefined;
    readonly limit?: number | undefined;
    readonly fromSequence?: number | undefined;
  } = {},
): Promise<LedgerPage> {
  const limit = Math.min(options.limit ?? DEFAULT_LEDGER_PAGE_SIZE, MAXIMUM_LEDGER_PAGE_SIZE);
  const page = Math.max(options.page ?? 1, 1);
  const isKeyset = options.fromSequence !== undefined;

  const conditions = [eq(sliceLedgerEntry.projectId, projectId)];
  if (options.fromSequence !== undefined) {
    conditions.push(gte(sliceLedgerEntry.sequenceNumber, options.fromSequence));
  }

  const rows = await db
    .select({
      id: sliceLedgerEntry.id,
      sequenceNumber: sliceLedgerEntry.sequenceNumber,
      memberId: sliceLedgerEntry.memberId,
      memberName: user.name,
      entryKind: sliceLedgerEntry.entryKind,
      contributionKind: sliceLedgerEntry.contributionKind,
      claimId: sliceLedgerEntry.claimId,
      sliceNumerator: sliceLedgerEntry.sliceNumerator,
      slicesAwarded: sliceLedgerEntry.slicesAwarded,
      effortMinutes: sliceLedgerEntry.effortMinutes,
      cashInCents: sliceLedgerEntry.cashInCents,
      unpaidRateCentsPerHour: sliceLedgerEntry.unpaidRateCentsPerHour,
      occurredAt: sliceLedgerEntry.occurredAt,
    })
    .from(sliceLedgerEntry)
    .innerJoin(projectMember, eq(projectMember.id, sliceLedgerEntry.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(and(...conditions))
    .orderBy(asc(sliceLedgerEntry.sequenceNumber))
    // One extra row ALWAYS, purely to answer "is there another page?" without a COUNT — the
    // same probe the daily-log feed uses. Fetched in offset mode too, because a cursor a
    // caller cannot obtain is a cursor nobody can use: `hasMore` used to be gated on
    // `isKeyset`, so a first request — which by definition carries no `fromSequence` — got
    // `nextSequence: null` and could never bootstrap into keyset mode.
    .limit(limit + 1)
    .offset(isKeyset ? 0 : (page - 1) * limit);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows.at(-1);
  // NOT gated on `isKeyset` — this read has no `pagination` block in either mode, so
  // `nextSequence` is the only paging signal it has ever carried.
  const hasMore = rows.length > limit && lastRow !== undefined;

  return {
    rows: pageRows.map((row) => ({
      ...row,
      // Every bigint crosses the wire as a decimal string: a numerator past 2^53 loses
      // precision the moment JSON.stringify touches it (§4b).
      sliceNumerator: row.sliceNumerator.toString(),
      cashInCents: row.cashInCents === null ? null : row.cashInCents.toString(),
      unpaidRateCentsPerHour:
        row.unpaidRateCentsPerHour === null ? null : row.unpaidRateCentsPerHour.toString(),
    })),
    nextSequence: hasMore ? lastRow.sequenceNumber + 1 : null,
  };
}
