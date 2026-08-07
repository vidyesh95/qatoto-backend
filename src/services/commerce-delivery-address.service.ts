import { and, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceOrder, commerceOrganizationAddress } from "#src/db/schema.js";
import {
  memberCanOperateCounterparty,
  type CommerceOrganizationMemberRole,
} from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import { readableAddress } from "#src/services/commerce-organizations.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The A15 reveal path — the authorized decrypt route §14 chose over a seller-openable
 * encrypted snapshot.
 *
 * THIS IS THE ONLY PLACE IN THIS BACKEND THAT HANDS ONE ORGANIZATION ANOTHER'S PII.
 * Everything else that decrypts commerce PII returns it to the organization that owns
 * it. Three gates and an audit entry are the entire safety argument:
 *
 *  1. the caller is a party to the order (and a stranger gets NOT_FOUND, not a hint);
 *  2. a seller-side caller holds a counterparty-operating role, the same gate that
 *     guards creating a shipment;
 *  3. the order is far enough along that shipping is the point — an unpaid order does
 *     not reveal a home address, and a cancelled one has nothing to ship.
 *
 * The audit entry is written to the BUYER's stream, not the seller's. It is the
 * buyer's address, and the buyer is who deserves the record of who opened it.
 */

export type CommerceDeliveryAddressError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "INVALID_STATE"; orderState: string }
  /** A quote-originated order has no buyer-chosen delivery address to reveal. */
  | { type: "ADDRESS_UNAVAILABLE" };

export interface CommerceDeliveryAddressActor {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface RevealedDeliveryAddressProjection {
  readonly orderId: string;
  readonly addressId: string;
  readonly recipientName: string | null;
  readonly addressLineOne: string | null;
  readonly addressLineTwo: string | null;
  readonly phone: string | null;
  readonly countryCode: string;
  readonly regionCode: string | null;
  readonly locality: string;
  readonly postalCode: string | null;
}

/**
 * `disputed` is deliberately absent. Phase 7 freezes fulfillment while an order is
 * disputed, and a frozen order is not one anybody should be pulling a shipping address
 * for. `pending_payment` and `payment_processing` are absent for the sharper reason:
 * money has not moved, and an unpaid order must not become a way to harvest addresses.
 */
const REVEALABLE_ORDER_STATES: readonly string[] = [
  "confirmed",
  "in_fulfillment",
  "partially_completed",
  "completed",
];

export async function revealOrderDeliveryAddress(
  actor: CommerceDeliveryAddressActor,
  orderId: string,
): Promise<Result<RevealedDeliveryAddressProjection, CommerceDeliveryAddressError>> {
  const occurredAt = new Date();

  const outcome = await db.transaction(async (transaction) => {
    const [order] = await transaction
      .select({
        id: commerceOrder.id,
        buyerOrganizationId: commerceOrder.buyerOrganizationId,
        counterpartyOrganizationId: commerceOrder.counterpartyOrganizationId,
        state: commerceOrder.state,
        deliveryAddressId: commerceOrder.deliveryAddressId,
      })
      .from(commerceOrder)
      .where(eq(commerceOrder.id, orderId))
      .limit(1);
    if (!order) return { status: "not_found" as const };

    const callerIsBuyer = order.buyerOrganizationId === actor.organizationId;
    const callerIsCounterparty = order.counterpartyOrganizationId === actor.organizationId;
    /**
     * NOT_FOUND rather than FORBIDDEN: a stranger must not learn that an order id
     * exists, which is the posture `getOrder` already takes.
     */
    if (!callerIsBuyer && !callerIsCounterparty) return { status: "not_found" as const };

    /**
     * Only the seller side needs a role gate. A buyer reading its own organization's
     * address discloses nothing it could not already read through `listAddresses`.
     */
    if (callerIsCounterparty && !callerIsBuyer && !memberCanOperateCounterparty(actor.memberRole)) {
      return { status: "forbidden" as const };
    }

    if (!REVEALABLE_ORDER_STATES.includes(order.state)) {
      return { status: "invalid_state" as const, orderState: order.state };
    }
    if (order.deliveryAddressId === null) {
      return { status: "address_unavailable" as const };
    }

    const [addressRow] = await transaction
      .select()
      .from(commerceOrganizationAddress)
      .where(
        and(
          eq(commerceOrganizationAddress.id, order.deliveryAddressId),
          // Belt and braces: the address must still belong to the buyer on the order.
          eq(commerceOrganizationAddress.organizationId, order.buyerOrganizationId),
        ),
      )
      .limit(1);
    if (!addressRow) return { status: "address_unavailable" as const };

    /**
     * Audited only when a COUNTERPARTY reads it. A buyer opening its own address is
     * not a disclosure, and logging it would bury the entries that matter.
     */
    if (callerIsCounterparty && !callerIsBuyer) {
      const appended = await appendCommerceOrganizationAuditEntry(transaction, {
        organizationId: order.buyerOrganizationId,
        eventKind: "delivery_address_revealed",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_organization_address",
        targetEntityId: addressRow.id,
        /**
         * Payload keys are checked against a PII-name regex, so nothing here may be
         * called `addressId` — the id rides `targetEntityId`, which is a column.
         */
        payload: {
          orderId: order.id,
          revealedToOrganizationId: actor.organizationId,
          orderState: order.state,
        },
        occurredAt,
      });
      /**
       * Throwing rolls the read back. An unlogged reveal is worse than a failed one:
       * the entire argument for choosing a decrypt path over an openable snapshot was
       * that every read leaves a record.
       */
      if (!appended.success) {
        throw new Error(`Delivery address reveal audit failed: ${appended.error.type}`);
      }
    }

    return { status: "revealed" as const, orderId: order.id, address: addressRow };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "forbidden":
      return { success: false, error: { type: "FORBIDDEN" } };
    case "invalid_state":
      return {
        success: false,
        error: { type: "INVALID_STATE", orderState: outcome.orderState },
      };
    case "address_unavailable":
      return { success: false, error: { type: "ADDRESS_UNAVAILABLE" } };
    case "revealed": {
      const decrypted = readableAddress(outcome.address);
      return {
        success: true,
        value: {
          orderId: outcome.orderId,
          addressId: decrypted.id,
          recipientName: decrypted.recipientName,
          addressLineOne: decrypted.addressLineOne,
          addressLineTwo: decrypted.addressLineTwo,
          phone: decrypted.phone,
          countryCode: decrypted.countryCode,
          regionCode: decrypted.regionCode,
          locality: decrypted.locality,
          postalCode: decrypted.postalCode,
        },
      };
    }
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(
        `Unhandled delivery address reveal outcome: ${JSON.stringify(exhaustiveOutcome)}`,
      );
    }
  }
}
