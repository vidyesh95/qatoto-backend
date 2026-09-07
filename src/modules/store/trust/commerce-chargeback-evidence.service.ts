import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceMessage,
  commerceMessageAttachment,
  commerceOrder,
  commerceShipment,
  commerceShipmentEvent,
  commerceShipmentLeg,
  commerceShipmentProductLine,
  commerceThread,
  user,
} from "#src/db/schema.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import { projectShipmentLeg } from "#src/modules/store/fulfillment/commerce-fulfillment-phase6.service.js";
import {
  projectOrderDetail,
  type OrderDetailProjection,
} from "#src/modules/store/orders/commerce-orders.service.js";
import type { CommerceMessageProjection } from "#src/modules/store/procurement/commerce-messages.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Chargeback evidence — a distinct concern from `commerce-trust.service.ts`'s disputes.
 *
 * A DISPUTE is opened by the buyer and decided BY QATOTO (`commerce_dispute`, this module's
 * sibling file). A CHARGEBACK is decided by the buyer's card issuer, entirely off this
 * platform — Qatoto has no vote and no escrow to release or withhold. This service exists
 * only to hand a staff member the raw record for one order so they can attach it to whatever
 * the issuer's own dispute process asks for. Nothing here submits anywhere automatically.
 */

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ChargebackEvidenceError = PlatformAccessError | { readonly type: "NOT_FOUND" };

export type ChargebackEvidenceMessage = CommerceMessageProjection;

export interface ChargebackEvidenceShipment {
  readonly id: string;
  readonly orderId: string;
  readonly state: string;
  readonly originCountryCode: string | null;
  readonly originLocality: string | null;
  readonly destinationCountryCode: string | null;
  readonly destinationLocality: string | null;
  readonly packageCount: number;
  readonly totalWeightGrams: number | null;
  readonly createdAt: Date;
  readonly version: number;
  readonly productLines: readonly {
    readonly id: string;
    readonly orderProductLineId: string;
    readonly quantity: number;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly eventKind: string;
    readonly occurredAt: Date;
    readonly description: string | null;
  }[];
  readonly legs: readonly ReturnType<typeof projectShipmentLeg>[];
}

export interface ChargebackEvidenceBundle {
  readonly order: OrderDetailProjection;
  readonly messages: readonly ChargebackEvidenceMessage[];
  readonly shipments: readonly ChargebackEvidenceShipment[];
  readonly generatedAt: Date;
  readonly exportedByStaffEmail: string;
  readonly exportAuditId: string;
}

/**
 * Every message on the order's accepted-quote thread, with NO participant check.
 *
 * `assertThreadParticipant` in `commerce-messages.service.ts` is deliberately not called here —
 * the staff capability check already authorized this read, and the whole point is that neither
 * party gated it. Row shape is copied from `listMessages`'s inline `.map()` rather than imported,
 * because that file has no standalone projection helper to reuse (see the exploration note this
 * function's call site cites).
 *
 * Orders with no accepted quote have no thread at all — this returns `[]`, not an error, for
 * exactly that (common) case.
 */
async function loadOrderMessages(
  acceptedQuoteId: string | null,
): Promise<ChargebackEvidenceMessage[]> {
  if (acceptedQuoteId === null) return [];

  const [thread] = await db
    .select({ id: commerceThread.id })
    .from(commerceThread)
    .where(
      and(eq(commerceThread.resourceKind, "quote"), eq(commerceThread.resourceId, acceptedQuoteId)),
    )
    .limit(1);
  if (!thread) return [];

  const rows = await db
    .select({
      id: commerceMessage.id,
      threadId: commerceMessage.threadId,
      authorOrganizationId: commerceMessage.authorOrganizationId,
      authorMemberId: commerceMessage.authorMemberId,
      bodyText: commerceMessage.bodyText,
      createdAt: commerceMessage.createdAt,
    })
    .from(commerceMessage)
    .where(eq(commerceMessage.threadId, thread.id))
    .orderBy(asc(commerceMessage.createdAt), asc(commerceMessage.id));

  const messageIds = rows.map((row) => row.id);
  const attachments =
    messageIds.length === 0
      ? []
      : await db
          .select({
            messageId: commerceMessageAttachment.messageId,
            encryptedDocumentId: commerceMessageAttachment.encryptedDocumentId,
          })
          .from(commerceMessageAttachment)
          .where(inArray(commerceMessageAttachment.messageId, messageIds));

  const attachmentsByMessageId = new Map<string, string[]>();
  for (const attachment of attachments) {
    const existing = attachmentsByMessageId.get(attachment.messageId) ?? [];
    existing.push(attachment.encryptedDocumentId);
    attachmentsByMessageId.set(attachment.messageId, existing);
  }

  return rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    authorOrganizationId: row.authorOrganizationId,
    authorMemberId: row.authorMemberId,
    bodyText: row.bodyText,
    createdAt: row.createdAt,
    encryptedDocumentIds: attachmentsByMessageId.get(row.id) ?? [],
  }));
}

/**
 * Every shipment for the order, with legs — same shape `getShipmentDetail` returns, minus its
 * actor/organization check, which is skipped for the same reason `loadOrderMessages` skips
 * `assertThreadParticipant`.
 */
async function loadOrderShipments(orderId: string): Promise<ChargebackEvidenceShipment[]> {
  const shipments = await db
    .select()
    .from(commerceShipment)
    .where(eq(commerceShipment.orderId, orderId));

  return Promise.all(
    shipments.map(async (shipment) => {
      const [productLines, events, legs] = await Promise.all([
        db
          .select()
          .from(commerceShipmentProductLine)
          .where(eq(commerceShipmentProductLine.shipmentId, shipment.id)),
        db
          .select()
          .from(commerceShipmentEvent)
          .where(eq(commerceShipmentEvent.shipmentId, shipment.id))
          .orderBy(asc(commerceShipmentEvent.occurredAt), asc(commerceShipmentEvent.id)),
        db
          .select()
          .from(commerceShipmentLeg)
          .where(eq(commerceShipmentLeg.shipmentId, shipment.id))
          .orderBy(asc(commerceShipmentLeg.sequence), asc(commerceShipmentLeg.id)),
      ]);

      return {
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
      };
    }),
  );
}

/**
 * Aggregates one order's detail, chat and shipments for a staff member's chargeback response,
 * and audits the export on the platform-wide chain.
 *
 * CAPABILITY CHECKED FIRST, order loaded SECOND — the house rule `platform-role.service.ts`
 * states by name: reversed, this route becomes an order-id oracle for anyone signed in.
 *
 * THE WHOLE THING RUNS IN ONE TRANSACTION and the audit write can roll back the read, mirroring
 * `commerce-delivery-address.service.ts`'s `revealOrderDeliveryAddress`: an unlogged export of
 * this much PII is worse than a failed one.
 */
export async function exportOrderChargebackEvidence(
  staffUserId: string,
  orderId: string,
): Promise<Result<ChargebackEvidenceBundle, ChargebackEvidenceError>> {
  const capability = await requirePlatformCapability(staffUserId, "export_chargeback_evidence");
  if (!capability.success) return capability;

  return db.transaction(async (tx: DatabaseExecutor) => {
    const [order] = await tx
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, orderId))
      .limit(1);
    if (!order) {
      return { success: false, error: { type: "NOT_FOUND" } } as const;
    }

    const [staff] = await tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, staffUserId))
      .limit(1);

    const [orderDetail, messages, shipments] = await Promise.all([
      projectOrderDetail(order),
      loadOrderMessages(order.acceptedQuoteId),
      loadOrderShipments(orderId),
    ]);

    const occurredAt = new Date();
    const auditEntry = await appendPlatformAuditEntry(tx, {
      eventKind: "chargeback_evidence_exported",
      actorUserId: staffUserId,
      actorRoleSnapshot: capability.value.platformRole,
      actionLabel: "Exported chargeback evidence",
      targetLabel: `order:${orderId}`,
      payload: { orderId },
      occurredAt,
    });

    return {
      success: true,
      value: {
        order: orderDetail,
        messages,
        shipments,
        generatedAt: occurredAt,
        exportedByStaffEmail: staff?.email ?? "",
        exportAuditId: auditEntry.id,
      },
    } as const;
  });
}
