import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceJournalAccount,
  commerceJournalEntry,
  commerceJournalLine,
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

export const COMMERCE_JOURNAL_ACCOUNT_KINDS: readonly CommerceJournalAccountKind[] = [
  "buyer_clearing",
  "order_held",
  "seller_payable",
  "platform_fee",
  "refunds_payable",
  "reconciliation_suspense",
];

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
  await tx
    .insert(commerceJournalAccount)
    .values(COMMERCE_JOURNAL_ACCOUNT_KINDS.map((kind) => ({ orderId, kind, currency })))
    .onConflictDoNothing();

  const rows = await tx
    .select({ id: commerceJournalAccount.id, kind: commerceJournalAccount.kind })
    .from(commerceJournalAccount)
    .where(eq(commerceJournalAccount.orderId, orderId));

  const byKind = new Map<CommerceJournalAccountKind, string>(rows.map((row) => [row.kind, row.id]));

  for (const kind of COMMERCE_JOURNAL_ACCOUNT_KINDS) {
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
