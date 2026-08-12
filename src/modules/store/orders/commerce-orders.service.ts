import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrder,
  commerceOrderProductLine,
  commerceOrderServiceLine,
  commercePaymentIntent,
  commerceServiceEngagement,
  product,
} from "#src/db/schema.js";
import { loadOrderCompletionIndex } from "#src/modules/store/orders/commerce-completion.service.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OrderRow = typeof commerceOrder.$inferSelect;
type OrderState = OrderRow["state"];
type ProductLineRow = typeof commerceOrderProductLine.$inferSelect;
type ServiceLineRow = typeof commerceOrderServiceLine.$inferSelect;

export type CommerceOrdersError =
  | { type: "NOT_FOUND" }
  | { type: "INVALID_STATE" }
  | { type: "INVALID_CURSOR" }
  | { type: "CONFLICT"; message: string };

export interface CommerceOrderActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface ListOrdersInput {
  readonly limit?: number;
  readonly cursor?: string;
  /** Narrows within the caller's own side of the order; omitted means every state. */
  readonly state?: OrderState;
}

export interface OrderSummaryProjection {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
  readonly checkoutGroupId: string | null;
  readonly source: OrderRow["source"];
  readonly state: OrderState;
  readonly currency: string;
  readonly totalInCents: number;
  readonly buyerLegalNameSnapshot: string;
  readonly counterpartyLegalNameSnapshot: string;
  readonly createdAt: Date;
  /**
   * STORE Phase 14. How this order settles, and whether a third party is holding the money.
   *
   * `hasEscrowProtection` is derived from the rail rather than stored a second time, and it
   * is on the wire because ABSENCE MUST BE LEGIBLE. A client has to be able to state plainly
   * that nobody is holding the funds; leaving that to be inferred from a rail name is how an
   * interface ends up implying a protection nobody agreed to.
   */
  readonly settlementRail: OrderRow["settlementRail"];
  readonly hasEscrowProtection: boolean;
  /**
   * A38. The payment intent this order can still be paid through, or NULL.
   *
   * WHY IT IS HERE. `POST /commerce/orders/:orderId/payment-intents` returned an id and
   * `GET /commerce/payments/:paymentIntentId` consumed one, and nothing in between survived a
   * page reload — so a buyer who navigated away from checkout could not pay their own order.
   * There is no payment-intent list route and there does not need to be: an order has at most
   * one live intent, so the order is the right place to carry it.
   *
   * THE ONE `commerce_payment_intent_active_order_uidx` ADMITS, which is what makes this a
   * single id rather than an array. NULL means either nothing has been created yet or every
   * attempt reached a terminal failure — in both cases the client's next move is to create
   * one, so the two do not need distinguishing here.
   */
  readonly paymentIntentId: string | null;
}

export interface OrderListPage {
  readonly items: readonly OrderSummaryProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export interface OrderProductLineProjection {
  readonly id: string;
  /**
   * The completion this line produced, once it was fulfilled — the id
   * `POST /commerce/completions/:completionId/reviews` demands. `null` until the line
   * completes. Before this shipped, `completionId` was projected NOWHERE, so a buyer
   * could not review a delivered line without guessing a UUID.
   */
  readonly completionId: string | null;
  readonly productId: string | null;
  readonly titleSnapshot: string;
  readonly specificationSnapshot: string;
  readonly quantityOrdered: number;
  readonly quantityReserved: number;
  readonly quantityFulfilled: number;
  readonly quantityCancelled: number;
  readonly quantityRefunded: number;
  readonly unitPriceInCents: number;
  readonly lineTotalInCents: number;
  readonly siblingOrder: number;
}

export interface OrderServiceLineProjection {
  readonly id: string;
  readonly providerKind: ServiceLineRow["providerKind"];
  readonly titleSnapshot: string;
  readonly scopeSnapshot: string;
  readonly feeInCents: number;
  readonly siblingOrder: number;
}

export interface OrderDetailProjection {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
  readonly checkoutGroupId: string | null;
  readonly source: OrderRow["source"];
  readonly state: OrderState;
  readonly acceptedQuoteId: string | null;
  readonly currency: string;
  readonly subtotalInCents: number;
  readonly taxInCents: number;
  readonly serviceFeeInCents: number;
  readonly shippingInCents: number;
  readonly discountInCents: number;
  readonly totalInCents: number;
  readonly paymentTermsSnapshot: string | null;
  readonly incotermSnapshot: string | null;
  readonly buyerLegalNameSnapshot: string;
  readonly counterpartyLegalNameSnapshot: string;
  readonly createdAt: Date;
  readonly productLines: readonly OrderProductLineProjection[];
  readonly serviceLines: readonly OrderServiceLineProjection[];
  /**
   * Every completion this order produced, including the service-engagement ones that
   * belong to no product line. The per-line id covers the common case; this covers the
   * rest without making a client walk two shapes to find them.
   */
  readonly completionIds: readonly string[];
  /**
   * STORE Phase 14. How this order settles, and whether a third party is holding the money.
   *
   * `hasEscrowProtection` is derived from the rail rather than stored a second time, and it
   * is on the wire because ABSENCE MUST BE LEGIBLE. A client has to be able to state plainly
   * that nobody is holding the funds; leaving that to be inferred from a rail name is how an
   * interface ends up implying a protection nobody agreed to.
   */
  readonly settlementRail: OrderRow["settlementRail"];
  readonly hasEscrowProtection: boolean;
  /**
   * A38. The payment intent this order can still be paid through, or NULL.
   *
   * WHY IT IS HERE. `POST /commerce/orders/:orderId/payment-intents` returned an id and
   * `GET /commerce/payments/:paymentIntentId` consumed one, and nothing in between survived a
   * page reload — so a buyer who navigated away from checkout could not pay their own order.
   * There is no payment-intent list route and there does not need to be: an order has at most
   * one live intent, so the order is the right place to carry it.
   *
   * THE ONE `commerce_payment_intent_active_order_uidx` ADMITS, which is what makes this a
   * single id rather than an array. NULL means either nothing has been created yet or every
   * attempt reached a terminal failure — in both cases the client's next move is to create
   * one, so the two do not need distinguishing here.
   */
  readonly paymentIntentId: string | null;
}

const DEFAULT_PAGE_LIMIT = 20;

/** States from which a buyer or counterparty may cancel — before any physical fulfillment. */
const CANCELLABLE_ORDER_STATES: readonly OrderState[] = ["pending_payment", "confirmed"];

/** Engagement states that have not yet started delivering the service. */
const CANCELLABLE_ENGAGEMENT_STATES: readonly (typeof commerceServiceEngagement.$inferSelect)["state"][] =
  ["awaiting_provider", "scheduled"];

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce order audit append failed: ${appended.error.type}`);
  }
}

/**
 * The states in which a payment intent is still the one to pay through (A38).
 *
 * MIRRORS `commerce_payment_intent_active_order_uidx`'s predicate exactly, and that is the
 * point: the index is what guarantees at most one such row per order, so a list built from a
 * different set of states could return two and the projection would have to pick arbitrarily.
 * `failed` and `cancelled` are absent because a terminal attempt is not payable — the client's
 * next move there is a fresh intent, not this one.
 */
const PAYABLE_PAYMENT_INTENT_STATES = [
  "created",
  "requires_action",
  "processing",
  "authorized",
  "settled",
  "partially_refunded",
  "refunded",
  "disputed",
] as const;

/** One query for a whole page of orders, rather than one per order. */
async function loadLivePaymentIntentIdsByOrderId(
  orderIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (orderIds.length === 0) return new Map();

  const rows = await db
    .select({ orderId: commercePaymentIntent.orderId, id: commercePaymentIntent.id })
    .from(commercePaymentIntent)
    .where(
      and(
        inArray(commercePaymentIntent.orderId, [...orderIds]),
        inArray(commercePaymentIntent.state, [...PAYABLE_PAYMENT_INTENT_STATES]),
      ),
    );

  return new Map(rows.map((row) => [row.orderId, row.id]));
}

function summarizeOrder(order: OrderRow, paymentIntentId: string | null): OrderSummaryProjection {
  return {
    id: order.id,
    buyerOrganizationId: order.buyerOrganizationId,
    counterpartyOrganizationId: order.counterpartyOrganizationId,
    checkoutGroupId: order.checkoutGroupId,
    source: order.source,
    state: order.state,
    currency: order.currency,
    totalInCents: order.totalInCents,
    buyerLegalNameSnapshot: order.buyerLegalNameSnapshot,
    counterpartyLegalNameSnapshot: order.counterpartyLegalNameSnapshot,
    settlementRail: order.settlementRail,
    // Derived, never stored twice: one fact cannot then disagree with itself.
    hasEscrowProtection: order.settlementRail === "external_escrow",
    paymentIntentId,
    createdAt: order.createdAt,
  };
}

function projectOrderProductLine(
  line: ProductLineRow,
  completionId: string | null,
): OrderProductLineProjection {
  return {
    id: line.id,
    completionId,
    productId: line.productId,
    titleSnapshot: line.titleSnapshot,
    specificationSnapshot: line.specificationSnapshot,
    quantityOrdered: line.quantityOrdered,
    quantityReserved: line.quantityReserved,
    quantityFulfilled: line.quantityFulfilled,
    quantityCancelled: line.quantityCancelled,
    quantityRefunded: line.quantityRefunded,
    unitPriceInCents: line.unitPriceInCents,
    lineTotalInCents: line.lineTotalInCents,
    siblingOrder: line.siblingOrder,
  };
}

function projectOrderServiceLine(line: ServiceLineRow): OrderServiceLineProjection {
  return {
    id: line.id,
    providerKind: line.providerKind,
    titleSnapshot: line.titleSnapshot,
    scopeSnapshot: line.scopeSnapshot,
    feeInCents: line.feeInCents,
    siblingOrder: line.siblingOrder,
  };
}

async function projectOrderDetail(order: OrderRow): Promise<OrderDetailProjection> {
  const [productLines, serviceLines, completionIndex, paymentIntentIdsByOrderId] =
    await Promise.all([
      db
        .select()
        .from(commerceOrderProductLine)
        .where(eq(commerceOrderProductLine.orderId, order.id))
        .orderBy(asc(commerceOrderProductLine.siblingOrder)),
      db
        .select()
        .from(commerceOrderServiceLine)
        .where(eq(commerceOrderServiceLine.orderId, order.id))
        .orderBy(asc(commerceOrderServiceLine.siblingOrder)),
      loadOrderCompletionIndex(order.id),
      loadLivePaymentIntentIdsByOrderId([order.id]),
    ]);

  return {
    id: order.id,
    buyerOrganizationId: order.buyerOrganizationId,
    counterpartyOrganizationId: order.counterpartyOrganizationId,
    checkoutGroupId: order.checkoutGroupId,
    source: order.source,
    state: order.state,
    acceptedQuoteId: order.acceptedQuoteId,
    currency: order.currency,
    subtotalInCents: order.subtotalInCents,
    taxInCents: order.taxInCents,
    serviceFeeInCents: order.serviceFeeInCents,
    shippingInCents: order.shippingInCents,
    discountInCents: order.discountInCents,
    totalInCents: order.totalInCents,
    paymentTermsSnapshot: order.paymentTermsSnapshot,
    incotermSnapshot: order.incotermSnapshot,
    buyerLegalNameSnapshot: order.buyerLegalNameSnapshot,
    counterpartyLegalNameSnapshot: order.counterpartyLegalNameSnapshot,
    settlementRail: order.settlementRail,
    // Derived, never stored twice: one fact cannot then disagree with itself.
    hasEscrowProtection: order.settlementRail === "external_escrow",
    paymentIntentId: paymentIntentIdsByOrderId.get(order.id) ?? null,
    createdAt: order.createdAt,
    completionIds: completionIndex.completionIds,
    productLines: productLines.map((line) =>
      projectOrderProductLine(
        line,
        completionIndex.completionIdByProductLineId.get(line.id) ?? null,
      ),
    ),
    serviceLines: serviceLines.map(projectOrderServiceLine),
  };
}

async function listOrdersBy(
  organizationFilter: SQL,
  input: ListOrdersInput,
): Promise<Result<OrderListPage, CommerceOrdersError>> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          lt(commerceOrder.createdAt, new Date(decodedCursor.sortKey)),
          and(
            eq(commerceOrder.createdAt, new Date(decodedCursor.sortKey)),
            gt(commerceOrder.id, decodedCursor.id),
          ),
        );

  const statePredicate =
    input.state === undefined ? undefined : eq(commerceOrder.state, input.state);

  const rows = await db
    .select()
    .from(commerceOrder)
    .where(and(organizationFilter, statePredicate, cursorPredicate))
    .orderBy(desc(commerceOrder.createdAt), asc(commerceOrder.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  const paymentIntentIdsByOrderId = await loadLivePaymentIntentIdsByOrderId(
    pageRows.map((row) => row.id),
  );

  return {
    success: true,
    value: {
      items: pageRows.map((row) =>
        summarizeOrder(row, paymentIntentIdsByOrderId.get(row.id) ?? null),
      ),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

/** Every order the caller's organization bought, most recent first. */
export async function listBuyerOrders(
  actor: CommerceOrderActorContext,
  input: ListOrdersInput,
): Promise<Result<OrderListPage, CommerceOrdersError>> {
  return listOrdersBy(eq(commerceOrder.buyerOrganizationId, actor.organizationId), input);
}

/** Every order the caller's organization is fulfilling as seller or provider. */
export async function listCounterpartyOrders(
  actor: CommerceOrderActorContext,
  input: ListOrdersInput,
): Promise<Result<OrderListPage, CommerceOrdersError>> {
  return listOrdersBy(eq(commerceOrder.counterpartyOrganizationId, actor.organizationId), input);
}

/** Visible to the buyer or the counterparty organization only; anyone else gets a 404. */
export async function getOrder(
  actor: CommerceOrderActorContext,
  orderId: string,
): Promise<Result<OrderDetailProjection, CommerceOrdersError>> {
  const [order] = await db
    .select()
    .from(commerceOrder)
    .where(eq(commerceOrder.id, orderId))
    .limit(1);
  if (!order) return { success: false, error: { type: "NOT_FOUND" } };
  if (
    order.buyerOrganizationId !== actor.organizationId &&
    order.counterpartyOrganizationId !== actor.organizationId
  ) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  return { success: true, value: await projectOrderDetail(order) };
}

/**
 * Cancels an order still in `pending_payment` or `confirmed` — before any shipment has
 * moved it into `in_fulfillment`. Restocks only the quantity this order actually reserved
 * against live inventory (`quantityReserved - quantityFulfilled`); quote-accepted lines
 * carry a reservation of zero because their stock was never decremented in the first place.
 */
export async function cancelOrder(
  actor: CommerceOrderActorContext,
  orderId: string,
): Promise<Result<OrderDetailProjection, CommerceOrdersError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, orderId))
      .for("update");
    if (!order) return { status: "not_found" as const };
    if (
      order.buyerOrganizationId !== actor.organizationId &&
      order.counterpartyOrganizationId !== actor.organizationId
    ) {
      return { status: "not_found" as const };
    }
    if (!CANCELLABLE_ORDER_STATES.includes(order.state)) {
      return { status: "invalid_state" as const };
    }

    const now = new Date();
    const productLines = await transaction
      .select()
      .from(commerceOrderProductLine)
      .where(eq(commerceOrderProductLine.orderId, order.id))
      .for("update");

    const productIds = [
      ...new Set(
        productLines
          .map((line) => line.productId)
          .filter((productId): productId is string => productId !== null),
      ),
    ];
    if (productIds.length > 0) {
      await transaction
        .select({ id: product.id })
        .from(product)
        .where(inArray(product.id, productIds))
        .for("update");
    }

    for (const line of productLines) {
      const remainingUncancelled =
        line.quantityOrdered - line.quantityFulfilled - line.quantityCancelled;
      if (remainingUncancelled <= 0) continue;

      await transaction
        .update(commerceOrderProductLine)
        .set({ quantityCancelled: line.quantityCancelled + remainingUncancelled })
        .where(eq(commerceOrderProductLine.id, line.id));

      const restockQuantity = Math.max(0, line.quantityReserved - line.quantityFulfilled);
      if (restockQuantity > 0 && line.productId !== null) {
        await transaction
          .update(product)
          .set({ stockQuantity: sql`${product.stockQuantity} + ${restockQuantity}` })
          .where(eq(product.id, line.productId));
      }
    }

    await transaction
      .update(commerceServiceEngagement)
      .set({ state: "cancelled", cancelledAt: now, updatedAt: now })
      .where(
        and(
          eq(commerceServiceEngagement.orderId, order.id),
          inArray(commerceServiceEngagement.state, CANCELLABLE_ENGAGEMENT_STATES),
        ),
      );

    const [cancelledOrder] = await transaction
      .update(commerceOrder)
      // STORE Phase 13. `cancelledAt` is the cancellation-rate clock. Until it existed the
      // only durable record that a cancellation happened at a particular time was an audit
      // row, and `updatedAt` moved again on the next write to the order.
      .set({
        state: "cancelled",
        cancelledAt: sql`coalesce(${commerceOrder.cancelledAt}, ${now})`,
        updatedAt: now,
      })
      .where(
        and(eq(commerceOrder.id, order.id), inArray(commerceOrder.state, CANCELLABLE_ORDER_STATES)),
      )
      .returning();
    if (!cancelledOrder) return { status: "conflict" as const };

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "order_cancelled",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_order",
      targetEntityId: order.id,
      payload: { orderId: order.id, previousState: order.state },
      occurredAt: now,
    });

    return { status: "cancelled" as const, order: cancelledOrder };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    case "conflict":
      return {
        success: false,
        error: { type: "CONFLICT", message: "Order cancellation raced with another update." },
      };
    case "cancelled":
      return { success: true, value: await projectOrderDetail(outcome.order) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled cancelOrder outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
