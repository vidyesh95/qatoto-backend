import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceEncryptedDocument,
  commerceOrder,
  commerceOrderThirdPartyDeclaration,
  commerceShipment,
  commerceShipmentLeg,
} from "#src/db/schema.js";
import type { RecordDeclarationBody } from "#src/modules/store/orders/commerce-order-declaration.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * Third-party declarations — what a party SAYS it arranged with an insurer, a warehouse's insurer
 * or a laboratory for an order.
 *
 * ## A record of a claim, and nothing more
 *
 * Qatoto is not an insurer, a broker, a warehouse or a conformity assessment body. It never sees
 * the policy, the storage contract or the test, and it checks none of what is typed here. So:
 *
 *   - **Every row is attributed** to the organization and side that made it, and the read says so.
 *   - **No verdict field exists.** A test report records the standard it was tested against and
 *     NO pass/fail. A stored "passed" on a self-arranged report is the endorsement this platform
 *     must not make — the laboratory's own result belongs to the laboratory's own document.
 *   - **The disclaimer is the server's.** The author must echo the CURRENT version to write, and
 *     the stored version is this file's constant, never the request's. A stale tab is refused
 *     rather than recorded as having acknowledged text it never showed.
 *
 * ## Both parties may declare, regardless of the Incoterm
 *
 * An Incoterm decides who is OBLIGED to insure; it does not decide who MAY. A buyer on CIF terms
 * commonly buys top-up cover over the seller's minimum. So the side is derived and recorded, and
 * nothing here refuses a declaration on contractual grounds it cannot see.
 *
 * ## Append-only except for withdrawal
 *
 * A correction is a withdrawal plus a new row. Editing in place would rewrite what the other party
 * may already have read and relied on. Withdrawal is the author's alone, and a withdrawn row stays
 * on the read, labelled, so the history is honest.
 *
 * ## No audit entry, on the settlement-attestation precedent
 *
 * The row records who declared, as which member, when; and who withdrew it, when. An audit entry
 * would be a second copy of the same facts.
 */

type OrderRow = typeof commerceOrder.$inferSelect;
type DeclarationRow = typeof commerceOrderThirdPartyDeclaration.$inferSelect;

/**
 * THE NON-LIABILITY TEXT, VERSIONED. Bump `version` whenever either sentence changes — a write
 * acknowledging an old version is then refused, so every stored row names text that was actually
 * shown. The frontend renders these strings from the list read rather than keeping its own copy,
 * so the two can never disagree about what was acknowledged.
 */
export const THIRD_PARTY_DECLARATION_DISCLAIMER = {
  version: "2026-10-03.1",
  coverText:
    "Qatoto does not underwrite, quote, broker or hold a premium, and does not check this policy. " +
    "Cover is a contract between the policyholder and the insurer alone, and this record does not " +
    "mean any goods are covered or that a claim would be paid.",
  testReportText:
    "Qatoto is not a testing laboratory or conformity assessment body and does not check this " +
    "report. A report says only what the laboratory that issued it says, and this record does not " +
    "mean any product conforms to a standard.",
} as const;

export type CommerceOrderDeclarationError =
  /** Unknown order, and also the answer a non-party gets — see `loadOrderForActor`. */
  | { type: "NOT_FOUND" }
  | { type: "DECLARATION_NOT_FOUND" }
  | { type: "ORDER_CANCELLED" }
  | { type: "DISCLAIMER_VERSION_STALE"; currentVersion: string }
  | { type: "LEG_NOT_ON_ORDER" }
  | { type: "DOCUMENT_NOT_AVAILABLE" }
  | { type: "NOT_AUTHOR" }
  | { type: "ALREADY_WITHDRAWN" };

export interface OrderDeclarationActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
}

export interface OrderDeclarationProjection {
  readonly id: string;
  readonly orderId: string;
  readonly kind: DeclarationRow["kind"];
  readonly declaredBySide: DeclarationRow["declaredBySide"];
  /** The declaring side's legal name as the ORDER snapshotted it — no join, no rename drift. */
  readonly declaredByLegalNameSnapshot: string;
  /** Whether the CALLER's organization made this declaration, which is what a Withdraw control needs. */
  readonly isOwnDeclaration: boolean;
  readonly issuer: string;
  readonly reference: string;
  readonly coverageClass: string | null;
  readonly standard: string | null;
  /** One nullable object rather than two nullable fields — half an amount is unanswerable. */
  readonly coverage: { readonly amountInCents: number; readonly currency: string } | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly issuedOn: string | null;
  readonly shipmentLegId: string | null;
  readonly evidenceDocumentId: string | null;
  readonly note: string | null;
  readonly disclaimerVersion: string;
  readonly withdrawnAt: Date | null;
  readonly createdAt: Date;
}

export interface OrderDeclarationListProjection {
  readonly orderId: string;
  /**
   * Whether a new declaration may be written. FALSE on a cancelled order, answered on the read so a
   * client can hide the form without provoking a 409 to find out.
   */
  readonly isDeclarable: boolean;
  readonly disclaimer: typeof THIRD_PARTY_DECLARATION_DISCLAIMER;
  readonly items: readonly OrderDeclarationProjection[];
}

/**
 * The order, if the caller is a party to it. A NON-PARTY GETS `NOT_FOUND`, byte-identical to an
 * unknown id — the line `getOrder` and the settlement attestations draw, for the same reason.
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
 * The buyer branch first, so an organization on both sides of its own order resolves
 * deterministically — the same tie-break as `resolveAttestationKind`.
 */
function resolveDeclaringSide(
  order: OrderRow,
  actorOrganizationId: string,
): DeclarationRow["declaredBySide"] {
  return order.buyerOrganizationId === actorOrganizationId ? "buyer" : "counterparty";
}

function projectDeclaration(
  order: OrderRow,
  row: DeclarationRow,
  actorOrganizationId: string,
): OrderDeclarationProjection {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    declaredBySide: row.declaredBySide,
    declaredByLegalNameSnapshot:
      row.declaredBySide === "buyer"
        ? order.buyerLegalNameSnapshot
        : order.counterpartyLegalNameSnapshot,
    isOwnDeclaration: row.declaredByOrganizationId === actorOrganizationId,
    issuer: row.issuer,
    reference: row.reference,
    coverageClass: row.coverageClass,
    standard: row.standard,
    coverage:
      row.coverageAmountInCents !== null && row.coverageCurrency !== null
        ? { amountInCents: row.coverageAmountInCents, currency: row.coverageCurrency }
        : null,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    issuedOn: row.issuedOn,
    shipmentLegId: row.shipmentLegId,
    evidenceDocumentId: row.evidenceDocumentId,
    note: row.note,
    disclaimerVersion: row.disclaimerVersion,
    withdrawnAt: row.withdrawnAt,
    createdAt: row.createdAt,
  };
}

async function loadDeclarationList(
  order: OrderRow,
  actorOrganizationId: string,
): Promise<OrderDeclarationListProjection> {
  const rows = await db
    .select()
    .from(commerceOrderThirdPartyDeclaration)
    .where(eq(commerceOrderThirdPartyDeclaration.orderId, order.id))
    .orderBy(
      desc(commerceOrderThirdPartyDeclaration.createdAt),
      desc(commerceOrderThirdPartyDeclaration.id),
    );

  return {
    orderId: order.id,
    isDeclarable: order.state !== "cancelled",
    disclaimer: THIRD_PARTY_DECLARATION_DISCLAIMER,
    items: rows.map((row) => projectDeclaration(order, row, actorOrganizationId)),
  };
}

/** Both parties' declarations for one order, withdrawn ones included. Parties only. */
export async function listOrderDeclarations(
  actor: OrderDeclarationActorContext,
  orderId: string,
): Promise<Result<OrderDeclarationListProjection, CommerceOrderDeclarationError>> {
  const order = await loadOrderForActor(actor.organizationId, orderId);
  if (!order) return { success: false, error: { type: "NOT_FOUND" } };
  return { success: true, value: await loadDeclarationList(order, actor.organizationId) };
}

/**
 * Records one party's declaration. Answers with the WHOLE list, so the writer sees their row beside
 * the other party's without racing their own write with a second GET.
 */
export async function recordOrderDeclaration(
  actor: OrderDeclarationActorContext,
  orderId: string,
  body: RecordDeclarationBody,
): Promise<Result<OrderDeclarationListProjection, CommerceOrderDeclarationError>> {
  const order = await loadOrderForActor(actor.organizationId, orderId);
  if (!order) return { success: false, error: { type: "NOT_FOUND" } };

  if (order.state === "cancelled") {
    return { success: false, error: { type: "ORDER_CANCELLED" } };
  }

  if (body.acknowledgedDisclaimerVersion !== THIRD_PARTY_DECLARATION_DISCLAIMER.version) {
    return {
      success: false,
      error: {
        type: "DISCLAIMER_VERSION_STALE",
        currentVersion: THIRD_PARTY_DECLARATION_DISCLAIMER.version,
      },
    };
  }

  const shipmentLegId = body.kind === "transit_cover" ? (body.shipmentLegId ?? null) : null;
  if (shipmentLegId !== null) {
    const [leg] = await db
      .select({ id: commerceShipmentLeg.id })
      .from(commerceShipmentLeg)
      .innerJoin(commerceShipment, eq(commerceShipment.id, commerceShipmentLeg.shipmentId))
      .where(and(eq(commerceShipmentLeg.id, shipmentLegId), eq(commerceShipment.orderId, order.id)))
      .limit(1);
    if (!leg) return { success: false, error: { type: "LEG_NOT_ON_ORDER" } };
  }

  /**
   * OWNED AND SCANNED CLEAN, the predicate `assertOwnedDocuments` uses for RFQs. The other party
   * gains read access to this file through the declaration (`organizationMayReadDocument`), so a
   * file that is `pending_scan` or `quarantined` must never be attachable here.
   */
  const evidenceDocumentId = body.evidenceDocumentId ?? null;
  if (evidenceDocumentId !== null) {
    const [document] = await db
      .select({ id: commerceEncryptedDocument.id })
      .from(commerceEncryptedDocument)
      .where(
        and(
          eq(commerceEncryptedDocument.id, evidenceDocumentId),
          eq(commerceEncryptedDocument.organizationId, actor.organizationId),
          eq(commerceEncryptedDocument.state, "available"),
        ),
      )
      .limit(1);
    if (!document) return { success: false, error: { type: "DOCUMENT_NOT_AVAILABLE" } };
  }

  const isCover = body.kind === "transit_cover" || body.kind === "storage_cover";
  await db.insert(commerceOrderThirdPartyDeclaration).values({
    orderId: order.id,
    shipmentLegId,
    kind: body.kind,
    declaredBySide: resolveDeclaringSide(order, actor.organizationId),
    declaredByOrganizationId: actor.organizationId,
    declaredByMemberId: actor.memberId,
    issuer: body.issuer,
    reference: body.reference,
    coverageClass: isCover ? (body.coverageClass ?? null) : null,
    standard: body.kind === "test_report" ? body.standard : null,
    coverageAmountInCents: isCover ? (body.coverage?.amountInCents ?? null) : null,
    coverageCurrency: isCover ? (body.coverage?.currency ?? null) : null,
    validFrom: body.validFrom ?? null,
    validUntil: body.validUntil ?? null,
    issuedOn: body.kind === "test_report" ? (body.issuedOn ?? null) : null,
    evidenceDocumentId,
    note: body.note ?? null,
    // The server's version, never the request's — see the file header.
    disclaimerVersion: THIRD_PARTY_DECLARATION_DISCLAIMER.version,
  });

  return { success: true, value: await loadDeclarationList(order, actor.organizationId) };
}

/**
 * Withdraws the caller's own declaration. The other party gets 403 rather than 404 — they can
 * already read the row, so hiding its existence would protect nothing. A repeat is a 409, which is
 * why this route needs no idempotency key: a second press changes nothing.
 */
export async function withdrawOrderDeclaration(
  actor: OrderDeclarationActorContext,
  orderId: string,
  declarationId: string,
): Promise<Result<OrderDeclarationListProjection, CommerceOrderDeclarationError>> {
  const order = await loadOrderForActor(actor.organizationId, orderId);
  if (!order) return { success: false, error: { type: "NOT_FOUND" } };

  const [declaration] = await db
    .select({
      id: commerceOrderThirdPartyDeclaration.id,
      declaredByOrganizationId: commerceOrderThirdPartyDeclaration.declaredByOrganizationId,
      withdrawnAt: commerceOrderThirdPartyDeclaration.withdrawnAt,
    })
    .from(commerceOrderThirdPartyDeclaration)
    .where(
      and(
        eq(commerceOrderThirdPartyDeclaration.id, declarationId),
        eq(commerceOrderThirdPartyDeclaration.orderId, order.id),
      ),
    )
    .limit(1);
  if (!declaration) return { success: false, error: { type: "DECLARATION_NOT_FOUND" } };
  if (declaration.declaredByOrganizationId !== actor.organizationId) {
    return { success: false, error: { type: "NOT_AUTHOR" } };
  }
  if (declaration.withdrawnAt !== null) {
    return { success: false, error: { type: "ALREADY_WITHDRAWN" } };
  }

  // Conditional on `withdrawn_at IS NULL` so two concurrent presses cannot both succeed.
  const updated = await db
    .update(commerceOrderThirdPartyDeclaration)
    .set({ withdrawnAt: new Date(), withdrawnByMemberId: actor.memberId })
    .where(
      and(
        eq(commerceOrderThirdPartyDeclaration.id, declaration.id),
        isNull(commerceOrderThirdPartyDeclaration.withdrawnAt),
      ),
    )
    .returning({ id: commerceOrderThirdPartyDeclaration.id });
  if (updated.length === 0) return { success: false, error: { type: "ALREADY_WITHDRAWN" } };

  return { success: true, value: await loadDeclarationList(order, actor.organizationId) };
}
