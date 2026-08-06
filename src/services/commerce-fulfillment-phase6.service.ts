import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import { db } from "#src/db/index.js";
import {
  commerceEncryptedDocument,
  commerceEngagementDeliverable,
  commerceEngagementDeliverableEvent,
  commerceFulfillmentCommand,
  commerceOrder,
  commerceOrderProductLine,
  commerceOrderServiceLink,
  commerceServiceEngagement,
  commerceServiceEngagementEvent,
  commerceShipment,
  commerceShipmentEvent,
  commerceShipmentLeg,
  commerceShipmentLegEvent,
  commerceShipmentProductLine,
  customsBrokerageDeliverableDetail,
  customsBrokerageEngagementDetail,
  foreignExchangeDeliverableDetail,
  foreignExchangeEngagementDetail,
  freightDeliverableDetail,
  freightEngagementDetail,
  inspectionDeliverableDetail,
  inspectionEngagementDetail,
  insuranceDeliverableDetail,
  insuranceEngagementDetail,
  marketingDeliverableDetail,
  marketingEngagementDetail,
  testingCertificationDeliverableDetail,
  testingCertificationEngagementDetail,
  warehouseDeliverableDetail,
  warehouseEngagementDetail,
} from "#src/db/schema.js";
import type {
  ServiceEngagementCommand,
  ShipmentLegCommand,
  ShipmentLegInput,
  TypedDeliverableResultSchema,
} from "#src/schemas/commerce-fulfillment.schemas.js";
import {
  reconcileOrderAggregateState,
  reconcileShipmentStateFromLegs,
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
type EngagementRow = typeof commerceServiceEngagement.$inferSelect;
type EngagementState = EngagementRow["state"];
type ProviderKind = EngagementRow["providerKind"];
type LegRow = typeof commerceShipmentLeg.$inferSelect;
type LegState = LegRow["state"];
type DeliverableResult = z.infer<typeof TypedDeliverableResultSchema>;

export type CommercePhase6Error =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "INVALID_STATE"; currentState: string; command: string }
  | { type: "VERSION_CONFLICT"; currentVersion: number }
  | { type: "IDEMPOTENCY_CONFLICT" }
  | { type: "PROVIDER_KIND_MISMATCH" }
  | { type: "CONTRACT_SNAPSHOT_MISSING" }
  | { type: "REQUIRED_DELIVERABLES_INCOMPLETE"; deliverableIds: readonly string[] }
  | { type: "DOCUMENT_NOT_AVAILABLE" }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "CONFLICT"; message: string };

export interface CommerceFulfillmentActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface FulfillmentIdempotencyContext {
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export type EngagementExecutionSnapshotProjection =
  | {
      readonly kind: "freight_forwarder" | "logistics_operator";
      readonly sourceQuoteServiceLineId: string | null;
      readonly transportModes: readonly string[];
      readonly originCountryCode: string | null;
      readonly destinationCountryCode: string | null;
      readonly estimatedTransitDays: number | null;
    }
  | {
      readonly kind: "customs_broker";
      readonly sourceQuoteServiceLineId: string | null;
      readonly jurisdictions: readonly string[];
      readonly filingSummary: string | null;
    }
  | {
      readonly kind: "insurance_provider";
      readonly sourceQuoteServiceLineId: string | null;
      readonly coverageClasses: readonly string[];
      readonly coverageLimitMinorUnits: string | null;
      readonly currency: string | null;
    }
  | {
      readonly kind: "inspection_agency";
      readonly sourceQuoteServiceLineId: string | null;
      readonly includedStages: readonly string[];
    }
  | {
      readonly kind: "testing_certification_lab";
      readonly sourceQuoteServiceLineId: string | null;
      readonly standards: readonly string[];
      readonly laboratoryLocation: string | null;
    }
  | {
      readonly kind: "marketing_agency";
      readonly sourceQuoteServiceLineId: string | null;
      readonly channels: readonly string[];
      readonly deliverablesSummary: string | null;
    }
  | {
      readonly kind: "warehouse_provider";
      readonly sourceQuoteServiceLineId: string | null;
      readonly storageTypes: readonly string[];
      readonly capacityUnits: string | null;
      readonly temperatureControlled: boolean;
    }
  | {
      readonly kind: "foreign_exchange_facilitator";
      readonly sourceQuoteServiceLineId: string | null;
      readonly currencyPair: string;
      readonly rate: { readonly units: string; readonly scale: number };
      readonly settlementRail: string | null;
      readonly notionalAmountMinorUnits: string | null;
      readonly notionalCurrency: string | null;
    };

export type DeliverableResultProjection =
  | { readonly kind: "freight_forwarder" | "logistics_operator"; readonly summary: string }
  | {
      readonly kind: "customs_broker";
      readonly filingKind: string;
      readonly jurisdiction: string;
      readonly providerFilingReference: string | null;
      readonly declarationReference: string | null;
      readonly decision: string | null;
    }
  | {
      readonly kind: "insurance_provider";
      readonly policyReference: string;
      readonly coverageClass: string;
      readonly insuredValueMinorUnits: string | null;
      readonly coverageLimitMinorUnits: string | null;
      readonly currency: string | null;
      readonly effectiveFrom: Date | null;
      readonly effectiveTo: Date | null;
    }
  | {
      readonly kind: "inspection_agency";
      readonly stage: string;
      readonly result: string;
      readonly findingsSummary: string | null;
      readonly inspectedQuantity: number | null;
      readonly inspectedAt: Date | null;
    }
  | {
      readonly kind: "testing_certification_lab";
      readonly standard: string;
      readonly specimenReference: string | null;
      readonly result: string;
      readonly laboratoryLocation: string | null;
      readonly reportedAt: Date | null;
    }
  | {
      readonly kind: "warehouse_provider";
      readonly movementKind: string;
      readonly quantityUnits: string;
      readonly quantityScale: number;
      readonly unitLabel: string;
      readonly facilityIdentifier: string | null;
      readonly occurredAt: Date | null;
    }
  | {
      readonly kind: "marketing_agency";
      readonly deliverableKind: string;
      readonly channel: string;
      readonly artifactUrl: string | null;
      readonly metricsSummary: string | null;
      readonly publishedAt: Date | null;
    }
  | {
      readonly kind: "foreign_exchange_facilitator";
      readonly currencyPair: string;
      readonly rate: { readonly units: string; readonly scale: number };
      readonly sellAmountMinorUnits: string;
      readonly buyAmountMinorUnits: string;
      readonly sellCurrency: string;
      readonly buyCurrency: string;
      readonly providerExecutionReference: string | null;
      readonly confirmationState: string;
    };

export type ServiceEngagementDetailProjection = ReturnType<typeof projectEngagement> & {
  readonly executionSnapshot: EngagementExecutionSnapshotProjection | null;
  readonly deliverables: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly title: string;
    readonly isRequired: boolean;
    readonly state: (typeof commerceEngagementDeliverable.$inferSelect)["state"];
    readonly dueAt: Date | null;
    readonly submittedAt: Date | null;
    readonly reviewedAt: Date | null;
    readonly evidenceDocumentId: string | null;
    readonly reviewNote: string | null;
    readonly result: DeliverableResultProjection | null;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly previousState: EngagementState | null;
    readonly nextState: EngagementState;
    readonly commandKind: string;
    readonly note: string | null;
    readonly occurredAt: Date;
  }[];
};

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce fulfillment audit append failed: ${appended.error.type}`);
  }
}

function fingerprintBody(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(",")}}`;
}

function parseCommandReplayBody(responseBody: string): unknown {
  const parsed: unknown = JSON.parse(responseBody);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Corrupt fulfillment command receipt body.");
  }
  return parsed;
}

export function buildFulfillmentRequestFingerprint(payload: unknown): string {
  return fingerprintBody(payload);
}

async function claimCommandReceipt(
  transaction: DatabaseTransaction,
  actor: CommerceFulfillmentActorContext,
  idempotency: FulfillmentIdempotencyContext,
): Promise<
  Result<
    | { status: "fresh" }
    | {
        status: "replay";
        responseBody: string;
      },
    CommercePhase6Error
  >
> {
  const advisoryLockKey = `${actor.organizationId}:${idempotency.idempotencyKey}`;
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${advisoryLockKey}, 0))`,
  );

  const [existing] = await transaction
    .select()
    .from(commerceFulfillmentCommand)
    .where(
      and(
        eq(commerceFulfillmentCommand.actorOrganizationId, actor.organizationId),
        eq(commerceFulfillmentCommand.idempotencyKey, idempotency.idempotencyKey),
      ),
    )
    .for("update")
    .limit(1);

  if (existing) {
    if (existing.requestFingerprint !== idempotency.requestFingerprint) {
      return { success: false, error: { type: "IDEMPOTENCY_CONFLICT" } };
    }
    return {
      success: true,
      value: {
        status: "replay",
        responseBody: existing.responseBody,
      },
    };
  }

  return { success: true, value: { status: "fresh" } };
}

async function finalizeCommandReceipt(
  transaction: DatabaseTransaction,
  actor: CommerceFulfillmentActorContext,
  idempotency: FulfillmentIdempotencyContext,
  targetKind: "shipment" | "shipment_leg" | "service_engagement" | "engagement_deliverable",
  targetId: string,
  commandKind: string,
  responseStatus: number,
  responseBody: unknown,
  resultingVersion: number | null,
): Promise<void> {
  await transaction.insert(commerceFulfillmentCommand).values({
    actorOrganizationId: actor.organizationId,
    actorUserId: actor.actorUserId,
    actorMemberId: actor.memberId,
    targetKind,
    targetId,
    commandKind,
    idempotencyKey: idempotency.idempotencyKey,
    requestFingerprint: idempotency.requestFingerprint,
    resultingVersion,
    responseStatus,
    responseBody: JSON.stringify(responseBody),
  });
}

async function assertAvailableDocument(
  transaction: DatabaseTransaction,
  organizationId: string,
  documentId: string,
): Promise<Result<true, CommercePhase6Error>> {
  const [document] = await transaction
    .select()
    .from(commerceEncryptedDocument)
    .where(eq(commerceEncryptedDocument.id, documentId))
    .limit(1);
  if (!document || document.organizationId !== organizationId) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (document.state !== "available") {
    return { success: false, error: { type: "DOCUMENT_NOT_AVAILABLE" } };
  }
  return { success: true, value: true };
}

export async function insertShipmentLegs(
  transaction: DatabaseTransaction,
  shipmentId: string,
  actorMemberId: string,
  legs: readonly ShipmentLegInput[],
): Promise<Result<readonly LegRow[], CommercePhase6Error>> {
  if (legs.length === 0) return { success: true, value: [] };

  const sequences = legs.map((leg) => leg.sequence);
  if (new Set(sequences).size !== sequences.length) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "Shipment leg sequences must be unique." },
    };
  }

  const [shipment] = await transaction
    .select()
    .from(commerceShipment)
    .where(eq(commerceShipment.id, shipmentId))
    .limit(1);
  if (!shipment) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  const [order] = await transaction
    .select()
    .from(commerceOrder)
    .where(eq(commerceOrder.id, shipment.orderId))
    .limit(1);
  if (!order) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  for (const leg of legs) {
    if (leg.logisticsEngagementId) {
      const [engagement] = await transaction
        .select()
        .from(commerceServiceEngagement)
        .where(eq(commerceServiceEngagement.id, leg.logisticsEngagementId))
        .limit(1);
      if (!engagement) {
        return { success: false, error: { type: "NOT_FOUND" } };
      }
      if (
        engagement.providerKind !== "freight_forwarder" &&
        engagement.providerKind !== "logistics_operator"
      ) {
        return { success: false, error: { type: "PROVIDER_KIND_MISMATCH" } };
      }
      if (
        engagement.buyerOrganizationId !== order.buyerOrganizationId ||
        engagement.state === "cancelled" ||
        engagement.state === "disputed"
      ) {
        return {
          success: false,
          error: {
            type: "VALIDATION_FAILED",
            message: "The logistics engagement must serve the shipment buyer and remain active.",
          },
        };
      }
      const [existingShipmentLink] = await transaction
        .select({ id: commerceOrderServiceLink.id })
        .from(commerceOrderServiceLink)
        .where(
          and(
            eq(commerceOrderServiceLink.engagementId, engagement.id),
            eq(commerceOrderServiceLink.orderId, shipment.orderId),
            eq(commerceOrderServiceLink.shipmentId, shipment.id),
          ),
        )
        .limit(1);
      if (!existingShipmentLink) {
        await transaction.insert(commerceOrderServiceLink).values({
          engagementId: engagement.id,
          orderId: shipment.orderId,
          shipmentId: shipment.id,
        });
      }
    }
  }

  const inserted: LegRow[] = [];
  for (const leg of legs) {
    const [row] = await transaction
      .insert(commerceShipmentLeg)
      .values({
        shipmentId,
        sequence: leg.sequence,
        mode: leg.mode,
        state: "planned",
        version: 0,
        originCountryCode: leg.originCountryCode,
        originLocality: leg.originLocality ?? null,
        originLocationIdentifier: leg.originLocationIdentifier ?? null,
        destinationCountryCode: leg.destinationCountryCode,
        destinationLocality: leg.destinationLocality ?? null,
        destinationLocationIdentifier: leg.destinationLocationIdentifier ?? null,
        logisticsEngagementId: leg.logisticsEngagementId ?? null,
        estimatedDepartureAt:
          leg.estimatedDepartureAt === undefined ? null : new Date(leg.estimatedDepartureAt),
        estimatedArrivalAt:
          leg.estimatedArrivalAt === undefined ? null : new Date(leg.estimatedArrivalAt),
        createdByMemberId: actorMemberId,
      })
      .returning();
    if (!row) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "Shipment leg could not be created." },
      };
    }
    await transaction.insert(commerceShipmentLegEvent).values({
      shipmentLegId: row.id,
      sequence: 0,
      eventKind: "created",
      occurredAt: new Date(),
      description: null,
      createdByMemberId: actorMemberId,
    });
    inserted.push(row);
  }
  return { success: true, value: inserted };
}

const LEG_TRANSITIONS: Readonly<Record<LegState, ReadonlySet<ShipmentLegCommand["command"]>>> = {
  planned: new Set(["book", "cancel", "report_exception"]),
  booked: new Set(["depart", "cancel", "report_exception"]),
  in_transit: new Set(["arrive", "cancel", "report_exception"]),
  arrived: new Set(["complete", "cancel", "report_exception"]),
  completed: new Set(),
  cancelled: new Set(),
};

function projectShipmentLeg(leg: LegRow) {
  return {
    id: leg.id,
    shipmentId: leg.shipmentId,
    sequence: leg.sequence,
    mode: leg.mode,
    state: leg.state,
    version: leg.version,
    originCountryCode: leg.originCountryCode,
    originLocality: leg.originLocality,
    originLocationIdentifier: leg.originLocationIdentifier,
    destinationCountryCode: leg.destinationCountryCode,
    destinationLocality: leg.destinationLocality,
    destinationLocationIdentifier: leg.destinationLocationIdentifier,
    logisticsEngagementId: leg.logisticsEngagementId,
    carrierReference: leg.carrierReference,
    trackingReference: leg.trackingReference,
    estimatedDepartureAt: leg.estimatedDepartureAt,
    estimatedArrivalAt: leg.estimatedArrivalAt,
    actualDepartureAt: leg.actualDepartureAt,
    actualArrivalAt: leg.actualArrivalAt,
    createdAt: leg.createdAt,
  };
}

export async function executeShipmentLegCommand(
  actor: CommerceFulfillmentActorContext,
  legId: string,
  idempotency: FulfillmentIdempotencyContext,
  command: ShipmentLegCommand,
): Promise<Result<unknown, CommercePhase6Error>> {
  const outcome = await db.transaction(async (transaction) => {
    const claim = await claimCommandReceipt(transaction, actor, idempotency);
    if (!claim.success) return { status: "error" as const, error: claim.error };

    const [leg] = await transaction
      .select()
      .from(commerceShipmentLeg)
      .where(eq(commerceShipmentLeg.id, legId))
      .for("update");
    if (!leg) return { status: "not_found" as const };

    const [shipment] = await transaction
      .select()
      .from(commerceShipment)
      .where(eq(commerceShipment.id, leg.shipmentId))
      .for("update");
    if (!shipment) return { status: "not_found" as const };

    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, shipment.orderId))
      .for("update")
      .limit(1);
    if (!order) return { status: "not_found" as const };

    let authorized = false;
    if (leg.logisticsEngagementId) {
      const [engagementLink] = await transaction
        .select({ engagement: commerceServiceEngagement })
        .from(commerceServiceEngagement)
        .innerJoin(
          commerceOrderServiceLink,
          eq(commerceOrderServiceLink.engagementId, commerceServiceEngagement.id),
        )
        .where(
          and(
            eq(commerceServiceEngagement.id, leg.logisticsEngagementId),
            eq(commerceOrderServiceLink.orderId, shipment.orderId),
            eq(commerceOrderServiceLink.shipmentId, shipment.id),
          ),
        )
        .limit(1);
      if (
        engagementLink &&
        (engagementLink.engagement.providerKind === "freight_forwarder" ||
          engagementLink.engagement.providerKind === "logistics_operator") &&
        engagementLink.engagement.buyerOrganizationId === order.buyerOrganizationId &&
        engagementLink.engagement.providerOrganizationId === actor.organizationId &&
        memberCanOperateProvider(actor.memberRole)
      ) {
        authorized = true;
      }
    } else if (
      order.counterpartyOrganizationId === actor.organizationId &&
      memberCanOperateCounterparty(actor.memberRole)
    ) {
      authorized = true;
    }
    if (!authorized) {
      if (
        order.buyerOrganizationId === actor.organizationId ||
        order.counterpartyOrganizationId === actor.organizationId
      ) {
        return { status: "forbidden" as const };
      }
      return { status: "not_found" as const };
    }

    if (claim.value.status === "replay") {
      return {
        status: "replay" as const,
        body: parseCommandReplayBody(claim.value.responseBody),
      };
    }

    if (leg.version !== command.expectedVersion) {
      return { status: "version_conflict" as const, currentVersion: leg.version };
    }
    if (!LEG_TRANSITIONS[leg.state].has(command.command)) {
      return {
        status: "invalid_state" as const,
        currentState: leg.state,
        command: command.command,
      };
    }

    const now = new Date();
    let nextState: LegState = leg.state;
    let actualDepartureAt = leg.actualDepartureAt;
    let actualArrivalAt = leg.actualArrivalAt;
    let carrierReference = leg.carrierReference;
    let trackingReference = leg.trackingReference;
    let eventKind: (typeof commerceShipmentLegEvent.$inferInsert)["eventKind"] = "exception";
    let description: string | null = null;
    let locationIdentifier: string | null = null;
    let evidenceDocumentId: string | null = null;

    switch (command.command) {
      case "book":
        nextState = "booked";
        eventKind = "booked";
        carrierReference = command.carrierReference ?? carrierReference;
        trackingReference = command.trackingReference ?? trackingReference;
        description = command.note ?? null;
        break;
      case "depart":
        nextState = "in_transit";
        eventKind = "departed";
        actualDepartureAt = command.departedAt === undefined ? now : new Date(command.departedAt);
        locationIdentifier = command.locationIdentifier ?? null;
        description = command.note ?? null;
        break;
      case "arrive":
        nextState = "arrived";
        eventKind = "arrived";
        actualArrivalAt = command.arrivedAt === undefined ? now : new Date(command.arrivedAt);
        locationIdentifier = command.locationIdentifier ?? null;
        description = command.note ?? null;
        break;
      case "complete":
        nextState = "completed";
        eventKind = "completed";
        description = command.note ?? null;
        break;
      case "report_exception":
        eventKind = "exception";
        description = command.description;
        locationIdentifier = command.locationIdentifier ?? null;
        if (command.evidenceDocumentId) {
          const documentCheck = await assertAvailableDocument(
            transaction,
            actor.organizationId,
            command.evidenceDocumentId,
          );
          if (!documentCheck.success) {
            return { status: "error" as const, error: documentCheck.error };
          }
          evidenceDocumentId = command.evidenceDocumentId;
        }
        break;
      case "cancel":
        nextState = "cancelled";
        eventKind = "cancelled";
        description = command.note ?? null;
        break;
      default: {
        const exhaustiveCheck: never = command;
        throw new Error(`Unhandled leg command: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }

    const [eventCount] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(commerceShipmentLegEvent)
      .where(eq(commerceShipmentLegEvent.shipmentLegId, leg.id));
    const nextSequence = eventCount?.count ?? 0;

    await transaction.insert(commerceShipmentLegEvent).values({
      shipmentLegId: leg.id,
      sequence: nextSequence,
      eventKind,
      occurredAt: now,
      description,
      carrierReference:
        command.command === "book" ? (command.carrierReference ?? null) : carrierReference,
      trackingReference:
        command.command === "book" ? (command.trackingReference ?? null) : trackingReference,
      locationIdentifier,
      evidenceDocumentId,
      createdByMemberId: actor.memberId,
    });

    const nextVersion = leg.version + 1;
    const [updated] = await transaction
      .update(commerceShipmentLeg)
      .set({
        state: nextState,
        version: nextVersion,
        carrierReference,
        trackingReference,
        actualDepartureAt,
        actualArrivalAt,
        updatedAt: now,
      })
      .where(and(eq(commerceShipmentLeg.id, leg.id), eq(commerceShipmentLeg.version, leg.version)))
      .returning();
    if (!updated) {
      return { status: "version_conflict" as const, currentVersion: leg.version };
    }

    if (nextState === "in_transit" && shipment.state === "planned") {
      await transaction
        .update(commerceShipment)
        .set({ state: "in_transit", version: shipment.version + 1, updatedAt: now })
        .where(eq(commerceShipment.id, shipment.id));
    }
    if (nextState === "completed" || nextState === "cancelled") {
      await reconcileShipmentStateFromLegs(transaction, shipment.id, now, actor.memberId);
    }

    const projection = projectShipmentLeg(updated);
    await finalizeCommandReceipt(
      transaction,
      actor,
      idempotency,
      "shipment_leg",
      leg.id,
      command.command,
      200,
      projection,
      nextVersion,
    );

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "shipment_leg_command_executed",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_shipment_leg",
      targetEntityId: leg.id,
      payload: {
        shipmentLegId: leg.id,
        command: command.command,
        previousState: leg.state,
        nextState,
      },
      occurredAt: now,
    });

    return { status: "ok" as const, projection };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "forbidden":
      return { success: false, error: { type: "FORBIDDEN" } };
    case "version_conflict":
      return {
        success: false,
        error: { type: "VERSION_CONFLICT", currentVersion: outcome.currentVersion },
      };
    case "invalid_state":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          currentState: outcome.currentState,
          command: outcome.command,
        },
      };
    case "error":
      return { success: false, error: outcome.error };
    case "replay":
      return { success: true, value: outcome.body };
    case "ok":
      return { success: true, value: outcome.projection };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled leg command outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

async function loadRequiredIncompleteDeliverableIds(
  transaction: DatabaseTransaction,
  engagementId: string,
): Promise<readonly string[]> {
  const rows = await transaction
    .select({ id: commerceEngagementDeliverable.id, state: commerceEngagementDeliverable.state })
    .from(commerceEngagementDeliverable)
    .where(
      and(
        eq(commerceEngagementDeliverable.engagementId, engagementId),
        eq(commerceEngagementDeliverable.isRequired, true),
      ),
    );
  return rows
    .filter(
      (row) => row.state !== "accepted" && row.state !== "waived" && row.state !== "cancelled",
    )
    .map((row) => row.id);
}

async function insertTypedDeliverableDetail(
  transaction: DatabaseTransaction,
  deliverableId: string,
  result: DeliverableResult,
): Promise<Result<true, CommercePhase6Error>> {
  switch (result.kind) {
    case "freight_forwarder":
    case "logistics_operator":
      await transaction.insert(freightDeliverableDetail).values({
        deliverableId,
        summary: result.summary,
      });
      return { success: true, value: true };
    case "customs_broker":
      await transaction.insert(customsBrokerageDeliverableDetail).values({
        deliverableId,
        filingKind: result.filingKind,
        jurisdiction: result.jurisdiction,
        providerFilingReference: result.providerFilingReference ?? null,
        declarationReference: result.declarationReference ?? null,
        decision: result.decision ?? null,
      });
      return { success: true, value: true };
    case "insurance_provider":
      await transaction.insert(insuranceDeliverableDetail).values({
        deliverableId,
        policyReference: result.policyReference,
        coverageClass: result.coverageClass,
        insuredValueMinorUnits: result.insuredValueMinorUnits ?? null,
        coverageLimitMinorUnits: result.coverageLimitMinorUnits ?? null,
        currency: result.currency ?? null,
        effectiveFrom: result.effectiveFrom === undefined ? null : new Date(result.effectiveFrom),
        effectiveTo: result.effectiveTo === undefined ? null : new Date(result.effectiveTo),
      });
      return { success: true, value: true };
    case "inspection_agency":
      await transaction.insert(inspectionDeliverableDetail).values({
        deliverableId,
        stage: result.stage,
        result: result.result,
        findingsSummary: result.findingsSummary ?? null,
        inspectedQuantity: result.inspectedQuantity ?? null,
        inspectedAt: result.inspectedAt === undefined ? null : new Date(result.inspectedAt),
      });
      return { success: true, value: true };
    case "testing_certification_lab":
      await transaction.insert(testingCertificationDeliverableDetail).values({
        deliverableId,
        standard: result.standard,
        specimenReference: result.specimenReference ?? null,
        result: result.result,
        laboratoryLocation: result.laboratoryLocation ?? null,
        reportedAt: result.reportedAt === undefined ? null : new Date(result.reportedAt),
      });
      return { success: true, value: true };
    case "warehouse_provider":
      await transaction.insert(warehouseDeliverableDetail).values({
        deliverableId,
        movementKind: result.movementKind,
        quantityUnits: result.quantityUnits,
        quantityScale: result.quantityScale,
        unitLabel: result.unitLabel,
        facilityIdentifier: result.facilityIdentifier ?? null,
        occurredAt: result.occurredAt === undefined ? null : new Date(result.occurredAt),
      });
      return { success: true, value: true };
    case "marketing_agency":
      await transaction.insert(marketingDeliverableDetail).values({
        deliverableId,
        deliverableKind: result.deliverableKind,
        channel: result.channel,
        artifactUrl: result.artifactUrl ?? null,
        metricsSummary: result.metricsSummary ?? null,
        publishedAt: result.publishedAt === undefined ? null : new Date(result.publishedAt),
      });
      return { success: true, value: true };
    case "foreign_exchange_facilitator":
      await transaction.insert(foreignExchangeDeliverableDetail).values({
        deliverableId,
        currencyPair: result.currencyPair,
        rateFixedPointUnits: result.rate.units,
        rateScale: result.rate.scale,
        sellAmountMinorUnits: result.sellAmountMinorUnits,
        buyAmountMinorUnits: result.buyAmountMinorUnits,
        sellCurrency: result.sellCurrency,
        buyCurrency: result.buyCurrency,
        providerExecutionReference: result.providerExecutionReference ?? null,
        confirmationState: "provider_confirmed",
      });
      return { success: true, value: true };
    default: {
      const exhaustiveCheck: never = result;
      throw new Error(`Unhandled deliverable result: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

async function ensureEngagementDetailFromInitialize(
  transaction: DatabaseTransaction,
  engagement: EngagementRow,
  details: ServiceEngagementCommand & { command: "initialize" },
): Promise<Result<true, CommercePhase6Error>> {
  if (details.details.kind !== engagement.providerKind) {
    return {
      success: false,
      error: { type: "PROVIDER_KIND_MISMATCH" } satisfies CommercePhase6Error,
    };
  }
  switch (details.details.kind) {
    case "freight_forwarder":
    case "logistics_operator":
      await transaction.insert(freightEngagementDetail).values({
        engagementId: engagement.id,
        transportModes: [...details.details.transportModes],
        originCountryCode: details.details.originCountryCode ?? null,
        destinationCountryCode: details.details.destinationCountryCode ?? null,
        estimatedTransitDays: details.details.estimatedTransitDays ?? null,
      });
      return { success: true, value: true };
    case "customs_broker":
      await transaction.insert(customsBrokerageEngagementDetail).values({
        engagementId: engagement.id,
        jurisdictions: [...details.details.jurisdictions],
        filingSummary: details.details.filingSummary ?? null,
      });
      return { success: true, value: true };
    case "insurance_provider":
      await transaction.insert(insuranceEngagementDetail).values({
        engagementId: engagement.id,
        coverageClasses: [...details.details.coverageClasses],
        coverageLimitMinorUnits: details.details.coverageLimitMinorUnits ?? null,
        currency: details.details.currency ?? null,
      });
      return { success: true, value: true };
    case "inspection_agency":
      await transaction.insert(inspectionEngagementDetail).values({
        engagementId: engagement.id,
        includedStages: [...details.details.includedStages],
      });
      return { success: true, value: true };
    case "testing_certification_lab":
      await transaction.insert(testingCertificationEngagementDetail).values({
        engagementId: engagement.id,
        standards: [...details.details.standards],
        laboratoryLocation: details.details.laboratoryLocation ?? null,
      });
      return { success: true, value: true };
    case "marketing_agency":
      await transaction.insert(marketingEngagementDetail).values({
        engagementId: engagement.id,
        channels: [...details.details.channels],
        deliverablesSummary: details.details.deliverablesSummary ?? null,
      });
      return { success: true, value: true };
    case "warehouse_provider":
      await transaction.insert(warehouseEngagementDetail).values({
        engagementId: engagement.id,
        storageTypes: [...details.details.storageTypes],
        capacityUnits: details.details.capacityUnits ?? null,
        temperatureControlled: details.details.temperatureControlled,
      });
      return { success: true, value: true };
    case "foreign_exchange_facilitator":
      await transaction.insert(foreignExchangeEngagementDetail).values({
        engagementId: engagement.id,
        currencyPair: details.details.currencyPair,
        rateFixedPointUnits: details.details.rate.units,
        rateScale: details.details.rate.scale,
        settlementRail: details.details.settlementRail ?? null,
        notionalAmountMinorUnits: details.details.notionalAmountMinorUnits ?? null,
        notionalCurrency: details.details.notionalCurrency ?? null,
      });
      return { success: true, value: true };
    default: {
      const exhaustiveCheck: never = details.details;
      throw new Error(`Unhandled initialize detail: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function projectEngagement(engagement: EngagementRow) {
  return {
    id: engagement.id,
    buyerOrganizationId: engagement.buyerOrganizationId,
    providerOrganizationId: engagement.providerOrganizationId,
    orderId: engagement.orderId,
    orderServiceLineId: engagement.orderServiceLineId,
    providerKind: engagement.providerKind,
    state: engagement.state,
    executionContractState: engagement.executionContractState,
    version: engagement.version,
    titleSnapshot: engagement.titleSnapshot,
    scopeSnapshot: engagement.scopeSnapshot,
    scheduledAt: engagement.scheduledAt,
    startedAt: engagement.startedAt,
    completedAt: engagement.completedAt,
    cancelledAt: engagement.cancelledAt,
    createdAt: engagement.createdAt,
  };
}

export async function executeServiceEngagementCommand(
  actor: CommerceFulfillmentActorContext,
  engagementId: string,
  idempotency: FulfillmentIdempotencyContext,
  command: ServiceEngagementCommand,
): Promise<Result<unknown, CommercePhase6Error>> {
  const outcome = await db.transaction(async (transaction) => {
    const claim = await claimCommandReceipt(transaction, actor, idempotency);
    if (!claim.success) return { status: "error" as const, error: claim.error };

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
      .select({ id: commerceOrder.id })
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

    const now = new Date();
    let nextState: EngagementState = engagement.state;
    let scheduledAt = engagement.scheduledAt;
    let startedAt = engagement.startedAt;
    let completedAt = engagement.completedAt;
    let cancelledAt = engagement.cancelledAt;
    let executionContractState = engagement.executionContractState;

    const providerCommands = new Set([
      "initialize",
      "schedule",
      "start",
      "request_buyer_action",
      "submit_deliverable",
      "complete",
      "cancel",
    ]);
    const buyerCommands = new Set([
      "accept_deliverable",
      "reject_deliverable",
      "waive_deliverable",
      "complete",
      "cancel",
    ]);

    const authorizedAsProvider =
      isProvider &&
      providerCommands.has(command.command) &&
      memberCanOperateProvider(actor.memberRole);
    const authorizedAsBuyer =
      isBuyer && buyerCommands.has(command.command) && memberCanOperateBuyer(actor.memberRole);
    if (!authorizedAsProvider && !authorizedAsBuyer) {
      return { status: "forbidden" as const };
    }

    if (claim.value.status === "replay") {
      return {
        status: "replay" as const,
        body: parseCommandReplayBody(claim.value.responseBody),
      };
    }

    if (
      engagement.state === "completed" ||
      engagement.state === "cancelled" ||
      engagement.state === "disputed"
    ) {
      return {
        status: "invalid_state" as const,
        currentState: engagement.state,
        command: command.command,
      };
    }

    if (engagement.version !== command.expectedVersion) {
      return { status: "version_conflict" as const, currentVersion: engagement.version };
    }

    if (
      engagement.executionContractState === "legacy_missing_snapshot" &&
      command.command !== "initialize" &&
      command.command !== "cancel"
    ) {
      return { status: "contract_missing" as const };
    }

    switch (command.command) {
      case "initialize": {
        if (engagement.executionContractState === "ready") {
          return {
            status: "invalid_state" as const,
            currentState: engagement.state,
            command: command.command,
          };
        }
        const detailResult = await ensureEngagementDetailFromInitialize(
          transaction,
          engagement,
          command,
        );
        if (!detailResult.success) {
          return { status: "error" as const, error: detailResult.error };
        }
        for (const deliverable of command.deliverables) {
          await transaction.insert(commerceEngagementDeliverable).values({
            engagementId: engagement.id,
            sequence: deliverable.sequence,
            title: deliverable.title,
            isRequired: deliverable.isRequired,
            state: "planned",
            dueAt: deliverable.dueAt === undefined ? null : new Date(deliverable.dueAt),
            createdByMemberId: actor.memberId,
          });
        }
        executionContractState = "ready";
        break;
      }
      case "schedule":
        if (engagement.state !== "awaiting_provider") {
          return {
            status: "invalid_state" as const,
            currentState: engagement.state,
            command: command.command,
          };
        }
        nextState = "scheduled";
        scheduledAt = now;
        break;
      case "start":
        if (engagement.state !== "scheduled" && engagement.state !== "awaiting_buyer") {
          return {
            status: "invalid_state" as const,
            currentState: engagement.state,
            command: command.command,
          };
        }
        nextState = "in_progress";
        startedAt = startedAt ?? now;
        break;
      case "request_buyer_action":
        if (engagement.state !== "in_progress") {
          return {
            status: "invalid_state" as const,
            currentState: engagement.state,
            command: command.command,
          };
        }
        nextState = "awaiting_buyer";
        break;
      case "submit_deliverable": {
        if (command.result.kind !== engagement.providerKind) {
          return {
            status: "error" as const,
            error: { type: "PROVIDER_KIND_MISMATCH" } satisfies CommercePhase6Error,
          };
        }
        const [deliverable] = await transaction
          .select()
          .from(commerceEngagementDeliverable)
          .where(eq(commerceEngagementDeliverable.id, command.deliverableId))
          .for("update");
        if (!deliverable || deliverable.engagementId !== engagement.id) {
          return { status: "not_found" as const };
        }
        if (deliverable.state !== "planned" && deliverable.state !== "submitted") {
          return {
            status: "invalid_state" as const,
            currentState: deliverable.state,
            command: command.command,
          };
        }
        if (command.evidenceDocumentId) {
          const documentCheck = await assertAvailableDocument(
            transaction,
            actor.organizationId,
            command.evidenceDocumentId,
          );
          if (!documentCheck.success) {
            return { status: "error" as const, error: documentCheck.error };
          }
        }
        await transaction
          .delete(freightDeliverableDetail)
          .where(eq(freightDeliverableDetail.deliverableId, deliverable.id));
        await transaction
          .delete(customsBrokerageDeliverableDetail)
          .where(eq(customsBrokerageDeliverableDetail.deliverableId, deliverable.id));
        await transaction
          .delete(insuranceDeliverableDetail)
          .where(eq(insuranceDeliverableDetail.deliverableId, deliverable.id));
        await transaction
          .delete(inspectionDeliverableDetail)
          .where(eq(inspectionDeliverableDetail.deliverableId, deliverable.id));
        await transaction
          .delete(testingCertificationDeliverableDetail)
          .where(eq(testingCertificationDeliverableDetail.deliverableId, deliverable.id));
        await transaction
          .delete(warehouseDeliverableDetail)
          .where(eq(warehouseDeliverableDetail.deliverableId, deliverable.id));
        await transaction
          .delete(marketingDeliverableDetail)
          .where(eq(marketingDeliverableDetail.deliverableId, deliverable.id));
        await transaction
          .delete(foreignExchangeDeliverableDetail)
          .where(eq(foreignExchangeDeliverableDetail.deliverableId, deliverable.id));

        const detailInsert = await insertTypedDeliverableDetail(
          transaction,
          deliverable.id,
          command.result,
        );
        if (!detailInsert.success) {
          return { status: "error" as const, error: detailInsert.error };
        }

        const [eventCount] = await transaction
          .select({ count: sql<number>`count(*)::int` })
          .from(commerceEngagementDeliverableEvent)
          .where(eq(commerceEngagementDeliverableEvent.deliverableId, deliverable.id));
        await transaction.insert(commerceEngagementDeliverableEvent).values({
          deliverableId: deliverable.id,
          sequence: eventCount?.count ?? 0,
          previousState: deliverable.state,
          nextState: "submitted",
          commandKind: "submit_deliverable",
          note: command.note ?? null,
          occurredAt: now,
          createdByMemberId: actor.memberId,
        });
        await transaction
          .update(commerceEngagementDeliverable)
          .set({
            state: "submitted",
            submittedAt: now,
            reviewedAt: null,
            reviewNote: null,
            evidenceDocumentId: command.evidenceDocumentId ?? null,
            updatedAt: now,
          })
          .where(eq(commerceEngagementDeliverable.id, deliverable.id));
        if (engagement.state === "awaiting_provider" || engagement.state === "scheduled") {
          nextState = "in_progress";
          startedAt = startedAt ?? now;
        }
        break;
      }
      case "accept_deliverable":
      case "reject_deliverable":
      case "waive_deliverable": {
        const [deliverable] = await transaction
          .select()
          .from(commerceEngagementDeliverable)
          .where(eq(commerceEngagementDeliverable.id, command.deliverableId))
          .for("update");
        if (!deliverable || deliverable.engagementId !== engagement.id) {
          return { status: "not_found" as const };
        }
        const nextDeliverableState =
          command.command === "accept_deliverable"
            ? ("accepted" as const)
            : command.command === "waive_deliverable"
              ? ("waived" as const)
              : ("planned" as const);
        if (command.command !== "waive_deliverable" && deliverable.state !== "submitted") {
          return {
            status: "invalid_state" as const,
            currentState: deliverable.state,
            command: command.command,
          };
        }
        if (command.command === "waive_deliverable" && deliverable.state === "accepted") {
          return {
            status: "invalid_state" as const,
            currentState: deliverable.state,
            command: command.command,
          };
        }
        const [eventCount] = await transaction
          .select({ count: sql<number>`count(*)::int` })
          .from(commerceEngagementDeliverableEvent)
          .where(eq(commerceEngagementDeliverableEvent.deliverableId, deliverable.id));
        await transaction.insert(commerceEngagementDeliverableEvent).values({
          deliverableId: deliverable.id,
          sequence: eventCount?.count ?? 0,
          previousState: deliverable.state,
          nextState: nextDeliverableState,
          commandKind: command.command,
          note: command.note ?? null,
          occurredAt: now,
          createdByMemberId: actor.memberId,
        });
        await transaction
          .update(commerceEngagementDeliverable)
          .set({
            state: nextDeliverableState,
            reviewedAt: now,
            reviewNote: command.note ?? null,
            updatedAt: now,
          })
          .where(eq(commerceEngagementDeliverable.id, deliverable.id));
        break;
      }
      case "complete": {
        if (engagement.state !== "in_progress" && engagement.state !== "awaiting_buyer") {
          return {
            status: "invalid_state" as const,
            currentState: engagement.state,
            command: command.command,
          };
        }
        const incomplete = await loadRequiredIncompleteDeliverableIds(transaction, engagement.id);
        if (incomplete.length > 0) {
          return {
            status: "incomplete_deliverables" as const,
            deliverableIds: incomplete,
          };
        }
        nextState = "completed";
        completedAt = now;
        break;
      }
      case "cancel":
        nextState = "cancelled";
        cancelledAt = now;
        break;
      default: {
        const exhaustiveCheck: never = command;
        throw new Error(`Unhandled engagement command: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }

    const [eventCount] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(commerceServiceEngagementEvent)
      .where(eq(commerceServiceEngagementEvent.engagementId, engagement.id));

    await transaction.insert(commerceServiceEngagementEvent).values({
      engagementId: engagement.id,
      sequence: eventCount?.count ?? 0,
      previousState: engagement.state,
      nextState,
      commandKind: command.command,
      note: "note" in command ? (command.note ?? null) : null,
      occurredAt: now,
      createdByMemberId: actor.memberId,
    });

    const nextVersion = engagement.version + 1;
    const [updated] = await transaction
      .update(commerceServiceEngagement)
      .set({
        state: nextState,
        executionContractState,
        version: nextVersion,
        scheduledAt,
        startedAt,
        completedAt,
        cancelledAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(commerceServiceEngagement.id, engagement.id),
          eq(commerceServiceEngagement.version, engagement.version),
        ),
      )
      .returning();
    if (!updated) {
      return { status: "version_conflict" as const, currentVersion: engagement.version };
    }
    await reconcileOrderAggregateState(transaction, engagement.orderId, now);

    const projection = projectEngagement(updated);
    await finalizeCommandReceipt(
      transaction,
      actor,
      idempotency,
      "service_engagement",
      engagement.id,
      command.command,
      200,
      projection,
      nextVersion,
    );

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "service_engagement_command_executed",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_service_engagement",
      targetEntityId: engagement.id,
      payload: {
        engagementId: engagement.id,
        command: command.command,
        previousState: engagement.state,
        nextState,
      },
      occurredAt: now,
    });

    return { status: "ok" as const, projection };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "forbidden":
      return { success: false, error: { type: "FORBIDDEN" } };
    case "version_conflict":
      return {
        success: false,
        error: { type: "VERSION_CONFLICT", currentVersion: outcome.currentVersion },
      };
    case "invalid_state":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          currentState: outcome.currentState,
          command: outcome.command,
        },
      };
    case "contract_missing":
      return { success: false, error: { type: "CONTRACT_SNAPSHOT_MISSING" } };
    case "incomplete_deliverables":
      return {
        success: false,
        error: {
          type: "REQUIRED_DELIVERABLES_INCOMPLETE",
          deliverableIds: outcome.deliverableIds,
        },
      };
    case "error": {
      const phase6Error: CommercePhase6Error = outcome.error;
      return { success: false, error: phase6Error };
    }
    case "replay":
      return { success: true, value: outcome.body };
    case "ok":
      return { success: true, value: outcome.projection };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled engagement command outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function getShipmentDetail(
  actor: CommerceFulfillmentActorContext,
  shipmentId: string,
): Promise<Result<unknown, CommercePhase6Error>> {
  const [shipment] = await db
    .select()
    .from(commerceShipment)
    .where(eq(commerceShipment.id, shipmentId))
    .limit(1);
  if (!shipment) return { success: false, error: { type: "NOT_FOUND" } };

  const [order] = await db
    .select()
    .from(commerceOrder)
    .where(eq(commerceOrder.id, shipment.orderId))
    .limit(1);
  if (
    !order ||
    (order.buyerOrganizationId !== actor.organizationId &&
      order.counterpartyOrganizationId !== actor.organizationId)
  ) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const [productLines, events, legs] = await Promise.all([
    db
      .select()
      .from(commerceShipmentProductLine)
      .where(eq(commerceShipmentProductLine.shipmentId, shipmentId)),
    db
      .select()
      .from(commerceShipmentEvent)
      .where(eq(commerceShipmentEvent.shipmentId, shipmentId))
      .orderBy(asc(commerceShipmentEvent.occurredAt), asc(commerceShipmentEvent.id)),
    db
      .select()
      .from(commerceShipmentLeg)
      .where(eq(commerceShipmentLeg.shipmentId, shipmentId))
      .orderBy(asc(commerceShipmentLeg.sequence), asc(commerceShipmentLeg.id)),
  ]);

  return {
    success: true,
    value: {
      id: shipment.id,
      orderId: shipment.orderId,
      state: shipment.state,
      version: shipment.version,
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
      legs: legs.map(projectShipmentLeg),
    },
  };
}

async function loadEngagementExecutionSnapshot(
  engagement: EngagementRow,
): Promise<EngagementExecutionSnapshotProjection | null> {
  switch (engagement.providerKind) {
    case "freight_forwarder":
    case "logistics_operator": {
      const [detail] = await db
        .select()
        .from(freightEngagementDetail)
        .where(eq(freightEngagementDetail.engagementId, engagement.id))
        .limit(1);
      return detail
        ? {
            kind: engagement.providerKind,
            sourceQuoteServiceLineId: detail.sourceQuoteServiceLineId,
            transportModes: detail.transportModes,
            originCountryCode: detail.originCountryCode,
            destinationCountryCode: detail.destinationCountryCode,
            estimatedTransitDays: detail.estimatedTransitDays,
          }
        : null;
    }
    case "customs_broker": {
      const [detail] = await db
        .select()
        .from(customsBrokerageEngagementDetail)
        .where(eq(customsBrokerageEngagementDetail.engagementId, engagement.id))
        .limit(1);
      return detail
        ? {
            kind: engagement.providerKind,
            sourceQuoteServiceLineId: detail.sourceQuoteServiceLineId,
            jurisdictions: detail.jurisdictions,
            filingSummary: detail.filingSummary,
          }
        : null;
    }
    case "insurance_provider": {
      const [detail] = await db
        .select()
        .from(insuranceEngagementDetail)
        .where(eq(insuranceEngagementDetail.engagementId, engagement.id))
        .limit(1);
      return detail
        ? {
            kind: engagement.providerKind,
            sourceQuoteServiceLineId: detail.sourceQuoteServiceLineId,
            coverageClasses: detail.coverageClasses,
            coverageLimitMinorUnits: detail.coverageLimitMinorUnits,
            currency: detail.currency,
          }
        : null;
    }
    case "inspection_agency": {
      const [detail] = await db
        .select()
        .from(inspectionEngagementDetail)
        .where(eq(inspectionEngagementDetail.engagementId, engagement.id))
        .limit(1);
      return detail
        ? {
            kind: engagement.providerKind,
            sourceQuoteServiceLineId: detail.sourceQuoteServiceLineId,
            includedStages: detail.includedStages,
          }
        : null;
    }
    case "testing_certification_lab": {
      const [detail] = await db
        .select()
        .from(testingCertificationEngagementDetail)
        .where(eq(testingCertificationEngagementDetail.engagementId, engagement.id))
        .limit(1);
      return detail
        ? {
            kind: engagement.providerKind,
            sourceQuoteServiceLineId: detail.sourceQuoteServiceLineId,
            standards: detail.standards,
            laboratoryLocation: detail.laboratoryLocation,
          }
        : null;
    }
    case "marketing_agency": {
      const [detail] = await db
        .select()
        .from(marketingEngagementDetail)
        .where(eq(marketingEngagementDetail.engagementId, engagement.id))
        .limit(1);
      return detail
        ? {
            kind: engagement.providerKind,
            sourceQuoteServiceLineId: detail.sourceQuoteServiceLineId,
            channels: detail.channels,
            deliverablesSummary: detail.deliverablesSummary,
          }
        : null;
    }
    case "warehouse_provider": {
      const [detail] = await db
        .select()
        .from(warehouseEngagementDetail)
        .where(eq(warehouseEngagementDetail.engagementId, engagement.id))
        .limit(1);
      return detail
        ? {
            kind: engagement.providerKind,
            sourceQuoteServiceLineId: detail.sourceQuoteServiceLineId,
            storageTypes: detail.storageTypes,
            capacityUnits: detail.capacityUnits,
            temperatureControlled: detail.temperatureControlled,
          }
        : null;
    }
    case "foreign_exchange_facilitator": {
      const [detail] = await db
        .select()
        .from(foreignExchangeEngagementDetail)
        .where(eq(foreignExchangeEngagementDetail.engagementId, engagement.id))
        .limit(1);
      return detail
        ? {
            kind: engagement.providerKind,
            sourceQuoteServiceLineId: detail.sourceQuoteServiceLineId,
            currencyPair: detail.currencyPair,
            rate: { units: detail.rateFixedPointUnits, scale: detail.rateScale },
            settlementRail: detail.settlementRail,
            notionalAmountMinorUnits: detail.notionalAmountMinorUnits,
            notionalCurrency: detail.notionalCurrency,
          }
        : null;
    }
    default: {
      const exhaustiveCheck: never = engagement.providerKind;
      throw new Error(`Unhandled engagement provider kind: ${String(exhaustiveCheck)}`);
    }
  }
}

async function loadTypedDeliverableResultMap(
  providerKind: ProviderKind,
  deliverableIds: readonly string[],
): Promise<ReadonlyMap<string, DeliverableResultProjection>> {
  const resultsByDeliverableId = new Map<string, DeliverableResultProjection>();
  if (deliverableIds.length === 0) return resultsByDeliverableId;

  switch (providerKind) {
    case "freight_forwarder":
    case "logistics_operator": {
      const details = await db
        .select()
        .from(freightDeliverableDetail)
        .where(inArray(freightDeliverableDetail.deliverableId, deliverableIds));
      for (const detail of details) {
        resultsByDeliverableId.set(detail.deliverableId, {
          kind: providerKind,
          summary: detail.summary,
        });
      }
      return resultsByDeliverableId;
    }
    case "customs_broker": {
      const details = await db
        .select()
        .from(customsBrokerageDeliverableDetail)
        .where(inArray(customsBrokerageDeliverableDetail.deliverableId, deliverableIds));
      for (const detail of details) {
        resultsByDeliverableId.set(detail.deliverableId, {
          kind: providerKind,
          filingKind: detail.filingKind,
          jurisdiction: detail.jurisdiction,
          providerFilingReference: detail.providerFilingReference,
          declarationReference: detail.declarationReference,
          decision: detail.decision,
        });
      }
      return resultsByDeliverableId;
    }
    case "insurance_provider": {
      const details = await db
        .select()
        .from(insuranceDeliverableDetail)
        .where(inArray(insuranceDeliverableDetail.deliverableId, deliverableIds));
      for (const detail of details) {
        resultsByDeliverableId.set(detail.deliverableId, {
          kind: providerKind,
          policyReference: detail.policyReference,
          coverageClass: detail.coverageClass,
          insuredValueMinorUnits: detail.insuredValueMinorUnits,
          coverageLimitMinorUnits: detail.coverageLimitMinorUnits,
          currency: detail.currency,
          effectiveFrom: detail.effectiveFrom,
          effectiveTo: detail.effectiveTo,
        });
      }
      return resultsByDeliverableId;
    }
    case "inspection_agency": {
      const details = await db
        .select()
        .from(inspectionDeliverableDetail)
        .where(inArray(inspectionDeliverableDetail.deliverableId, deliverableIds));
      for (const detail of details) {
        resultsByDeliverableId.set(detail.deliverableId, {
          kind: providerKind,
          stage: detail.stage,
          result: detail.result,
          findingsSummary: detail.findingsSummary,
          inspectedQuantity: detail.inspectedQuantity,
          inspectedAt: detail.inspectedAt,
        });
      }
      return resultsByDeliverableId;
    }
    case "testing_certification_lab": {
      const details = await db
        .select()
        .from(testingCertificationDeliverableDetail)
        .where(inArray(testingCertificationDeliverableDetail.deliverableId, deliverableIds));
      for (const detail of details) {
        resultsByDeliverableId.set(detail.deliverableId, {
          kind: providerKind,
          standard: detail.standard,
          specimenReference: detail.specimenReference,
          result: detail.result,
          laboratoryLocation: detail.laboratoryLocation,
          reportedAt: detail.reportedAt,
        });
      }
      return resultsByDeliverableId;
    }
    case "warehouse_provider": {
      const details = await db
        .select()
        .from(warehouseDeliverableDetail)
        .where(inArray(warehouseDeliverableDetail.deliverableId, deliverableIds));
      for (const detail of details) {
        resultsByDeliverableId.set(detail.deliverableId, {
          kind: providerKind,
          movementKind: detail.movementKind,
          quantityUnits: detail.quantityUnits,
          quantityScale: detail.quantityScale,
          unitLabel: detail.unitLabel,
          facilityIdentifier: detail.facilityIdentifier,
          occurredAt: detail.occurredAt,
        });
      }
      return resultsByDeliverableId;
    }
    case "marketing_agency": {
      const details = await db
        .select()
        .from(marketingDeliverableDetail)
        .where(inArray(marketingDeliverableDetail.deliverableId, deliverableIds));
      for (const detail of details) {
        resultsByDeliverableId.set(detail.deliverableId, {
          kind: providerKind,
          deliverableKind: detail.deliverableKind,
          channel: detail.channel,
          artifactUrl: detail.artifactUrl,
          metricsSummary: detail.metricsSummary,
          publishedAt: detail.publishedAt,
        });
      }
      return resultsByDeliverableId;
    }
    case "foreign_exchange_facilitator": {
      const details = await db
        .select()
        .from(foreignExchangeDeliverableDetail)
        .where(inArray(foreignExchangeDeliverableDetail.deliverableId, deliverableIds));
      for (const detail of details) {
        resultsByDeliverableId.set(detail.deliverableId, {
          kind: providerKind,
          currencyPair: detail.currencyPair,
          rate: { units: detail.rateFixedPointUnits, scale: detail.rateScale },
          sellAmountMinorUnits: detail.sellAmountMinorUnits,
          buyAmountMinorUnits: detail.buyAmountMinorUnits,
          sellCurrency: detail.sellCurrency,
          buyCurrency: detail.buyCurrency,
          providerExecutionReference: detail.providerExecutionReference,
          confirmationState: detail.confirmationState,
        });
      }
      return resultsByDeliverableId;
    }
    default: {
      const exhaustiveCheck: never = providerKind;
      throw new Error(`Unhandled deliverable provider kind: ${String(exhaustiveCheck)}`);
    }
  }
}

export async function getServiceEngagementDetail(
  actor: CommerceFulfillmentActorContext,
  engagementId: string,
): Promise<Result<ServiceEngagementDetailProjection, CommercePhase6Error>> {
  const [engagement] = await db
    .select()
    .from(commerceServiceEngagement)
    .where(eq(commerceServiceEngagement.id, engagementId))
    .limit(1);
  if (!engagement) return { success: false, error: { type: "NOT_FOUND" } };
  if (
    engagement.buyerOrganizationId !== actor.organizationId &&
    engagement.providerOrganizationId !== actor.organizationId
  ) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const [deliverables, events, executionSnapshot] = await Promise.all([
    db
      .select()
      .from(commerceEngagementDeliverable)
      .where(eq(commerceEngagementDeliverable.engagementId, engagementId))
      .orderBy(asc(commerceEngagementDeliverable.sequence), asc(commerceEngagementDeliverable.id)),
    db
      .select()
      .from(commerceServiceEngagementEvent)
      .where(eq(commerceServiceEngagementEvent.engagementId, engagementId))
      .orderBy(
        asc(commerceServiceEngagementEvent.sequence),
        asc(commerceServiceEngagementEvent.id),
      ),
    loadEngagementExecutionSnapshot(engagement),
  ]);
  const deliverableResults = await loadTypedDeliverableResultMap(
    engagement.providerKind,
    deliverables.map((deliverable) => deliverable.id),
  );

  return {
    success: true,
    value: {
      ...projectEngagement(engagement),
      executionSnapshot,
      deliverables: deliverables.map((deliverable) => ({
        id: deliverable.id,
        sequence: deliverable.sequence,
        title: deliverable.title,
        isRequired: deliverable.isRequired,
        state: deliverable.state,
        dueAt: deliverable.dueAt,
        submittedAt: deliverable.submittedAt,
        reviewedAt: deliverable.reviewedAt,
        evidenceDocumentId: deliverable.evidenceDocumentId,
        reviewNote: deliverable.reviewNote,
        result: deliverableResults.get(deliverable.id) ?? null,
      })),
      events: events.map((event) => ({
        id: event.id,
        sequence: event.sequence,
        previousState: event.previousState,
        nextState: event.nextState,
        commandKind: event.commandKind,
        note: event.note,
        occurredAt: event.occurredAt,
      })),
    },
  };
}

export async function listShipmentLegEvents(
  actor: CommerceFulfillmentActorContext,
  legId: string,
): Promise<Result<unknown, CommercePhase6Error>> {
  const [leg] = await db
    .select()
    .from(commerceShipmentLeg)
    .where(eq(commerceShipmentLeg.id, legId))
    .limit(1);
  if (!leg) return { success: false, error: { type: "NOT_FOUND" } };
  const shipmentResult = await getShipmentDetail(actor, leg.shipmentId);
  if (!shipmentResult.success) return shipmentResult;

  const events = await db
    .select()
    .from(commerceShipmentLegEvent)
    .where(eq(commerceShipmentLegEvent.shipmentLegId, legId))
    .orderBy(asc(commerceShipmentLegEvent.sequence), asc(commerceShipmentLegEvent.id));

  return {
    success: true,
    value: {
      items: events.map((event) => ({
        id: event.id,
        sequence: event.sequence,
        eventKind: event.eventKind,
        occurredAt: event.occurredAt,
        description: event.description,
        carrierReference: event.carrierReference,
        trackingReference: event.trackingReference,
        locationIdentifier: event.locationIdentifier,
        evidenceDocumentId: event.evidenceDocumentId,
      })),
    },
  };
}

export async function listServiceEngagementEvents(
  actor: CommerceFulfillmentActorContext,
  engagementId: string,
): Promise<Result<unknown, CommercePhase6Error>> {
  const detail = await getServiceEngagementDetail(actor, engagementId);
  if (!detail.success) return detail;
  const events = await db
    .select()
    .from(commerceServiceEngagementEvent)
    .where(eq(commerceServiceEngagementEvent.engagementId, engagementId))
    .orderBy(asc(commerceServiceEngagementEvent.sequence), asc(commerceServiceEngagementEvent.id));
  return {
    success: true,
    value: {
      items: events.map((event) => ({
        id: event.id,
        sequence: event.sequence,
        previousState: event.previousState,
        nextState: event.nextState,
        commandKind: event.commandKind,
        note: event.note,
        occurredAt: event.occurredAt,
      })),
    },
  };
}

export async function getOrderFulfillment(
  actor: CommerceFulfillmentActorContext,
  orderId: string,
): Promise<Result<unknown, CommercePhase6Error>> {
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

  const [productLines, shipments, engagements] = await Promise.all([
    db.select().from(commerceOrderProductLine).where(eq(commerceOrderProductLine.orderId, orderId)),
    db.select().from(commerceShipment).where(eq(commerceShipment.orderId, orderId)),
    db
      .select()
      .from(commerceServiceEngagement)
      .where(eq(commerceServiceEngagement.orderId, orderId))
      .orderBy(desc(commerceServiceEngagement.createdAt), asc(commerceServiceEngagement.id)),
  ]);

  const shipmentIds = shipments.map((shipment) => shipment.id);
  const legs =
    shipmentIds.length === 0
      ? []
      : await db
          .select()
          .from(commerceShipmentLeg)
          .where(inArray(commerceShipmentLeg.shipmentId, shipmentIds));

  const progress = computeFulfillmentProgress({
    orderState: order.state,
    productLines: productLines.map((line) => ({
      quantityOrdered: line.quantityOrdered,
      quantityFulfilled: line.quantityFulfilled,
      quantityCancelled: line.quantityCancelled,
    })),
    shipments: shipments.map((shipment) => ({
      id: shipment.id,
      state: shipment.state,
    })),
    legs: legs.map((leg) => ({
      shipmentId: leg.shipmentId,
      state: leg.state,
    })),
    engagements: engagements.map((engagement) => ({
      state: engagement.state,
    })),
  });

  return {
    success: true,
    value: {
      orderId: order.id,
      orderState: order.state,
      overallState: progress.overallState,
      progress: {
        completedUnits: progress.completedUnits,
        totalUnits: progress.totalUnits,
        basisPoints: progress.basisPoints,
      },
      shipments: shipments.map((shipment) => ({
        id: shipment.id,
        state: shipment.state,
        version: shipment.version,
        legs: legs.filter((leg) => leg.shipmentId === shipment.id).map(projectShipmentLeg),
      })),
      engagements: engagements.map(projectEngagement),
      attentionItems: [
        ...engagements
          .filter((engagement) => engagement.state === "awaiting_buyer")
          .map((engagement) => ({
            kind: "engagement_awaiting_buyer" as const,
            engagementId: engagement.id,
          })),
        ...engagements
          .filter((engagement) => engagement.executionContractState === "legacy_missing_snapshot")
          .map((engagement) => ({
            kind: "legacy_missing_snapshot" as const,
            engagementId: engagement.id,
          })),
      ],
      computedAt: new Date(),
    },
  };
}

export type FulfillmentProgressInput = {
  readonly orderState: string;
  readonly productLines: readonly {
    readonly quantityOrdered: number;
    readonly quantityFulfilled: number;
    readonly quantityCancelled: number;
  }[];
  readonly shipments: readonly {
    readonly id: string;
    readonly state: string;
  }[];
  readonly legs: readonly {
    readonly shipmentId: string;
    readonly state: string;
  }[];
  readonly engagements: readonly {
    readonly state: string;
  }[];
};

export type FulfillmentProgressResult = {
  readonly completedUnits: number;
  readonly totalUnits: number;
  readonly basisPoints: number;
  readonly overallState:
    | "not_started"
    | "in_progress"
    | "awaiting_buyer"
    | "attention_required"
    | "completed"
    | "cancelled";
};

/** Pure progress derivation — no client-writable percentage; basis points only. */
export function computeFulfillmentProgress(
  input: FulfillmentProgressInput,
): FulfillmentProgressResult {
  type WorkUnit = {
    readonly completed: boolean;
    readonly awaitingBuyer: boolean;
    readonly blocked: boolean;
    readonly cancelled: boolean;
  };

  const units: WorkUnit[] = [];

  if (input.productLines.length > 0) {
    const productComplete = input.productLines.every(
      (line) => line.quantityFulfilled + line.quantityCancelled >= line.quantityOrdered,
    );
    units.push({
      completed: productComplete,
      awaitingBuyer: false,
      blocked: false,
      cancelled: input.productLines.every((line) => line.quantityCancelled >= line.quantityOrdered),
    });
  }

  for (const shipment of input.shipments) {
    const shipmentLegs = input.legs.filter(
      (leg) => leg.shipmentId === shipment.id && leg.state !== "cancelled",
    );
    if (shipmentLegs.length === 0) {
      units.push({
        completed: shipment.state === "delivered",
        awaitingBuyer: false,
        blocked: false,
        cancelled: shipment.state === "cancelled",
      });
    } else {
      for (const leg of shipmentLegs) {
        units.push({
          completed: leg.state === "completed",
          awaitingBuyer: false,
          blocked: false,
          cancelled: false,
        });
      }
    }
  }

  for (const engagement of input.engagements) {
    units.push({
      completed: engagement.state === "completed",
      awaitingBuyer: engagement.state === "awaiting_buyer",
      blocked: engagement.state === "disputed",
      cancelled: engagement.state === "cancelled",
    });
  }

  const activeUnits = units.filter((unit) => !unit.cancelled);
  const completedUnits = activeUnits.filter((unit) => unit.completed).length;
  const totalUnits = activeUnits.length;
  const basisPoints =
    totalUnits === 0 ? 10_000 : Math.floor((completedUnits * 10_000) / totalUnits);

  let overallState: FulfillmentProgressResult["overallState"] = "not_started";

  if (input.orderState === "cancelled" || (units.length > 0 && activeUnits.length === 0)) {
    overallState = "cancelled";
  } else if (activeUnits.some((unit) => unit.blocked)) {
    overallState = "attention_required";
  } else if (activeUnits.some((unit) => unit.awaitingBuyer)) {
    overallState = "awaiting_buyer";
  } else if (totalUnits > 0 && completedUnits === totalUnits) {
    overallState = "completed";
  } else if (
    completedUnits > 0 ||
    input.orderState === "in_fulfillment" ||
    input.orderState === "partially_completed"
  ) {
    overallState = "in_progress";
  }

  return {
    completedUnits,
    totalUnits,
    basisPoints,
    overallState,
  };
}

export function isShipmentLegCommandAllowed(
  currentState: LegState,
  command: ShipmentLegCommand["command"],
): boolean {
  return LEG_TRANSITIONS[currentState].has(command);
}
