import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, exists, gt, lt, not, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCompletion,
  commerceOrder,
  commerceOrderProductLine,
  commerceOrganization,
  commerceReview,
  commerceServiceEngagement,
} from "#src/db/schema.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import { mintSampleCreditsForOrder } from "#src/modules/store/orders/commerce-sample-credit.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import type { CommerceTrustError } from "#src/modules/store/trust/commerce-trust.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const COMPLETION_ELIGIBLE_ORDER_STATES: ReadonlySet<(typeof commerceOrder.$inferSelect)["state"]> =
  new Set(["confirmed", "in_fulfillment", "partially_completed", "completed"]);

export function isOrderEligibleForCompletion(
  orderState: (typeof commerceOrder.$inferSelect)["state"],
): boolean {
  return COMPLETION_ELIGIBLE_ORDER_STATES.has(orderState);
}

export function isProductLineEligibleForCompletion(input: {
  readonly quantityOrdered: number;
  readonly quantityFulfilled: number;
  readonly quantityCancelled: number;
}): boolean {
  return (
    input.quantityFulfilled > 0 &&
    input.quantityFulfilled + input.quantityCancelled >= input.quantityOrdered
  );
}

export function isServiceEngagementEligibleForCompletion(input: {
  readonly state: (typeof commerceServiceEngagement.$inferSelect)["state"];
  readonly executionContractState: (typeof commerceServiceEngagement.$inferSelect)["executionContractState"];
  readonly requiresDeliverableNormalization: boolean;
  readonly buyerOrganizationId: string;
  readonly providerOrganizationId: string;
}): boolean {
  return (
    input.state === "completed" &&
    input.executionContractState === "ready" &&
    !input.requiresDeliverableNormalization &&
    input.buyerOrganizationId !== input.providerOrganizationId
  );
}

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce completion audit append failed: ${appended.error.type}`);
  }
}

/**
 * Issues immutable completion rows for newly fulfilled product lines and completed
 * engagements on an order. Skips self-counterparty relationships (no review eligibility).
 * Safe to call repeatedly — unique source indexes make issuance idempotent.
 */
export async function issueCompletionsForOrder(
  transaction: DatabaseTransaction,
  orderId: string,
  occurredAt: Date,
  actorUserId: string | null,
): Promise<void> {
  const [order] = await transaction
    .select()
    .from(commerceOrder)
    .where(eq(commerceOrder.id, orderId))
    .limit(1);
  if (!order) {
    throw new Error("Order vanished while issuing commerce completions.");
  }
  if (order.buyerOrganizationId === order.counterpartyOrganizationId) {
    return;
  }
  if (!isOrderEligibleForCompletion(order.state)) {
    return;
  }

  /**
   * A17. A refundable sample that has completed is what mints a credit, and it rides
   * this transaction because the same commit is what decided the order is finished.
   */
  await mintSampleCreditsForOrder(transaction, order.id, occurredAt, actorUserId);

  const eligibleProductLines = await transaction
    .select()
    .from(commerceOrderProductLine)
    .where(
      and(
        eq(commerceOrderProductLine.orderId, order.id),
        gt(commerceOrderProductLine.quantityFulfilled, 0),
        sql`(quantity_fulfilled + quantity_cancelled) >= quantity_ordered`,
      ),
    );

  for (const productLine of eligibleProductLines) {
    if (!isProductLineEligibleForCompletion(productLine)) continue;

    const [existing] = await transaction
      .select({ id: commerceCompletion.id })
      .from(commerceCompletion)
      .where(eq(commerceCompletion.orderProductLineId, productLine.id))
      .limit(1);
    if (existing) continue;

    const [inserted] = await transaction
      .insert(commerceCompletion)
      .values({
        targetKind: "product_order_line",
        orderId: order.id,
        buyerOrganizationId: order.buyerOrganizationId,
        counterpartyOrganizationId: order.counterpartyOrganizationId,
        orderProductLineId: productLine.id,
        serviceEngagementId: null,
        productId: productLine.productId,
        completedAt: occurredAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) continue;

    await appendAuditOrThrow(transaction, {
      organizationId: order.buyerOrganizationId,
      eventKind: "completion_issued",
      actorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_completion",
      targetEntityId: inserted.id,
      payload: {
        completionId: inserted.id,
        targetKind: "product_order_line",
        orderId: order.id,
        orderProductLineId: productLine.id,
      },
      occurredAt,
    });
  }

  const completedEngagements = await transaction
    .select()
    .from(commerceServiceEngagement)
    .where(
      and(
        eq(commerceServiceEngagement.orderId, order.id),
        eq(commerceServiceEngagement.state, "completed"),
      ),
    );

  for (const engagement of completedEngagements) {
    if (!isServiceEngagementEligibleForCompletion(engagement)) continue;

    const [existing] = await transaction
      .select({ id: commerceCompletion.id })
      .from(commerceCompletion)
      .where(eq(commerceCompletion.serviceEngagementId, engagement.id))
      .limit(1);
    if (existing) continue;

    const [inserted] = await transaction
      .insert(commerceCompletion)
      .values({
        targetKind: "service_engagement",
        orderId: order.id,
        buyerOrganizationId: engagement.buyerOrganizationId,
        counterpartyOrganizationId: engagement.providerOrganizationId,
        orderProductLineId: null,
        serviceEngagementId: engagement.id,
        productId: null,
        completedAt: engagement.completedAt ?? occurredAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) continue;

    await appendAuditOrThrow(transaction, {
      organizationId: engagement.buyerOrganizationId,
      eventKind: "completion_issued",
      actorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_completion",
      targetEntityId: inserted.id,
      payload: {
        completionId: inserted.id,
        targetKind: "service_engagement",
        orderId: order.id,
        engagementId: engagement.id,
      },
      occurredAt,
    });
  }
}

/**
 * One row of the buyer's completion list.
 *
 * `productId` is nullable and that is structural, not laziness: `commerce_completion_target_ck`
 * forces it NOT NULL on a `product_order_line` completion and NULL on a `service_engagement`
 * one, which is the same reason `commerce_review.productId` is nullable. `targetKind` rides
 * alongside so a client reads which shape it has rather than inferring it from a null.
 */
export interface BuyerCompletionProjection {
  readonly completionId: string;
  readonly targetKind: (typeof commerceCompletion.$inferSelect)["targetKind"];
  readonly orderId: string;
  readonly productId: string | null;
  readonly counterpartyOrganization: {
    readonly organizationId: string;
    readonly slug: string;
    readonly displayName: string;
  };
  readonly completedAt: Date;
  /**
   * Whether THIS buyer organization has already reviewed this completion — a fact about the
   * caller, never about the completion. Another organization's review must not make a
   * completion look spent.
   */
  readonly hasReview: boolean;
}

export interface BuyerCompletionListPage {
  readonly items: readonly BuyerCompletionProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

const DEFAULT_COMPLETION_PAGE_LIMIT = 20;

/**
 * The buyer's completions, newest first — the read that makes reviewing possible at all.
 *
 * `POST /commerce/completions/:completionId/reviews` has shipped since Phase 7 and
 * `completionId` was projected on NOTHING, so a buyer had no way to obtain the id the route
 * demands. Ratings, review photos and review videos were all reachable only by guessing a
 * UUID.
 *
 * `reviewable` filters in SQL rather than over the fetched page. A post-filter would return
 * short pages and a cursor computed from rows that were then dropped, so the next page would
 * start past rows the caller never saw — the pagination bug that looks like missing data.
 *
 * The unique index it tests, `commerce_review_completion_reviewer_uidx`, carries NO partial
 * predicate, so a hidden review still blocks a second one. `hasReview` therefore counts hidden
 * reviews too: reporting `false` for one would offer the client a write `createReview` refuses.
 */
export async function listBuyerCompletions(input: {
  readonly buyerOrganizationId: string;
  readonly reviewable?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}): Promise<Result<BuyerCompletionListPage, CommerceTrustError>> {
  const limit = input.limit ?? DEFAULT_COMPLETION_PAGE_LIMIT;

  let cursorPredicate: SQL | undefined;
  if (input.cursor !== undefined) {
    const decodedCursor = decodeTimestampStoreCursor(input.cursor);
    if (!decodedCursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    cursorPredicate = or(
      lt(commerceCompletion.completedAt, decodedCursor.sortKey),
      and(
        eq(commerceCompletion.completedAt, decodedCursor.sortKey),
        gt(commerceCompletion.id, decodedCursor.id),
      ),
    );
  }

  /**
   * Correlated on BOTH columns of the unique index. Scoping to the caller's organization is
   * what keeps one buyer's review from hiding a completion from another buyer of the same
   * order — and there is no such thing here, because a completion belongs to one buyer, but
   * the predicate must still say so or a later multi-buyer shape would silently inherit the
   * wrong meaning.
   */
  const reviewedByCaller = exists(
    db
      .select({ marker: sql`1` })
      .from(commerceReview)
      .where(
        and(
          eq(commerceReview.completionId, commerceCompletion.id),
          eq(commerceReview.reviewerOrganizationId, input.buyerOrganizationId),
        ),
      ),
  );

  const rows = await db
    .select({
      id: commerceCompletion.id,
      targetKind: commerceCompletion.targetKind,
      orderId: commerceCompletion.orderId,
      productId: commerceCompletion.productId,
      completedAt: commerceCompletion.completedAt,
      counterpartyOrganizationId: commerceCompletion.counterpartyOrganizationId,
      counterpartySlug: commerceOrganization.slug,
      counterpartyDisplayName: commerceOrganization.displayName,
      /**
       * `exists()` is typed `SQL<unknown>`, and CLAUDE.md §2 forbids an assertion to fix
       * that. Re-wrapping states the type at the boundary instead — `EXISTS` returns a
       * Postgres boolean and node-postgres parses it as one.
       */
      hasReview: sql<boolean>`${reviewedByCaller}`,
    })
    .from(commerceCompletion)
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceCompletion.counterpartyOrganizationId),
    )
    .where(
      and(
        eq(commerceCompletion.buyerOrganizationId, input.buyerOrganizationId),
        input.reviewable === true ? not(reviewedByCaller) : undefined,
        cursorPredicate,
      ),
    )
    // Ends in a unique column, so a page boundary cannot fall inside a group of rows
    // sharing `completedAt` (§7).
    .orderBy(desc(commerceCompletion.completedAt), asc(commerceCompletion.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        completionId: row.id,
        targetKind: row.targetKind,
        orderId: row.orderId,
        productId: row.productId,
        counterpartyOrganization: {
          organizationId: row.counterpartyOrganizationId,
          slug: row.counterpartySlug,
          displayName: row.counterpartyDisplayName,
        },
        completedAt: row.completedAt,
        hasReview: row.hasReview,
      })),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({
                sortKey: lastRow.completedAt.toISOString(),
                id: lastRow.id,
              })
            : null,
        hasMore,
      },
    },
  };
}

export interface OrderCompletionIndex {
  /** Product-line id → its completion id. The common review case. */
  readonly completionIdByProductLineId: ReadonlyMap<string, string>;
  /** Every completion on the order, including the service-engagement ones. */
  readonly completionIds: readonly string[];
}

/**
 * The completions one order produced, shaped for the order detail read.
 *
 * A buyer arriving from an order should not have to page `GET /commerce/completions` to
 * review the thing they just received.
 *
 * NOT scoped to the caller: `getOrder` admits both the buyer AND the counterparty, and
 * filtering these rows by the reader would hand the seller an order whose lines claim no
 * completion exists. A completion id is not a capability — `evaluateReviewRelationship`
 * refuses anyone but the buyer — so the honest projection is the same for both parties.
 * The order's own authorization is what gates reaching this at all.
 */
export async function loadOrderCompletionIndex(orderId: string): Promise<OrderCompletionIndex> {
  const rows = await db
    .select({
      id: commerceCompletion.id,
      orderProductLineId: commerceCompletion.orderProductLineId,
    })
    .from(commerceCompletion)
    .where(eq(commerceCompletion.orderId, orderId))
    .orderBy(asc(commerceCompletion.completedAt), asc(commerceCompletion.id));

  const completionIdByProductLineId = new Map<string, string>();
  for (const row of rows) {
    if (row.orderProductLineId === null) continue;
    completionIdByProductLineId.set(row.orderProductLineId, row.id);
  }

  return {
    completionIdByProductLineId,
    completionIds: rows.map((row) => row.id),
  };
}
