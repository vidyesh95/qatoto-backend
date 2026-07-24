import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  escrowAccount,
  escrowJournalEntry,
  escrowPosting,
  projectChainHead,
} from "#src/db/schema.js";
import {
  canonicalHashHex,
  canonicalizeDocument,
  type CanonicalValue,
} from "#src/lib/canonical-hash.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";
import {
  advanceEscrowChainHead,
  allocateEscrowChainSlot,
  appendAuditEntry,
  ESCROW_GENESIS_PREVIOUS_HASH,
  type ProjectAuditEventKind,
} from "#src/services/project-audit.service.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * THE ESCROW LEDGER (R_AND_D_BACKEND_STRUCTURE.md §7).
 *
 * THIS FILE IS THE ONLY WRITER OF `escrow_journal_entry` AND `escrow_posting`, and the
 * only verb it uses is `insert`. There is no `db.update`/`db.delete` against either table
 * anywhere in this codebase — that is §7's enforcement 3, and enforcements 1, 2 and 4
 * (revoked grants, triggers, the chain) sit underneath it precisely because this one is
 * only as good as the next person to edit the file.
 *
 * If you are about to add a function here that UPDATEs a journal entry, stop. Corrections
 * are REVERSING ENTRIES. A settlement that flips a column in place destroys the one record
 * an auditor needs — what the books said before someone changed them.
 *
 * FOUR INVARIANTS:
 *
 *  1. EVERY ENTRY SUMS TO ZERO. Asserted here before the insert, by a deferred constraint
 *     trigger at commit, and again by the nightly reconciliation job. §7 calls this "a
 *     machine-checkable proof that no money was conjured", and a proof only the
 *     application performs is not that.
 *  2. GAPLESS SEQUENCE, allocated under the `project_chain_head` lock — the same lock the
 *     audit trail and the slice ledger take, so a writer touching all three holds one.
 *  3. HASH CHAINED, full 64 hex characters, over RFC 8785 canonical bytes, with the child
 *     postings sorted by a documented unique key before serialization (§4c).
 *  4. THE POOL NEVER GOES NEGATIVE. Not a column constraint — `provider_clearing` is the
 *     outside world and is negative by construction — but a gate the release path checks
 *     against a FRESHLY DERIVED sum rather than the cached column.
 *
 * ---------------------------------------------------------------------------
 * THE TWO BALANCES, and the rule that decides which one a posting lands in.
 *
 *   settled bucket  = postings whose entry settlement is `settled`
 *   pending bucket  = postings whose entry settlement is `pending` OR `failed`
 *
 * `failed` sits with `pending` because a failure entry MIRRORS a pending authorization —
 * it exists to cancel one. Filing it anywhere else leaves the in-flight figure permanently
 * overstated by every pledge that ever declined, which is a number no one would notice was
 * wrong.
 * ---------------------------------------------------------------------------
 */

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type EscrowAccountKind = (typeof escrowAccount.$inferSelect)["kind"];
export type EscrowJournalKind = (typeof escrowJournalEntry.$inferSelect)["kind"];
export type EscrowEntrySettlement = (typeof escrowJournalEntry.$inferSelect)["settlement"];

/** Bumping this changes future hashes without invalidating history (§4c). */
export const ESCROW_HASH_VERSION = 1;

/**
 * The six accounts of §7, in a FIXED ORDER so provisioning is deterministic and two
 * concurrent first-writes cannot deadlock by inserting them in opposite orders.
 */
export const ESCROW_ACCOUNT_KINDS: readonly EscrowAccountKind[] = [
  "escrow_held",
  "platform_fee",
  "provider_clearing",
  "reconciliation_suspense",
  "refunds_payable",
  "released_to_project",
];

/** Settlements whose postings count toward the IN-FLIGHT figure. See the header. */
const PENDING_SETTLEMENTS: readonly EscrowEntrySettlement[] = ["pending", "failed"];

export type EscrowError =
  | ProjectAccessError
  | { type: "ESCROW_ENTRY_NOT_FOUND"; entryId: string }
  | {
      type: "ESCROW_CHAIN_BROKEN";
      sequenceNumber: number;
      reason: "hash-mismatch" | "link-mismatch" | "sequence-gap" | "unbalanced-entry";
    };

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Creates the project's six accounts if they do not exist, and returns them by kind.
 *
 * `ON CONFLICT DO NOTHING` then re-select, rather than an upsert with `RETURNING`: two
 * transactions racing a project's first pledge must BOTH end up with the full set, and the
 * loser of an upsert race gets nothing back from `RETURNING`.
 */
export async function ensureEscrowAccounts(
  tx: DatabaseExecutor,
  projectId: string,
  currency: string,
): Promise<ReadonlyMap<EscrowAccountKind, string>> {
  await tx
    .insert(escrowAccount)
    .values(ESCROW_ACCOUNT_KINDS.map((kind) => ({ projectId, kind, currency })))
    .onConflictDoNothing();

  const rows = await tx
    .select({ id: escrowAccount.id, kind: escrowAccount.kind })
    .from(escrowAccount)
    .where(eq(escrowAccount.projectId, projectId));

  const byKind = new Map<EscrowAccountKind, string>(rows.map((row) => [row.kind, row.id]));

  for (const kind of ESCROW_ACCOUNT_KINDS) {
    if (!byKind.has(kind)) {
      throw new Error(`ensureEscrowAccounts: account ${kind} missing for project ${projectId}`);
    }
  }
  return byKind;
}

// ---------------------------------------------------------------------------
// The hash document
// ---------------------------------------------------------------------------

interface HashablePosting {
  readonly accountKind: string;
  readonly signedAmountInCents: bigint;
  readonly postingIndex: number;
}

/**
 * The hashed document, in the FIXED DECLARED ORDER §7 owns for this table.
 *
 * The key ORDER in this literal is documentation — RFC 8785 sorts keys itself — but the
 * key SET is the contract. Adding a field silently changes every hash computed afterwards,
 * which is what `hashVersion` exists to make visible.
 *
 * Deliberately EXCLUDED: `id` (a random UUID makes the chain unreproducible from
 * semantics) and `createdAt` (write time is not event time). `linkedPledgeId` and friends
 * ARE included, because which pledge an entry settles is part of what the entry MEANS —
 * unlike §9's audit chain, where the back-references are circular.
 *
 * POSTINGS ARE SORTED BY `(accountKind, postingIndex)` BEFORE SERIALIZATION (§4c). Two
 * servers must produce identical bytes, and "the order Postgres returned them in" is not a
 * property either one controls.
 */
function buildEscrowHashDocument(fields: {
  readonly projectId: string;
  readonly sequenceNumber: number;
  readonly kind: string;
  readonly description: string;
  readonly currency: string;
  readonly settlement: string;
  readonly occurredAt: Date;
  readonly linkedMilestoneId: string | null;
  readonly linkedPledgeId: string | null;
  readonly linkedReleaseId: string | null;
  readonly reversesJournalEntryId: string | null;
  readonly postings: readonly HashablePosting[];
  readonly previousEntryHash: string;
  readonly hashVersion: number;
}): CanonicalValue {
  const sortedPostings = fields.postings.toSorted((left, right) => {
    if (left.accountKind !== right.accountKind) {
      return compareUtf8Bytes(left.accountKind, right.accountKind);
    }
    return left.postingIndex - right.postingIndex;
  });

  return {
    projectId: fields.projectId,
    // `bigint`: canonicalize refuses plain numbers outright, because JCS's double
    // serialization is easy to get subtly wrong across platforms.
    sequenceNumber: BigInt(fields.sequenceNumber),
    kind: fields.kind,
    description: fields.description,
    currency: fields.currency,
    settlement: fields.settlement,
    occurredAt: fields.occurredAt,
    linkedMilestoneId: fields.linkedMilestoneId,
    linkedPledgeId: fields.linkedPledgeId,
    linkedReleaseId: fields.linkedReleaseId,
    reversesJournalEntryId: fields.reversesJournalEntryId,
    postings: sortedPostings.map((posting) => ({
      accountKind: posting.accountKind,
      signedAmountInCents: posting.signedAmountInCents,
      postingIndex: BigInt(posting.postingIndex),
    })),
    previousEntryHash: fields.previousEntryHash,
    hashVersion: BigInt(fields.hashVersion),
  };
}

// ---------------------------------------------------------------------------
// Appending
// ---------------------------------------------------------------------------

export interface EscrowPostingInput {
  readonly accountKind: EscrowAccountKind;
  /** Positive INTO the account, negative OUT. The set must sum to zero. */
  readonly signedAmountInCents: bigint;
}

export interface AppendJournalEntryInput {
  readonly projectId: string;
  readonly currency: string;
  readonly kind: EscrowJournalKind;
  /** SERVER-COMPOSED prose. The one deliberate display string in this domain (§7). */
  readonly description: string;
  readonly settlement: EscrowEntrySettlement;
  /** The BUSINESS EVENT time, which may lag the write. */
  readonly occurredAt: Date;
  readonly postings: readonly EscrowPostingInput[];
  readonly linkedMilestoneId?: string | null | undefined;
  readonly linkedPledgeId?: string | null | undefined;
  readonly linkedReleaseId?: string | null | undefined;
  readonly reversesJournalEntryId?: string | null | undefined;
  /** NULL for system/adapter-authored entries — most of them. */
  readonly createdByUserId: string | null;
  // --- The §9 audit entry appended in the SAME transaction (§9.9).
  readonly auditEventKind: ProjectAuditEventKind;
  readonly actorRoleSnapshot: string;
  readonly auditActionLabel: string;
  readonly auditTargetLabel: string;
  readonly auditDetailNote?: string | undefined;
}

export interface JournalEntryRecord {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly entryHash: string;
  readonly previousEntryHash: string;
}

/**
 * Appends one balanced entry, its postings, its balance movements and its audit record —
 * in ONE transaction the caller supplies.
 *
 * The caller supplies the transaction because a ledger write never happens alone: it is
 * always the settlement of a pledge or the approval of a release, whose row changes in the
 * same commit. An audit trail that can lag the ledger is worse than none (§9.9), and so is
 * a release marked `approved` whose journal entry rolled back.
 *
 * @throws if the postings do not sum to zero, if there are fewer than two of them, or if
 *         the insert fails — all unrecoverable programmer errors, never a `Result`. There
 *         is no domain outcome in which "the money half-moved" is something a caller
 *         should handle and continue past (CLAUDE.md §3.3).
 */
export async function appendJournalEntry(
  tx: DatabaseExecutor,
  input: AppendJournalEntryInput,
): Promise<JournalEntryRecord> {
  // INVARIANT 1, asserted before anything is written. The deferred trigger catches this
  // too, but at COMMIT — by which point the stack trace names the transaction, not the
  // caller that composed the bad entry.
  if (input.postings.length < 2) {
    throw new Error(
      `appendJournalEntry: double entry needs at least 2 postings, got ${input.postings.length}`,
    );
  }
  const postingTotal = input.postings.reduce(
    (runningTotal, posting) => runningTotal + posting.signedAmountInCents,
    0n,
  );
  if (postingTotal !== 0n) {
    throw new Error(
      `appendJournalEntry: postings sum to ${postingTotal} cents, not zero (${input.kind}, project ${input.projectId})`,
    );
  }
  for (const posting of input.postings) {
    if (posting.signedAmountInCents === 0n) {
      throw new Error(
        `appendJournalEntry: a zero-amount posting on ${posting.accountKind} moves nothing`,
      );
    }
  }

  const accountsByKind = await ensureEscrowAccounts(tx, input.projectId, input.currency);
  const slot = await allocateEscrowChainSlot(tx, input.projectId);

  const indexedPostings = input.postings.map((posting, postingIndex) => ({
    accountKind: posting.accountKind,
    signedAmountInCents: posting.signedAmountInCents,
    postingIndex,
  }));

  const linkedMilestoneId = input.linkedMilestoneId ?? null;
  const linkedPledgeId = input.linkedPledgeId ?? null;
  const linkedReleaseId = input.linkedReleaseId ?? null;
  const reversesJournalEntryId = input.reversesJournalEntryId ?? null;

  const entryHash = canonicalHashHex(
    buildEscrowHashDocument({
      projectId: input.projectId,
      sequenceNumber: slot.sequenceNumber,
      kind: input.kind,
      description: input.description,
      currency: input.currency,
      settlement: input.settlement,
      occurredAt: input.occurredAt,
      linkedMilestoneId,
      linkedPledgeId,
      linkedReleaseId,
      reversesJournalEntryId,
      postings: indexedPostings,
      previousEntryHash: slot.previousEntryHash,
      hashVersion: ESCROW_HASH_VERSION,
    }),
  );

  const [insertedEntry] = await tx
    .insert(escrowJournalEntry)
    .values({
      projectId: input.projectId,
      sequenceNumber: slot.sequenceNumber,
      kind: input.kind,
      description: input.description,
      currency: input.currency,
      occurredAt: input.occurredAt,
      settlement: input.settlement,
      linkedMilestoneId,
      linkedPledgeId,
      linkedReleaseId,
      reversesJournalEntryId,
      entryHash,
      previousEntryHash: slot.previousEntryHash,
      hashVersion: ESCROW_HASH_VERSION,
      createdByUserId: input.createdByUserId,
    })
    .returning({ id: escrowJournalEntry.id });

  if (!insertedEntry) {
    throw new Error("appendJournalEntry: insert returned no row");
  }

  await tx.insert(escrowPosting).values(
    indexedPostings.map((posting) => {
      const accountId = accountsByKind.get(posting.accountKind);
      if (accountId === undefined) {
        throw new Error(`appendJournalEntry: no ${posting.accountKind} account`);
      }
      return {
        journalEntryId: insertedEntry.id,
        projectId: input.projectId,
        accountId,
        accountKind: posting.accountKind,
        signedAmountInCents: posting.signedAmountInCents,
        postingIndex: posting.postingIndex,
      };
    }),
  );

  // The balance columns are CACHES, moved here in the same transaction as the postings
  // that justify them. Every read that GATES a release re-derives from the postings
  // instead (see `deriveAccountBalances`), so a cache that drifts costs a stale display
  // and never a wrong payout.
  const landsInPendingBucket = PENDING_SETTLEMENTS.includes(input.settlement);

  for (const posting of indexedPostings) {
    const movement = posting.signedAmountInCents;
    await tx
      .update(escrowAccount)
      .set({
        ...(landsInPendingBucket
          ? {
              pendingBalanceInCents: sql`${escrowAccount.pendingBalanceInCents} + ${movement}`,
            }
          : {
              cachedBalanceInCents: sql`${escrowAccount.cachedBalanceInCents} + ${movement}`,
            }),
        balanceThroughSequenceNumber: slot.sequenceNumber,
      })
      .where(
        and(
          eq(escrowAccount.projectId, input.projectId),
          eq(escrowAccount.kind, posting.accountKind),
        ),
      );
  }

  await advanceEscrowChainHead(tx, input.projectId, {
    sequenceNumber: slot.sequenceNumber,
    entryHash,
    entryId: insertedEntry.id,
  });

  await appendAuditEntry(tx, {
    projectId: input.projectId,
    eventKind: input.auditEventKind,
    actorUserId: input.createdByUserId,
    actorRoleSnapshot: input.actorRoleSnapshot,
    actionLabel: input.auditActionLabel,
    targetLabel: input.auditTargetLabel,
    ...(input.auditDetailNote === undefined ? {} : { detailNote: input.auditDetailNote }),
    payload: {
      escrowJournalEntryId: insertedEntry.id,
      escrowSequenceNumber: BigInt(slot.sequenceNumber),
      escrowEntryHash: entryHash,
      kind: input.kind,
      settlement: input.settlement,
      currency: input.currency,
      linkedPledgeId,
      linkedMilestoneId,
      linkedReleaseId,
      postings: indexedPostings.map((posting) => ({
        accountKind: posting.accountKind,
        signedAmountInCents: posting.signedAmountInCents,
      })),
    },
    occurredAt: input.occurredAt,
  });

  return {
    id: insertedEntry.id,
    sequenceNumber: slot.sequenceNumber,
    entryHash,
    previousEntryHash: slot.previousEntryHash,
  };
}

/**
 * Appends the exact mirror of an earlier entry — THE ONLY CORRECTION MECHANISM (§7).
 *
 * Not an UPDATE and not a DELETE: the original stays exactly as written and a second entry
 * carries the negated postings. An auditor reading the journal sees both the movement and
 * its cancellation, which is the whole point, and the pending bucket returns to where it
 * started without any column being rewritten.
 */
export async function appendReversingEntry(
  tx: DatabaseExecutor,
  input: {
    readonly projectId: string;
    readonly reversesJournalEntryId: string;
    readonly kind: EscrowJournalKind;
    readonly description: string;
    readonly settlement: EscrowEntrySettlement;
    readonly occurredAt: Date;
    readonly createdByUserId: string | null;
    readonly auditEventKind: ProjectAuditEventKind;
    readonly actorRoleSnapshot: string;
    readonly auditActionLabel: string;
    readonly auditTargetLabel: string;
    readonly auditDetailNote?: string | undefined;
  },
): Promise<JournalEntryRecord> {
  const [original] = await tx
    .select({
      id: escrowJournalEntry.id,
      currency: escrowJournalEntry.currency,
      linkedMilestoneId: escrowJournalEntry.linkedMilestoneId,
      linkedPledgeId: escrowJournalEntry.linkedPledgeId,
      linkedReleaseId: escrowJournalEntry.linkedReleaseId,
    })
    .from(escrowJournalEntry)
    .where(
      // BOTH columns: an entry id belonging to another project must be indistinguishable
      // from a nonexistent one, or this becomes a cross-tenant probe.
      and(
        eq(escrowJournalEntry.id, input.reversesJournalEntryId),
        eq(escrowJournalEntry.projectId, input.projectId),
      ),
    );

  if (!original) {
    throw new Error(
      `appendReversingEntry: entry ${input.reversesJournalEntryId} not found on project ${input.projectId}`,
    );
  }

  const originalPostings = await tx
    .select({
      accountKind: escrowPosting.accountKind,
      signedAmountInCents: escrowPosting.signedAmountInCents,
      postingIndex: escrowPosting.postingIndex,
    })
    .from(escrowPosting)
    .where(eq(escrowPosting.journalEntryId, original.id))
    .orderBy(asc(escrowPosting.postingIndex));

  return appendJournalEntry(tx, {
    projectId: input.projectId,
    currency: original.currency,
    kind: input.kind,
    description: input.description,
    settlement: input.settlement,
    occurredAt: input.occurredAt,
    postings: originalPostings.map((posting) => ({
      accountKind: posting.accountKind,
      signedAmountInCents: -posting.signedAmountInCents,
    })),
    linkedMilestoneId: original.linkedMilestoneId,
    linkedPledgeId: original.linkedPledgeId,
    linkedReleaseId: original.linkedReleaseId,
    reversesJournalEntryId: original.id,
    createdByUserId: input.createdByUserId,
    auditEventKind: input.auditEventKind,
    actorRoleSnapshot: input.actorRoleSnapshot,
    auditActionLabel: input.auditActionLabel,
    auditTargetLabel: input.auditTargetLabel,
    ...(input.auditDetailNote === undefined ? {} : { auditDetailNote: input.auditDetailNote }),
  });
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface AccountBalance {
  readonly kind: EscrowAccountKind;
  readonly settledInCents: bigint;
  readonly pendingInCents: bigint;
}

/**
 * Re-derives every balance from the postings themselves, ignoring the cached columns.
 *
 * THIS IS WHAT THE RELEASE GATE READS. A cached balance that is stale in the permissive
 * direction pays out money the project does not have, and no amount of "the cache is
 * updated in the same transaction" survives the first migration, backfill or reversal
 * someone writes by hand.
 *
 * SQL SUMS RAW INTEGERS AND DOES NO DIVISION (§4c rule 1).
 */
export async function deriveAccountBalances(
  projectId: string,
  executor: DatabaseExecutor | typeof db = db,
): Promise<ReadonlyMap<EscrowAccountKind, AccountBalance>> {
  const rows = await executor
    .select({
      kind: escrowPosting.accountKind,
      settled: sql<string>`COALESCE(SUM(${escrowPosting.signedAmountInCents})
        FILTER (WHERE ${escrowJournalEntry.settlement} = 'settled'), 0)`,
      pending: sql<string>`COALESCE(SUM(${escrowPosting.signedAmountInCents})
        FILTER (WHERE ${escrowJournalEntry.settlement} IN ('pending', 'failed')), 0)`,
    })
    .from(escrowPosting)
    .innerJoin(escrowJournalEntry, eq(escrowJournalEntry.id, escrowPosting.journalEntryId))
    .where(eq(escrowPosting.projectId, projectId))
    .groupBy(escrowPosting.accountKind);

  const byKind = new Map<EscrowAccountKind, AccountBalance>(
    ESCROW_ACCOUNT_KINDS.map((kind) => [kind, { kind, settledInCents: 0n, pendingInCents: 0n }]),
  );

  for (const row of rows) {
    byKind.set(row.kind, {
      kind: row.kind,
      // SUM over a bigint column returns a decimal STRING from node-postgres. Parsed here
      // rather than anywhere downstream, so no float ever sees it.
      settledInCents: BigInt(row.settled),
      pendingInCents: BigInt(row.pending),
    });
  }
  return byKind;
}

/** The settled `escrow_held` balance — the only number a release may be paid out of. */
export async function deriveAvailableEscrowInCents(
  projectId: string,
  executor: DatabaseExecutor | typeof db = db,
): Promise<bigint> {
  const balances = await deriveAccountBalances(projectId, executor);
  return balances.get("escrow_held")?.settledInCents ?? 0n;
}

export interface EscrowSummaryView {
  readonly currency: string | null;
  /** Everything ever settled into the pool — §7's "Allocated". */
  readonly allocatedInCents: string;
  /** Paid out against approved milestone releases — "Released". */
  readonly releasedInCents: string;
  /** Still in the pool — "Held". */
  readonly heldInCents: string;
  readonly platformFeeInCents: string;
  readonly refundsPayableInCents: string;
  /** Where provider and ledger are allowed to differ, in public (§7). */
  readonly reconciliationSuspenseInCents: string;
  /** Authorized but not settled. §7's "money in flight … is simply a balance". */
  readonly inFlightInCents: string;
  /**
   * TRUE when every posting ever written nets to zero across the six accounts. Returned
   * rather than merely asserted, because a client that renders "books balance" from a
   * server that never checked is theatre.
   */
  readonly booksBalance: boolean;
  readonly asOfSequenceNumber: number;
}

/**
 * `GET …/escrow/summary` — Allocated / Released / Held from ACCOUNT BALANCES, never from
 * client arithmetic (§7).
 *
 * "Allocated" is derived as held + released + fee rather than stored: it is the total that
 * ever entered the pool, and computing it from the two halves means it cannot disagree
 * with them.
 */
export async function getEscrowSummary(projectId: string): Promise<EscrowSummaryView> {
  const [balances, [accountRow]] = await Promise.all([
    deriveAccountBalances(projectId),
    db
      .select({
        currency: escrowAccount.currency,
        sequenceNumber: escrowAccount.balanceThroughSequenceNumber,
      })
      .from(escrowAccount)
      .where(and(eq(escrowAccount.projectId, projectId), eq(escrowAccount.kind, "escrow_held"))),
  ]);

  const held = balances.get("escrow_held")?.settledInCents ?? 0n;
  const released = balances.get("released_to_project")?.settledInCents ?? 0n;
  const platformFee = balances.get("platform_fee")?.settledInCents ?? 0n;
  const refunds = balances.get("refunds_payable")?.settledInCents ?? 0n;
  const suspense = balances.get("reconciliation_suspense")?.settledInCents ?? 0n;
  const clearing = balances.get("provider_clearing")?.settledInCents ?? 0n;
  const inFlight = balances.get("escrow_held")?.pendingInCents ?? 0n;

  return {
    currency: accountRow?.currency ?? null,
    allocatedInCents: (held + released + platformFee + refunds).toString(),
    releasedInCents: released.toString(),
    heldInCents: held.toString(),
    platformFeeInCents: platformFee.toString(),
    refundsPayableInCents: refunds.toString(),
    reconciliationSuspenseInCents: suspense.toString(),
    inFlightInCents: inFlight.toString(),
    // The zero-sum identity over the WHOLE project, which is the aggregate form of the
    // per-entry invariant. If this is ever false, every number above is suspect.
    booksBalance: held + released + platformFee + refunds + suspense + clearing === 0n,
    asOfSequenceNumber: accountRow?.sequenceNumber ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface EscrowLedgerEntryView {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly kind: EscrowJournalKind;
  readonly description: string;
  readonly currency: string;
  readonly settlement: EscrowEntrySettlement;
  /**
   * THE READ PROJECTION §7 promises. The mock's `EscrowLedgerEntry.direction` survives as
   * the SIGN OF THE POSTING AGAINST `escrow_held`, so the shipped frontend type does not
   * change shape — but nothing stores it, so nothing can forge it.
   *
   * NULL when the entry does not touch the pool at all (a pure suspense adjustment).
   */
  readonly direction: "in" | "out" | null;
  /** The magnitude of the `escrow_held` movement, as a decimal string. */
  readonly amountInCents: string;
  readonly occurredAt: Date;
  readonly linkedMilestoneId: string | null;
  readonly linkedPledgeId: string | null;
  readonly linkedReleaseId: string | null;
  readonly reversesJournalEntryId: string | null;
  /** Full 64 hex characters, always. The 6-character form the mocks show is a rendering. */
  readonly entryHash: string;
  readonly previousEntryHash: string;
  readonly hashVersion: number;
  readonly postings: readonly {
    readonly accountKind: EscrowAccountKind;
    readonly signedAmountInCents: string;
    readonly postingIndex: number;
  }[];
}

const DEFAULT_LEDGER_PAGE_SIZE = 50;
const MAXIMUM_LEDGER_PAGE_SIZE = 200;

/**
 * `GET …/escrow/ledger` — a page of the journal, ordered by `sequenceNumber` ASC, never by
 * `createdAt`: two rows share a millisecond and replica clocks skew.
 *
 * Returns EVERY hashed column plus the postings, so a client can canonicalize and verify
 * WITHOUT trusting this server's bytes (§9.9's anti-theatre rule, applied to §7's chain).
 */
export async function listEscrowLedger(
  projectId: string,
  options: { readonly page?: number | undefined; readonly limit?: number | undefined } = {},
): Promise<readonly EscrowLedgerEntryView[]> {
  const limit = Math.min(options.limit ?? DEFAULT_LEDGER_PAGE_SIZE, MAXIMUM_LEDGER_PAGE_SIZE);
  const page = Math.max(options.page ?? 1, 1);

  const entries = await db
    .select()
    .from(escrowJournalEntry)
    .where(eq(escrowJournalEntry.projectId, projectId))
    .orderBy(asc(escrowJournalEntry.sequenceNumber))
    .limit(limit)
    .offset((page - 1) * limit);

  if (entries.length === 0) {
    return [];
  }

  const postings = await db
    .select({
      journalEntryId: escrowPosting.journalEntryId,
      accountKind: escrowPosting.accountKind,
      signedAmountInCents: escrowPosting.signedAmountInCents,
      postingIndex: escrowPosting.postingIndex,
    })
    .from(escrowPosting)
    .where(
      inArray(
        escrowPosting.journalEntryId,
        entries.map((entry) => entry.id),
      ),
    )
    .orderBy(asc(escrowPosting.journalEntryId), asc(escrowPosting.postingIndex));

  return entries.map((entry) => {
    const entryPostings = postings.filter((posting) => posting.journalEntryId === entry.id);
    const poolMovement = entryPostings
      .filter((posting) => posting.accountKind === "escrow_held")
      .reduce((runningTotal, posting) => runningTotal + posting.signedAmountInCents, 0n);

    return {
      id: entry.id,
      sequenceNumber: entry.sequenceNumber,
      kind: entry.kind,
      description: entry.description,
      currency: entry.currency,
      settlement: entry.settlement,
      direction: poolMovement === 0n ? null : poolMovement > 0n ? "in" : "out",
      // Magnitude only — the sign is already carried by `direction`, and shipping it twice
      // invites a client to apply it twice.
      amountInCents: (poolMovement < 0n ? -poolMovement : poolMovement).toString(),
      occurredAt: entry.occurredAt,
      linkedMilestoneId: entry.linkedMilestoneId,
      linkedPledgeId: entry.linkedPledgeId,
      linkedReleaseId: entry.linkedReleaseId,
      reversesJournalEntryId: entry.reversesJournalEntryId,
      entryHash: entry.entryHash,
      previousEntryHash: entry.previousEntryHash,
      hashVersion: entry.hashVersion,
      postings: entryPostings.map((posting) => ({
        accountKind: posting.accountKind,
        // Every bigint crosses the wire as a decimal string: an amount past 2^53 loses
        // precision the moment JSON.stringify touches it (§4b).
        signedAmountInCents: posting.signedAmountInCents.toString(),
        postingIndex: posting.postingIndex,
      })),
    };
  });
}

export interface EscrowChainVerificationSummary {
  readonly entriesChecked: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly headEntryHash: string | null;
  /** The aggregate zero-sum identity, re-derived over every posting ever written. */
  readonly booksBalance: boolean;
}

/**
 * Re-walks the escrow chain and checks FOUR things per entry: the hash recomputes from its
 * own columns and postings, the link matches its predecessor, `sequenceNumber` has no gap,
 * and the postings still sum to zero.
 *
 * The gap check is the one that is easy to omit and impossible to do without: a DELETED row
 * leaves every surviving hash self-consistent, so a chain missing its middle verifies
 * perfectly unless someone counts.
 *
 * The zero-sum re-check is §7's own, and it is here rather than only in the nightly job
 * because a verification that says "the bytes are intact" while the money does not add up
 * answers a question nobody asked.
 *
 * A break is a `Result` failure the controller renders as **409 ESCROW_CHAIN_BROKEN**,
 * never `200 {valid:false}` — a broken ledger is an operational emergency and must page.
 */
export async function verifyEscrowChain(
  projectId: string,
): Promise<Result<EscrowChainVerificationSummary, EscrowError>> {
  const entries = await db
    .select()
    .from(escrowJournalEntry)
    .where(eq(escrowJournalEntry.projectId, projectId))
    .orderBy(asc(escrowJournalEntry.sequenceNumber));

  const allPostings = await db
    .select({
      journalEntryId: escrowPosting.journalEntryId,
      accountKind: escrowPosting.accountKind,
      signedAmountInCents: escrowPosting.signedAmountInCents,
      postingIndex: escrowPosting.postingIndex,
    })
    .from(escrowPosting)
    .where(eq(escrowPosting.projectId, projectId));

  const postingsByEntry = new Map<string, HashablePosting[]>();
  for (const posting of allPostings) {
    const bucket = postingsByEntry.get(posting.journalEntryId);
    if (bucket) {
      bucket.push(posting);
    } else {
      postingsByEntry.set(posting.journalEntryId, [posting]);
    }
  }

  let expectedSequence = 1;
  let expectedPreviousHash = ESCROW_GENESIS_PREVIOUS_HASH;
  let runningTotal = 0n;

  for (const entry of entries) {
    if (entry.sequenceNumber !== expectedSequence) {
      return {
        success: false,
        error: {
          type: "ESCROW_CHAIN_BROKEN",
          sequenceNumber: expectedSequence,
          reason: "sequence-gap",
        },
      };
    }

    if (entry.previousEntryHash !== expectedPreviousHash) {
      return {
        success: false,
        error: {
          type: "ESCROW_CHAIN_BROKEN",
          sequenceNumber: entry.sequenceNumber,
          reason: "link-mismatch",
        },
      };
    }

    const entryPostings = postingsByEntry.get(entry.id) ?? [];
    const entryTotal = entryPostings.reduce(
      (total, posting) => total + posting.signedAmountInCents,
      0n,
    );
    if (entryTotal !== 0n || entryPostings.length < 2) {
      return {
        success: false,
        error: {
          type: "ESCROW_CHAIN_BROKEN",
          sequenceNumber: entry.sequenceNumber,
          reason: "unbalanced-entry",
        },
      };
    }
    runningTotal += entryTotal;

    const recomputed = canonicalHashHex(
      buildEscrowHashDocument({
        projectId: entry.projectId,
        sequenceNumber: entry.sequenceNumber,
        kind: entry.kind,
        description: entry.description,
        currency: entry.currency,
        settlement: entry.settlement,
        occurredAt: entry.occurredAt,
        linkedMilestoneId: entry.linkedMilestoneId,
        linkedPledgeId: entry.linkedPledgeId,
        linkedReleaseId: entry.linkedReleaseId,
        reversesJournalEntryId: entry.reversesJournalEntryId,
        postings: entryPostings,
        previousEntryHash: entry.previousEntryHash,
        hashVersion: entry.hashVersion,
      }),
    );

    if (recomputed !== entry.entryHash) {
      return {
        success: false,
        error: {
          type: "ESCROW_CHAIN_BROKEN",
          sequenceNumber: entry.sequenceNumber,
          reason: "hash-mismatch",
        },
      };
    }

    expectedPreviousHash = entry.entryHash;
    expectedSequence += 1;
  }

  const [head] = await db
    .select()
    .from(projectChainHead)
    .where(eq(projectChainHead.projectId, projectId));

  // The head must agree with what was just walked. A head pointing at a hash no entry
  // carries means a row was removed from the END, where the per-entry checks above see
  // nothing wrong at all.
  const walkedHead = entries.length === 0 ? null : expectedPreviousHash;
  if ((head?.escrowHeadEntryHash ?? null) !== walkedHead) {
    return {
      success: false,
      error: {
        type: "ESCROW_CHAIN_BROKEN",
        sequenceNumber: Math.max(expectedSequence - 1, 0),
        reason: "link-mismatch",
      },
    };
  }

  const firstEntry = entries[0];
  const lastEntry = entries.at(-1);

  return {
    success: true,
    value: {
      entriesChecked: entries.length,
      firstSequence: firstEntry?.sequenceNumber ?? null,
      lastSequence: lastEntry?.sequenceNumber ?? null,
      headEntryHash: head?.escrowHeadEntryHash ?? null,
      booksBalance: runningTotal === 0n,
    },
  };
}

export interface EscrowHashInputView {
  readonly entryId: string;
  readonly sequenceNumber: number;
  /**
   * The exact RFC 8785 bytes that were hashed. Five lines of `crypto.subtle`,
   * `MessageDigest` or `CryptoKit` reproduce `entryHash` from this string — which is the
   * whole point, because a server that grades its own homework proves nothing.
   */
  readonly canonicalBytes: string;
  readonly entryHash: string;
  readonly hashVersion: number;
}

/** `GET …/escrow/ledger/:entryId/hash-input` — the anti-theatre endpoint. */
export async function buildEscrowHashInput(
  projectId: string,
  entryId: string,
): Promise<Result<EscrowHashInputView, EscrowError>> {
  const [entry] = await db
    .select()
    .from(escrowJournalEntry)
    .where(
      // BOTH columns: an entry id belonging to another project must be indistinguishable
      // from a nonexistent one, or this becomes a cross-tenant probe.
      and(eq(escrowJournalEntry.id, entryId), eq(escrowJournalEntry.projectId, projectId)),
    );

  if (!entry) {
    return { success: false, error: { type: "ESCROW_ENTRY_NOT_FOUND", entryId } };
  }

  const postings = await db
    .select({
      accountKind: escrowPosting.accountKind,
      signedAmountInCents: escrowPosting.signedAmountInCents,
      postingIndex: escrowPosting.postingIndex,
    })
    .from(escrowPosting)
    .where(eq(escrowPosting.journalEntryId, entry.id));

  return {
    success: true,
    value: {
      entryId: entry.id,
      sequenceNumber: entry.sequenceNumber,
      canonicalBytes: canonicalizeDocument(
        buildEscrowHashDocument({
          projectId: entry.projectId,
          sequenceNumber: entry.sequenceNumber,
          kind: entry.kind,
          description: entry.description,
          currency: entry.currency,
          settlement: entry.settlement,
          occurredAt: entry.occurredAt,
          linkedMilestoneId: entry.linkedMilestoneId,
          linkedPledgeId: entry.linkedPledgeId,
          linkedReleaseId: entry.linkedReleaseId,
          reversesJournalEntryId: entry.reversesJournalEntryId,
          postings,
          previousEntryHash: entry.previousEntryHash,
          hashVersion: entry.hashVersion,
        }),
      ),
      entryHash: entry.entryHash,
      hashVersion: entry.hashVersion,
    },
  };
}
