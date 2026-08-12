import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceEngagementDeliverable,
  commerceOrder,
  commerceOrderProductLine,
  commerceOrderServiceLine,
  commerceOrderServiceLink,
  commerceOrganization,
  commerceProviderKindLink,
  commerceQuote,
  commerceQuoteProductLine,
  commerceQuoteRevision,
  commerceQuoteServiceDeliverablePlan,
  commerceQuoteServiceLine,
  commerceRfq,
  commerceRfqInvitation,
  commerceRfqProductLine,
  commerceRfqServiceLine,
  commerceServiceEngagement,
  commerceServiceEngagementEvent,
  customsBrokerageEngagementDetail,
  customsBrokerageQuoteServiceDetail,
  foreignExchangeEngagementDetail,
  foreignExchangeQuoteServiceDetail,
  freightEngagementDetail,
  freightQuoteServiceDetail,
  inspectionEngagementDetail,
  inspectionQuoteServiceDetail,
  insuranceEngagementDetail,
  insuranceQuoteServiceDetail,
  marketingEngagementDetail,
  marketingQuoteServiceDetail,
  product,
  testingCertificationEngagementDetail,
  testingCertificationQuoteServiceDetail,
  warehouseEngagementDetail,
  warehouseQuoteServiceDetail,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { deriveStockState } from "#src/modules/store/catalog/store-catalog.service.js";
import {
  derivePromisedDeliveryAt,
  latestPromisedDeliveryAt,
} from "#src/modules/store/commerce-promised-delivery.js";
import {
  createEscrowSessionForOrder,
  scheduleEscrowCommands,
} from "#src/modules/store/orders/commerce-escrow.service.js";
import {
  consumeSettlementAgreement,
  resolveSettlementRail,
} from "#src/modules/store/orders/commerce-settlement.service.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QuoteRow = typeof commerceQuote.$inferSelect;
type RevisionRow = typeof commerceQuoteRevision.$inferSelect;
/**
 * A40. Derived from the column rather than restated, so adding an Incoterm to the enum reaches
 * the service, the projections and the Zod schema without anybody editing three lists.
 */
export type CommerceIncoterm = NonNullable<RevisionRow["incoterm"]>;
type OrderRow = typeof commerceOrder.$inferSelect;
type QuoteDeliverablePlanRow = typeof commerceQuoteServiceDeliverablePlan.$inferSelect;
type QuoteServiceLineRow = typeof commerceQuoteServiceLine.$inferSelect;
type ProviderKind = (typeof commerceRfqServiceLine.$inferSelect)["providerKind"];
type FreightTransportMode = (typeof freightQuoteServiceDetail.$inferSelect.transportModes)[number];

export type CommerceQuotesError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "QUOTE_EXPIRED"; expiredAt: Date }
  | { type: "REVISION_CHANGED"; currentRevision: number }
  | { type: "RFQ_NOT_OPEN" }
  | { type: "ORGANIZATION_NOT_ACTIVE" }
  | { type: "CONFLICTING_ACCEPTANCE"; orderId: string }
  | { type: "INVALID_STATE" }
  | { type: "INSUFFICIENT_STOCK"; productId: string; availableQuantity: number }
  /**
   * STORE Phase 14. The buyer named settlement terms that can no longer be used.
   *
   * The acceptance is REFUSED rather than completed on a different rail. Accepting a
   * quote is the moment an order becomes an immutable commercial record, and creating
   * that record with weaker protection than the buyer asked for is the silent downgrade
   * §0 exists to prevent.
   */
  | { type: "SETTLEMENT_UNAVAILABLE"; reason: string }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "CONFLICT"; message: string }
  /** A38. The provider quote queue is the first paginated read on this service. */
  | { type: "INVALID_CURSOR" };

export interface QuoteActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export type QuoteServiceDetailInput =
  | {
      readonly kind: "freight_forwarder" | "logistics_operator";
      readonly transportModes: readonly FreightTransportMode[];
      readonly originCountryCode?: string;
      readonly destinationCountryCode?: string;
      readonly estimatedTransitDays?: number;
    }
  | {
      readonly kind: "customs_broker";
      readonly jurisdictions: readonly string[];
      readonly filingSummary?: string;
    }
  | {
      readonly kind: "insurance_provider";
      readonly coverageClasses: readonly string[];
      readonly coverageLimitInCents?: number;
      readonly currency?: string;
    }
  | {
      readonly kind: "inspection_agency";
      readonly includedStages: readonly string[];
    }
  | {
      readonly kind: "testing_certification_lab";
      readonly standards: readonly string[];
      readonly laboratoryLocation?: string;
    }
  | {
      readonly kind: "marketing_agency";
      readonly channels: readonly string[];
      readonly deliverablesSummary?: string;
    }
  | {
      readonly kind: "warehouse_provider";
      readonly storageTypes: readonly string[];
      readonly capacityUnits?: string;
      readonly temperatureControlled: boolean;
    }
  | {
      readonly kind: "foreign_exchange_facilitator";
      readonly currencyPair: string;
      readonly rateFixedPoint: number;
      readonly rateScale: number;
      readonly settlementRail?: string;
      readonly notionalAmountInCents?: number;
      readonly notionalCurrency?: string;
    };

export type QuoteServiceDetailProjection =
  | {
      readonly kind: "freight_forwarder" | "logistics_operator";
      readonly transportModes: readonly FreightTransportMode[];
      readonly originCountryCode: string | null;
      readonly destinationCountryCode: string | null;
      readonly estimatedTransitDays: number | null;
    }
  | {
      readonly kind: "customs_broker";
      readonly jurisdictions: readonly string[];
      readonly filingSummary: string | null;
    }
  | {
      readonly kind: "insurance_provider";
      readonly coverageClasses: readonly string[];
      readonly coverageLimitInCents: number | null;
      readonly currency: string | null;
    }
  | { readonly kind: "inspection_agency"; readonly includedStages: readonly string[] }
  | {
      readonly kind: "testing_certification_lab";
      readonly standards: readonly string[];
      readonly laboratoryLocation: string | null;
    }
  | {
      readonly kind: "marketing_agency";
      readonly channels: readonly string[];
      readonly deliverablesSummary: string | null;
    }
  | {
      readonly kind: "warehouse_provider";
      readonly storageTypes: readonly string[];
      readonly capacityUnits: string | null;
      readonly temperatureControlled: boolean;
    }
  | {
      readonly kind: "foreign_exchange_facilitator";
      readonly currencyPair: string;
      readonly rateFixedPoint: number;
      readonly rateScale: number;
      readonly settlementRail: string | null;
      readonly notionalAmountInCents: number | null;
      readonly notionalCurrency: string | null;
    };

export interface QuoteProductLineInput {
  readonly rfqProductLineId: string;
  readonly quantity: number;
  readonly unitPriceInCents: number;
  readonly titleSnapshot: string;
  readonly specificationSnapshot: string;
  readonly leadTimeDays?: number;
  readonly exclusionsSnapshot?: string;
  readonly siblingOrder: number;
}

export interface QuoteServiceLineInput {
  readonly rfqServiceLineId: string;
  readonly feeInCents: number;
  readonly titleSnapshot: string;
  readonly scopeSnapshot: string;
  readonly leadTimeDays?: number;
  readonly exclusionsSnapshot?: string;
  readonly deliverableSnapshot?: string;
  readonly deliverables: readonly QuoteDeliverablePlanInput[];
  readonly siblingOrder: number;
  readonly serviceDetail: QuoteServiceDetailInput;
}

export interface QuoteDeliverablePlanInput {
  readonly sequence: number;
  readonly title: string;
  readonly isRequired: boolean;
  readonly dueAt?: Date;
}

export interface AppendRevisionInput {
  readonly currency: string;
  readonly validityDeadlineAt: Date;
  readonly taxInCents: number;
  readonly serviceFeeInCents: number;
  readonly shippingInCents: number;
  readonly discountInCents: number;
  readonly paymentTerms?: string;
  readonly incoterm?: CommerceIncoterm;
  readonly notes?: string;
  readonly productLines: readonly QuoteProductLineInput[];
  readonly serviceLines: readonly QuoteServiceLineInput[];
}

export interface QuoteShellProjection {
  readonly id: string;
  readonly rfqId: string;
  readonly providerOrganizationId: string;
  readonly status: QuoteRow["status"];
  readonly latestRevisionNumber: number;
  readonly createdAt: Date;
}

export interface QuoteRevisionMoneyProjection {
  readonly revisionNumber: number;
  readonly currency: string;
  readonly validityDeadlineAt: Date;
  readonly subtotalInCents: number;
  readonly taxInCents: number;
  readonly serviceFeeInCents: number;
  readonly shippingInCents: number;
  readonly discountInCents: number;
  readonly totalInCents: number;
  readonly submittedAt: Date | null;
}

export interface QuoteComparisonItem {
  readonly quoteId: string;
  readonly status: QuoteRow["status"];
  readonly provider: {
    readonly organizationId: string;
    readonly displayName: string;
    readonly slug: string;
  };
  readonly latestSubmittedRevision: QuoteRevisionMoneyProjection | null;
  readonly productLineSummaries: readonly {
    readonly titleSnapshot: string;
    readonly quantity: number;
    readonly unitPriceInCents: number;
    readonly lineTotalInCents: number;
  }[];
  readonly serviceLineSummaries: readonly {
    readonly titleSnapshot: string;
    readonly providerKind: ProviderKind;
    readonly feeInCents: number;
  }[];
}

export interface QuoteDetailProjection {
  readonly id: string;
  readonly rfqId: string;
  readonly providerOrganizationId: string;
  readonly status: QuoteRow["status"];
  readonly latestRevisionNumber: number;
  readonly acceptedRevisionNumber: number | null;
  readonly submittedAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly declinedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly expiredAt: Date | null;
  readonly createdAt: Date;
  readonly latestRevision:
    | (QuoteRevisionMoneyProjection & {
        readonly paymentTerms: string | null;
        readonly incoterm: CommerceIncoterm | null;
        readonly notes: string | null;
        readonly productLines: readonly {
          readonly id: string;
          readonly rfqProductLineId: string;
          readonly quantity: number;
          readonly unitPriceInCents: number;
          readonly lineTotalInCents: number;
          readonly titleSnapshot: string;
          readonly specificationSnapshot: string;
          readonly leadTimeDays: number | null;
          readonly exclusionsSnapshot: string | null;
          readonly siblingOrder: number;
        }[];
        readonly serviceLines: readonly {
          readonly id: string;
          readonly rfqServiceLineId: string;
          readonly providerKind: ProviderKind;
          readonly feeInCents: number;
          readonly titleSnapshot: string;
          readonly scopeSnapshot: string;
          readonly leadTimeDays: number | null;
          readonly exclusionsSnapshot: string | null;
          readonly deliverableSnapshot: string | null;
          readonly serviceDetail: QuoteServiceDetailProjection | null;
          readonly deliverables: readonly {
            readonly id: string;
            readonly sequence: number;
            readonly title: string;
            readonly isRequired: boolean;
            readonly dueAt: Date | null;
          }[];
          readonly siblingOrder: number;
        }[];
      })
    | null;
}

export interface OrderProjection {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
  readonly source: OrderRow["source"];
  readonly state: OrderRow["state"];
  readonly acceptedQuoteId: string | null;
  readonly acceptedQuoteRevisionId: string | null;
  readonly currency: string;
  readonly subtotalInCents: number;
  readonly taxInCents: number;
  readonly serviceFeeInCents: number;
  readonly shippingInCents: number;
  readonly discountInCents: number;
  readonly totalInCents: number;
  readonly paymentTermsSnapshot: string | null;
  readonly incotermSnapshot: CommerceIncoterm | null;
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
}

const MUTABLE_QUOTE_STATUSES: readonly QuoteRow["status"][] = ["draft", "submitted"];
const INVITATION_RESPONDABLE_STATES: readonly (typeof commerceRfqInvitation.$inferSelect.state)[] =
  ["pending", "sent", "read", "responded"];

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce quote audit append failed: ${appended.error.type}`);
  }
}

function validationFailed(message: string): Result<never, CommerceQuotesError> {
  return { success: false, error: { type: "VALIDATION_FAILED", message } };
}

function projectQuoteShell(quote: QuoteRow): QuoteShellProjection {
  return {
    id: quote.id,
    rfqId: quote.rfqId,
    providerOrganizationId: quote.providerOrganizationId,
    status: quote.status,
    latestRevisionNumber: quote.latestRevisionNumber,
    createdAt: quote.createdAt,
  };
}

function projectOrder(order: OrderRow): OrderProjection {
  return {
    id: order.id,
    buyerOrganizationId: order.buyerOrganizationId,
    counterpartyOrganizationId: order.counterpartyOrganizationId,
    source: order.source,
    state: order.state,
    acceptedQuoteId: order.acceptedQuoteId,
    acceptedQuoteRevisionId: order.acceptedQuoteRevisionId,
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
    createdAt: order.createdAt,
  };
}

function projectRevisionMoney(revision: RevisionRow): QuoteRevisionMoneyProjection {
  return {
    revisionNumber: revision.revisionNumber,
    currency: revision.currency,
    validityDeadlineAt: revision.validityDeadlineAt,
    subtotalInCents: revision.subtotalInCents,
    taxInCents: revision.taxInCents,
    serviceFeeInCents: revision.serviceFeeInCents,
    shippingInCents: revision.shippingInCents,
    discountInCents: revision.discountInCents,
    totalInCents: revision.totalInCents,
    submittedAt: revision.submittedAt,
  };
}

type QuoteQueryExecutor = DatabaseTransaction | typeof db;

async function providerMayQuoteRfq(
  queryExecutor: QuoteQueryExecutor,
  input: {
    readonly rfqId: string;
    readonly providerOrganizationId: string;
    readonly visibility: (typeof commerceRfq.$inferSelect)["visibility"];
  },
): Promise<boolean> {
  const [invitation] = await queryExecutor
    .select({
      id: commerceRfqInvitation.id,
      state: commerceRfqInvitation.state,
    })
    .from(commerceRfqInvitation)
    .where(
      and(
        eq(commerceRfqInvitation.rfqId, input.rfqId),
        eq(commerceRfqInvitation.providerOrganizationId, input.providerOrganizationId),
      ),
    )
    .limit(1);

  if (invitation && INVITATION_RESPONDABLE_STATES.includes(invitation.state)) {
    return true;
  }

  if (input.visibility !== "matched_providers") {
    return false;
  }

  const rfqServiceKinds = await queryExecutor
    .selectDistinct({ providerKind: commerceRfqServiceLine.providerKind })
    .from(commerceRfqServiceLine)
    .where(eq(commerceRfqServiceLine.rfqId, input.rfqId));

  if (rfqServiceKinds.length === 0) {
    return false;
  }

  const kindValues = rfqServiceKinds.map((row) => row.providerKind);
  const [verifiedLink] = await queryExecutor
    .select({ id: commerceProviderKindLink.id })
    .from(commerceProviderKindLink)
    .where(
      and(
        eq(commerceProviderKindLink.organizationId, input.providerOrganizationId),
        eq(commerceProviderKindLink.verificationState, "verified"),
        inArray(commerceProviderKindLink.providerKind, kindValues),
      ),
    )
    .limit(1);

  return verifiedLink !== undefined;
}

async function insertQuoteServiceDetail(
  transaction: DatabaseTransaction,
  quoteServiceLineId: string,
  providerKind: ProviderKind,
  detail: QuoteServiceDetailInput,
): Promise<Result<true, CommerceQuotesError>> {
  if (detail.kind !== providerKind) {
    return validationFailed("serviceDetail.kind must match the RFQ service line provider kind.");
  }

  switch (detail.kind) {
    case "freight_forwarder":
    case "logistics_operator":
      await transaction.insert(freightQuoteServiceDetail).values({
        quoteServiceLineId,
        transportModes: [...detail.transportModes],
        originCountryCode: detail.originCountryCode ?? null,
        destinationCountryCode: detail.destinationCountryCode ?? null,
        estimatedTransitDays: detail.estimatedTransitDays ?? null,
      });
      return { success: true, value: true };
    case "customs_broker":
      await transaction.insert(customsBrokerageQuoteServiceDetail).values({
        quoteServiceLineId,
        jurisdictions: [...detail.jurisdictions],
        filingSummary: detail.filingSummary ?? null,
      });
      return { success: true, value: true };
    case "insurance_provider":
      await transaction.insert(insuranceQuoteServiceDetail).values({
        quoteServiceLineId,
        coverageClasses: [...detail.coverageClasses],
        coverageLimitInCents: detail.coverageLimitInCents ?? null,
        currency: detail.currency ?? null,
      });
      return { success: true, value: true };
    case "inspection_agency":
      await transaction.insert(inspectionQuoteServiceDetail).values({
        quoteServiceLineId,
        includedStages: [...detail.includedStages],
      });
      return { success: true, value: true };
    case "testing_certification_lab":
      await transaction.insert(testingCertificationQuoteServiceDetail).values({
        quoteServiceLineId,
        standards: [...detail.standards],
        laboratoryLocation: detail.laboratoryLocation ?? null,
      });
      return { success: true, value: true };
    case "marketing_agency":
      await transaction.insert(marketingQuoteServiceDetail).values({
        quoteServiceLineId,
        channels: [...detail.channels],
        deliverablesSummary: detail.deliverablesSummary ?? null,
      });
      return { success: true, value: true };
    case "warehouse_provider":
      await transaction.insert(warehouseQuoteServiceDetail).values({
        quoteServiceLineId,
        storageTypes: [...detail.storageTypes],
        capacityUnits: detail.capacityUnits ?? null,
        temperatureControlled: detail.temperatureControlled,
      });
      return { success: true, value: true };
    case "foreign_exchange_facilitator": {
      if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(detail.currencyPair)) {
        return validationFailed("FX currencyPair must be XXX/YYY.");
      }
      if (detail.rateFixedPoint <= 0 || detail.rateScale < 0 || detail.rateScale > 12) {
        return validationFailed("FX rateFixedPoint must be > 0 and rateScale between 0 and 12.");
      }
      await transaction.insert(foreignExchangeQuoteServiceDetail).values({
        quoteServiceLineId,
        currencyPair: detail.currencyPair,
        rateFixedPoint: detail.rateFixedPoint,
        rateScale: detail.rateScale,
        settlementRail: detail.settlementRail ?? null,
        notionalAmountInCents: detail.notionalAmountInCents ?? null,
        notionalCurrency: detail.notionalCurrency ?? null,
      });
      return { success: true, value: true };
    }
    default: {
      const exhaustiveCheck: never = detail;
      throw new Error(`Unhandled quote service detail: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Copies an accepted typed quote service-line detail into the matching engagement
 * execution snapshot. Returns whether a typed snapshot was written.
 */
async function copyAcceptedQuoteDetailToEngagement(
  transaction: DatabaseTransaction,
  engagementId: string,
  quoteServiceLineId: string,
  providerKind: ProviderKind,
): Promise<boolean> {
  switch (providerKind) {
    case "freight_forwarder":
    case "logistics_operator": {
      const [detail] = await transaction
        .select()
        .from(freightQuoteServiceDetail)
        .where(eq(freightQuoteServiceDetail.quoteServiceLineId, quoteServiceLineId))
        .limit(1);
      if (!detail) return false;
      await transaction.insert(freightEngagementDetail).values({
        engagementId,
        sourceQuoteServiceLineId: quoteServiceLineId,
        transportModes: detail.transportModes,
        originCountryCode: detail.originCountryCode,
        destinationCountryCode: detail.destinationCountryCode,
        estimatedTransitDays: detail.estimatedTransitDays,
      });
      return true;
    }
    case "customs_broker": {
      const [detail] = await transaction
        .select()
        .from(customsBrokerageQuoteServiceDetail)
        .where(eq(customsBrokerageQuoteServiceDetail.quoteServiceLineId, quoteServiceLineId))
        .limit(1);
      if (!detail) return false;
      await transaction.insert(customsBrokerageEngagementDetail).values({
        engagementId,
        sourceQuoteServiceLineId: quoteServiceLineId,
        jurisdictions: detail.jurisdictions,
        filingSummary: detail.filingSummary,
      });
      return true;
    }
    case "insurance_provider": {
      const [detail] = await transaction
        .select()
        .from(insuranceQuoteServiceDetail)
        .where(eq(insuranceQuoteServiceDetail.quoteServiceLineId, quoteServiceLineId))
        .limit(1);
      if (!detail) return false;
      await transaction.insert(insuranceEngagementDetail).values({
        engagementId,
        sourceQuoteServiceLineId: quoteServiceLineId,
        coverageClasses: detail.coverageClasses,
        coverageLimitMinorUnits:
          detail.coverageLimitInCents === null ? null : String(detail.coverageLimitInCents),
        currency: detail.currency,
      });
      return true;
    }
    case "inspection_agency": {
      const [detail] = await transaction
        .select()
        .from(inspectionQuoteServiceDetail)
        .where(eq(inspectionQuoteServiceDetail.quoteServiceLineId, quoteServiceLineId))
        .limit(1);
      if (!detail) return false;
      await transaction.insert(inspectionEngagementDetail).values({
        engagementId,
        sourceQuoteServiceLineId: quoteServiceLineId,
        includedStages: detail.includedStages,
      });
      return true;
    }
    case "testing_certification_lab": {
      const [detail] = await transaction
        .select()
        .from(testingCertificationQuoteServiceDetail)
        .where(eq(testingCertificationQuoteServiceDetail.quoteServiceLineId, quoteServiceLineId))
        .limit(1);
      if (!detail) return false;
      await transaction.insert(testingCertificationEngagementDetail).values({
        engagementId,
        sourceQuoteServiceLineId: quoteServiceLineId,
        standards: detail.standards,
        laboratoryLocation: detail.laboratoryLocation,
      });
      return true;
    }
    case "marketing_agency": {
      const [detail] = await transaction
        .select()
        .from(marketingQuoteServiceDetail)
        .where(eq(marketingQuoteServiceDetail.quoteServiceLineId, quoteServiceLineId))
        .limit(1);
      if (!detail) return false;
      await transaction.insert(marketingEngagementDetail).values({
        engagementId,
        sourceQuoteServiceLineId: quoteServiceLineId,
        channels: detail.channels,
        deliverablesSummary: detail.deliverablesSummary,
      });
      return true;
    }
    case "warehouse_provider": {
      const [detail] = await transaction
        .select()
        .from(warehouseQuoteServiceDetail)
        .where(eq(warehouseQuoteServiceDetail.quoteServiceLineId, quoteServiceLineId))
        .limit(1);
      if (!detail) return false;
      await transaction.insert(warehouseEngagementDetail).values({
        engagementId,
        sourceQuoteServiceLineId: quoteServiceLineId,
        storageTypes: detail.storageTypes,
        capacityUnits: detail.capacityUnits,
        temperatureControlled: detail.temperatureControlled,
      });
      return true;
    }
    case "foreign_exchange_facilitator": {
      const [detail] = await transaction
        .select()
        .from(foreignExchangeQuoteServiceDetail)
        .where(eq(foreignExchangeQuoteServiceDetail.quoteServiceLineId, quoteServiceLineId))
        .limit(1);
      if (!detail) return false;
      await transaction.insert(foreignExchangeEngagementDetail).values({
        engagementId,
        sourceQuoteServiceLineId: quoteServiceLineId,
        currencyPair: detail.currencyPair,
        rateFixedPointUnits: String(detail.rateFixedPoint),
        rateScale: detail.rateScale,
        settlementRail: detail.settlementRail,
        notionalAmountMinorUnits:
          detail.notionalAmountInCents === null ? null : String(detail.notionalAmountInCents),
        notionalCurrency: detail.notionalCurrency,
      });
      return true;
    }
    default: {
      const exhaustiveKind: never = providerKind;
      throw new Error(`Unhandled provider kind: ${JSON.stringify(exhaustiveKind)}`);
    }
  }
}

/**
 * Provider creates an empty quote shell against an open RFQ they are invited to
 * or eligible to match. One quote per provider per RFQ.
 */
export async function createQuoteShell(
  actor: QuoteActorContext,
  rfqId: string,
): Promise<Result<QuoteShellProjection, CommerceQuotesError>> {
  try {
    const created = await db.transaction(async (transaction) => {
      const [rfq] = await transaction
        .select()
        .from(commerceRfq)
        .where(eq(commerceRfq.id, rfqId))
        .for("update");
      if (!rfq) return { status: "not_found" as const };

      if (rfq.state !== "open") {
        return { status: "rfq_not_open" as const };
      }

      const eligible = await providerMayQuoteRfq(transaction, {
        rfqId: rfq.id,
        providerOrganizationId: actor.organizationId,
        visibility: rfq.visibility,
      });
      if (!eligible) {
        return { status: "not_found" as const };
      }

      const [existingQuote] = await transaction
        .select({ id: commerceQuote.id })
        .from(commerceQuote)
        .where(
          and(
            eq(commerceQuote.rfqId, rfq.id),
            eq(commerceQuote.providerOrganizationId, actor.organizationId),
          ),
        )
        .limit(1);
      if (existingQuote) {
        return { status: "conflict" as const };
      }

      const now = new Date();
      const [quote] = await transaction
        .insert(commerceQuote)
        .values({
          rfqId: rfq.id,
          providerOrganizationId: actor.organizationId,
          createdByMemberId: actor.memberId,
          status: "draft",
          latestRevisionNumber: 0,
        })
        .returning();
      if (!quote) {
        throw new Error("Quote shell insert returned no row.");
      }

      await transaction
        .update(commerceRfqInvitation)
        .set({
          state: "responded",
          respondedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(commerceRfqInvitation.rfqId, rfq.id),
            eq(commerceRfqInvitation.providerOrganizationId, actor.organizationId),
            inArray(commerceRfqInvitation.state, ["pending", "sent", "read"]),
          ),
        );

      return { status: "created" as const, quote };
    });

    switch (created.status) {
      case "not_found":
        return { success: false, error: { type: "NOT_FOUND" } };
      case "rfq_not_open":
        return { success: false, error: { type: "RFQ_NOT_OPEN" } };
      case "conflict":
        return {
          success: false,
          error: { type: "CONFLICT", message: "A quote already exists for this RFQ." },
        };
      case "created":
        return { success: true, value: projectQuoteShell(created.quote) };
      default: {
        const exhaustiveCheck: never = created;
        throw new Error(`Unhandled createQuoteShell outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "A quote already exists for this RFQ." },
      };
    }
    throw error;
  }
}

/**
 * Appends an unsubmitted revision. Only one draft revision may exist at a time
 * while the quote is still draft or submitted.
 */
export async function appendRevision(
  actor: QuoteActorContext,
  quoteId: string,
  input: AppendRevisionInput,
): Promise<
  Result<QuoteRevisionMoneyProjection & { readonly quoteId: string }, CommerceQuotesError>
> {
  if (input.validityDeadlineAt.getTime() <= Date.now()) {
    return validationFailed("validityDeadlineAt must be in the future.");
  }
  if (input.productLines.length === 0 && input.serviceLines.length === 0) {
    return validationFailed("At least one product or service line is required.");
  }

  const outcome = await db.transaction(async (transaction) => {
    const [quote] = await transaction
      .select()
      .from(commerceQuote)
      .where(eq(commerceQuote.id, quoteId))
      .for("update");
    if (!quote) return { status: "not_found" as const };
    if (quote.providerOrganizationId !== actor.organizationId) {
      return { status: "not_found" as const };
    }
    if (!MUTABLE_QUOTE_STATUSES.includes(quote.status)) {
      return { status: "invalid_state" as const };
    }

    const [openDraft] = await transaction
      .select({ id: commerceQuoteRevision.id })
      .from(commerceQuoteRevision)
      .where(
        and(eq(commerceQuoteRevision.quoteId, quote.id), isNull(commerceQuoteRevision.submittedAt)),
      )
      .limit(1);
    if (openDraft) {
      return {
        status: "validation" as const,
        message: "Submit or abandon the existing unsubmitted revision before appending another.",
      };
    }

    const rfqProductLines = await transaction
      .select()
      .from(commerceRfqProductLine)
      .where(eq(commerceRfqProductLine.rfqId, quote.rfqId));
    const rfqServiceLines = await transaction
      .select()
      .from(commerceRfqServiceLine)
      .where(eq(commerceRfqServiceLine.rfqId, quote.rfqId));
    const rfqProductLineById = new Map(rfqProductLines.map((line) => [line.id, line]));
    const rfqServiceLineById = new Map(rfqServiceLines.map((line) => [line.id, line]));

    let productSubtotal = 0;
    for (const productLine of input.productLines) {
      if (!rfqProductLineById.has(productLine.rfqProductLineId)) {
        return {
          status: "validation" as const,
          message: "rfqProductLineId does not belong to this RFQ.",
        };
      }
      productSubtotal += productLine.quantity * productLine.unitPriceInCents;
    }

    let serviceSubtotal = 0;
    for (const serviceLine of input.serviceLines) {
      const rfqServiceLine = rfqServiceLineById.get(serviceLine.rfqServiceLineId);
      if (!rfqServiceLine) {
        return {
          status: "validation" as const,
          message: "rfqServiceLineId does not belong to this RFQ.",
        };
      }
      if (!serviceLine.serviceDetail) {
        return {
          status: "validation" as const,
          message: "Every service line requires exactly one typed serviceDetail.",
        };
      }
      if (serviceLine.serviceDetail.kind !== rfqServiceLine.providerKind) {
        return {
          status: "validation" as const,
          message: "serviceDetail.kind must match the RFQ service line provider kind.",
        };
      }
      const deliverableSequences = serviceLine.deliverables.map(
        (deliverable) => deliverable.sequence,
      );
      if (new Set(deliverableSequences).size !== deliverableSequences.length) {
        return {
          status: "validation" as const,
          message: "Deliverable sequences must be unique within each service line.",
        };
      }
      if (serviceLine.serviceDetail.kind === "insurance_provider") {
        const hasCoverageLimit = serviceLine.serviceDetail.coverageLimitInCents !== undefined;
        const hasCurrency = serviceLine.serviceDetail.currency !== undefined;
        if (hasCoverageLimit !== hasCurrency) {
          return {
            status: "validation" as const,
            message: "Insurance coverageLimitInCents and currency must be provided together.",
          };
        }
      }
      if (serviceLine.serviceDetail.kind === "foreign_exchange_facilitator") {
        const hasNotionalAmount = serviceLine.serviceDetail.notionalAmountInCents !== undefined;
        const hasNotionalCurrency = serviceLine.serviceDetail.notionalCurrency !== undefined;
        if (hasNotionalAmount !== hasNotionalCurrency) {
          return {
            status: "validation" as const,
            message: "FX notionalAmountInCents and notionalCurrency must be provided together.",
          };
        }
      }
      serviceSubtotal += serviceLine.feeInCents;
    }

    const subtotalInCents = productSubtotal + serviceSubtotal;
    const totalInCents =
      subtotalInCents +
      input.taxInCents +
      input.serviceFeeInCents +
      input.shippingInCents -
      input.discountInCents;
    if (totalInCents < 0) {
      return { status: "validation" as const, message: "Computed total cannot be negative." };
    }

    const revisionNumber = quote.latestRevisionNumber + 1;
    const [revision] = await transaction
      .insert(commerceQuoteRevision)
      .values({
        quoteId: quote.id,
        revisionNumber,
        currency: input.currency,
        validityDeadlineAt: input.validityDeadlineAt,
        subtotalInCents,
        taxInCents: input.taxInCents,
        serviceFeeInCents: input.serviceFeeInCents,
        shippingInCents: input.shippingInCents,
        discountInCents: input.discountInCents,
        totalInCents,
        paymentTerms: input.paymentTerms ?? null,
        incoterm: input.incoterm ?? null,
        notes: input.notes ?? null,
        createdByMemberId: actor.memberId,
        submittedAt: null,
      })
      .returning();
    if (!revision) {
      throw new Error("Quote revision insert returned no row.");
    }

    for (const productLine of input.productLines) {
      const lineTotalInCents = productLine.quantity * productLine.unitPriceInCents;
      await transaction.insert(commerceQuoteProductLine).values({
        revisionId: revision.id,
        rfqProductLineId: productLine.rfqProductLineId,
        quantity: productLine.quantity,
        unitPriceInCents: productLine.unitPriceInCents,
        lineTotalInCents,
        titleSnapshot: productLine.titleSnapshot,
        specificationSnapshot: productLine.specificationSnapshot,
        leadTimeDays: productLine.leadTimeDays ?? null,
        exclusionsSnapshot: productLine.exclusionsSnapshot ?? null,
        siblingOrder: productLine.siblingOrder,
      });
    }

    for (const serviceLine of input.serviceLines) {
      const rfqServiceLine = rfqServiceLineById.get(serviceLine.rfqServiceLineId);
      if (!rfqServiceLine) {
        return {
          status: "validation" as const,
          message: "rfqServiceLineId does not belong to this RFQ.",
        };
      }
      const [insertedServiceLine] = await transaction
        .insert(commerceQuoteServiceLine)
        .values({
          revisionId: revision.id,
          rfqServiceLineId: serviceLine.rfqServiceLineId,
          providerKind: rfqServiceLine.providerKind,
          feeInCents: serviceLine.feeInCents,
          titleSnapshot: serviceLine.titleSnapshot,
          scopeSnapshot: serviceLine.scopeSnapshot,
          leadTimeDays: serviceLine.leadTimeDays ?? null,
          exclusionsSnapshot: serviceLine.exclusionsSnapshot ?? null,
          deliverableSnapshot: serviceLine.deliverableSnapshot ?? null,
          siblingOrder: serviceLine.siblingOrder,
        })
        .returning();
      if (!insertedServiceLine) {
        throw new Error("Quote service line insert returned no row.");
      }
      for (const deliverable of serviceLine.deliverables) {
        await transaction.insert(commerceQuoteServiceDeliverablePlan).values({
          quoteServiceLineId: insertedServiceLine.id,
          sequence: deliverable.sequence,
          title: deliverable.title,
          isRequired: deliverable.isRequired,
          dueAt: deliverable.dueAt ?? null,
        });
      }
      const detailResult = await insertQuoteServiceDetail(
        transaction,
        insertedServiceLine.id,
        rfqServiceLine.providerKind,
        serviceLine.serviceDetail,
      );
      if (!detailResult.success) {
        const detailError = detailResult.error;
        if (detailError.type !== "VALIDATION_FAILED") {
          throw new Error(`Unexpected service detail error: ${detailError.type}`);
        }
        return { status: "validation" as const, message: detailError.message };
      }
    }

    await transaction
      .update(commerceQuote)
      .set({ latestRevisionNumber: revisionNumber })
      .where(eq(commerceQuote.id, quote.id));

    return { status: "created" as const, revision, quoteId: quote.id };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    case "validation":
      return validationFailed(outcome.message);
    case "created":
      return {
        success: true,
        value: { quoteId: outcome.quoteId, ...projectRevisionMoney(outcome.revision) },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled appendRevision outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Freezes an unsubmitted revision. Later revisions supersede prior submitted ones
 * while the quote remains in `submitted` status until acceptance or withdrawal.
 */
export async function submitRevision(
  actor: QuoteActorContext,
  quoteId: string,
  revisionNumber: number,
): Promise<
  Result<QuoteShellProjection & { readonly revisionNumber: number }, CommerceQuotesError>
> {
  const outcome = await db.transaction(async (transaction) => {
    const [quote] = await transaction
      .select()
      .from(commerceQuote)
      .where(eq(commerceQuote.id, quoteId))
      .for("update");
    if (!quote) return { status: "not_found" as const };
    if (quote.providerOrganizationId !== actor.organizationId) {
      return { status: "not_found" as const };
    }
    if (!MUTABLE_QUOTE_STATUSES.includes(quote.status)) {
      return { status: "invalid_state" as const };
    }
    if (revisionNumber !== quote.latestRevisionNumber) {
      return {
        status: "revision_changed" as const,
        currentRevision: quote.latestRevisionNumber,
      };
    }

    const [revision] = await transaction
      .select()
      .from(commerceQuoteRevision)
      .where(
        and(
          eq(commerceQuoteRevision.quoteId, quote.id),
          eq(commerceQuoteRevision.revisionNumber, revisionNumber),
        ),
      )
      .for("update");
    if (!revision || revision.submittedAt !== null) {
      return { status: "invalid_state" as const };
    }

    const now = new Date();
    if (revision.validityDeadlineAt.getTime() <= now.getTime()) {
      return { status: "expired" as const, expiredAt: revision.validityDeadlineAt };
    }

    await transaction
      .update(commerceQuoteRevision)
      .set({ submittedAt: now })
      .where(eq(commerceQuoteRevision.id, revision.id));

    const [updatedQuote] = await transaction
      .update(commerceQuote)
      .set({
        status: "submitted",
        submittedAt: quote.submittedAt ?? now,
      })
      .where(eq(commerceQuote.id, quote.id))
      .returning();
    if (!updatedQuote) {
      throw new Error("Quote submit update returned no row.");
    }

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "quote_submitted",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_quote",
      targetEntityId: quote.id,
      payload: {
        quoteId: quote.id,
        rfqId: quote.rfqId,
        revisionNumber: String(revisionNumber),
        totalInCents: String(revision.totalInCents),
      },
      occurredAt: now,
    });

    return { status: "submitted" as const, quote: updatedQuote, revisionNumber };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    case "revision_changed":
      return {
        success: false,
        error: { type: "REVISION_CHANGED", currentRevision: outcome.currentRevision },
      };
    case "expired":
      return { success: false, error: { type: "QUOTE_EXPIRED", expiredAt: outcome.expiredAt } };
    case "submitted":
      return {
        success: true,
        value: { ...projectQuoteShell(outcome.quote), revisionNumber: outcome.revisionNumber },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled submitRevision outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

async function loadLatestSubmittedRevision(quoteId: string): Promise<RevisionRow | null> {
  const submitted = await db
    .select()
    .from(commerceQuoteRevision)
    .where(
      and(eq(commerceQuoteRevision.quoteId, quoteId), isNotNull(commerceQuoteRevision.submittedAt)),
    );
  if (submitted.length === 0) return null;
  return submitted.reduce((latest, candidate) =>
    candidate.revisionNumber > latest.revisionNumber ? candidate : latest,
  );
}

/**
 * One row of a provider's cross-RFQ quote queue (Appendix A38).
 *
 * DELIBERATELY LIGHTER THAN `QuoteComparisonItem`. That shape carries every product and
 * service line because a buyer comparing three bids on one RFQ is reading the lines. A
 * provider scanning fifty quotes across fifty RFQs is reading status and money, and building
 * the line summaries would mean two extra queries per row for data the screen does not show.
 */
export interface ProviderQuoteQueueItem {
  readonly quoteId: string;
  readonly status: QuoteRow["status"];
  readonly rfq: {
    readonly id: string;
    readonly title: string;
    readonly state: typeof commerceRfq.$inferSelect.state;
    readonly buyerOrganizationId: string;
  };
  readonly latestSubmittedRevision: QuoteRevisionMoneyProjection | null;
  readonly latestRevisionNumber: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Every quote this provider has authored, across every RFQ (Appendix A38).
 *
 * WHY THIS ROUTE HAD TO EXIST. `GET /commerce/rfqs/:rfqId/quotes` is RFQ-scoped, so a provider
 * could only see a quote by first knowing which RFQ it belonged to. `GET /commerce/provider/rfqs`
 * lists the WORK, not the BIDS — an RFQ leaves that queue when it closes, taking any quote on it
 * out of reach. The only way to enumerate one's own bids was to fan out per RFQ from the browser.
 *
 * DRAFTS INCLUDED, unlike the buyer's comparison view. A draft is the provider's own unfinished
 * work and hiding it here would lose it entirely — this is the only list that yields its id.
 *
 * Ordered newest-updated first, keyed on `updatedAt` then `id`, which is what
 * `commerce_quote_provider_status_idx` was already built to serve.
 */
export async function listProviderQuotes(
  actor: QuoteActorContext,
  input: {
    readonly status?: QuoteRow["status"] | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
): Promise<
  Result<
    {
      readonly items: readonly ProviderQuoteQueueItem[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceQuotesError
  >
> {
  const limit = input.limit ?? 20;
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          lt(commerceQuote.updatedAt, new Date(decodedCursor.sortKey)),
          and(
            eq(commerceQuote.updatedAt, new Date(decodedCursor.sortKey)),
            gt(commerceQuote.id, decodedCursor.id),
          ),
        );

  const rows = await db
    .select({
      quote: commerceQuote,
      rfqId: commerceRfq.id,
      rfqTitle: commerceRfq.title,
      rfqState: commerceRfq.state,
      rfqBuyerOrganizationId: commerceRfq.buyerOrganizationId,
    })
    .from(commerceQuote)
    .innerJoin(commerceRfq, eq(commerceRfq.id, commerceQuote.rfqId))
    .where(
      and(
        // Authorship IS the authorization here. A quote belongs to exactly one provider
        // organization, so there is no second party to admit.
        eq(commerceQuote.providerOrganizationId, actor.organizationId),
        input.status === undefined ? undefined : eq(commerceQuote.status, input.status),
        cursorPredicate,
      ),
    )
    .orderBy(desc(commerceQuote.updatedAt), asc(commerceQuote.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow
      ? encodeStoreCursor({
          sortKey: lastRow.quote.updatedAt.toISOString(),
          id: lastRow.quote.id,
        })
      : null;

  const latestRevisions = await Promise.all(
    pageRows.map(async (row) => loadLatestSubmittedRevision(row.quote.id)),
  );

  const items = pageRows.map((row, rowIndex) => {
    const latestSubmitted = latestRevisions[rowIndex] ?? null;
    return {
      quoteId: row.quote.id,
      status: row.quote.status,
      rfq: {
        id: row.rfqId,
        title: row.rfqTitle,
        state: row.rfqState,
        buyerOrganizationId: row.rfqBuyerOrganizationId,
      },
      latestSubmittedRevision:
        latestSubmitted === null ? null : projectRevisionMoney(latestSubmitted),
      latestRevisionNumber: row.quote.latestRevisionNumber,
      createdAt: row.quote.createdAt,
      updatedAt: row.quote.updatedAt,
    };
  });

  return { success: true, value: { items, page: { nextCursor, hasMore: nextCursor !== null } } };
}

/**
 * Buyer comparison list (submitted+) or provider view of own quote including drafts.
 */
export async function listQuotesForRfq(
  actor: QuoteActorContext,
  rfqId: string,
): Promise<Result<{ readonly items: readonly QuoteComparisonItem[] }, CommerceQuotesError>> {
  const [rfq] = await db.select().from(commerceRfq).where(eq(commerceRfq.id, rfqId)).limit(1);
  if (!rfq) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const isBuyer = rfq.buyerOrganizationId === actor.organizationId;
  const quotes = await db
    .select({
      quote: commerceQuote,
      providerDisplayName: commerceOrganization.displayName,
      providerSlug: commerceOrganization.slug,
    })
    .from(commerceQuote)
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceQuote.providerOrganizationId),
    )
    .where(
      isBuyer
        ? and(eq(commerceQuote.rfqId, rfqId), ne(commerceQuote.status, "draft"))
        : and(
            eq(commerceQuote.rfqId, rfqId),
            eq(commerceQuote.providerOrganizationId, actor.organizationId),
          ),
    )
    .orderBy(asc(commerceQuote.createdAt), asc(commerceQuote.id));

  if (!isBuyer && quotes.length === 0) {
    // Provider with no quote and no invitation visibility → not found (probe-safe).
    const eligible = await providerMayQuoteRfq(db, {
      rfqId,
      providerOrganizationId: actor.organizationId,
      visibility: rfq.visibility,
    });
    if (!eligible) {
      return { success: false, error: { type: "NOT_FOUND" } };
    }
  }

  if (!isBuyer) {
    // Non-buyer who isn't the provider of returned rows (shouldn't happen) or has no access.
    const ownsAny = quotes.some((row) => row.quote.providerOrganizationId === actor.organizationId);
    if (!ownsAny && quotes.length > 0) {
      return { success: false, error: { type: "NOT_FOUND" } };
    }
    if (!ownsAny && quotes.length === 0) {
      // Already handled eligibility above; empty list is valid for invited provider without shell.
    }
  }

  const items: QuoteComparisonItem[] = [];
  for (const row of quotes) {
    const latestSubmitted = await loadLatestSubmittedRevision(row.quote.id);
    let productLineSummaries: QuoteComparisonItem["productLineSummaries"] = [];
    let serviceLineSummaries: QuoteComparisonItem["serviceLineSummaries"] = [];
    if (latestSubmitted) {
      const productLines = await db
        .select({
          titleSnapshot: commerceQuoteProductLine.titleSnapshot,
          quantity: commerceQuoteProductLine.quantity,
          unitPriceInCents: commerceQuoteProductLine.unitPriceInCents,
          lineTotalInCents: commerceQuoteProductLine.lineTotalInCents,
        })
        .from(commerceQuoteProductLine)
        .where(eq(commerceQuoteProductLine.revisionId, latestSubmitted.id))
        .orderBy(asc(commerceQuoteProductLine.siblingOrder));
      const serviceLines = await db
        .select({
          titleSnapshot: commerceQuoteServiceLine.titleSnapshot,
          providerKind: commerceQuoteServiceLine.providerKind,
          feeInCents: commerceQuoteServiceLine.feeInCents,
        })
        .from(commerceQuoteServiceLine)
        .where(eq(commerceQuoteServiceLine.revisionId, latestSubmitted.id))
        .orderBy(asc(commerceQuoteServiceLine.siblingOrder));
      productLineSummaries = productLines;
      serviceLineSummaries = serviceLines;
    }

    items.push({
      quoteId: row.quote.id,
      status: row.quote.status,
      provider: {
        organizationId: row.quote.providerOrganizationId,
        displayName: row.providerDisplayName,
        slug: row.providerSlug,
      },
      latestSubmittedRevision: latestSubmitted ? projectRevisionMoney(latestSubmitted) : null,
      productLineSummaries,
      serviceLineSummaries,
    });
  }

  return { success: true, value: { items } };
}

async function loadQuoteServiceDetailProjection(
  serviceLine: QuoteServiceLineRow,
): Promise<QuoteServiceDetailProjection | null> {
  switch (serviceLine.providerKind) {
    case "freight_forwarder":
    case "logistics_operator": {
      const [detail] = await db
        .select()
        .from(freightQuoteServiceDetail)
        .where(eq(freightQuoteServiceDetail.quoteServiceLineId, serviceLine.id))
        .limit(1);
      return detail
        ? {
            kind: serviceLine.providerKind,
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
        .from(customsBrokerageQuoteServiceDetail)
        .where(eq(customsBrokerageQuoteServiceDetail.quoteServiceLineId, serviceLine.id))
        .limit(1);
      return detail
        ? {
            kind: serviceLine.providerKind,
            jurisdictions: detail.jurisdictions,
            filingSummary: detail.filingSummary,
          }
        : null;
    }
    case "insurance_provider": {
      const [detail] = await db
        .select()
        .from(insuranceQuoteServiceDetail)
        .where(eq(insuranceQuoteServiceDetail.quoteServiceLineId, serviceLine.id))
        .limit(1);
      return detail
        ? {
            kind: serviceLine.providerKind,
            coverageClasses: detail.coverageClasses,
            coverageLimitInCents: detail.coverageLimitInCents,
            currency: detail.currency,
          }
        : null;
    }
    case "inspection_agency": {
      const [detail] = await db
        .select()
        .from(inspectionQuoteServiceDetail)
        .where(eq(inspectionQuoteServiceDetail.quoteServiceLineId, serviceLine.id))
        .limit(1);
      return detail
        ? { kind: serviceLine.providerKind, includedStages: detail.includedStages }
        : null;
    }
    case "testing_certification_lab": {
      const [detail] = await db
        .select()
        .from(testingCertificationQuoteServiceDetail)
        .where(eq(testingCertificationQuoteServiceDetail.quoteServiceLineId, serviceLine.id))
        .limit(1);
      return detail
        ? {
            kind: serviceLine.providerKind,
            standards: detail.standards,
            laboratoryLocation: detail.laboratoryLocation,
          }
        : null;
    }
    case "marketing_agency": {
      const [detail] = await db
        .select()
        .from(marketingQuoteServiceDetail)
        .where(eq(marketingQuoteServiceDetail.quoteServiceLineId, serviceLine.id))
        .limit(1);
      return detail
        ? {
            kind: serviceLine.providerKind,
            channels: detail.channels,
            deliverablesSummary: detail.deliverablesSummary,
          }
        : null;
    }
    case "warehouse_provider": {
      const [detail] = await db
        .select()
        .from(warehouseQuoteServiceDetail)
        .where(eq(warehouseQuoteServiceDetail.quoteServiceLineId, serviceLine.id))
        .limit(1);
      return detail
        ? {
            kind: serviceLine.providerKind,
            storageTypes: detail.storageTypes,
            capacityUnits: detail.capacityUnits,
            temperatureControlled: detail.temperatureControlled,
          }
        : null;
    }
    case "foreign_exchange_facilitator": {
      const [detail] = await db
        .select()
        .from(foreignExchangeQuoteServiceDetail)
        .where(eq(foreignExchangeQuoteServiceDetail.quoteServiceLineId, serviceLine.id))
        .limit(1);
      return detail
        ? {
            kind: serviceLine.providerKind,
            currencyPair: detail.currencyPair,
            rateFixedPoint: detail.rateFixedPoint,
            rateScale: detail.rateScale,
            settlementRail: detail.settlementRail,
            notionalAmountInCents: detail.notionalAmountInCents,
            notionalCurrency: detail.notionalCurrency,
          }
        : null;
    }
    default: {
      const exhaustiveCheck: never = serviceLine.providerKind;
      throw new Error(`Unhandled quote provider kind: ${String(exhaustiveCheck)}`);
    }
  }
}

export async function getQuote(
  actor: QuoteActorContext,
  quoteId: string,
): Promise<Result<QuoteDetailProjection, CommerceQuotesError>> {
  const [row] = await db
    .select({
      quote: commerceQuote,
      buyerOrganizationId: commerceRfq.buyerOrganizationId,
    })
    .from(commerceQuote)
    .innerJoin(commerceRfq, eq(commerceRfq.id, commerceQuote.rfqId))
    .where(eq(commerceQuote.id, quoteId))
    .limit(1);

  if (!row) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const isBuyer = row.buyerOrganizationId === actor.organizationId;
  const isProvider = row.quote.providerOrganizationId === actor.organizationId;
  if (!isBuyer && !isProvider) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (isBuyer && !isProvider && row.quote.status === "draft") {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const [latestRevision] = await db
    .select()
    .from(commerceQuoteRevision)
    .where(
      and(
        eq(commerceQuoteRevision.quoteId, row.quote.id),
        eq(commerceQuoteRevision.revisionNumber, row.quote.latestRevisionNumber),
      ),
    )
    .limit(1);

  let latestRevisionProjection: QuoteDetailProjection["latestRevision"] = null;
  if (latestRevision && row.quote.latestRevisionNumber > 0) {
    // Buyers only see submitted revisions as the detail tip when the latest is still draft.
    const revisionForViewer =
      isBuyer && !isProvider && latestRevision.submittedAt === null
        ? await loadLatestSubmittedRevision(row.quote.id)
        : latestRevision;

    if (revisionForViewer) {
      const productLines = await db
        .select()
        .from(commerceQuoteProductLine)
        .where(eq(commerceQuoteProductLine.revisionId, revisionForViewer.id))
        .orderBy(asc(commerceQuoteProductLine.siblingOrder));
      const serviceLines = await db
        .select()
        .from(commerceQuoteServiceLine)
        .where(eq(commerceQuoteServiceLine.revisionId, revisionForViewer.id))
        .orderBy(asc(commerceQuoteServiceLine.siblingOrder));
      const serviceDetailEntries = await Promise.all(
        serviceLines.map(async (serviceLine) => ({
          quoteServiceLineId: serviceLine.id,
          serviceDetail: await loadQuoteServiceDetailProjection(serviceLine),
        })),
      );
      const serviceDetailByLineId = new Map(
        serviceDetailEntries.map((entry) => [entry.quoteServiceLineId, entry.serviceDetail]),
      );
      const deliverablePlans =
        serviceLines.length === 0
          ? []
          : await db
              .select()
              .from(commerceQuoteServiceDeliverablePlan)
              .where(
                inArray(
                  commerceQuoteServiceDeliverablePlan.quoteServiceLineId,
                  serviceLines.map((serviceLine) => serviceLine.id),
                ),
              )
              .orderBy(
                asc(commerceQuoteServiceDeliverablePlan.quoteServiceLineId),
                asc(commerceQuoteServiceDeliverablePlan.sequence),
              );
      const deliverablePlansByServiceLineId = new Map<string, QuoteDeliverablePlanRow[]>();
      for (const deliverablePlan of deliverablePlans) {
        const existingPlans =
          deliverablePlansByServiceLineId.get(deliverablePlan.quoteServiceLineId) ?? [];
        existingPlans.push(deliverablePlan);
        deliverablePlansByServiceLineId.set(deliverablePlan.quoteServiceLineId, existingPlans);
      }

      latestRevisionProjection = {
        ...projectRevisionMoney(revisionForViewer),
        paymentTerms: revisionForViewer.paymentTerms,
        incoterm: revisionForViewer.incoterm,
        notes: revisionForViewer.notes,
        productLines: productLines.map((line) => ({
          id: line.id,
          rfqProductLineId: line.rfqProductLineId,
          quantity: line.quantity,
          unitPriceInCents: line.unitPriceInCents,
          lineTotalInCents: line.lineTotalInCents,
          titleSnapshot: line.titleSnapshot,
          specificationSnapshot: line.specificationSnapshot,
          leadTimeDays: line.leadTimeDays,
          exclusionsSnapshot: line.exclusionsSnapshot,
          siblingOrder: line.siblingOrder,
        })),
        serviceLines: serviceLines.map((line) => ({
          id: line.id,
          rfqServiceLineId: line.rfqServiceLineId,
          providerKind: line.providerKind,
          feeInCents: line.feeInCents,
          titleSnapshot: line.titleSnapshot,
          scopeSnapshot: line.scopeSnapshot,
          leadTimeDays: line.leadTimeDays,
          exclusionsSnapshot: line.exclusionsSnapshot,
          deliverableSnapshot: line.deliverableSnapshot,
          serviceDetail: serviceDetailByLineId.get(line.id) ?? null,
          deliverables: (deliverablePlansByServiceLineId.get(line.id) ?? []).map(
            (deliverablePlan) => ({
              id: deliverablePlan.id,
              sequence: deliverablePlan.sequence,
              title: deliverablePlan.title,
              isRequired: deliverablePlan.isRequired,
              dueAt: deliverablePlan.dueAt,
            }),
          ),
          siblingOrder: line.siblingOrder,
        })),
      };
    }
  }

  return {
    success: true,
    value: {
      id: row.quote.id,
      rfqId: row.quote.rfqId,
      providerOrganizationId: row.quote.providerOrganizationId,
      status: row.quote.status,
      latestRevisionNumber: row.quote.latestRevisionNumber,
      acceptedRevisionNumber: row.quote.acceptedRevisionNumber,
      submittedAt: row.quote.submittedAt,
      acceptedAt: row.quote.acceptedAt,
      declinedAt: row.quote.declinedAt,
      withdrawnAt: row.quote.withdrawnAt,
      expiredAt: row.quote.expiredAt,
      createdAt: row.quote.createdAt,
      latestRevision: latestRevisionProjection,
    },
  };
}

/**
 * Atomically accepts a submitted revision, creates an order snapshot, awards the RFQ,
 * and declines competing submitted quotes.
 */
export async function acceptQuote(
  actor: QuoteActorContext,
  quoteId: string,
  expectedRevision: number,
  /**
   * STORE Phase 14. The accepted settlement agreement the buyer says applies, if any.
   *
   * OMITTING IT IS THE DEFAULT: the order settles `direct_offline` and the parties carry
   * the counterparty risk between them, which is how most negotiated B2B trade at this
   * size actually settles. Naming one does not establish it — `resolveSettlementRail`
   * revalidates it under a row lock and refuses the acceptance if it has lapsed.
   */
  settlementAgreementId: string | null = null,
): Promise<Result<OrderProjection, CommerceQuotesError>> {
  try {
    const outcome = await db.transaction(async (transaction) => {
      const [quote] = await transaction
        .select()
        .from(commerceQuote)
        .where(eq(commerceQuote.id, quoteId))
        .for("update");
      if (!quote) return { status: "not_found" as const };

      const [rfq] = await transaction
        .select()
        .from(commerceRfq)
        .where(eq(commerceRfq.id, quote.rfqId))
        .for("update");
      if (!rfq) return { status: "not_found" as const };

      if (rfq.buyerOrganizationId !== actor.organizationId) {
        return { status: "not_found" as const };
      }

      const [buyerOrg] = await transaction
        .select({
          tradeState: commerceOrganization.tradeState,
          legalName: commerceOrganization.legalName,
        })
        .from(commerceOrganization)
        .where(eq(commerceOrganization.id, actor.organizationId))
        .limit(1);
      if (!buyerOrg || buyerOrg.tradeState !== "active") {
        return { status: "org_inactive" as const };
      }

      const [existingOrder] = await transaction
        .select()
        .from(commerceOrder)
        .where(eq(commerceOrder.acceptedQuoteId, quote.id))
        .limit(1);
      if (existingOrder) {
        return { status: "replay" as const, order: existingOrder };
      }

      if (rfq.state === "awarded") {
        const [competingOrder] = await transaction
          .select({ id: commerceOrder.id })
          .from(commerceOrder)
          .innerJoin(commerceQuote, eq(commerceQuote.id, commerceOrder.acceptedQuoteId))
          .where(eq(commerceQuote.rfqId, rfq.id))
          .limit(1);
        if (competingOrder) {
          return { status: "conflicting" as const, orderId: competingOrder.id };
        }
        return { status: "rfq_not_open" as const };
      }

      if (rfq.state !== "open") {
        return { status: "rfq_not_open" as const };
      }

      if (quote.status !== "submitted") {
        return { status: "invalid_state" as const };
      }

      if (expectedRevision !== quote.latestRevisionNumber) {
        return {
          status: "revision_changed" as const,
          currentRevision: quote.latestRevisionNumber,
        };
      }

      const [revision] = await transaction
        .select()
        .from(commerceQuoteRevision)
        .where(
          and(
            eq(commerceQuoteRevision.quoteId, quote.id),
            eq(commerceQuoteRevision.revisionNumber, expectedRevision),
          ),
        )
        .for("update");
      if (!revision || revision.submittedAt === null) {
        return { status: "invalid_state" as const };
      }

      const now = new Date();
      if (revision.validityDeadlineAt.getTime() <= now.getTime()) {
        return { status: "expired" as const, expiredAt: revision.validityDeadlineAt };
      }

      const [providerOrg] = await transaction
        .select({ legalName: commerceOrganization.legalName })
        .from(commerceOrganization)
        .where(eq(commerceOrganization.id, quote.providerOrganizationId))
        .limit(1);
      if (!providerOrg) {
        return { status: "not_found" as const };
      }

      const productLines = await transaction
        .select({
          quoteLine: commerceQuoteProductLine,
          productId: commerceRfqProductLine.productId,
        })
        .from(commerceQuoteProductLine)
        .innerJoin(
          commerceRfqProductLine,
          eq(commerceRfqProductLine.id, commerceQuoteProductLine.rfqProductLineId),
        )
        .where(eq(commerceQuoteProductLine.revisionId, revision.id));

      const serviceLines = await transaction
        .select()
        .from(commerceQuoteServiceLine)
        .where(eq(commerceQuoteServiceLine.revisionId, revision.id));
      const contractedDeliverablePlans =
        serviceLines.length === 0
          ? []
          : await transaction
              .select()
              .from(commerceQuoteServiceDeliverablePlan)
              .where(
                inArray(
                  commerceQuoteServiceDeliverablePlan.quoteServiceLineId,
                  serviceLines.map((serviceLine) => serviceLine.id),
                ),
              )
              .orderBy(
                asc(commerceQuoteServiceDeliverablePlan.quoteServiceLineId),
                asc(commerceQuoteServiceDeliverablePlan.sequence),
              );
      const contractedDeliverablePlansByServiceLineId = new Map<
        string,
        QuoteDeliverablePlanRow[]
      >();
      for (const contractedDeliverablePlan of contractedDeliverablePlans) {
        const existingPlans =
          contractedDeliverablePlansByServiceLineId.get(
            contractedDeliverablePlan.quoteServiceLineId,
          ) ?? [];
        existingPlans.push(contractedDeliverablePlan);
        contractedDeliverablePlansByServiceLineId.set(
          contractedDeliverablePlan.quoteServiceLineId,
          existingPlans,
        );
      }

      /**
       * A13. A quote-originated order derives its promise from the lead time the PROVIDER
       * PUT IN THE REVISION the buyer accepted — `commerce_quote_product_line.leadTimeDays`,
       * which has existed since Phase 3 and had no reader.
       *
       * That is a stronger promise than the direct-checkout one: a quote lead time is a
       * negotiated term on an immutable revision, not a catalogue advertisement. Same
       * column on the order either way, because what the metric measures is identical —
       * what the counterparty committed to before it knew the outcome.
       */
      const linePromisedDeliveryDates = productLines.map((line) =>
        derivePromisedDeliveryAt({
          orderedAt: now,
          leadTimeMaxDays: line.quoteLine.leadTimeDays,
        }),
      );
      const orderPromisedDeliveryAt = latestPromisedDeliveryAt(linePromisedDeliveryDates);

      /**
       * STORE Phase 14. Resolved BEFORE the insert, because `settlement_rail` belongs to
       * the immutable commercial snapshot and the database refuses to change it after.
       *
       * `hasProcessorPayment: false`, and that is the substantive difference from direct
       * checkout. A quote-originated order takes no payment intent at creation; a
       * negotiated B2B order of this size is usually settled by wire or letter of credit,
       * which this backend never observes. So its non-escrow rail is `direct_offline`,
       * which posts no settlement entries at all and records party attestations instead.
       */
      /** Connector commands enqueued here, dispatched after this transaction commits. */
      const escrowOutboxIds: string[] = [];

      const railResolution = await resolveSettlementRail(transaction, {
        buyerOrganizationId: rfq.buyerOrganizationId,
        sellerOrganizationId: quote.providerOrganizationId,
        currency: revision.currency,
        totalInCents: revision.totalInCents,
        hasProcessorPayment: false,
        requestedAgreementId: settlementAgreementId,
      });
      if (!railResolution.success) {
        return {
          status: "settlement_unavailable" as const,
          reason: railResolution.error.reason,
        };
      }

      const [order] = await transaction
        .insert(commerceOrder)
        .values({
          buyerOrganizationId: rfq.buyerOrganizationId,
          counterpartyOrganizationId: quote.providerOrganizationId,
          source: "accepted_quote",
          settlementRail: railResolution.value.rail,
          state: "pending_payment",
          acceptedQuoteId: quote.id,
          acceptedQuoteRevisionId: revision.id,
          currency: revision.currency,
          subtotalInCents: revision.subtotalInCents,
          taxInCents: revision.taxInCents,
          serviceFeeInCents: revision.serviceFeeInCents,
          shippingInCents: revision.shippingInCents,
          discountInCents: revision.discountInCents,
          totalInCents: revision.totalInCents,
          paymentTermsSnapshot: revision.paymentTerms,
          incotermSnapshot: revision.incoterm,
          buyerLegalNameSnapshot: buyerOrg.legalName,
          counterpartyLegalNameSnapshot: providerOrg.legalName,
          promisedDeliveryAt: orderPromisedDeliveryAt,
          createdByMemberId: actor.memberId,
        })
        .returning();
      if (!order) {
        throw new Error("Order insert returned no row.");
      }

      /**
       * Spend the agreement and open the session in the same transaction as the order.
       * The provider is called later, by a worker, so a slow escrow API cannot hold the
       * quote and RFQ row locks this transaction is already holding.
       */
      if (railResolution.value.rail === "external_escrow") {
        const consumed = await consumeSettlementAgreement(
          transaction,
          railResolution.value.agreementId,
          order.id,
        );
        if (!consumed.success) {
          return { status: "settlement_unavailable" as const, reason: consumed.error.reason };
        }

        const session = await createEscrowSessionForOrder(transaction, {
          orderId: order.id,
          agreementId: railResolution.value.agreementId,
          providerId: railResolution.value.providerId,
          currency: railResolution.value.currency,
          totalInCents: railResolution.value.totalInCents,
        });
        if (!session.success) {
          return {
            status: "settlement_unavailable" as const,
            reason: "reason" in session.error ? session.error.reason : session.error.type,
          };
        }
        escrowOutboxIds.push(session.value.outboxId);
      }

      for (const [lineIndex, line] of productLines.entries()) {
        let quantityReserved = 0;
        if (line.productId !== null) {
          const [lockedProduct] = await transaction
            .select({
              id: product.id,
              stockQuantity: product.stockQuantity,
              leadTimeMinDays: product.leadTimeMinDays,
              leadTimeMaxDays: product.leadTimeMaxDays,
            })
            .from(product)
            .where(eq(product.id, line.productId))
            .for("update");
          if (!lockedProduct) {
            return {
              status: "insufficient_stock" as const,
              productId: line.productId,
              availableQuantity: 0,
            };
          }
          const stockState = deriveStockState({
            stockQuantity: lockedProduct.stockQuantity,
            leadTimeMinDays: lockedProduct.leadTimeMinDays,
            leadTimeMaxDays: lockedProduct.leadTimeMaxDays,
          });
          if (stockState === "unavailable") {
            return {
              status: "insufficient_stock" as const,
              productId: line.productId,
              availableQuantity: 0,
            };
          }
          if (stockState !== "made_to_order") {
            if (lockedProduct.stockQuantity < line.quoteLine.quantity) {
              return {
                status: "insufficient_stock" as const,
                productId: line.productId,
                availableQuantity: lockedProduct.stockQuantity,
              };
            }
            await transaction
              .update(product)
              .set({
                stockQuantity: lockedProduct.stockQuantity - line.quoteLine.quantity,
              })
              .where(eq(product.id, line.productId));
            quantityReserved = line.quoteLine.quantity;
          }
        }

        await transaction.insert(commerceOrderProductLine).values({
          orderId: order.id,
          productId: line.productId,
          titleSnapshot: line.quoteLine.titleSnapshot,
          specificationSnapshot: line.quoteLine.specificationSnapshot,
          quantityOrdered: line.quoteLine.quantity,
          quantityReserved,
          unitPriceInCents: line.quoteLine.unitPriceInCents,
          lineTotalInCents: line.quoteLine.lineTotalInCents,
          promisedDeliveryAt: linePromisedDeliveryDates[lineIndex] ?? null,
          siblingOrder: line.quoteLine.siblingOrder,
        });
      }

      for (const line of serviceLines) {
        const [orderServiceLine] = await transaction
          .insert(commerceOrderServiceLine)
          .values({
            orderId: order.id,
            providerKind: line.providerKind,
            titleSnapshot: line.titleSnapshot,
            scopeSnapshot: line.scopeSnapshot,
            feeInCents: line.feeInCents,
            siblingOrder: line.siblingOrder,
            sourceQuoteServiceLineId: line.id,
          })
          .returning();
        if (!orderServiceLine) {
          throw new Error("Order service line insert returned no row.");
        }

        const contractedDeliverablePlansForLine =
          contractedDeliverablePlansByServiceLineId.get(line.id) ?? [];
        const requiresDeliverableNormalization =
          contractedDeliverablePlansForLine.length === 0 &&
          line.deliverableSnapshot !== null &&
          line.deliverableSnapshot.trim().length > 0;

        const [engagement] = await transaction
          .insert(commerceServiceEngagement)
          .values({
            buyerOrganizationId: rfq.buyerOrganizationId,
            providerOrganizationId: quote.providerOrganizationId,
            orderId: order.id,
            orderServiceLineId: orderServiceLine.id,
            providerKind: line.providerKind,
            state: "awaiting_provider",
            executionContractState: "legacy_missing_snapshot",
            requiresDeliverableNormalization,
            version: 0,
            titleSnapshot: line.titleSnapshot,
            scopeSnapshot: line.scopeSnapshot,
          })
          .returning();
        if (!engagement) {
          throw new Error("Service engagement insert returned no row.");
        }

        const hasTypedSnapshot = await copyAcceptedQuoteDetailToEngagement(
          transaction,
          engagement.id,
          line.id,
          line.providerKind,
        );
        if (hasTypedSnapshot) {
          await transaction
            .update(commerceServiceEngagement)
            .set({
              executionContractState: "ready",
              executionContractProvenance: "accepted_quote",
              updatedAt: now,
            })
            .where(eq(commerceServiceEngagement.id, engagement.id));
        }

        for (const contractedDeliverablePlan of contractedDeliverablePlansForLine) {
          await transaction.insert(commerceEngagementDeliverable).values({
            engagementId: engagement.id,
            sequence: contractedDeliverablePlan.sequence,
            title: contractedDeliverablePlan.title,
            isRequired: contractedDeliverablePlan.isRequired,
            state: "planned",
            dueAt: contractedDeliverablePlan.dueAt,
            createdByMemberId: actor.memberId,
          });
        }

        await transaction.insert(commerceServiceEngagementEvent).values({
          engagementId: engagement.id,
          sequence: 0,
          previousState: null,
          nextState: "awaiting_provider",
          commandKind: "created_from_accepted_quote",
          note: null,
          occurredAt: now,
          createdByMemberId: actor.memberId,
        });

        await transaction.insert(commerceOrderServiceLink).values({
          engagementId: engagement.id,
          orderId: order.id,
          orderServiceLineId: orderServiceLine.id,
        });

        await appendAuditOrThrow(transaction, {
          organizationId: actor.organizationId,
          eventKind: "service_engagement_created",
          actorUserId: actor.actorUserId,
          actorMemberRoleSnapshot: actor.memberRole,
          targetEntityType: "commerce_service_engagement",
          targetEntityId: engagement.id,
          payload: {
            engagementId: engagement.id,
            orderId: order.id,
            orderServiceLineId: orderServiceLine.id,
            providerKind: line.providerKind,
            executionContractState: hasTypedSnapshot ? "ready" : "legacy_missing_snapshot",
          },
          occurredAt: now,
        });
      }

      await transaction
        .update(commerceQuote)
        .set({
          status: "accepted",
          acceptedRevisionNumber: expectedRevision,
          acceptedAt: now,
        })
        .where(eq(commerceQuote.id, quote.id));

      await transaction
        .update(commerceRfq)
        .set({
          state: "awarded",
          awardedAt: now,
        })
        .where(eq(commerceRfq.id, rfq.id));

      const competingQuotes = await transaction
        .select()
        .from(commerceQuote)
        .where(
          and(
            eq(commerceQuote.rfqId, rfq.id),
            ne(commerceQuote.id, quote.id),
            eq(commerceQuote.status, "submitted"),
          ),
        )
        .for("update");

      for (const competing of competingQuotes) {
        await transaction
          .update(commerceQuote)
          .set({
            status: "declined",
            declinedAt: now,
          })
          .where(eq(commerceQuote.id, competing.id));

        await appendAuditOrThrow(transaction, {
          organizationId: competing.providerOrganizationId,
          eventKind: "quote_declined",
          actorUserId: actor.actorUserId,
          actorMemberRoleSnapshot: actor.memberRole,
          targetEntityType: "commerce_quote",
          targetEntityId: competing.id,
          payload: {
            quoteId: competing.id,
            rfqId: rfq.id,
            reason: "competing_quote_accepted",
            acceptedQuoteId: quote.id,
          },
          occurredAt: now,
        });
      }

      await appendAuditOrThrow(transaction, {
        organizationId: actor.organizationId,
        eventKind: "quote_accepted",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_quote",
        targetEntityId: quote.id,
        payload: {
          quoteId: quote.id,
          rfqId: rfq.id,
          revisionNumber: String(expectedRevision),
          orderId: order.id,
        },
        occurredAt: now,
      });

      await appendAuditOrThrow(transaction, {
        organizationId: actor.organizationId,
        eventKind: "order_created_from_quote",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_order",
        targetEntityId: order.id,
        payload: {
          orderId: order.id,
          quoteId: quote.id,
          rfqId: rfq.id,
          totalInCents: String(order.totalInCents),
        },
        occurredAt: now,
      });

      await appendAuditOrThrow(transaction, {
        organizationId: actor.organizationId,
        eventKind: "rfq_awarded",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_rfq",
        targetEntityId: rfq.id,
        payload: {
          rfqId: rfq.id,
          quoteId: quote.id,
          orderId: order.id,
        },
        occurredAt: now,
      });

      return { status: "accepted" as const, order, escrowOutboxIds };
    });

    switch (outcome.status) {
      case "not_found":
        return { success: false, error: { type: "NOT_FOUND" } };
      case "org_inactive":
        return { success: false, error: { type: "ORGANIZATION_NOT_ACTIVE" } };
      case "replay":
        return { success: true, value: projectOrder(outcome.order) };
      case "conflicting":
        return {
          success: false,
          error: { type: "CONFLICTING_ACCEPTANCE", orderId: outcome.orderId },
        };
      case "rfq_not_open":
        return { success: false, error: { type: "RFQ_NOT_OPEN" } };
      case "invalid_state":
        return { success: false, error: { type: "INVALID_STATE" } };
      case "revision_changed":
        return {
          success: false,
          error: { type: "REVISION_CHANGED", currentRevision: outcome.currentRevision },
        };
      case "expired":
        return { success: false, error: { type: "QUOTE_EXPIRED", expiredAt: outcome.expiredAt } };
      case "insufficient_stock":
        return {
          success: false,
          error: {
            type: "INSUFFICIENT_STOCK",
            productId: outcome.productId,
            availableQuantity: outcome.availableQuantity,
          },
        };
      case "settlement_unavailable":
        return {
          success: false,
          error: { type: "SETTLEMENT_UNAVAILABLE", reason: outcome.reason },
        };
      case "accepted":
        // Dispatch after commit; the outbox rows are durable and the reconciler re-enqueues.
        await scheduleEscrowCommands(outcome.escrowOutboxIds);
        return { success: true, value: projectOrder(outcome.order) };
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled acceptQuote outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      const [existingOrder] = await db
        .select()
        .from(commerceOrder)
        .where(eq(commerceOrder.acceptedQuoteId, quoteId))
        .limit(1);
      if (existingOrder) {
        return { success: true, value: projectOrder(existingOrder) };
      }
      return {
        success: false,
        error: { type: "CONFLICT", message: "Quote acceptance conflicted with concurrent state." },
      };
    }
    throw error;
  }
}

export async function declineQuote(
  actor: QuoteActorContext,
  quoteId: string,
): Promise<Result<QuoteShellProjection, CommerceQuotesError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [quote] = await transaction
      .select()
      .from(commerceQuote)
      .where(eq(commerceQuote.id, quoteId))
      .for("update");
    if (!quote) return { status: "not_found" as const };

    const [rfq] = await transaction
      .select({ buyerOrganizationId: commerceRfq.buyerOrganizationId })
      .from(commerceRfq)
      .where(eq(commerceRfq.id, quote.rfqId))
      .limit(1);
    if (!rfq || rfq.buyerOrganizationId !== actor.organizationId) {
      return { status: "not_found" as const };
    }
    if (quote.status !== "submitted") {
      return { status: "invalid_state" as const };
    }

    const now = new Date();
    const [updated] = await transaction
      .update(commerceQuote)
      .set({
        status: "declined",
        declinedAt: now,
      })
      .where(eq(commerceQuote.id, quote.id))
      .returning();
    if (!updated) {
      throw new Error("Quote decline update returned no row.");
    }

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "quote_declined",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_quote",
      targetEntityId: quote.id,
      payload: {
        quoteId: quote.id,
        rfqId: quote.rfqId,
        reason: "buyer_declined",
      },
      occurredAt: now,
    });

    return { status: "declined" as const, quote: updated };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    case "declined":
      return { success: true, value: projectQuoteShell(outcome.quote) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled declineQuote outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function withdrawQuote(
  actor: QuoteActorContext,
  quoteId: string,
): Promise<Result<QuoteShellProjection, CommerceQuotesError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [quote] = await transaction
      .select()
      .from(commerceQuote)
      .where(eq(commerceQuote.id, quoteId))
      .for("update");
    if (!quote) return { status: "not_found" as const };
    if (quote.providerOrganizationId !== actor.organizationId) {
      return { status: "not_found" as const };
    }
    if (quote.status === "accepted") {
      return { status: "invalid_state" as const };
    }
    if (!MUTABLE_QUOTE_STATUSES.includes(quote.status)) {
      return { status: "invalid_state" as const };
    }

    const now = new Date();
    const [updated] = await transaction
      .update(commerceQuote)
      .set({
        status: "withdrawn",
        withdrawnAt: now,
      })
      .where(eq(commerceQuote.id, quote.id))
      .returning();
    if (!updated) {
      throw new Error("Quote withdraw update returned no row.");
    }

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "quote_withdrawn",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_quote",
      targetEntityId: quote.id,
      payload: {
        quoteId: quote.id,
        rfqId: quote.rfqId,
      },
      occurredAt: now,
    });

    return { status: "withdrawn" as const, quote: updated };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    case "withdrawn":
      return { success: true, value: projectQuoteShell(outcome.quote) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled withdrawQuote outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
