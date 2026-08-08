import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceJournalAccount,
  commerceJournalEntry,
  commerceJournalLine,
  commerceOrder,
} from "#src/db/schema.js";
import { canonicalHashHex, type CanonicalValue } from "#src/lib/canonical-hash.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";

/**
 * Commerce double-entry journal (STORE_BACKEND_STRUCTURE.md §4.9,
 * ESCROW_LEDGER_STRUCTURE.md retargeted at orders).
 *
 * THIS MODULE IS THE ONLY WRITER of `commerce_journal_entry` and `commerce_journal_line`.
 * The only verb is `insert`. Corrections are reversing entries — never UPDATE/DELETE.
 *
 * Invariants:
 *   1. Every entry has ≥ 2 lines that sum to exactly zero (asserted here + deferred trigger).
 *   2. Gapless sequence per order, allocated under a lock on the order's journal head.
 *   3. Hash-chained over RFC 8785 canonical bytes with a fixed key set.
 *   4. Separate namespace from project-funding escrow — never posts into those rows.
 */

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CommerceJournalAccountKind = (typeof commerceJournalAccount.$inferSelect)["kind"];
export type CommerceJournalKind = (typeof commerceJournalEntry.$inferSelect)["kind"];
export type CommerceJournalEntrySettlement =
  (typeof commerceJournalEntry.$inferSelect)["settlement"];

export const COMMERCE_JOURNAL_HASH_VERSION = 1;
export const COMMERCE_JOURNAL_GENESIS_PREVIOUS_HASH = "genesis";

/**
 * The pre-Phase-14 account set. Retained under its original name because it is exactly the
 * set the `internal_custody` rail permits, which is what every order created before Phase
 * 14 runs on.
 */
export const COMMERCE_JOURNAL_ACCOUNT_KINDS: readonly CommerceJournalAccountKind[] = [
  "buyer_clearing",
  "order_held",
  "seller_payable",
  "platform_fee",
  "refunds_payable",
  "reconciliation_suspense",
];

export type CommerceSettlementRail = (typeof commerceOrder.$inferSelect)["settlementRail"];

/**
 * Which accounts each settlement rail may hold (STORE Phase 14).
 *
 * THIS MIRRORS `commerce_settlement_rail_account_guard` IN MIGRATION 0087, deliberately. It
 * is not redundant: without it `ensureCommerceJournalAccounts` would try to create all six
 * legacy accounts for an escrow order and the trigger would reject the whole transaction
 * with a database error, which is a confusing way to learn that a rail forbids an account.
 * The map fails fast and legibly; the trigger remains the thing that cannot be bypassed.
 *
 *   - `order_held` means QATOTO holds funds, so it exists only on the frozen rail.
 *   - The four memo accounts record what a THIRD party holds, so they are absent from
 *     `internal_custody` and from `direct_offline`.
 *   - `settlement_custody_memo` is further absent from `direct_processor`, which settles
 *     buyer straight to seller: funding goes directly to released with no custody hop, and
 *     a custody balance there would be value nobody is holding.
 *   - `direct_offline` holds NO settlement account at all. Qatoto cannot observe a wire
 *     between two banks it has no relationship with, so it records commission and nothing
 *     else; the movement itself lives in `commerce_settlement_attestation`.
 *   - `seller_payable` appears only on the frozen rail and nothing posts it even there.
 */
const PLATFORM_FEE_ACCOUNT_KINDS: readonly CommerceJournalAccountKind[] = [
  "platform_fee_receivable",
  "platform_fee_earned",
  "platform_fee_cash",
];

export const COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL: Readonly<
  Record<CommerceSettlementRail, readonly CommerceJournalAccountKind[]>
> = {
  internal_custody: COMMERCE_JOURNAL_ACCOUNT_KINDS,
  direct_offline: [...PLATFORM_FEE_ACCOUNT_KINDS, "reconciliation_suspense"],
  direct_processor: [
    "settlement_funding_memo",
    "settlement_released_memo",
    "settlement_refunded_memo",
    ...PLATFORM_FEE_ACCOUNT_KINDS,
    "reconciliation_suspense",
  ],
  external_escrow: [
    "settlement_funding_memo",
    "settlement_custody_memo",
    "settlement_released_memo",
    "settlement_refunded_memo",
    ...PLATFORM_FEE_ACCOUNT_KINDS,
    "reconciliation_suspense",
  ],
};

/**
 * Off balance sheet: value a third party holds, never a Qatoto asset. Bound to the kind by
 * `commerce_journal_account_memorandum_ck` in both directions, so this function and the
 * constraint cannot disagree about a row.
 */
const MEMORANDUM_ACCOUNT_KINDS: ReadonlySet<CommerceJournalAccountKind> = new Set([
  "settlement_funding_memo",
  "settlement_custody_memo",
  "settlement_released_memo",
  "settlement_refunded_memo",
]);

export function isMemorandumAccountKind(kind: CommerceJournalAccountKind): boolean {
  return MEMORANDUM_ACCOUNT_KINDS.has(kind);
}

export interface CommerceJournalLineInput {
  readonly accountKind: CommerceJournalAccountKind;
  /** Positive INTO the account, negative OUT. The set must sum to zero. */
  readonly signedAmountInCents: bigint;
}

export interface AppendCommerceJournalEntryInput {
  readonly orderId: string;
  readonly currency: string;
  readonly kind: CommerceJournalKind;
  readonly description: string;
  readonly settlement: CommerceJournalEntrySettlement;
  readonly occurredAt: Date;
  readonly lines: readonly CommerceJournalLineInput[];
  readonly linkedPaymentIntentId?: string | null | undefined;
  readonly linkedRefundId?: string | null | undefined;
  readonly linkedTransferId?: string | null | undefined;
  readonly reversesJournalEntryId?: string | null | undefined;
  readonly createdByUserId: string | null;
}

export interface CommerceJournalEntryRecord {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly entryHash: string;
  readonly previousEntryHash: string;
}

interface HashableLine {
  readonly accountKind: string;
  readonly signedAmountInCents: bigint;
  readonly lineIndex: number;
}

/**
 * Creates the order's six accounts if they do not exist, and returns them by kind.
 */
export async function ensureCommerceJournalAccounts(
  tx: DatabaseExecutor,
  orderId: string,
  currency: string,
): Promise<ReadonlyMap<CommerceJournalAccountKind, string>> {
  /**
   * The rail decides which accounts may exist, so it is read first. Creating the legacy
   * six unconditionally — which is what this did before Phase 14 — now makes the rail
   * guard reject the whole transaction the moment an order settles any other way.
   */
  const [order] = await tx
    .select({ settlementRail: commerceOrder.settlementRail })
    .from(commerceOrder)
    .where(eq(commerceOrder.id, orderId))
    .limit(1);
  if (!order) {
    throw new Error(`ensureCommerceJournalAccounts: order ${orderId} does not exist`);
  }

  const permittedKinds = COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL[order.settlementRail];

  await tx
    .insert(commerceJournalAccount)
    .values(
      permittedKinds.map((kind) => ({
        orderId,
        kind,
        currency,
        isMemorandum: isMemorandumAccountKind(kind),
      })),
    )
    .onConflictDoNothing();

  const rows = await tx
    .select({ id: commerceJournalAccount.id, kind: commerceJournalAccount.kind })
    .from(commerceJournalAccount)
    .where(eq(commerceJournalAccount.orderId, orderId));

  const byKind = new Map<CommerceJournalAccountKind, string>(rows.map((row) => [row.kind, row.id]));

  for (const kind of permittedKinds) {
    if (!byKind.has(kind)) {
      throw new Error(
        `ensureCommerceJournalAccounts: account ${kind} missing for order ${orderId}`,
      );
    }
  }
  return byKind;
}

function buildCommerceJournalHashDocument(fields: {
  readonly orderId: string;
  readonly sequenceNumber: number;
  readonly kind: string;
  readonly description: string;
  readonly currency: string;
  readonly settlement: string;
  readonly occurredAt: Date;
  readonly linkedPaymentIntentId: string | null;
  readonly linkedRefundId: string | null;
  readonly linkedTransferId: string | null;
  readonly reversesJournalEntryId: string | null;
  readonly lines: readonly HashableLine[];
  readonly previousEntryHash: string;
  readonly hashVersion: number;
}): CanonicalValue {
  const sortedLines = fields.lines.toSorted((left, right) => {
    if (left.accountKind !== right.accountKind) {
      return compareUtf8Bytes(left.accountKind, right.accountKind);
    }
    return left.lineIndex - right.lineIndex;
  });

  return {
    orderId: fields.orderId,
    sequenceNumber: BigInt(fields.sequenceNumber),
    kind: fields.kind,
    description: fields.description,
    currency: fields.currency,
    settlement: fields.settlement,
    occurredAt: fields.occurredAt,
    linkedPaymentIntentId: fields.linkedPaymentIntentId,
    linkedRefundId: fields.linkedRefundId,
    linkedTransferId: fields.linkedTransferId,
    reversesJournalEntryId: fields.reversesJournalEntryId,
    lines: sortedLines.map((line) => ({
      accountKind: line.accountKind,
      signedAmountInCents: line.signedAmountInCents,
      lineIndex: BigInt(line.lineIndex),
    })),
    previousEntryHash: fields.previousEntryHash,
    hashVersion: BigInt(fields.hashVersion),
  };
}

async function allocateCommerceJournalSlot(
  tx: DatabaseExecutor,
  orderId: string,
): Promise<{ readonly sequenceNumber: number; readonly previousEntryHash: string }> {
  // Serialize appenders for this order by locking existing accounts (or creating them
  // under the caller's ensure step). Selecting the latest entry under FOR UPDATE on the
  // account set is not enough alone when no entry exists yet — the order row lock in the
  // payment service is the primary serialization point; this is the gapless sequence read.
  const [latest] = await tx
    .select({
      sequenceNumber: commerceJournalEntry.sequenceNumber,
      entryHash: commerceJournalEntry.entryHash,
    })
    .from(commerceJournalEntry)
    .where(eq(commerceJournalEntry.orderId, orderId))
    .orderBy(desc(commerceJournalEntry.sequenceNumber))
    .limit(1)
    .for("update");

  if (!latest) {
    return {
      sequenceNumber: 1,
      previousEntryHash: COMMERCE_JOURNAL_GENESIS_PREVIOUS_HASH,
    };
  }

  return {
    sequenceNumber: latest.sequenceNumber + 1,
    previousEntryHash: latest.entryHash,
  };
}

/**
 * Appends one balanced journal entry and its lines inside the caller's transaction.
 *
 * @throws on unbalanced lines or insert failure — programmer/invariant errors, not Result.
 */
export async function appendCommerceJournalEntry(
  tx: DatabaseExecutor,
  input: AppendCommerceJournalEntryInput,
): Promise<CommerceJournalEntryRecord> {
  if (input.lines.length < 2) {
    throw new Error(
      `appendCommerceJournalEntry: double entry needs at least 2 lines, got ${String(input.lines.length)}`,
    );
  }
  const lineTotal = input.lines.reduce(
    (runningTotal, line) => runningTotal + line.signedAmountInCents,
    0n,
  );
  if (lineTotal !== 0n) {
    throw new Error(
      `appendCommerceJournalEntry: lines sum to ${String(lineTotal)} cents, not zero (${input.kind}, order ${input.orderId})`,
    );
  }
  for (const line of input.lines) {
    if (line.signedAmountInCents === 0n) {
      throw new Error(
        `appendCommerceJournalEntry: a zero-amount line on ${line.accountKind} moves nothing`,
      );
    }
  }

  const accountsByKind = await ensureCommerceJournalAccounts(tx, input.orderId, input.currency);

  /**
   * A line naming an account the rail does not permit is caught here rather than by the
   * database trigger. Both refuse it; this one says which account and which order, where
   * the trigger can only report a constraint name from inside a rolled-back transaction.
   */
  for (const line of input.lines) {
    if (!accountsByKind.has(line.accountKind)) {
      throw new Error(
        `appendCommerceJournalEntry: account ${line.accountKind} is not permitted on order ${input.orderId}'s settlement rail`,
      );
    }
  }

  const slot = await allocateCommerceJournalSlot(tx, input.orderId);

  const indexedLines = input.lines.map((line, lineIndex) => ({
    accountKind: line.accountKind,
    signedAmountInCents: line.signedAmountInCents,
    lineIndex,
  }));

  const linkedPaymentIntentId = input.linkedPaymentIntentId ?? null;
  const linkedRefundId = input.linkedRefundId ?? null;
  const linkedTransferId = input.linkedTransferId ?? null;
  const reversesJournalEntryId = input.reversesJournalEntryId ?? null;

  const entryHash = canonicalHashHex(
    buildCommerceJournalHashDocument({
      orderId: input.orderId,
      sequenceNumber: slot.sequenceNumber,
      kind: input.kind,
      description: input.description,
      currency: input.currency,
      settlement: input.settlement,
      occurredAt: input.occurredAt,
      linkedPaymentIntentId,
      linkedRefundId,
      linkedTransferId,
      reversesJournalEntryId,
      lines: indexedLines,
      previousEntryHash: slot.previousEntryHash,
      hashVersion: COMMERCE_JOURNAL_HASH_VERSION,
    }),
  );

  const [insertedEntry] = await tx
    .insert(commerceJournalEntry)
    .values({
      orderId: input.orderId,
      sequenceNumber: slot.sequenceNumber,
      kind: input.kind,
      description: input.description,
      currency: input.currency,
      occurredAt: input.occurredAt,
      settlement: input.settlement,
      linkedPaymentIntentId,
      linkedRefundId,
      linkedTransferId,
      reversesJournalEntryId,
      entryHash,
      previousEntryHash: slot.previousEntryHash,
      hashVersion: COMMERCE_JOURNAL_HASH_VERSION,
      createdByUserId: input.createdByUserId,
    })
    .returning({
      id: commerceJournalEntry.id,
      sequenceNumber: commerceJournalEntry.sequenceNumber,
      entryHash: commerceJournalEntry.entryHash,
      previousEntryHash: commerceJournalEntry.previousEntryHash,
    });

  if (!insertedEntry) {
    throw new Error("appendCommerceJournalEntry: insert returned no row");
  }

  await tx.insert(commerceJournalLine).values(
    indexedLines.map((line) => {
      const accountId = accountsByKind.get(line.accountKind);
      if (!accountId) {
        throw new Error(
          `appendCommerceJournalEntry: missing account ${line.accountKind} for order ${input.orderId}`,
        );
      }
      return {
        journalEntryId: insertedEntry.id,
        orderId: input.orderId,
        accountId,
        accountKind: line.accountKind,
        signedAmountInCents: line.signedAmountInCents,
        lineIndex: line.lineIndex,
      };
    }),
  );

  return insertedEntry;
}

/**
 * Derives per-account balances for an order from settled and pending journal lines.
 * Used by reconciliation — never trust a cached balance column.
 */
export async function deriveCommerceJournalBalances(
  orderId: string,
): Promise<ReadonlyMap<CommerceJournalAccountKind, bigint>> {
  const rows = await db
    .select({
      accountKind: commerceJournalLine.accountKind,
      total: sql<string>`coalesce(sum(${commerceJournalLine.signedAmountInCents}), 0)`,
    })
    .from(commerceJournalLine)
    .innerJoin(
      commerceJournalEntry,
      and(
        eq(commerceJournalEntry.id, commerceJournalLine.journalEntryId),
        eq(commerceJournalEntry.orderId, orderId),
      ),
    )
    .where(eq(commerceJournalLine.orderId, orderId))
    .groupBy(commerceJournalLine.accountKind);

  const balances = new Map<CommerceJournalAccountKind, bigint>(
    COMMERCE_JOURNAL_ACCOUNT_KINDS.map((kind) => [kind, 0n]),
  );
  for (const row of rows) {
    balances.set(row.accountKind, BigInt(row.total));
  }
  return balances;
}
