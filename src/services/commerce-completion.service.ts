import { and, eq, gt, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCompletion,
  commerceOrder,
  commerceOrderProductLine,
  commerceServiceEngagement,
} from "#src/db/schema.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";

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
