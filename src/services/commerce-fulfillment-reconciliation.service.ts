import { eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrder,
  commerceOrderProductLine,
  commerceServiceEngagement,
  commerceShipment,
  commerceShipmentEvent,
  commerceShipmentLeg,
  commerceShipmentProductLine,
} from "#src/db/schema.js";
import { issueCompletionsForOrder } from "#src/services/commerce-completion.service.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OrderState = typeof commerceOrder.$inferSelect.state;
type ShipmentTerminalState = "delivered" | "cancelled";

export function deriveShipmentTerminalState(
  shipmentLegStates: readonly (typeof commerceShipmentLeg.$inferSelect.state)[],
): ShipmentTerminalState | null {
  if (shipmentLegStates.length === 0) return null;

  const nonCancelledLegStates = shipmentLegStates.filter(
    (shipmentLegState) => shipmentLegState !== "cancelled",
  );
  if (nonCancelledLegStates.length === 0) return "cancelled";
  return nonCancelledLegStates.every((shipmentLegState) => shipmentLegState === "completed")
    ? "delivered"
    : null;
}

export function deriveOrderAggregateState(
  productLines: readonly {
    readonly quantityFulfilled: number;
    readonly quantityCancelled: number;
    readonly quantityOrdered: number;
  }[],
  serviceEngagements: readonly {
    readonly state: (typeof commerceServiceEngagement.$inferSelect)["state"];
  }[],
  currentState: OrderState,
): OrderState {
  if (
    currentState === "completed" ||
    currentState === "cancelled" ||
    currentState === "disputed" ||
    currentState === "pending_payment" ||
    currentState === "payment_processing"
  ) {
    return currentState;
  }

  const productWorkComplete = productLines.every(
    (productLine) =>
      productLine.quantityFulfilled + productLine.quantityCancelled >= productLine.quantityOrdered,
  );
  const serviceWorkComplete = serviceEngagements.every(
    (serviceEngagement) =>
      serviceEngagement.state === "completed" || serviceEngagement.state === "cancelled",
  );
  const hasFulfillmentWork = productLines.length > 0 || serviceEngagements.length > 0;
  if (hasFulfillmentWork && productWorkComplete && serviceWorkComplete) return "completed";

  const anyWorkCompleted =
    productLines.some((productLine) => productLine.quantityFulfilled > 0) ||
    serviceEngagements.some((serviceEngagement) => serviceEngagement.state === "completed");
  if (anyWorkCompleted) return "partially_completed";

  return currentState === "confirmed" ? "in_fulfillment" : currentState;
}

export async function reconcileOrderAggregateState(
  transaction: DatabaseTransaction,
  orderId: string,
  occurredAt: Date,
): Promise<void> {
  const [order] = await transaction
    .select()
    .from(commerceOrder)
    .where(eq(commerceOrder.id, orderId))
    .for("update");
  if (!order) {
    throw new Error("Order vanished during fulfillment reconciliation.");
  }

  const [orderProductLines, serviceEngagements] = await Promise.all([
    transaction
      .select()
      .from(commerceOrderProductLine)
      .where(eq(commerceOrderProductLine.orderId, order.id)),
    transaction
      .select()
      .from(commerceServiceEngagement)
      .where(eq(commerceServiceEngagement.orderId, order.id)),
  ]);
  const nextOrderState = deriveOrderAggregateState(
    orderProductLines,
    serviceEngagements,
    order.state,
  );
  if (nextOrderState !== order.state) {
    await transaction
      .update(commerceOrder)
      .set({ state: nextOrderState, updatedAt: occurredAt })
      .where(eq(commerceOrder.id, order.id));
  }
}

/**
 * Applies the shared shipment terminal side effects exactly once while the shipment is locked.
 * Event creation remains with the caller so legacy and leg-driven paths can retain their own
 * append-only event metadata.
 */
export async function finalizeShipmentState(
  transaction: DatabaseTransaction,
  shipmentId: string,
  targetState: ShipmentTerminalState,
  occurredAt: Date,
): Promise<boolean> {
  const [shipment] = await transaction
    .select()
    .from(commerceShipment)
    .where(eq(commerceShipment.id, shipmentId))
    .for("update");
  if (!shipment || shipment.state === "delivered" || shipment.state === "cancelled") {
    return false;
  }

  const [order] = await transaction
    .select()
    .from(commerceOrder)
    .where(eq(commerceOrder.id, shipment.orderId))
    .for("update");
  if (!order) {
    throw new Error("Shipment order vanished during fulfillment reconciliation.");
  }

  if (targetState === "delivered") {
    const shipmentProductLines = await transaction
      .select()
      .from(commerceShipmentProductLine)
      .where(eq(commerceShipmentProductLine.shipmentId, shipment.id));

    for (const shipmentProductLine of shipmentProductLines) {
      await transaction
        .update(commerceOrderProductLine)
        .set({
          quantityFulfilled: sql`${commerceOrderProductLine.quantityFulfilled} + ${shipmentProductLine.quantity}`,
        })
        .where(eq(commerceOrderProductLine.id, shipmentProductLine.orderProductLineId));
    }
  }

  await transaction
    .update(commerceShipment)
    .set({
      state: targetState,
      version: shipment.version + 1,
      updatedAt: occurredAt,
    })
    .where(eq(commerceShipment.id, shipment.id));

  await reconcileOrderAggregateState(transaction, order.id, occurredAt);
  await issueCompletionsForOrder(transaction, order.id, occurredAt, null);

  return true;
}

export async function reconcileShipmentStateFromLegs(
  transaction: DatabaseTransaction,
  shipmentId: string,
  occurredAt: Date,
  createdByMemberId: string,
): Promise<void> {
  const shipmentLegs = await transaction
    .select({ state: commerceShipmentLeg.state })
    .from(commerceShipmentLeg)
    .where(eq(commerceShipmentLeg.shipmentId, shipmentId));
  if (shipmentLegs.length === 0) return;

  const targetState = deriveShipmentTerminalState(
    shipmentLegs.map((shipmentLeg) => shipmentLeg.state),
  );
  if (targetState === null) return;

  const finalized = await finalizeShipmentState(transaction, shipmentId, targetState, occurredAt);
  if (!finalized) return;

  await transaction.insert(commerceShipmentEvent).values({
    shipmentId,
    eventKind: targetState,
    occurredAt,
    description:
      targetState === "delivered"
        ? "Derived from terminal shipment-leg states."
        : "All shipment legs were cancelled.",
    createdByMemberId,
  });
}
