import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrder,
  commerceOrderProductLine,
  commerceSampleCredit,
  product,
} from "#src/db/schema.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The mechanism behind `samplePolicy = 'refundable'` (Appendix A17).
 *
 * Until Phase 11 the third policy value was decorative: a buyer paid for a sample and
 * nothing ever returned that value against a later bulk order, so `refundable` and
 * `paid` behaved identically.
 *
 * A credit is minted ONCE when a refundable sample order completes and spent ONCE as a
 * discount on a later order from the same seller in the same currency. It deliberately
 * does not move money: the discount lands before a payment intent exists, so there is no
 * cross-order journal posting to invent — and `commerce_journal_entry` is strictly
 * per-order.
 */

export interface SampleCreditProjection {
  readonly id: string;
  readonly sellerOrganizationId: string;
  readonly productId: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly sourceOrderId: string;
}

/**
 * Mints credits for the refundable sample lines on a completed order.
 *
 * Called from the completion path so it rides the transaction that already decided the
 * order is finished. Idempotent twice over: the unique index on `source_order_id` makes
 * a replay a no-op, and the pre-check keeps the common case out of the error path.
 */
export async function mintSampleCreditsForOrder(
  transaction: DatabaseTransaction,
  orderId: string,
  occurredAt: Date,
  actorUserId: string | null,
): Promise<void> {
  const [order] = await transaction
    .select({
      id: commerceOrder.id,
      buyerOrganizationId: commerceOrder.buyerOrganizationId,
      counterpartyOrganizationId: commerceOrder.counterpartyOrganizationId,
      currency: commerceOrder.currency,
    })
    .from(commerceOrder)
    .where(eq(commerceOrder.id, orderId))
    .limit(1);
  if (!order) return;
  // A seller buying from itself has nothing to credit.
  if (order.buyerOrganizationId === order.counterpartyOrganizationId) return;

  const [existingCredit] = await transaction
    .select({ id: commerceSampleCredit.id })
    .from(commerceSampleCredit)
    .where(eq(commerceSampleCredit.sourceOrderId, orderId))
    .limit(1);
  if (existingCredit) return;

  /**
   * Only lines that were BOTH sold as a sample and whose product still declares
   * `refundable`. The policy is read live rather than snapshotted because a seller
   * downgrading `refundable` to `paid` before the sample completes has withdrawn the
   * offer, and honouring a promise the listing no longer makes would be inventing one.
   */
  const refundableSampleLines = await transaction
    .select({
      productId: commerceOrderProductLine.productId,
      lineTotalInCents: commerceOrderProductLine.lineTotalInCents,
    })
    .from(commerceOrderProductLine)
    .innerJoin(product, eq(product.id, commerceOrderProductLine.productId))
    .where(
      and(
        eq(commerceOrderProductLine.orderId, orderId),
        eq(commerceOrderProductLine.isSample, true),
        eq(product.samplePolicy, "refundable"),
      ),
    );
  if (refundableSampleLines.length === 0) return;

  const creditableTotalInCents = refundableSampleLines.reduce(
    (running, line) => running + line.lineTotalInCents,
    0,
  );
  if (creditableTotalInCents <= 0) return;

  /**
   * `commerce_order_product_line.product_id` is nullable — a delisted product leaves
   * the snapshot standing and the pointer gone. A credit needs a real product for
   * provenance, so a line that has lost its pointer contributes its value but cannot be
   * the one the credit is attributed to.
   */
  const attributableLine = refundableSampleLines.find((line) => line.productId !== null);
  const attributableProductId = attributableLine?.productId;
  if (attributableProductId === undefined || attributableProductId === null) return;

  await transaction
    .insert(commerceSampleCredit)
    .values({
      buyerOrganizationId: order.buyerOrganizationId,
      sellerOrganizationId: order.counterpartyOrganizationId,
      /**
       * One credit per order, attributed to the first sample product on it. The
       * attribution is provenance, not a spending restriction — the credit is against
       * the SELLER, because a buyer who sampled one product and ordered its sibling in
       * bulk has done exactly what the policy invites.
       */
      productId: attributableProductId,
      sourceOrderId: orderId,
      amountInCents: creditableTotalInCents,
      currency: order.currency,
      state: "available",
    })
    .onConflictDoNothing();

  const appended = await appendCommerceOrganizationAuditEntry(transaction, {
    organizationId: order.buyerOrganizationId,
    eventKind: "sample_credit_minted",
    actorUserId,
    actorMemberRoleSnapshot: null,
    targetEntityType: "commerce_sample_credit",
    targetEntityId: orderId,
    payload: {
      orderId,
      sellerOrganizationId: order.counterpartyOrganizationId,
      amountInCents: String(creditableTotalInCents),
      currency: order.currency,
    },
    occurredAt,
  });
  if (!appended.success) {
    throw new Error(`Sample credit mint audit failed: ${appended.error.type}`);
  }
}

/**
 * Credits a buyer may spend with one seller in one currency.
 *
 * Used twice with different intent: at prepare to SHOW the buyer what will be applied,
 * and at confirm — under the row lock — to decide what actually is. The read is the same
 * because the answer must be, but only the second one is authoritative.
 */
export async function listSpendableSampleCredits(
  databaseExecutor: DatabaseTransaction | typeof db,
  input: {
    readonly buyerOrganizationId: string;
    readonly sellerOrganizationId: string;
    readonly currency: string;
    readonly asOf: Date;
    readonly forUpdate?: boolean;
  },
): Promise<readonly SampleCreditProjection[]> {
  const baseQuery = databaseExecutor
    .select({
      id: commerceSampleCredit.id,
      sellerOrganizationId: commerceSampleCredit.sellerOrganizationId,
      productId: commerceSampleCredit.productId,
      amountInCents: commerceSampleCredit.amountInCents,
      currency: commerceSampleCredit.currency,
      sourceOrderId: commerceSampleCredit.sourceOrderId,
    })
    .from(commerceSampleCredit)
    .where(
      and(
        eq(commerceSampleCredit.buyerOrganizationId, input.buyerOrganizationId),
        eq(commerceSampleCredit.sellerOrganizationId, input.sellerOrganizationId),
        eq(commerceSampleCredit.currency, input.currency),
        eq(commerceSampleCredit.state, "available"),
        // An unset expiry never expires; a set one is exclusive at the boundary.
        sql`(${commerceSampleCredit.expiresAt} IS NULL OR ${commerceSampleCredit.expiresAt} > ${input.asOf})`,
      ),
    )
    // Oldest first, so a credit that might expire is the one spent.
    .orderBy(asc(commerceSampleCredit.createdAt), asc(commerceSampleCredit.id));

  return input.forUpdate === true ? baseQuery.for("update") : baseQuery;
}

/**
 * Applies as much credit as the order can absorb and marks exactly that much consumed.
 *
 * A credit is spent whole or not at all. Splitting one would need a residual-balance
 * column and a partial-consumption state, and neither earns its keep for a value that
 * exists to refund one sample.
 */
export function selectConsumableCredits(
  credits: readonly SampleCreditProjection[],
  subtotalInCents: number,
): {
  readonly consumedCredits: readonly SampleCreditProjection[];
  readonly discountInCents: number;
} {
  const consumedCredits: SampleCreditProjection[] = [];
  let discountInCents = 0;

  for (const credit of credits) {
    if (discountInCents + credit.amountInCents > subtotalInCents) continue;
    consumedCredits.push(credit);
    discountInCents += credit.amountInCents;
  }

  return { consumedCredits, discountInCents };
}

/** Marks credits spent against the order that spent them, inside its transaction. */
export async function consumeSampleCredits(
  transaction: DatabaseTransaction,
  input: {
    readonly creditIds: readonly string[];
    readonly consumedByOrderId: string;
    readonly buyerOrganizationId: string;
    readonly actorUserId: string;
    readonly occurredAt: Date;
  },
): Promise<void> {
  if (input.creditIds.length === 0) return;

  for (const creditId of input.creditIds) {
    const updated = await transaction
      .update(commerceSampleCredit)
      .set({
        state: "consumed",
        consumedByOrderId: input.consumedByOrderId,
        consumedAt: input.occurredAt,
      })
      .where(
        and(
          eq(commerceSampleCredit.id, creditId),
          // The state predicate is the concurrency guard: two confirms racing for one
          // credit means the second update matches nothing.
          eq(commerceSampleCredit.state, "available"),
          isNull(commerceSampleCredit.consumedByOrderId),
        ),
      )
      .returning({ id: commerceSampleCredit.id });
    if (updated.length === 0) {
      throw new Error(`Sample credit ${creditId} was consumed concurrently.`);
    }
  }

  const appended = await appendCommerceOrganizationAuditEntry(transaction, {
    organizationId: input.buyerOrganizationId,
    eventKind: "sample_credit_consumed",
    actorUserId: input.actorUserId,
    actorMemberRoleSnapshot: null,
    targetEntityType: "commerce_order",
    targetEntityId: input.consumedByOrderId,
    payload: {
      orderId: input.consumedByOrderId,
      creditCount: String(input.creditIds.length),
    },
    occurredAt: input.occurredAt,
  });
  if (!appended.success) {
    throw new Error(`Sample credit consumption audit failed: ${appended.error.type}`);
  }
}
