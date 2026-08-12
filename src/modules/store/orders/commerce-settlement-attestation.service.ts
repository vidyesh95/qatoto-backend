import { and, asc, count, eq, gte, lt, notInArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceOrder, commerceSettlementAttestation } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

/**
 * Settlement attestations — the `direct_offline` rail's only record that money moved.
 *
 * ## Why this exists at all
 *
 * `direct_offline` is what the rail enum itself calls "The default": T/T, an L/C, or whatever
 * two organizations arranged between their own banks. Its schema comment is blunt about what
 * Qatoto knows — "Qatoto observes nothing." Until this service, that was literally true in the
 * strongest sense: `commerce_settlement_attestation` had been in the schema since Phase 14 with
 * NO WRITER AND NO ROUTE anywhere in the codebase. The table was reachable only by hand.
 *
 * The cost of that was not abstract. A seller's earnings on the most common rail were
 * unknowable, because nothing in the system had ever been told the wire arrived.
 *
 * ## A CLAIM, NOT AN OBSERVATION — and the distinction is the whole design
 *
 * An attestation is one organization saying "I sent it" or "I received it". Qatoto did not see
 * the money, cannot see the money, and has no relationship with either bank. So:
 *
 *   - **Nothing here posts to the journal.** `commerce_journal_entry` is hash-chained evidence
 *     of what this platform observed. Writing a self-report into it would launder a claim into
 *     evidence, and every downstream reader of that ledger would be entitled to believe it.
 *   - **Every read that consumes this must label it self-reported** and must never add it to a
 *     processor-settled or escrow-released figure. `GET /commerce/provider/earnings` keeps it in
 *     a separate `selfReported` member for exactly this reason.
 *
 * ## Both sides attest, and disagreement is the point
 *
 * The unique index is `(order_id, attested_by_organization_id, attestation_kind)`, so each party
 * gets exactly one attestation of its own kind. The read returns BOTH, because the useful
 * question on an offline order is not "did someone claim payment" but "do the two parties agree
 * about the amount". A mismatch is surfaced rather than reconciled — this service has no basis
 * on which to decide which party is right, and inventing one would be worse than showing both.
 *
 * ## No audit entry, deliberately
 *
 * `commerce_organization_audit_entry` has no event kind for this and does not need one. The
 * attestation row already records who attested, as which member, for how much, when it happened
 * and when it was written; it is append-only and unique per party. An audit entry would be a
 * second copy of the same facts, and the enum value would cost a migration to say nothing new.
 */

type OrderRow = typeof commerceOrder.$inferSelect;
type SettlementAttestationRow = typeof commerceSettlementAttestation.$inferSelect;

export type CommerceSettlementAttestationError =
  /** Unknown order, and also the answer a non-party gets — see `loadOrderForActor`. */
  | { type: "NOT_FOUND" }
  | { type: "RAIL_NOT_ATTESTABLE"; settlementRail: OrderRow["settlementRail"] }
  | { type: "ALREADY_ATTESTED"; attestationKind: SettlementAttestationRow["attestationKind"] }
  | { type: "VALIDATION_FAILED"; message: string };

export interface SettlementAttestationActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
}

export interface RecordSettlementAttestationInput {
  readonly amountInCents: number;
  readonly occurredAt: Date;
  readonly referenceNote: string | null;
}

export interface SettlementAttestationProjection {
  readonly id: string;
  readonly orderId: string;
  readonly attestationKind: SettlementAttestationRow["attestationKind"];
  readonly attestedByOrganizationId: string;
  /**
   * WHICH SIDE OF THE ORDER ATTESTED, derived rather than stored.
   *
   * The client needs to render "the buyer says they sent it" beside "you say you received it",
   * and resolving that from two organization ids means the client has to know which id it is —
   * which it does not on a shared surface. The order already carries both ids, so this costs
   * no join.
   */
  readonly attestedByRole: "buyer" | "seller";
  readonly attestedByLegalNameSnapshot: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly referenceNote: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export interface SettlementAttestationListProjection {
  readonly orderId: string;
  readonly settlementRail: OrderRow["settlementRail"];
  readonly currency: string;
  readonly orderTotalInCents: number;
  /**
   * Whether this order's rail admits an attestation at all. FALSE is a legitimate answer and
   * not an error on the read — a client showing an order detail should be able to say "this
   * settles through a processor, nothing to attest" without provoking a 409 to find out.
   */
  readonly isAttestable: boolean;
  readonly items: readonly SettlementAttestationProjection[];
}

/**
 * The order, if the caller is a party to it.
 *
 * A NON-PARTY GETS `NOT_FOUND`, byte-identical to an unknown id. This is the same line
 * `getOrder` draws: distinguishing "that order exists but is not yours" from "no such order"
 * hands an enumerator a membership oracle over every order id.
 */
async function loadOrderForActor(
  actorOrganizationId: string,
  orderId: string,
): Promise<OrderRow | null> {
  const [order] = await db
    .select()
    .from(commerceOrder)
    .where(eq(commerceOrder.id, orderId))
    .limit(1);

  if (!order) return null;
  if (
    order.buyerOrganizationId !== actorOrganizationId &&
    order.counterpartyOrganizationId !== actorOrganizationId
  ) {
    return null;
  }
  return order;
}

/**
 * Which attestation this actor is entitled to write, DERIVED FROM THE ORDER, never accepted
 * from the request.
 *
 * ESCROW_LEDGER_STRUCTURE.md §0: "No request body ever carries a value the server owns." A
 * body-supplied `attestationKind` would let a buyer record that the SELLER received money —
 * the one claim a buyer has no standing to make, and the one that would inflate a seller's
 * earnings figure without the seller ever touching it.
 *
 * The buyer branch is checked first so that a hypothetical order whose two sides are the same
 * organization resolves deterministically rather than by row order.
 */
function resolveAttestationKind(
  order: OrderRow,
  actorOrganizationId: string,
): SettlementAttestationRow["attestationKind"] {
  return order.buyerOrganizationId === actorOrganizationId ? "payment_sent" : "payment_received";
}

function projectAttestation(
  order: OrderRow,
  row: SettlementAttestationRow,
): SettlementAttestationProjection {
  const isBuyer = row.attestedByOrganizationId === order.buyerOrganizationId;
  return {
    id: row.id,
    orderId: row.orderId,
    attestationKind: row.attestationKind,
    attestedByOrganizationId: row.attestedByOrganizationId,
    attestedByRole: isBuyer ? "buyer" : "seller",
    attestedByLegalNameSnapshot: isBuyer
      ? order.buyerLegalNameSnapshot
      : order.counterpartyLegalNameSnapshot,
    amountInCents: row.amountInCents,
    currency: row.currency,
    referenceNote: row.referenceNote,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

async function loadAttestationList(
  order: OrderRow,
): Promise<SettlementAttestationListProjection> {
  const rows = await db
    .select()
    .from(commerceSettlementAttestation)
    .where(eq(commerceSettlementAttestation.orderId, order.id))
    .orderBy(asc(commerceSettlementAttestation.occurredAt), asc(commerceSettlementAttestation.id));

  return {
    orderId: order.id,
    settlementRail: order.settlementRail,
    currency: order.currency,
    orderTotalInCents: order.totalInCents,
    isAttestable: order.settlementRail === "direct_offline",
    items: rows.map((row) => projectAttestation(order, row)),
  };
}

/** Both parties' attestations for one order. Visible to either party, nobody else. */
export async function listSettlementAttestations(
  actor: SettlementAttestationActorContext,
  orderId: string,
): Promise<Result<SettlementAttestationListProjection, CommerceSettlementAttestationError>> {
  const order = await loadOrderForActor(actor.organizationId, orderId);
  if (!order) return { success: false, error: { type: "NOT_FOUND" } };

  return { success: true, value: await loadAttestationList(order) };
}

/**
 * Records one party's claim that money moved on this order.
 *
 * Returns the WHOLE list rather than the inserted row, so the caller immediately sees its own
 * attestation beside the counterparty's — including the case where the two disagree about the
 * amount, which is the single most useful thing this surface can show and would be invisible if
 * the write answered with only what the writer just said.
 */
export async function recordSettlementAttestation(
  actor: SettlementAttestationActorContext,
  orderId: string,
  input: RecordSettlementAttestationInput,
): Promise<Result<SettlementAttestationListProjection, CommerceSettlementAttestationError>> {
  const order = await loadOrderForActor(actor.organizationId, orderId);
  if (!order) return { success: false, error: { type: "NOT_FOUND" } };

  /**
   * ONLY THE OFFLINE RAIL. On `direct_processor` and `external_escrow` the money IS observed —
   * a payment intent settles or a provider event releases a milestone — so an attestation there
   * would be a self-report competing with evidence, and any reader would have to decide which to
   * believe. `internal_custody` is frozen. Refusing is the honest answer; the rail is on the
   * error so the client can say which one it is.
   */
  if (order.settlementRail !== "direct_offline") {
    return {
      success: false,
      error: { type: "RAIL_NOT_ATTESTABLE", settlementRail: order.settlementRail },
    };
  }

  if (input.amountInCents > order.totalInCents) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "The attested amount is larger than the order total.",
      },
    };
  }

  /**
   * A wire cannot have arrived later than now. The rest of `occurredAt` is the party's to state
   * — they know when their bank moved it and this server does not — but a future date would put
   * money into a window that has not happened, which every period read would then report.
   */
  if (input.occurredAt.getTime() > Date.now()) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "The payment date cannot be in the future." },
    };
  }

  const attestationKind = resolveAttestationKind(order, actor.organizationId);

  /**
   * `onConflictDoNothing` against `commerce_settlement_attestation_uidx`, then detect the
   * no-row case. A SECOND ATTESTATION IS A FINDING, NOT A RETRY: the caller is telling us a
   * different amount or date for a payment they already recorded, and silently overwriting the
   * first claim would erase the version the counterparty may have already read and acted on.
   * Corrections belong in a conversation, the same way a journal correction is a reversing
   * entry rather than an edit.
   */
  const inserted = await db
    .insert(commerceSettlementAttestation)
    .values({
      orderId: order.id,
      attestedByOrganizationId: actor.organizationId,
      attestedByMemberId: actor.memberId,
      attestationKind,
      amountInCents: input.amountInCents,
      // Read off the order, never accepted — one order settles in one currency.
      currency: order.currency,
      referenceNote: input.referenceNote,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: commerceSettlementAttestation.id });

  if (inserted.length === 0) {
    return { success: false, error: { type: "ALREADY_ATTESTED", attestationKind } };
  }

  return { success: true, value: await loadAttestationList(order) };
}

/**
 * Order ids on this seller's `direct_offline` orders that nobody has yet marked received.
 *
 * Exported for the earnings read, which reports the count as a BLIND SPOT rather than treating
 * those orders as unpaid. They may well have been paid — that is precisely the point: nobody
 * has told this platform, so no figure can include them and no figure should pretend they are
 * zero.
 */
export async function countOfflineOrdersWithoutSellerAttestation(
  sellerOrganizationId: string,
  window: { readonly from: Date | null; readonly to: Date | null },
): Promise<number> {
  const sellerAttestedOrderIds = db
    .select({ orderId: commerceSettlementAttestation.orderId })
    .from(commerceSettlementAttestation)
    .where(
      and(
        eq(commerceSettlementAttestation.attestedByOrganizationId, sellerOrganizationId),
        eq(commerceSettlementAttestation.attestationKind, "payment_received"),
      ),
    );

  /**
   * BUCKETED ON `created_at`, not on a settlement timestamp, because an unattested order has
   * no settlement timestamp — that absence is the entire thing being counted.
   */
  const [row] = await db
    .select({ orderCount: count() })
    .from(commerceOrder)
    .where(
      and(
        eq(commerceOrder.counterpartyOrganizationId, sellerOrganizationId),
        eq(commerceOrder.settlementRail, "direct_offline"),
        window.from === null ? undefined : gte(commerceOrder.createdAt, window.from),
        window.to === null ? undefined : lt(commerceOrder.createdAt, window.to),
        notInArray(commerceOrder.id, sellerAttestedOrderIds),
      ),
    );

  return row?.orderCount ?? 0;
}
