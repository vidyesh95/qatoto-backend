import { and, count, countDistinct, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceJournalEntry,
  commerceJournalLine,
  commerceOrder,
  commercePaymentIntent,
  commerceRefund,
  commerceSettlementAttestation,
} from "#src/db/schema.js";
import { countOfflineOrdersWithoutSellerAttestation } from "#src/modules/store/orders/commerce-settlement-attestation.service.js";
import type { Result } from "#src/types/index.js";

/**
 * What a seller has been paid — the read `/sales` shipped without.
 *
 * ## This adds nothing to the ledger. It reads what was already there.
 *
 * No table, column or constraint was created for this. The double-entry journal, the payment
 * intents and the refund rows have all existed since Phase 14; there was simply no route that
 * summed them, and `deriveCommerceJournalBalances` — the one function that could — had no
 * caller anywhere. The gap was a route.
 *
 * ## §14 permits this, and the distinction matters
 *
 * §14 decided a seller's revenue is publishable "only on explicit seller consent", and that
 * deferral is UNTOUCHED here. It governs publishing a seller's takings on their PUBLIC
 * storefront, where the reader is a stranger and possibly a competitor. This route is
 * self-scoped and authenticated: the organization comes from the actor, never from a query
 * parameter, and there is no path by which one seller reads another's. Consent protects a
 * seller from disclosure to others; it is not required to show them their own books.
 *
 * ## THREE KINDS OF FACT, AND THEY NEVER ADD UP TO ONE NUMBER
 *
 * There is deliberately no grand total in this response, and adding one later would be a
 * regression rather than a feature. `commerce_journal_account_memorandum_ck` exists, in the
 * schema author's own words, "so no future balance report can sum memo value and real money
 * into one number". The three tiers:
 *
 *   1. `observed.processorSettled` — a payment processor told us it moved the money. The
 *      strongest evidence in the system, and still only as good as the adapter reporting it.
 *   2. `observed.escrowReleased` — a licensed third party released a milestone. Recorded in
 *      MEMORANDUM accounts: value someone else holds, never a Qatoto asset.
 *   3. `selfReported.attestedReceived` — the seller said so. On the `direct_offline` rail that
 *      is all there will ever be, because two banks moved money between themselves and this
 *      platform was not a party to it.
 *
 * A client is free to render them together. It is not free to add them.
 *
 * ## Never "your balance with Qatoto"
 *
 * `seller_payable` is documented as NEVER POSTED: "Qatoto owes the seller money it is holding"
 * cannot be true under no-custody. Nothing here is a claim on Qatoto. Every figure answers
 * "what did somebody else release to you", and `commissionOwed` runs the OTHER way — it is what
 * the seller owes Qatoto, which is why it sits in its own member and is never netted off.
 *
 * ## What is absent, and why absence is not zero
 *
 * A currency with no money in it is ABSENT from its array rather than present as `0`. The two
 * are different answers — "nothing settled in EUR" versus "EUR settled to nothing" — and the
 * client renders a sentence for the first. `uncounted` exists for the same reason: offline
 * orders nobody has attested may well have been paid, and reporting them as zero revenue would
 * be a claim this platform has no basis for.
 *
 * ## No profit
 *
 * Nothing in this backend records what a seller PAID for anything — no cost of goods, no
 * expense, no purchase record. Margin is therefore not derivable and is not estimated here.
 */

type PaymentIntentState = (typeof commercePaymentIntent.$inferSelect)["state"];

/**
 * Money arrived, even where some of it later left again.
 *
 * `partially_refunded` and `refunded` belong here: the buyer's money DID settle to the seller,
 * and the refund is reported separately rather than by quietly shrinking this figure. Netting
 * them at source would make a fully refunded order indistinguishable from one that never
 * happened, which is exactly the distinction a seller is looking for.
 */
const SETTLED_PAYMENT_INTENT_STATES: readonly PaymentIntentState[] = [
  "settled",
  "partially_refunded",
  "refunded",
];

export type CommerceEarningsError = { type: "INVALID_WINDOW"; message: string };

export interface CommerceEarningsActorContext {
  readonly organizationId: string;
}

export interface EarningsWindowInput {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

/** One currency's worth of one kind of fact. Never merged across currencies. */
export interface CurrencyAmount {
  readonly currency: string;
  readonly amountInCents: number;
  readonly orderCount: number;
}

export interface CommerceEarningsProjection {
  readonly window: { readonly from: Date | null; readonly to: Date | null };
  readonly observed: {
    readonly processorSettled: readonly CurrencyAmount[];
    readonly processorRefunded: readonly CurrencyAmount[];
    readonly escrowReleased: readonly CurrencyAmount[];
    readonly escrowRefunded: readonly CurrencyAmount[];
  };
  readonly selfReported: {
    readonly attestedReceived: readonly CurrencyAmount[];
  };
  /** What this seller owes Qatoto in commission. Real money, and it runs the other way. */
  readonly commissionOwed: readonly CurrencyAmount[];
  readonly uncounted: {
    readonly offlineOrdersWithNoAttestation: number;
    readonly ordersAwaitingPayment: number;
  };
}

/**
 * `sum()` comes back as a numeric STRING from Postgres, and the journal's own amounts are
 * `bigint`. Parsing through `BigInt` and refusing above `Number.MAX_SAFE_INTEGER` means an
 * impossible total is an error rather than a quietly rounded figure — a ledger read that
 * silently loses precision is worse than one that fails.
 */
function toSafeCents(total: string | null, figureName: string): number {
  if (total === null) return 0;
  const exactCents = BigInt(total);
  if (
    exactCents > BigInt(Number.MAX_SAFE_INTEGER) ||
    exactCents < BigInt(-Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      `Commerce earnings: ${figureName} totals ${total} cents, beyond safe integer range.`,
    );
  }
  return Number(exactCents);
}

/** Sorted by currency so two identical windows answer byte-identically. */
function sortByCurrency(rows: CurrencyAmount[]): readonly CurrencyAmount[] {
  return rows.toSorted((left, right) => left.currency.localeCompare(right.currency));
}

/** Drops a currency whose total came to nothing — absence, not a zero row. See the header. */
function withoutEmptyTotals(rows: readonly CurrencyAmount[]): CurrencyAmount[] {
  return rows.filter((row) => row.amountInCents !== 0);
}

async function loadProcessorSettled(
  sellerOrganizationId: string,
  window: EarningsWindowInput,
): Promise<readonly CurrencyAmount[]> {
  const rows = await db
    .select({
      currency: commercePaymentIntent.currency,
      total: sql<string>`coalesce(sum(${commercePaymentIntent.amountInCents}), 0)`,
      orderCount: countDistinct(commercePaymentIntent.orderId),
    })
    .from(commercePaymentIntent)
    .where(
      and(
        eq(commercePaymentIntent.counterpartyOrganizationId, sellerOrganizationId),
        inArray(commercePaymentIntent.state, SETTLED_PAYMENT_INTENT_STATES),
        isNotNull(commercePaymentIntent.settledAt),
        window.from === undefined
          ? undefined
          : gte(commercePaymentIntent.settledAt, window.from),
        window.to === undefined ? undefined : lt(commercePaymentIntent.settledAt, window.to),
      ),
    )
    .groupBy(commercePaymentIntent.currency);

  return sortByCurrency(
    withoutEmptyTotals(
      rows.map((row) => ({
        currency: row.currency,
        amountInCents: toSafeCents(row.total, "processorSettled"),
        orderCount: row.orderCount,
      })),
    ),
  );
}

/**
 * Refunds against this seller's orders.
 *
 * The refund row carries only `buyer_organization_id`, so the seller side is reached by joining
 * the order — the same predicate `listRefunds` already authorizes with. `settled` only: a refund
 * that was requested and has not moved is not money that has left.
 */
async function loadProcessorRefunded(
  sellerOrganizationId: string,
  window: EarningsWindowInput,
): Promise<readonly CurrencyAmount[]> {
  const rows = await db
    .select({
      currency: commerceRefund.currency,
      total: sql<string>`coalesce(sum(${commerceRefund.amountInCents}), 0)`,
      orderCount: countDistinct(commerceRefund.orderId),
    })
    .from(commerceRefund)
    .innerJoin(commerceOrder, eq(commerceOrder.id, commerceRefund.orderId))
    .where(
      and(
        eq(commerceOrder.counterpartyOrganizationId, sellerOrganizationId),
        eq(commerceRefund.state, "settled"),
        isNotNull(commerceRefund.settledAt),
        window.from === undefined ? undefined : gte(commerceRefund.settledAt, window.from),
        window.to === undefined ? undefined : lt(commerceRefund.settledAt, window.to),
      ),
    )
    .groupBy(commerceRefund.currency);

  return sortByCurrency(
    withoutEmptyTotals(
      rows.map((row) => ({
        currency: row.currency,
        amountInCents: toSafeCents(row.total, "processorRefunded"),
        orderCount: row.orderCount,
      })),
    ),
  );
}

/**
 * Escrow releases and refunds, from the journal's memorandum accounts.
 *
 * ## THE RAIL FILTER IS LOAD-BEARING — do not remove it
 *
 * `settlement_released_memo` is NOT unique to escrow. `planSettlementPostings` posts the very
 * same account on the `direct_processor` rail, as `settlement_funding_memo → released_memo` with
 * no custody hop. Without `settlementRail = 'external_escrow'` every processor payment would be
 * counted TWICE — once as `processorSettled` and again as `escrowReleased` — and the page would
 * silently double a seller's revenue. This is the single easiest way to get this read wrong, and
 * it is asserted by name in the phase 25 smoke script.
 *
 * Only `settlement = 'settled'` entries count. A pending entry is a movement the provider has
 * not confirmed.
 */
async function loadEscrowMovements(
  sellerOrganizationId: string,
  window: EarningsWindowInput,
): Promise<{
  readonly released: readonly CurrencyAmount[];
  readonly refunded: readonly CurrencyAmount[];
}> {
  const rows = await db
    .select({
      currency: commerceJournalEntry.currency,
      accountKind: commerceJournalLine.accountKind,
      total: sql<string>`coalesce(sum(${commerceJournalLine.signedAmountInCents}), 0)`,
      orderCount: countDistinct(commerceJournalLine.orderId),
    })
    .from(commerceJournalLine)
    .innerJoin(
      commerceJournalEntry,
      eq(commerceJournalEntry.id, commerceJournalLine.journalEntryId),
    )
    .innerJoin(commerceOrder, eq(commerceOrder.id, commerceJournalLine.orderId))
    .where(
      and(
        eq(commerceOrder.counterpartyOrganizationId, sellerOrganizationId),
        // See the header block. Removing this double-counts every processor payment.
        eq(commerceOrder.settlementRail, "external_escrow"),
        inArray(commerceJournalLine.accountKind, [
          "settlement_released_memo",
          "settlement_refunded_memo",
        ]),
        eq(commerceJournalEntry.settlement, "settled"),
        window.from === undefined ? undefined : gte(commerceJournalEntry.occurredAt, window.from),
        window.to === undefined ? undefined : lt(commerceJournalEntry.occurredAt, window.to),
      ),
    )
    .groupBy(commerceJournalEntry.currency, commerceJournalLine.accountKind);

  const byKind = (kind: string): CurrencyAmount[] =>
    rows
      .filter((row) => row.accountKind === kind)
      .map((row) => ({
        currency: row.currency,
        amountInCents: toSafeCents(row.total, kind),
        orderCount: row.orderCount,
      }));

  return {
    released: sortByCurrency(withoutEmptyTotals(byKind("settlement_released_memo"))),
    refunded: sortByCurrency(withoutEmptyTotals(byKind("settlement_refunded_memo"))),
  };
}

/**
 * What the seller itself said arrived, on the `direct_offline` rail.
 *
 * `payment_received` attested BY THIS ORGANIZATION. The buyer's matching `payment_sent` is
 * deliberately not counted here — a buyer's claim that they paid is not evidence the seller was
 * paid, and the two can disagree. The order detail surfaces both so the disagreement is visible;
 * this figure reports only what the seller stands behind.
 */
async function loadAttestedReceived(
  sellerOrganizationId: string,
  window: EarningsWindowInput,
): Promise<readonly CurrencyAmount[]> {
  const rows = await db
    .select({
      currency: commerceSettlementAttestation.currency,
      total: sql<string>`coalesce(sum(${commerceSettlementAttestation.amountInCents}), 0)`,
      orderCount: countDistinct(commerceSettlementAttestation.orderId),
    })
    .from(commerceSettlementAttestation)
    .where(
      and(
        eq(commerceSettlementAttestation.attestedByOrganizationId, sellerOrganizationId),
        eq(commerceSettlementAttestation.attestationKind, "payment_received"),
        window.from === undefined
          ? undefined
          : gte(commerceSettlementAttestation.occurredAt, window.from),
        window.to === undefined
          ? undefined
          : lt(commerceSettlementAttestation.occurredAt, window.to),
      ),
    )
    .groupBy(commerceSettlementAttestation.currency);

  return sortByCurrency(
    withoutEmptyTotals(
      rows.map((row) => ({
        currency: row.currency,
        amountInCents: toSafeCents(row.total, "attestedReceived"),
        orderCount: row.orderCount,
      })),
    ),
  );
}

/**
 * Commission recognized against this seller's orders.
 *
 * REAL MONEY, NOT MEMO, which is why it may not be netted against anything above — and it runs
 * the opposite way: `platform_fee_receivable` is what the SELLER owes Qatoto, accrued as a
 * receivable rather than deducted, because no rail lets Qatoto take a fee out of money it holds.
 *
 * EXPECT THIS TO BE EMPTY. `COMMERCE_PLATFORM_COMMISSION_BASIS_POINTS` defaults to zero, and
 * `recognizeCommission` treats zero as "not decided" and posts nothing at all rather than
 * writing a zero-value entry. An empty array here is the correct and ordinary answer.
 */
async function loadCommissionOwed(
  sellerOrganizationId: string,
  window: EarningsWindowInput,
): Promise<readonly CurrencyAmount[]> {
  const rows = await db
    .select({
      currency: commerceJournalEntry.currency,
      total: sql<string>`coalesce(sum(${commerceJournalLine.signedAmountInCents}), 0)`,
      orderCount: countDistinct(commerceJournalLine.orderId),
    })
    .from(commerceJournalLine)
    .innerJoin(
      commerceJournalEntry,
      eq(commerceJournalEntry.id, commerceJournalLine.journalEntryId),
    )
    .innerJoin(commerceOrder, eq(commerceOrder.id, commerceJournalLine.orderId))
    .where(
      and(
        eq(commerceOrder.counterpartyOrganizationId, sellerOrganizationId),
        eq(commerceJournalLine.accountKind, "platform_fee_receivable"),
        eq(commerceJournalEntry.settlement, "settled"),
        window.from === undefined ? undefined : gte(commerceJournalEntry.occurredAt, window.from),
        window.to === undefined ? undefined : lt(commerceJournalEntry.occurredAt, window.to),
      ),
    )
    .groupBy(commerceJournalEntry.currency);

  return sortByCurrency(
    withoutEmptyTotals(
      rows.map((row) => ({
        currency: row.currency,
        amountInCents: toSafeCents(row.total, "commissionOwed"),
        orderCount: row.orderCount,
      })),
    ),
  );
}

/** Orders whose money has not moved yet at all. A count, never a projected amount. */
async function countOrdersAwaitingPayment(
  sellerOrganizationId: string,
  window: EarningsWindowInput,
): Promise<number> {
  const [row] = await db
    .select({ orderCount: count() })
    .from(commerceOrder)
    .where(
      and(
        eq(commerceOrder.counterpartyOrganizationId, sellerOrganizationId),
        inArray(commerceOrder.state, ["pending_payment", "payment_processing"]),
        window.from === undefined ? undefined : gte(commerceOrder.createdAt, window.from),
        window.to === undefined ? undefined : lt(commerceOrder.createdAt, window.to),
      ),
    );
  return row?.orderCount ?? 0;
}

/**
 * Every figure for one seller over one window.
 *
 * The six reads are independent and run concurrently, following the batching shape
 * `commerce-trust-metrics.service.ts` established for per-organization aggregates.
 */
export async function getSellerEarnings(
  actor: CommerceEarningsActorContext,
  window: EarningsWindowInput,
): Promise<Result<CommerceEarningsProjection, CommerceEarningsError>> {
  if (window.from !== undefined && window.to !== undefined && window.from >= window.to) {
    return {
      success: false,
      error: { type: "INVALID_WINDOW", message: "`from` must be earlier than `to`." },
    };
  }

  const sellerOrganizationId = actor.organizationId;

  const [
    processorSettled,
    processorRefunded,
    escrowMovements,
    attestedReceived,
    commissionOwed,
    offlineOrdersWithNoAttestation,
    ordersAwaitingPayment,
  ] = await Promise.all([
    loadProcessorSettled(sellerOrganizationId, window),
    loadProcessorRefunded(sellerOrganizationId, window),
    loadEscrowMovements(sellerOrganizationId, window),
    loadAttestedReceived(sellerOrganizationId, window),
    loadCommissionOwed(sellerOrganizationId, window),
    countOfflineOrdersWithoutSellerAttestation(sellerOrganizationId, {
      from: window.from ?? null,
      to: window.to ?? null,
    }),
    countOrdersAwaitingPayment(sellerOrganizationId, window),
  ]);

  return {
    success: true,
    value: {
      window: { from: window.from ?? null, to: window.to ?? null },
      observed: {
        processorSettled,
        processorRefunded,
        escrowReleased: escrowMovements.released,
        escrowRefunded: escrowMovements.refunded,
      },
      selfReported: { attestedReceived },
      commissionOwed,
      uncounted: { offlineOrdersWithNoAttestation, ordersAwaitingPayment },
    },
  };
}
