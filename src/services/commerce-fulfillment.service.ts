import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrder,
  commerceOrderProductLine,
  commerceEngagementDeliverable,
  commerceServiceEngagement,
  commerceServiceEngagementEvent,
  commerceShipment,
  commerceShipmentEvent,
  commerceShipmentLeg,
  commerceShipmentProductLine,
} from "#src/db/schema.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import type { ShipmentLegInput } from "#src/schemas/commerce-fulfillment.schemas.js";
import { issueCompletionsForOrder } from "#src/services/commerce-completion.service.js";
import { insertShipmentLegs } from "#src/services/commerce-fulfillment-phase6.service.js";
import {
  canExecutePaidFulfillmentForOrderState,
  finalizeShipmentState,
  isRequiredDeliverableSatisfied,
  reconcileOrderAggregateState,
} from "#src/services/commerce-fulfillment-reconciliation.service.js";
import {
  memberCanOperateBuyer,
  memberCanOperateCounterparty,
  memberCanOperateProvider,
  type CommerceOrganizationMemberRole,
} from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OrderRow = typeof commerceOrder.$inferSelect;
type OrderState = OrderRow["state"];
type ProductLineRow = typeof commerceOrderProductLine.$inferSelect;
type ShipmentRow = typeof commerceShipment.$inferSelect;
type ShipmentState = ShipmentRow["state"];
type ShipmentEventKind = (typeof commerceShipmentEvent.$inferSelect)["eventKind"];
/** Event kinds a caller may append explicitly — `created` is stamped only by `createShipment`. */
type AppendableShipmentEventKind = Exclude<ShipmentEventKind, "created">;
type EngagementRow = typeof commerceServiceEngagement.$inferSelect;
type EngagementState = EngagementRow["state"];

export type CommerceFulfillmentError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "INVALID_STATE" }
  | { type: "INVALID_CURSOR" }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "CONFLICT"; message: string };

export interface CommerceFulfillmentActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

/** Order states a shipment may be raised against — after payment confirmation. */
const SHIPPABLE_ORDER_STATES: readonly OrderState[] = [
  "confirmed",
  "in_fulfillment",
  "partially_completed",
];

const SHIPMENT_TERMINAL_STATES: readonly ShipmentState[] = ["delivered", "cancelled"];

export interface CreateShipmentProductLineInput {
  readonly orderProductLineId: string;
  readonly quantity: number;
}

export interface CreateShipmentInput {
  readonly lines: readonly CreateShipmentProductLineInput[];
  readonly originCountryCode?: string;
  readonly originLocality?: string;
  readonly destinationCountryCode?: string;
  readonly destinationLocality?: string;
  readonly packageCount: number;
  readonly totalWeightGrams?: number;
  readonly legs?: readonly ShipmentLegInput[];
}

export interface ShipmentProductLineProjection {
  readonly id: string;
  readonly orderProductLineId: string;
  readonly quantity: number;
}

export interface ShipmentEventProjection {
  readonly id: string;
  readonly eventKind: ShipmentEventKind;
  readonly occurredAt: Date;
  readonly description: string | null;
}

export interface ShipmentProjection {
  readonly id: string;
  readonly orderId: string;
  readonly state: ShipmentState;
  readonly originCountryCode: string | null;
  readonly originLocality: string | null;
  readonly destinationCountryCode: string | null;
  readonly destinationLocality: string | null;
  readonly packageCount: number;
  readonly totalWeightGrams: number | null;
  readonly createdAt: Date;
  readonly productLines: readonly ShipmentProductLineProjection[];
  readonly events: readonly ShipmentEventProjection[];
}

export interface AppendShipmentEventInput {
  readonly eventKind: AppendableShipmentEventKind;
  readonly occurredAt?: Date;
  readonly description?: string;
}

export interface ListServiceEngagementsInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly role?: "buyer" | "provider";
}

export interface ServiceEngagementProjection {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly providerOrganizationId: string;
  readonly orderId: string;
  readonly orderServiceLineId: string;
  readonly providerKind: EngagementRow["providerKind"];
  readonly state: EngagementState;
  readonly titleSnapshot: string;
  readonly scopeSnapshot: string;
  readonly scheduledAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
}

export interface ServiceEngagementListPage {
  readonly items: readonly ServiceEngagementProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/** Targets a caller may transition an engagement to, keyed by which side may act. */
export type ServiceEngagementTransitionTarget =
  | "scheduled"
  | "in_progress"
  | "awaiting_buyer"
  | "completed"
  | "cancelled";

export interface TransitionServiceEngagementInput {
  readonly targetState: ServiceEngagementTransitionTarget;
  readonly note?: string;
}

const DEFAULT_PAGE_LIMIT = 20;

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce fulfillment audit append failed: ${appended.error.type}`);
  }
}

function projectShipment(
  shipment: ShipmentRow,
  productLines: readonly (typeof commerceShipmentProductLine.$inferSelect)[],
  events: readonly (typeof commerceShipmentEvent.$inferSelect)[],
): ShipmentProjection {
  return {
    id: shipment.id,
    orderId: shipment.orderId,
    state: shipment.state,
    originCountryCode: shipment.originCountryCode,
    originLocality: shipment.originLocality,
    destinationCountryCode: shipment.destinationCountryCode,
    destinationLocality: shipment.destinationLocality,
    packageCount: shipment.packageCount,
    totalWeightGrams: shipment.totalWeightGrams,
    createdAt: shipment.createdAt,
    productLines: productLines.map((line) => ({
      id: line.id,
      orderProductLineId: line.orderProductLineId,
      quantity: line.quantity,
    })),
    events: events.map((event) => ({
      id: event.id,
      eventKind: event.eventKind,
      occurredAt: event.occurredAt,
      description: event.description,
    })),
  };
}

async function loadShipmentProjection(shipmentId: string): Promise<ShipmentProjection | null> {
  const [shipment] = await db
    .select()
    .from(commerceShipment)
    .where(eq(commerceShipment.id, shipmentId))
    .limit(1);
  if (!shipment) return null;

  const [productLines, events] = await Promise.all([
    db
      .select()
      .from(commerceShipmentProductLine)
      .where(eq(commerceShipmentProductLine.shipmentId, shipmentId)),
    db
      .select()
      .from(commerceShipmentEvent)
      .where(eq(commerceShipmentEvent.shipmentId, shipmentId))
      .orderBy(asc(commerceShipmentEvent.occurredAt), asc(commerceShipmentEvent.id)),
  ]);

  return projectShipment(shipment, productLines, events);
}

/**
 * Creates a shipment against an order that is confirmed or already in fulfillment.
 * Payment must settle first — shipping before confirmation would lock the order out of
 * payment-intent creation (`pending_payment` only).
 */
export async function createShipment(
  actor: CommerceFulfillmentActorContext,
  orderId: string,
  input: CreateShipmentInput,
): Promise<Result<ShipmentProjection, CommerceFulfillmentError>> {
  if (!memberCanOperateCounterparty(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }
  if (input.lines.length === 0) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "At least one shipment line is required." },
    };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, orderId))
      .for("update");
    if (!order) return { status: "not_found" as const };
    if (order.counterpartyOrganizationId !== actor.organizationId) {
      return { status: "not_found" as const };
    }
    if (!SHIPPABLE_ORDER_STATES.includes(order.state)) {
      return { status: "invalid_state" as const };
    }

    const orderProductLineIds = input.lines.map((line) => line.orderProductLineId);
    const uniqueOrderProductLineIds = [...new Set(orderProductLineIds)];
    if (uniqueOrderProductLineIds.length !== orderProductLineIds.length) {
      return {
        status: "validation_failed" as const,
        message: "Duplicate orderProductLineId in shipment lines.",
      };
    }

    const productLines = await transaction
      .select()
      .from(commerceOrderProductLine)
      .where(
        and(
          eq(commerceOrderProductLine.orderId, order.id),
          inArray(commerceOrderProductLine.id, uniqueOrderProductLineIds),
        ),
      )
      .for("update");
    const productLinesById = new Map<string, ProductLineRow>(
      productLines.map((line) => [line.id, line]),
    );

    const alreadyShippedByLineId = await loadShippedQuantitiesByOrderProductLine(
      transaction,
      uniqueOrderProductLineIds,
    );

    for (const requestedLine of input.lines) {
      const orderProductLine = productLinesById.get(requestedLine.orderProductLineId);
      if (!orderProductLine) {
        return {
          status: "validation_failed" as const,
          message: `Order product line ${requestedLine.orderProductLineId} does not belong to this order.`,
        };
      }
      const alreadyShipped = alreadyShippedByLineId.get(orderProductLine.id) ?? 0;
      const remaining =
        orderProductLine.quantityOrdered -
        orderProductLine.quantityFulfilled -
        orderProductLine.quantityCancelled -
        alreadyShipped;
      if (requestedLine.quantity <= 0 || requestedLine.quantity > remaining) {
        return {
          status: "validation_failed" as const,
          message: `Requested quantity for line ${orderProductLine.id} exceeds the remaining unfulfilled quantity (${String(remaining)}).`,
        };
      }
    }

    const now = new Date();
    const [insertedShipment] = await transaction
      .insert(commerceShipment)
      .values({
        orderId: order.id,
        state: "planned",
        originCountryCode: input.originCountryCode ?? null,
        originLocality: input.originLocality ?? null,
        destinationCountryCode: input.destinationCountryCode ?? null,
        destinationLocality: input.destinationLocality ?? null,
        packageCount: input.packageCount,
        totalWeightGrams: input.totalWeightGrams ?? null,
        createdByMemberId: actor.memberId,
      })
      .returning();
    if (!insertedShipment) {
      return { status: "conflict" as const, message: "Shipment could not be created." };
    }

    await transaction.insert(commerceShipmentProductLine).values(
      input.lines.map((line) => ({
        shipmentId: insertedShipment.id,
        orderProductLineId: line.orderProductLineId,
        quantity: line.quantity,
      })),
    );

    await transaction.insert(commerceShipmentEvent).values({
      shipmentId: insertedShipment.id,
      eventKind: "created",
      occurredAt: now,
      description: null,
      createdByMemberId: actor.memberId,
    });

    if (input.legs !== undefined && input.legs.length > 0) {
      const legsResult = await insertShipmentLegs(
        transaction,
        insertedShipment.id,
        actor.memberId,
        input.legs,
      );
      if (!legsResult.success) {
        return {
          status: "validation_failed" as const,
          message:
            legsResult.error.type === "VALIDATION_FAILED"
              ? legsResult.error.message
              : legsResult.error.type === "PROVIDER_KIND_MISMATCH"
                ? "logisticsEngagementId must reference a freight or logistics engagement."
                : "Shipment legs could not be created.",
        };
      }
    }

    if (order.state === "confirmed") {
      await transaction
        .update(commerceOrder)
        .set({ state: "in_fulfillment", updatedAt: now })
        .where(eq(commerceOrder.id, order.id));
    }

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "shipment_created",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_shipment",
      targetEntityId: insertedShipment.id,
      payload: { orderId: order.id, shipmentId: insertedShipment.id },
      occurredAt: now,
    });

    return { status: "created" as const, shipmentId: insertedShipment.id };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    case "validation_failed":
      return { success: false, error: { type: "VALIDATION_FAILED", message: outcome.message } };
    case "conflict":
      return { success: false, error: { type: "CONFLICT", message: outcome.message } };
    case "created": {
      const projection = await loadShipmentProjection(outcome.shipmentId);
      if (!projection) throw new Error("Shipment vanished immediately after creation.");
      return { success: true, value: projection };
    }
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled createShipment outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Sums quantities already committed to OTHER shipments for each order product line, so a
 * second shipment cannot double-allocate stock the first one already claimed. Cancelled
 * shipments are excluded — their lines never fulfilled anything and free their allocation.
 */
async function loadShippedQuantitiesByOrderProductLine(
  transaction: DatabaseTransaction,
  orderProductLineIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderProductLineIds.length === 0) return new Map();

  const rows = await transaction
    .select({
      orderProductLineId: commerceShipmentProductLine.orderProductLineId,
      quantity: commerceShipmentProductLine.quantity,
      shipmentState: commerceShipment.state,
    })
    .from(commerceShipmentProductLine)
    .innerJoin(commerceShipment, eq(commerceShipment.id, commerceShipmentProductLine.shipmentId))
    .where(inArray(commerceShipmentProductLine.orderProductLineId, orderProductLineIds));

  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.shipmentState === "cancelled") continue;
    totals.set(row.orderProductLineId, (totals.get(row.orderProductLineId) ?? 0) + row.quantity);
  }
  return totals;
}

/**
 * Appends an append-only shipment event. `delivered` is the one event kind with a side
 * effect: it increments `quantityFulfilled` on every line this shipment carries, exactly
 * once — the shipment's own state is the guard against a double-delivery replay.
 */
export async function appendShipmentEvent(
  actor: CommerceFulfillmentActorContext,
  shipmentId: string,
  input: AppendShipmentEventInput,
): Promise<Result<ShipmentProjection, CommerceFulfillmentError>> {
  if (!memberCanOperateCounterparty(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [shipment] = await transaction
      .select()
      .from(commerceShipment)
      .where(eq(commerceShipment.id, shipmentId))
      .for("update");
    if (!shipment) return { status: "not_found" as const };

    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, shipment.orderId))
      .for("update");
    if (!order || order.counterpartyOrganizationId !== actor.organizationId) {
      return { status: "not_found" as const };
    }

    if (input.eventKind !== "exception" && !canExecutePaidFulfillmentForOrderState(order.state)) {
      return { status: "invalid_state" as const };
    }

    if (SHIPMENT_TERMINAL_STATES.includes(shipment.state)) {
      return { status: "conflict" as const, message: "This shipment is already finalized." };
    }

    if (input.eventKind === "delivered" || input.eventKind === "cancelled") {
      const [legCount] = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(commerceShipmentLeg)
        .where(eq(commerceShipmentLeg.shipmentId, shipment.id));
      if ((legCount?.count ?? 0) > 0) {
        return {
          status: "conflict" as const,
          message: "Shipments with legs must be advanced through shipment-leg commands.",
        };
      }
    }

    const recordedAt = new Date();
    const claimedOccurredAt = input.occurredAt ?? recordedAt;
    await transaction.insert(commerceShipmentEvent).values({
      shipmentId: shipment.id,
      eventKind: input.eventKind,
      occurredAt: claimedOccurredAt,
      description: input.description ?? null,
      createdByMemberId: actor.memberId,
    });

    switch (input.eventKind) {
      case "delivered": {
        await finalizeShipmentState(
          transaction,
          shipment.id,
          "delivered",
          recordedAt,
          actor.actorUserId,
        );
        break;
      }
      case "cancelled": {
        await finalizeShipmentState(
          transaction,
          shipment.id,
          "cancelled",
          recordedAt,
          actor.actorUserId,
        );
        break;
      }
      case "picked_up":
      case "in_transit": {
        await transaction
          .update(commerceShipment)
          .set({
            state: "in_transit",
            version: shipment.version + 1,
            updatedAt: recordedAt,
          })
          .where(eq(commerceShipment.id, shipment.id));
        break;
      }
      case "exception": {
        // No shipment-state change; the event is the record.
        break;
      }
      default: {
        const exhaustiveCheck: never = input.eventKind;
        throw new Error(`Unhandled shipment event kind: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "shipment_event_recorded",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_shipment",
      targetEntityId: shipment.id,
      payload: {
        shipmentId: shipment.id,
        eventKind: input.eventKind,
        claimedOccurredAt: claimedOccurredAt.toISOString(),
      },
      occurredAt: recordedAt,
    });

    return { status: "recorded" as const, shipmentId: shipment.id };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    case "conflict":
      return { success: false, error: { type: "CONFLICT", message: outcome.message } };
    case "recorded": {
      const projection = await loadShipmentProjection(outcome.shipmentId);
      if (!projection) throw new Error("Shipment vanished immediately after an event append.");
      return { success: true, value: projection };
    }
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled appendShipmentEvent outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function projectEngagement(engagement: EngagementRow): ServiceEngagementProjection {
  return {
    id: engagement.id,
    buyerOrganizationId: engagement.buyerOrganizationId,
    providerOrganizationId: engagement.providerOrganizationId,
    orderId: engagement.orderId,
    orderServiceLineId: engagement.orderServiceLineId,
    providerKind: engagement.providerKind,
    state: engagement.state,
    titleSnapshot: engagement.titleSnapshot,
    scopeSnapshot: engagement.scopeSnapshot,
    scheduledAt: engagement.scheduledAt,
    startedAt: engagement.startedAt,
    completedAt: engagement.completedAt,
    cancelledAt: engagement.cancelledAt,
    createdAt: engagement.createdAt,
  };
}

/** Engagements where the caller's organization is buyer or provider, filtered by `role` if given. */
export async function listServiceEngagements(
  actor: CommerceFulfillmentActorContext,
  input: ListServiceEngagementsInput,
): Promise<Result<ServiceEngagementListPage, CommerceFulfillmentError>> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const decodedCursor =
    input.cursor === undefined ? null : decodeTimestampStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const membershipFilter =
    input.role === "buyer"
      ? eq(commerceServiceEngagement.buyerOrganizationId, actor.organizationId)
      : input.role === "provider"
        ? eq(commerceServiceEngagement.providerOrganizationId, actor.organizationId)
        : or(
            eq(commerceServiceEngagement.buyerOrganizationId, actor.organizationId),
            eq(commerceServiceEngagement.providerOrganizationId, actor.organizationId),
          );

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          lt(commerceServiceEngagement.createdAt, decodedCursor.sortKey),
          and(
            eq(commerceServiceEngagement.createdAt, decodedCursor.sortKey),
            gt(commerceServiceEngagement.id, decodedCursor.id),
          ),
        );

  const rows = await db
    .select()
    .from(commerceServiceEngagement)
    .where(and(membershipFilter, cursorPredicate))
    .orderBy(desc(commerceServiceEngagement.createdAt), asc(commerceServiceEngagement.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map(projectEngagement),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

/**
 * Guarded transition matrix. The provider drives the working states forward; the buyer's
 * only lever is completing (or reopening) work sitting in `awaiting_buyer`. Terminal states
 * (`completed`, `cancelled`, `disputed`) have no outgoing entry — `disputed` is reserved for
 * a future dispute flow and is not a target this function accepts today.
 */
const ENGAGEMENT_TRANSITIONS: Readonly<
  Record<EngagementState, ReadonlySet<ServiceEngagementTransitionTarget>>
> = {
  awaiting_provider: new Set(["scheduled", "cancelled"]),
  scheduled: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["awaiting_buyer", "completed", "cancelled"]),
  awaiting_buyer: new Set(["completed", "in_progress"]),
  completed: new Set(),
  cancelled: new Set(),
  disputed: new Set(),
};

/** Which side of the engagement may drive a given target state. */
function actingSideFor(targetState: ServiceEngagementTransitionTarget): "buyer" | "provider" {
  switch (targetState) {
    case "completed":
      // A provider may also mark work complete directly from in_progress.
      return "buyer";
    case "scheduled":
    case "in_progress":
    case "cancelled":
      return "provider";
    case "awaiting_buyer":
      return "provider";
    default: {
      const exhaustiveCheck: never = targetState;
      throw new Error(`Unhandled transition target: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function timestampPatchFor(
  targetState: ServiceEngagementTransitionTarget,
  now: Date,
): Partial<Pick<EngagementRow, "scheduledAt" | "startedAt" | "completedAt" | "cancelledAt">> {
  switch (targetState) {
    case "scheduled":
      return { scheduledAt: now };
    case "in_progress":
      return { startedAt: now };
    case "awaiting_buyer":
      return {};
    case "completed":
      return { completedAt: now };
    case "cancelled":
      return { cancelledAt: now };
    default: {
      const exhaustiveCheck: never = targetState;
      throw new Error(`Unhandled transition target: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Transitions a service engagement along the guarded matrix above. `note`, when given, is
 * never persisted on the engagement row itself — it exists only as audit-trail context, so
 * it is validated for length here and carried solely in the audit payload.
 */
export async function transitionServiceEngagement(
  actor: CommerceFulfillmentActorContext,
  engagementId: string,
  input: TransitionServiceEngagementInput,
): Promise<Result<ServiceEngagementProjection, CommerceFulfillmentError>> {
  if (input.note !== undefined && input.note.length > 2000) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "note must be at most 2000 characters." },
    };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [engagementIdentity] = await transaction
      .select({
        id: commerceServiceEngagement.id,
        orderId: commerceServiceEngagement.orderId,
      })
      .from(commerceServiceEngagement)
      .where(eq(commerceServiceEngagement.id, engagementId))
      .limit(1);
    if (!engagementIdentity) return { status: "not_found" as const };

    const [lockedOrder] = await transaction
      .select({ id: commerceOrder.id, state: commerceOrder.state })
      .from(commerceOrder)
      .where(eq(commerceOrder.id, engagementIdentity.orderId))
      .for("update");
    if (!lockedOrder) return { status: "not_found" as const };

    const [engagement] = await transaction
      .select()
      .from(commerceServiceEngagement)
      .where(eq(commerceServiceEngagement.id, engagementId))
      .for("update");
    if (!engagement) return { status: "not_found" as const };

    const isBuyer = engagement.buyerOrganizationId === actor.organizationId;
    const isProvider = engagement.providerOrganizationId === actor.organizationId;
    if (!isBuyer && !isProvider) return { status: "not_found" as const };

    const requiredSide = actingSideFor(input.targetState);
    const actorSideMatches = requiredSide === "buyer" ? isBuyer : isProvider;
    // A provider may also complete their own in-progress work directly, without waiting
    // on the buyer — the matrix already allows in_progress -> completed for that case.
    const providerCompletingOwnWork =
      input.targetState === "completed" && isProvider && engagement.state === "in_progress";
    if (!actorSideMatches && !providerCompletingOwnWork) {
      return { status: "forbidden" as const };
    }
    const actingAsProvider = providerCompletingOwnWork || requiredSide === "provider";
    const memberRoleAuthorized = actingAsProvider
      ? memberCanOperateProvider(actor.memberRole)
      : memberCanOperateBuyer(actor.memberRole);
    if (!memberRoleAuthorized) {
      return { status: "forbidden" as const };
    }

    const isPrepaymentCancellation =
      (lockedOrder.state === "pending_payment" || lockedOrder.state === "payment_processing") &&
      input.targetState === "cancelled";
    if (!canExecutePaidFulfillmentForOrderState(lockedOrder.state) && !isPrepaymentCancellation) {
      return { status: "invalid_state" as const };
    }

    const allowedTargets = ENGAGEMENT_TRANSITIONS[engagement.state];
    if (!allowedTargets.has(input.targetState)) {
      return { status: "invalid_state" as const };
    }

    if (input.targetState === "completed") {
      const requiredRows = await transaction
        .select({
          id: commerceEngagementDeliverable.id,
          state: commerceEngagementDeliverable.state,
        })
        .from(commerceEngagementDeliverable)
        .where(
          and(
            eq(commerceEngagementDeliverable.engagementId, engagement.id),
            eq(commerceEngagementDeliverable.isRequired, true),
          ),
        );
      const incompleteIds = requiredRows
        .filter((row) => !isRequiredDeliverableSatisfied(row.state))
        .map((row) => row.id);
      if (incompleteIds.length > 0) {
        return {
          status: "validation_failed" as const,
          message: `Required deliverables are incomplete: ${incompleteIds.join(", ")}`,
        };
      }
      if (engagement.executionContractState === "legacy_missing_snapshot") {
        return {
          status: "validation_failed" as const,
          message:
            "This engagement is missing an accepted typed execution snapshot. Initialize it before completing.",
        };
      }
      if (engagement.requiresDeliverableNormalization) {
        return {
          status: "validation_failed" as const,
          message:
            "This engagement has an unresolved free-text deliverable obligation. Normalize structured deliverables before completing.",
        };
      }
    }

    const now = new Date();
    const [updatedEngagement] = await transaction
      .update(commerceServiceEngagement)
      .set({
        state: input.targetState,
        version: engagement.version + 1,
        updatedAt: now,
        ...timestampPatchFor(input.targetState, now),
      })
      .where(
        and(
          eq(commerceServiceEngagement.id, engagement.id),
          eq(commerceServiceEngagement.state, engagement.state),
        ),
      )
      .returning();
    if (!updatedEngagement) {
      return { status: "conflict" as const, message: "Engagement state changed concurrently." };
    }

    const [latestEvent] = await transaction
      .select({ sequence: commerceServiceEngagementEvent.sequence })
      .from(commerceServiceEngagementEvent)
      .where(eq(commerceServiceEngagementEvent.engagementId, engagement.id))
      .orderBy(desc(commerceServiceEngagementEvent.sequence))
      .limit(1);
    await transaction.insert(commerceServiceEngagementEvent).values({
      engagementId: engagement.id,
      sequence: (latestEvent?.sequence ?? -1) + 1,
      previousState: engagement.state,
      nextState: input.targetState,
      commandKind: "compatibility_transition",
      note: input.note ?? null,
      occurredAt: now,
      createdByMemberId: actor.memberId,
    });
    await reconcileOrderAggregateState(transaction, engagement.orderId, now);
    if (input.targetState === "completed") {
      await issueCompletionsForOrder(transaction, engagement.orderId, now, actor.actorUserId);
    }

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "service_engagement_transitioned",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_service_engagement",
      targetEntityId: engagement.id,
      payload: {
        engagementId: engagement.id,
        previousState: engagement.state,
        targetState: input.targetState,
        note: input.note ?? null,
      },
      occurredAt: now,
    });

    return { status: "transitioned" as const, engagement: updatedEngagement };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "forbidden":
      return { success: false, error: { type: "FORBIDDEN" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    case "validation_failed":
      return { success: false, error: { type: "VALIDATION_FAILED", message: outcome.message } };
    case "conflict":
      return { success: false, error: { type: "CONFLICT", message: outcome.message } };
    case "transitioned":
      return { success: true, value: projectEngagement(outcome.engagement) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(
        `Unhandled transitionServiceEngagement outcome: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}
