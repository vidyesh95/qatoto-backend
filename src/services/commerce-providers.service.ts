import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, ne, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrganization,
  commerceProviderKindLink,
  commerceProviderProfile,
  commerceServiceCoverage,
  commerceServiceOffering,
  customsBrokerageOfferingDetail,
  foreignExchangeOfferingDetail,
  freightOfferingDetail,
  inspectionOfferingDetail,
  insuranceOfferingDetail,
  marketingOfferingDetail,
  product,
  supplier,
  testingCertificationOfferingDetail,
  warehouseOfferingDetail,
} from "#src/db/schema.js";
import {
  tradingOrganizationCountryCode,
  withTradingOrganizationCountryCode,
} from "#src/lib/commerce-organization-country.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { decodeStoreCursor, encodeStoreCursor, slugifyPublicTitle } from "#src/lib/store-cursor.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import { memberCanOperateProvider } from "#src/services/commerce-organization-access.service.js";
import {
  loadSellerDeclaredProfiles,
  type SellerDeclaredProfileProjection,
} from "#src/services/commerce-seller-profile.service.js";
import {
  EMPTY_FULFILLMENT_METRICS,
  EMPTY_MEASURED_METRICS,
  loadOrganizationFulfillmentMetrics,
  loadOrganizationMeasuredMetrics,
  loadOrganizationReviewMetrics,
  type OrganizationFulfillmentMetrics,
  type OrganizationMeasuredMetrics,
} from "#src/services/commerce-trust-metrics.service.js";
import {
  enqueueOfferingSearchDocumentRefresh,
  enqueueProductSearchDocumentRefresh,
} from "#src/services/store-search.service.js";
import type { Result } from "#src/types/index.js";

type ProviderProfile = typeof commerceProviderProfile.$inferSelect;
type ServiceOffering = typeof commerceServiceOffering.$inferSelect;
type ProviderKind = ServiceOffering["providerKind"];
type PricingModel = ServiceOffering["pricingModel"];
type OfferingState = ServiceOffering["state"];
type FreightTransportMode = (typeof freightOfferingDetail.$inferSelect.transportModes)[number];
type MemberRole = Parameters<typeof memberCanOperateProvider>[0];
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type KindLink = typeof commerceProviderKindLink.$inferSelect;
type CoverageRow = typeof commerceServiceCoverage.$inferSelect;
type ProductRow = typeof product.$inferSelect;
type SupplierRow = typeof supplier.$inferSelect;

export type CommerceProvidersError =
  | { type: "FORBIDDEN" }
  | { type: "NOT_FOUND" }
  | { type: "PROFILE_REQUIRED" }
  | { type: "KIND_LINK_EXISTS" }
  | { type: "KIND_LINK_REQUIRED" }
  | { type: "VALIDATION"; message: string }
  | { type: "INVALID_STATE" }
  | { type: "INVALID_CURSOR" }
  | { type: "ORGANIZATION_NOT_FOUND" }
  | { type: "ORGANIZATION_CONTEXT_MISMATCH" };

export type ServiceOfferingDetailInput =
  | {
      readonly kind: "freight_forwarder" | "logistics_operator";
      readonly transportModes: readonly FreightTransportMode[];
      readonly supportsConsolidation: boolean;
      readonly supportsContainers: boolean;
      readonly supportsHazardousGoods: boolean;
    }
  | {
      readonly kind: "customs_broker";
      readonly jurisdictions: readonly string[];
      readonly importSupported: boolean;
      readonly exportSupported: boolean;
      readonly commodityCoverageSummary?: string;
    }
  | {
      readonly kind: "insurance_provider";
      readonly cargoCoverageClasses: readonly string[];
      readonly coverageLimitMinInCents?: number;
      readonly coverageLimitMaxInCents?: number;
      readonly currency?: string;
      readonly exclusionsDocumentReference?: string;
    }
  | {
      readonly kind: "inspection_agency";
      readonly preProduction: boolean;
      readonly duringProduction: boolean;
      readonly preShipment: boolean;
      readonly loadingSupervision: boolean;
    }
  | {
      readonly kind: "testing_certification_lab";
      readonly standards: readonly string[];
      readonly accreditationBodies: readonly string[];
      readonly laboratoryLocations: readonly string[];
    }
  | {
      readonly kind: "marketing_agency";
      readonly channels: readonly string[];
      readonly targetRegions: readonly string[];
      readonly languageCapabilities: readonly string[];
      readonly engagementModel?: string;
    }
  | {
      readonly kind: "warehouse_provider";
      readonly storageTypes: readonly string[];
      readonly temperatureControlled: boolean;
      readonly bondedStatus: boolean;
      readonly capacityUnits?: string;
    }
  | {
      readonly kind: "foreign_exchange_facilitator";
      readonly currencyPairs: readonly string[];
      readonly settlementRails: readonly string[];
      readonly minimumNotionalInCents?: number;
      readonly maximumNotionalInCents?: number;
      readonly notionalCurrency?: string;
    };

export type ServiceOfferingDetailProjection = ServiceOfferingDetailInput;

export interface CoverageInput {
  readonly originCountryCode?: string | null;
  readonly destinationCountryCode?: string | null;
  readonly originRegionLabel?: string | null;
  readonly destinationRegionLabel?: string | null;
  readonly locationIdentifier?: string | null;
  readonly supportsHazardousGoods?: boolean;
  readonly supportsConsolidation?: boolean;
}

export interface PublicProviderCard {
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly countryCode: string;
  readonly logoUrl: string | null;
  readonly publicSummary: string | null;
  readonly verificationState: ProviderProfile["verificationState"];
  readonly acceptingRequests: boolean;
  readonly serviceRegionSummary: string | null;
  /**
   * A13. RENAMED FROM `averageResponseTimeHours` IN PHASE 12, and the rename is the fix.
   *
   * This is an integer a provider TYPES ABOUT ITSELF on
   * `commerce_provider_profile.average_response_time_hours`. Under the old name it sat as a
   * flat sibling of `fulfillmentMetrics.onTimeShipmentRate`, which the platform derives —
   * so one payload presented an assertion and a measurement as the same kind of fact. That
   * is precisely what A13's closing rule forbids, and it had been shipping since Phase 2.
   *
   * The MEASURED figure is `measuredMetrics.measuredResponseTimeHours` on the provider
   * detail read, computed from message timestamps. The two are never merged.
   *
   * A card carries the provenance in the NAME rather than in a nested object, because a
   * directory page returns 24 of these and one scalar does not earn a wrapper. The detail
   * read gets the full two-object split.
   */
  readonly declaredResponseTimeHours: number | null;
  readonly reviewMetrics: {
    readonly averageRating: number | null;
    readonly reviewCount: number;
  };
  readonly fulfillmentMetrics: OrganizationFulfillmentMetrics;
}

export interface PublicCoverageProjection {
  readonly originCountryCode: string | null;
  readonly destinationCountryCode: string | null;
  readonly originRegionLabel: string | null;
  readonly destinationRegionLabel: string | null;
  readonly locationIdentifier: string | null;
  readonly supportsHazardousGoods: boolean;
  readonly supportsConsolidation: boolean;
}

export interface PublicOfferingCard {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly providerKind: ProviderKind;
  readonly pricingModel: PricingModel;
  readonly indicativePriceMinInCents: number | null;
  readonly indicativePriceMaxInCents: number | null;
  readonly currency: string;
  readonly minimumLeadTimeDays: number | null;
  readonly maximumLeadTimeDays: number | null;
}

const publicProviderEligibility = and(
  eq(commerceOrganization.tradeState, "active"),
  eq(commerceOrganization.visibility, "public"),
  ne(commerceProviderProfile.verificationState, "rejected"),
  ne(commerceProviderProfile.verificationState, "suspended"),
);

const publicKindLinkEligibility = and(
  ne(commerceProviderKindLink.verificationState, "rejected"),
  ne(commerceProviderKindLink.verificationState, "suspended"),
);

const publicProviderSelect = {
  organizationId: commerceOrganization.id,
  slug: commerceOrganization.slug,
  displayName: commerceOrganization.displayName,
  countryCode: commerceOrganization.countryCode,
  logoUrl: commerceOrganization.logoUrl,
  publicSummary: commerceProviderProfile.publicSummary,
  verificationState: commerceProviderProfile.verificationState,
  acceptingRequests: commerceProviderProfile.acceptingRequests,
  serviceRegionSummary: commerceProviderProfile.serviceRegionSummary,
  declaredResponseTimeHours: commerceProviderProfile.averageResponseTimeHours,
};

async function attachPublicProviderTrustMetrics(
  rows: readonly Omit<PublicProviderCard, "reviewMetrics" | "fulfillmentMetrics">[],
): Promise<readonly PublicProviderCard[]> {
  const organizationIds = rows.map((row) => row.organizationId);
  const [reviewMetrics, fulfillmentMetrics] = await Promise.all([
    loadOrganizationReviewMetrics(organizationIds),
    loadOrganizationFulfillmentMetrics(organizationIds),
  ]);
  return rows.map((row) => ({
    ...row,
    reviewMetrics: reviewMetrics.get(row.organizationId) ?? {
      averageRating: null,
      reviewCount: 0,
    },
    fulfillmentMetrics: fulfillmentMetrics.get(row.organizationId) ?? EMPTY_FULFILLMENT_METRICS,
  }));
}

export function assertOrganizationContextMatch(input: {
  readonly activeOrganizationId: string;
  readonly routeOrganizationId: string;
}): Result<true, CommerceProvidersError> {
  if (input.activeOrganizationId !== input.routeOrganizationId) {
    return { success: false, error: { type: "ORGANIZATION_CONTEXT_MISMATCH" } };
  }
  return { success: true, value: true };
}

function requireProviderRole(memberRole: MemberRole): Result<true, CommerceProvidersError> {
  if (!memberCanOperateProvider(memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }
  return { success: true, value: true };
}

function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

function validationFailure(message: string): Result<never, CommerceProvidersError> {
  return { success: false, error: { type: "VALIDATION", message } };
}

function validatePairedRange(
  minValue: number | null | undefined,
  maxValue: number | null | undefined,
  options: { readonly maxCeiling?: number; readonly message: string },
): Result<true, CommerceProvidersError> {
  if (minValue === undefined && maxValue === undefined) return { success: true, value: true };
  if (minValue === null && maxValue === null) return { success: true, value: true };
  if (
    typeof minValue !== "number" ||
    typeof maxValue !== "number" ||
    !Number.isInteger(minValue) ||
    !Number.isInteger(maxValue) ||
    minValue < 0 ||
    maxValue < minValue ||
    (options.maxCeiling !== undefined && maxValue > options.maxCeiling)
  ) {
    return validationFailure(options.message);
  }
  return { success: true, value: true };
}

async function insertOfferingDetail(
  transaction: DatabaseTransaction,
  offeringId: string,
  detail: ServiceOfferingDetailInput,
): Promise<void> {
  switch (detail.kind) {
    case "freight_forwarder":
    case "logistics_operator":
      await transaction.insert(freightOfferingDetail).values({
        offeringId,
        transportModes: [...detail.transportModes],
        supportsConsolidation: detail.supportsConsolidation,
        supportsContainers: detail.supportsContainers,
        supportsHazardousGoods: detail.supportsHazardousGoods,
      });
      return;
    case "customs_broker":
      await transaction.insert(customsBrokerageOfferingDetail).values({
        offeringId,
        jurisdictions: [...detail.jurisdictions],
        importSupported: detail.importSupported,
        exportSupported: detail.exportSupported,
        commodityCoverageSummary: detail.commodityCoverageSummary,
      });
      return;
    case "insurance_provider":
      await transaction.insert(insuranceOfferingDetail).values({
        offeringId,
        cargoCoverageClasses: [...detail.cargoCoverageClasses],
        coverageLimitMinInCents: detail.coverageLimitMinInCents,
        coverageLimitMaxInCents: detail.coverageLimitMaxInCents,
        currency: detail.currency ?? "USD",
        exclusionsDocumentReference: detail.exclusionsDocumentReference,
      });
      return;
    case "inspection_agency":
      await transaction.insert(inspectionOfferingDetail).values({
        offeringId,
        preProduction: detail.preProduction,
        duringProduction: detail.duringProduction,
        preShipment: detail.preShipment,
        loadingSupervision: detail.loadingSupervision,
      });
      return;
    case "testing_certification_lab":
      await transaction.insert(testingCertificationOfferingDetail).values({
        offeringId,
        standards: [...detail.standards],
        accreditationBodies: [...detail.accreditationBodies],
        laboratoryLocations: [...detail.laboratoryLocations],
      });
      return;
    case "marketing_agency":
      await transaction.insert(marketingOfferingDetail).values({
        offeringId,
        channels: [...detail.channels],
        targetRegions: [...detail.targetRegions],
        languageCapabilities: [...detail.languageCapabilities],
        engagementModel: detail.engagementModel,
      });
      return;
    case "warehouse_provider":
      await transaction.insert(warehouseOfferingDetail).values({
        offeringId,
        storageTypes: [...detail.storageTypes],
        temperatureControlled: detail.temperatureControlled,
        bondedStatus: detail.bondedStatus,
        capacityUnits: detail.capacityUnits,
      });
      return;
    case "foreign_exchange_facilitator":
      await transaction.insert(foreignExchangeOfferingDetail).values({
        offeringId,
        currencyPairs: [...detail.currencyPairs],
        settlementRails: [...detail.settlementRails],
        minimumNotionalInCents: detail.minimumNotionalInCents,
        maximumNotionalInCents: detail.maximumNotionalInCents,
        notionalCurrency: detail.notionalCurrency ?? "USD",
      });
      return;
    default: {
      const exhaustiveDetail: never = detail;
      throw new Error(`Unhandled offering detail kind: ${JSON.stringify(exhaustiveDetail)}`);
    }
  }
}

async function loadOfferingDetail(
  offeringId: string,
  providerKind: ProviderKind,
): Promise<ServiceOfferingDetailProjection | null> {
  switch (providerKind) {
    case "freight_forwarder":
    case "logistics_operator": {
      const [row] = await db
        .select()
        .from(freightOfferingDetail)
        .where(eq(freightOfferingDetail.offeringId, offeringId))
        .limit(1);
      return row
        ? {
            kind: providerKind,
            transportModes: row.transportModes,
            supportsConsolidation: row.supportsConsolidation,
            supportsContainers: row.supportsContainers,
            supportsHazardousGoods: row.supportsHazardousGoods,
          }
        : null;
    }
    case "customs_broker": {
      const [row] = await db
        .select()
        .from(customsBrokerageOfferingDetail)
        .where(eq(customsBrokerageOfferingDetail.offeringId, offeringId))
        .limit(1);
      return row
        ? {
            kind: "customs_broker",
            jurisdictions: row.jurisdictions,
            importSupported: row.importSupported,
            exportSupported: row.exportSupported,
            commodityCoverageSummary: row.commodityCoverageSummary ?? undefined,
          }
        : null;
    }
    case "insurance_provider": {
      const [row] = await db
        .select()
        .from(insuranceOfferingDetail)
        .where(eq(insuranceOfferingDetail.offeringId, offeringId))
        .limit(1);
      return row
        ? {
            kind: "insurance_provider",
            cargoCoverageClasses: row.cargoCoverageClasses,
            coverageLimitMinInCents: row.coverageLimitMinInCents ?? undefined,
            coverageLimitMaxInCents: row.coverageLimitMaxInCents ?? undefined,
            currency: row.currency,
            exclusionsDocumentReference: row.exclusionsDocumentReference ?? undefined,
          }
        : null;
    }
    case "inspection_agency": {
      const [row] = await db
        .select()
        .from(inspectionOfferingDetail)
        .where(eq(inspectionOfferingDetail.offeringId, offeringId))
        .limit(1);
      return row
        ? {
            kind: "inspection_agency",
            preProduction: row.preProduction,
            duringProduction: row.duringProduction,
            preShipment: row.preShipment,
            loadingSupervision: row.loadingSupervision,
          }
        : null;
    }
    case "testing_certification_lab": {
      const [row] = await db
        .select()
        .from(testingCertificationOfferingDetail)
        .where(eq(testingCertificationOfferingDetail.offeringId, offeringId))
        .limit(1);
      return row
        ? {
            kind: "testing_certification_lab",
            standards: row.standards,
            accreditationBodies: row.accreditationBodies,
            laboratoryLocations: row.laboratoryLocations,
          }
        : null;
    }
    case "marketing_agency": {
      const [row] = await db
        .select()
        .from(marketingOfferingDetail)
        .where(eq(marketingOfferingDetail.offeringId, offeringId))
        .limit(1);
      return row
        ? {
            kind: "marketing_agency",
            channels: row.channels,
            targetRegions: row.targetRegions,
            languageCapabilities: row.languageCapabilities,
            engagementModel: row.engagementModel ?? undefined,
          }
        : null;
    }
    case "warehouse_provider": {
      const [row] = await db
        .select()
        .from(warehouseOfferingDetail)
        .where(eq(warehouseOfferingDetail.offeringId, offeringId))
        .limit(1);
      return row
        ? {
            kind: "warehouse_provider",
            storageTypes: row.storageTypes,
            temperatureControlled: row.temperatureControlled,
            bondedStatus: row.bondedStatus,
            capacityUnits: row.capacityUnits ?? undefined,
          }
        : null;
    }
    case "foreign_exchange_facilitator": {
      const [row] = await db
        .select()
        .from(foreignExchangeOfferingDetail)
        .where(eq(foreignExchangeOfferingDetail.offeringId, offeringId))
        .limit(1);
      return row
        ? {
            kind: "foreign_exchange_facilitator",
            currencyPairs: row.currencyPairs,
            settlementRails: row.settlementRails,
            minimumNotionalInCents: row.minimumNotionalInCents ?? undefined,
            maximumNotionalInCents: row.maximumNotionalInCents ?? undefined,
            notionalCurrency: row.notionalCurrency,
          }
        : null;
    }
    default: {
      const exhaustiveKind: never = providerKind;
      throw new Error(`Unhandled provider kind: ${JSON.stringify(exhaustiveKind)}`);
    }
  }
}

function toPublicOfferingCard(offering: ServiceOffering): PublicOfferingCard {
  return {
    id: offering.id,
    slug: offering.slug,
    title: offering.title,
    summary: offering.summary,
    providerKind: offering.providerKind,
    pricingModel: offering.pricingModel,
    indicativePriceMinInCents: offering.indicativePriceMinInCents,
    indicativePriceMaxInCents: offering.indicativePriceMaxInCents,
    currency: offering.currency,
    minimumLeadTimeDays: offering.minimumLeadTimeDays,
    maximumLeadTimeDays: offering.maximumLeadTimeDays,
  };
}

async function findOwnedOffering(
  offeringId: string,
  organizationId: string,
): Promise<ServiceOffering | null> {
  const [existing] = await db
    .select()
    .from(commerceServiceOffering)
    .where(
      and(
        eq(commerceServiceOffering.id, offeringId),
        eq(commerceServiceOffering.providerOrganizationId, organizationId),
      ),
    )
    .limit(1);
  return existing ?? null;
}

export async function upsertProviderProfile(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly memberRole: MemberRole;
  readonly publicSummary?: string;
  readonly supportPolicy?: string;
  readonly acceptingRequests?: boolean;
  readonly serviceRegionSummary?: string;
}): Promise<Result<ProviderProfile, CommerceProvidersError>> {
  const access = requireProviderRole(input.memberRole);
  if (!access.success) return access;

  const [existing] = await db
    .select()
    .from(commerceProviderProfile)
    .where(eq(commerceProviderProfile.organizationId, input.organizationId))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(commerceProviderProfile)
      .set({
        publicSummary:
          input.publicSummary === undefined ? existing.publicSummary : input.publicSummary,
        supportPolicy:
          input.supportPolicy === undefined ? existing.supportPolicy : input.supportPolicy,
        acceptingRequests:
          input.acceptingRequests === undefined
            ? existing.acceptingRequests
            : input.acceptingRequests,
        serviceRegionSummary:
          input.serviceRegionSummary === undefined
            ? existing.serviceRegionSummary
            : input.serviceRegionSummary,
        updatedAt: new Date(),
      })
      .where(eq(commerceProviderProfile.organizationId, input.organizationId))
      .returning();
    if (!updated) throw new Error("Provider profile update returned no row.");
    return { success: true, value: updated };
  }

  const [created] = await db
    .insert(commerceProviderProfile)
    .values({
      organizationId: input.organizationId,
      publicSummary: input.publicSummary,
      supportPolicy: input.supportPolicy,
      acceptingRequests: input.acceptingRequests ?? true,
      serviceRegionSummary: input.serviceRegionSummary,
      verificationState: "unverified",
    })
    .returning();
  if (!created) throw new Error("Provider profile insert returned no row.");
  return { success: true, value: created };
}

export async function addProviderKindLink(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly memberRole: MemberRole;
  readonly providerKind: ProviderKind;
}): Promise<Result<KindLink, CommerceProvidersError>> {
  const access = requireProviderRole(input.memberRole);
  if (!access.success) return access;

  const [profile] = await db
    .select({ organizationId: commerceProviderProfile.organizationId })
    .from(commerceProviderProfile)
    .where(eq(commerceProviderProfile.organizationId, input.organizationId))
    .limit(1);
  if (!profile) return { success: false, error: { type: "PROFILE_REQUIRED" } };

  try {
    const [created] = await db
      .insert(commerceProviderKindLink)
      .values({
        organizationId: input.organizationId,
        providerKind: input.providerKind,
        verificationState: "unverified",
      })
      .returning();
    if (!created) throw new Error("Provider kind link insert returned no row.");
    return { success: true, value: created };
  } catch (insertError: unknown) {
    if (isUniqueViolation(insertError)) {
      return { success: false, error: { type: "KIND_LINK_EXISTS" } };
    }
    throw insertError;
  }
}

export async function createServiceOffering(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly memberRole: MemberRole;
  readonly providerKind: ProviderKind;
  readonly title: string;
  readonly summary?: string;
  readonly pricingModel: PricingModel;
  readonly indicativePriceMinInCents?: number;
  readonly indicativePriceMaxInCents?: number;
  readonly currency?: string;
  readonly minimumLeadTimeDays?: number;
  readonly maximumLeadTimeDays?: number;
  readonly detail: ServiceOfferingDetailInput;
}): Promise<Result<ServiceOffering, CommerceProvidersError>> {
  const access = requireProviderRole(input.memberRole);
  if (!access.success) return access;
  if (input.detail.kind !== input.providerKind) {
    return validationFailure("Detail kind must match providerKind.");
  }

  const trimmedTitle = input.title.trim();
  if (trimmedTitle.length < 1 || trimmedTitle.length > 200) {
    return validationFailure("Title must be between 1 and 200 characters.");
  }
  if (input.summary !== undefined && input.summary.length > 4000) {
    return validationFailure("Summary must be at most 4000 characters.");
  }
  const currency = input.currency ?? "USD";
  if (!isCurrencyCode(currency)) {
    return validationFailure("Currency must be a three-letter ISO code.");
  }
  const priceCheck = validatePairedRange(
    input.indicativePriceMinInCents,
    input.indicativePriceMaxInCents,
    { message: "Indicative price range must be a pair of non-negative integer cents." },
  );
  if (!priceCheck.success) return priceCheck;
  const leadCheck = validatePairedRange(input.minimumLeadTimeDays, input.maximumLeadTimeDays, {
    maxCeiling: 3650,
    message: "Lead time range must be a pair of integers from 0 to 3650 days.",
  });
  if (!leadCheck.success) return leadCheck;
  if (
    input.detail.kind === "insurance_provider" &&
    input.detail.currency !== undefined &&
    !isCurrencyCode(input.detail.currency)
  ) {
    return validationFailure("Insurance currency must be a three-letter ISO code.");
  }
  if (
    input.detail.kind === "foreign_exchange_facilitator" &&
    input.detail.notionalCurrency !== undefined &&
    !isCurrencyCode(input.detail.notionalCurrency)
  ) {
    return validationFailure("Notional currency must be a three-letter ISO code.");
  }

  const [profile] = await db
    .select({ organizationId: commerceProviderProfile.organizationId })
    .from(commerceProviderProfile)
    .where(eq(commerceProviderProfile.organizationId, input.organizationId))
    .limit(1);
  if (!profile) return { success: false, error: { type: "PROFILE_REQUIRED" } };

  const [kindLink] = await db
    .select({ id: commerceProviderKindLink.id })
    .from(commerceProviderKindLink)
    .where(
      and(
        eq(commerceProviderKindLink.organizationId, input.organizationId),
        eq(commerceProviderKindLink.providerKind, input.providerKind),
      ),
    )
    .limit(1);
  if (!kindLink) return { success: false, error: { type: "KIND_LINK_REQUIRED" } };

  const offeringId = randomUUID();
  const created = await db.transaction(async (transaction) => {
    const [offering] = await transaction
      .insert(commerceServiceOffering)
      .values({
        id: offeringId,
        slug: slugifyPublicTitle(trimmedTitle, offeringId),
        providerOrganizationId: input.organizationId,
        providerKind: input.providerKind,
        title: trimmedTitle,
        summary: input.summary,
        state: "draft",
        pricingModel: input.pricingModel,
        indicativePriceMinInCents: input.indicativePriceMinInCents,
        indicativePriceMaxInCents: input.indicativePriceMaxInCents,
        currency,
        minimumLeadTimeDays: input.minimumLeadTimeDays,
        maximumLeadTimeDays: input.maximumLeadTimeDays,
      })
      .returning();
    if (!offering) throw new Error("Service offering insert returned no row.");
    await insertOfferingDetail(transaction, offering.id, input.detail);
    return offering;
  });
  return { success: true, value: created };
}

export async function updateServiceOffering(input: {
  readonly offeringId: string;
  readonly organizationId: string;
  readonly memberRole: MemberRole;
  readonly title?: string;
  readonly summary?: string | null;
  readonly pricingModel?: PricingModel;
  readonly indicativePriceMinInCents?: number | null;
  readonly indicativePriceMaxInCents?: number | null;
  readonly currency?: string;
  readonly minimumLeadTimeDays?: number | null;
  readonly maximumLeadTimeDays?: number | null;
}): Promise<Result<ServiceOffering, CommerceProvidersError>> {
  const access = requireProviderRole(input.memberRole);
  if (!access.success) return access;

  const existing = await findOwnedOffering(input.offeringId, input.organizationId);
  if (!existing) return { success: false, error: { type: "NOT_FOUND" } };
  if (existing.state !== "draft") return { success: false, error: { type: "INVALID_STATE" } };

  const nextTitle = input.title === undefined ? existing.title : input.title.trim();
  if (nextTitle.length < 1 || nextTitle.length > 200) {
    return validationFailure("Title must be between 1 and 200 characters.");
  }
  const nextSummary = input.summary === undefined ? existing.summary : input.summary;
  if (nextSummary !== null && nextSummary !== undefined && nextSummary.length > 4000) {
    return validationFailure("Summary must be at most 4000 characters.");
  }
  const nextCurrency = input.currency ?? existing.currency;
  if (!isCurrencyCode(nextCurrency)) {
    return validationFailure("Currency must be a three-letter ISO code.");
  }
  const nextMinPrice =
    input.indicativePriceMinInCents === undefined
      ? existing.indicativePriceMinInCents
      : input.indicativePriceMinInCents;
  const nextMaxPrice =
    input.indicativePriceMaxInCents === undefined
      ? existing.indicativePriceMaxInCents
      : input.indicativePriceMaxInCents;
  const priceCheck = validatePairedRange(nextMinPrice, nextMaxPrice, {
    message: "Indicative price range must be a pair of non-negative integer cents.",
  });
  if (!priceCheck.success) return priceCheck;
  const nextMinLead =
    input.minimumLeadTimeDays === undefined
      ? existing.minimumLeadTimeDays
      : input.minimumLeadTimeDays;
  const nextMaxLead =
    input.maximumLeadTimeDays === undefined
      ? existing.maximumLeadTimeDays
      : input.maximumLeadTimeDays;
  const leadCheck = validatePairedRange(nextMinLead, nextMaxLead, {
    maxCeiling: 3650,
    message: "Lead time range must be a pair of integers from 0 to 3650 days.",
  });
  if (!leadCheck.success) return leadCheck;

  const [updated] = await db
    .update(commerceServiceOffering)
    .set({
      title: nextTitle,
      summary: nextSummary,
      pricingModel: input.pricingModel ?? existing.pricingModel,
      indicativePriceMinInCents: nextMinPrice,
      indicativePriceMaxInCents: nextMaxPrice,
      currency: nextCurrency,
      minimumLeadTimeDays: nextMinLead,
      maximumLeadTimeDays: nextMaxLead,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commerceServiceOffering.id, input.offeringId),
        eq(commerceServiceOffering.providerOrganizationId, input.organizationId),
        eq(commerceServiceOffering.state, "draft"),
      ),
    )
    .returning();
  if (!updated) return { success: false, error: { type: "INVALID_STATE" } };
  return { success: true, value: updated };
}

export async function submitServiceOffering(input: {
  readonly offeringId: string;
  readonly organizationId: string;
  readonly memberRole: MemberRole;
}): Promise<Result<ServiceOffering, CommerceProvidersError>> {
  const access = requireProviderRole(input.memberRole);
  if (!access.success) return access;

  const [updated] = await db
    .update(commerceServiceOffering)
    .set({ state: "pending_review", updatedAt: new Date() })
    .where(
      and(
        eq(commerceServiceOffering.id, input.offeringId),
        eq(commerceServiceOffering.providerOrganizationId, input.organizationId),
        eq(commerceServiceOffering.state, "draft"),
      ),
    )
    .returning();
  if (updated) {
    await enqueueOfferingSearchDocumentRefresh(updated.id);
    return { success: true, value: updated };
  }

  const existing = await findOwnedOffering(input.offeringId, input.organizationId);
  if (!existing) return { success: false, error: { type: "NOT_FOUND" } };
  return { success: false, error: { type: "INVALID_STATE" } };
}

export async function setOfferingCoverage(input: {
  readonly offeringId: string;
  readonly organizationId: string;
  readonly memberRole: MemberRole;
  readonly coverages: readonly CoverageInput[];
}): Promise<Result<readonly CoverageRow[], CommerceProvidersError>> {
  const access = requireProviderRole(input.memberRole);
  if (!access.success) return access;

  for (const coverage of input.coverages) {
    if (coverage.originCountryCode != null && !/^[A-Z]{2}$/.test(coverage.originCountryCode)) {
      return validationFailure("Origin country code must be ISO-3166 alpha-2.");
    }
    if (
      coverage.destinationCountryCode != null &&
      !/^[A-Z]{2}$/.test(coverage.destinationCountryCode)
    ) {
      return validationFailure("Destination country code must be ISO-3166 alpha-2.");
    }
  }

  type CoverageOutcome =
    | { readonly status: "replaced"; readonly rows: readonly CoverageRow[] }
    | { readonly status: "not_found" }
    | { readonly status: "invalid_state" };

  const outcome = await db.transaction(async (transaction): Promise<CoverageOutcome> => {
    const [existing] = await transaction
      .select({ id: commerceServiceOffering.id, state: commerceServiceOffering.state })
      .from(commerceServiceOffering)
      .where(
        and(
          eq(commerceServiceOffering.id, input.offeringId),
          eq(commerceServiceOffering.providerOrganizationId, input.organizationId),
        ),
      )
      .for("update");
    if (!existing) return { status: "not_found" };
    if (existing.state !== "draft" && existing.state !== "pending_review") {
      return { status: "invalid_state" };
    }

    await transaction
      .delete(commerceServiceCoverage)
      .where(eq(commerceServiceCoverage.offeringId, input.offeringId));

    if (input.coverages.length === 0) return { status: "replaced", rows: [] };

    const rows = await transaction
      .insert(commerceServiceCoverage)
      .values(
        input.coverages.map((coverage) => ({
          offeringId: input.offeringId,
          originCountryCode: coverage.originCountryCode ?? null,
          destinationCountryCode: coverage.destinationCountryCode ?? null,
          originRegionLabel: coverage.originRegionLabel ?? null,
          destinationRegionLabel: coverage.destinationRegionLabel ?? null,
          locationIdentifier: coverage.locationIdentifier ?? null,
          supportsHazardousGoods: coverage.supportsHazardousGoods ?? false,
          supportsConsolidation: coverage.supportsConsolidation ?? false,
        })),
      )
      .returning();
    return { status: "replaced", rows };
  });

  switch (outcome.status) {
    case "replaced":
      return { success: true, value: outcome.rows };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE" } };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled coverage outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

function nextStateForModerationDecision(
  decision: "approve" | "reject" | "suspend",
  currentState: OfferingState,
): Result<OfferingState, CommerceProvidersError> {
  switch (decision) {
    case "approve":
      return currentState === "pending_review"
        ? { success: true, value: "active" }
        : { success: false, error: { type: "INVALID_STATE" } };
    case "reject":
      return currentState === "pending_review"
        ? { success: true, value: "retired" }
        : { success: false, error: { type: "INVALID_STATE" } };
    case "suspend":
      return currentState === "active" || currentState === "pending_review"
        ? { success: true, value: "suspended" }
        : { success: false, error: { type: "INVALID_STATE" } };
    default: {
      const exhaustiveDecision: never = decision;
      throw new Error(`Unhandled moderation decision: ${JSON.stringify(exhaustiveDecision)}`);
    }
  }
}

export async function moderateServiceOffering(input: {
  readonly moderatorUserId: string;
  readonly offeringId: string;
  readonly decision: "approve" | "reject" | "suspend";
  readonly reason?: string;
}): Promise<Result<ServiceOffering, CommerceProvidersError>> {
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) return { success: false, error: { type: "FORBIDDEN" } };

  const [existing] = await db
    .select()
    .from(commerceServiceOffering)
    .where(eq(commerceServiceOffering.id, input.offeringId))
    .limit(1);
  if (!existing) return { success: false, error: { type: "NOT_FOUND" } };

  const nextState = nextStateForModerationDecision(input.decision, existing.state);
  if (!nextState.success) return nextState;

  const occurredAt = new Date();
  const updated = await db.transaction(async (transaction) => {
    const [row] = await transaction
      .update(commerceServiceOffering)
      .set({
        state: nextState.value,
        moderatedByUserId: input.moderatorUserId,
        moderatedAt: occurredAt,
        moderationReason: input.reason ?? null,
        updatedAt: occurredAt,
      })
      .where(
        and(
          eq(commerceServiceOffering.id, input.offeringId),
          eq(commerceServiceOffering.state, existing.state),
        ),
      )
      .returning();
    if (!row) return null;

    await appendPlatformAuditEntry(transaction, {
      eventKind:
        input.decision === "approve" ? "content_review_approved" : "content_review_rejected",
      actorUserId: input.moderatorUserId,
      actorRoleSnapshot: capability.value.platformRole,
      actionLabel: `Commerce service offering ${input.decision}`,
      targetLabel: `service_offering ${input.offeringId}`,
      detailNote: input.reason ?? "",
      payload: {
        offeringId: input.offeringId,
        decision: input.decision,
        previousState: existing.state,
        nextState: nextState.value,
      },
      occurredAt,
    });
    return row;
  });
  if (!updated) return { success: false, error: { type: "INVALID_STATE" } };

  await enqueueOfferingSearchDocumentRefresh(updated.id);
  return { success: true, value: updated };
}

export async function moderateProduct(input: {
  readonly moderatorUserId: string;
  readonly productId: string;
  readonly moderationState: "approved" | "rejected" | "suspended";
  readonly reason?: string;
}): Promise<Result<ProductRow, CommerceProvidersError>> {
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) return { success: false, error: { type: "FORBIDDEN" } };

  const occurredAt = new Date();
  const updated = await db.transaction(async (transaction) => {
    const [row] = await transaction
      .update(product)
      .set({ moderationState: input.moderationState, updatedAt: occurredAt })
      .where(eq(product.id, input.productId))
      .returning();
    if (!row) return null;

    await appendPlatformAuditEntry(transaction, {
      eventKind:
        input.moderationState === "approved"
          ? "content_review_approved"
          : "content_review_rejected",
      actorUserId: input.moderatorUserId,
      actorRoleSnapshot: capability.value.platformRole,
      actionLabel: `Commerce product moderation ${input.moderationState}`,
      targetLabel: `product ${input.productId}`,
      detailNote: input.reason ?? "",
      payload: {
        productId: input.productId,
        moderationState: input.moderationState,
      },
      occurredAt,
    });
    return row;
  });
  if (!updated) return { success: false, error: { type: "NOT_FOUND" } };

  await enqueueProductSearchDocumentRefresh(updated.id);
  return { success: true, value: updated };
}

export async function linkSupplierToCommerceOrganization(input: {
  readonly moderatorUserId: string;
  readonly supplierId: string;
  readonly commerceOrganizationId: string;
}): Promise<Result<SupplierRow, CommerceProvidersError>> {
  const capability = await requirePlatformCapability(input.moderatorUserId, "moderate_commerce");
  if (!capability.success) return { success: false, error: { type: "FORBIDDEN" } };

  const [organization] = await db
    .select({ id: commerceOrganization.id })
    .from(commerceOrganization)
    .where(eq(commerceOrganization.id, input.commerceOrganizationId))
    .limit(1);
  if (!organization) return { success: false, error: { type: "ORGANIZATION_NOT_FOUND" } };

  const [updated] = await db
    .update(supplier)
    .set({ commerceOrganizationId: input.commerceOrganizationId, updatedAt: new Date() })
    .where(eq(supplier.id, input.supplierId))
    .returning();
  if (!updated) return { success: false, error: { type: "NOT_FOUND" } };
  return { success: true, value: updated };
}

export async function listPublicProviders(input: {
  readonly providerKind?: ProviderKind;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<
  Result<
    {
      readonly items: readonly PublicProviderCard[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceProvidersError
  >
> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          gt(commerceOrganization.displayName, decodedCursor.sortKey),
          and(
            eq(commerceOrganization.displayName, decodedCursor.sortKey),
            gt(commerceOrganization.id, decodedCursor.id),
          ),
        );

  const rows =
    input.providerKind === undefined
      ? await db
          .select(publicProviderSelect)
          .from(commerceOrganization)
          .innerJoin(
            commerceProviderProfile,
            eq(commerceProviderProfile.organizationId, commerceOrganization.id),
          )
          .where(and(publicProviderEligibility, cursorPredicate))
          .orderBy(asc(commerceOrganization.displayName), asc(commerceOrganization.id))
          .limit(input.limit + 1)
      : await db
          .select(publicProviderSelect)
          .from(commerceOrganization)
          .innerJoin(
            commerceProviderProfile,
            eq(commerceProviderProfile.organizationId, commerceOrganization.id),
          )
          .innerJoin(
            commerceProviderKindLink,
            and(
              eq(commerceProviderKindLink.organizationId, commerceOrganization.id),
              eq(commerceProviderKindLink.providerKind, input.providerKind),
              publicKindLinkEligibility,
            ),
          )
          .where(and(publicProviderEligibility, cursorPredicate))
          .orderBy(asc(commerceOrganization.displayName), asc(commerceOrganization.id))
          .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const items = await attachPublicProviderTrustMetrics(
    pageRows.map((row) => withTradingOrganizationCountryCode(row, row.organizationId)),
  );
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > input.limit && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.displayName, id: lastRow.organizationId })
      : null;

  return {
    success: true,
    value: { items, page: { nextCursor, hasMore: nextCursor !== null } },
  };
}

/**
 * A13. The provider detail read carries the same two-object split the seller storefront
 * does, so a company page renders one shape whichever trade role it is looking at.
 *
 * `declaredProfile` is null for a provider that has never described itself — a freight
 * forwarder has no factory photos, and an empty object would invite the UI to render an
 * empty "About the factory" panel.
 */
export async function getPublicProviderByOrganizationSlug(organizationSlug: string): Promise<
  Result<
    {
      readonly provider: PublicProviderCard;
      readonly declaredProfile: SellerDeclaredProfileProjection | null;
      readonly measuredMetrics: OrganizationMeasuredMetrics;
      readonly offerings: readonly PublicOfferingCard[];
    },
    CommerceProvidersError
  >
> {
  const [provider] = await db
    .select(publicProviderSelect)
    .from(commerceOrganization)
    .innerJoin(
      commerceProviderProfile,
      eq(commerceProviderProfile.organizationId, commerceOrganization.id),
    )
    .where(and(publicProviderEligibility, eq(commerceOrganization.slug, organizationSlug)))
    .limit(1);
  if (!provider) return { success: false, error: { type: "NOT_FOUND" } };

  const [enrichedProvider] = await attachPublicProviderTrustMetrics([
    withTradingOrganizationCountryCode(provider, provider.organizationId),
  ]);
  if (!enrichedProvider) return { success: false, error: { type: "NOT_FOUND" } };

  const offerings = await db
    .select({ offering: commerceServiceOffering })
    .from(commerceServiceOffering)
    .innerJoin(
      commerceProviderKindLink,
      and(
        eq(commerceProviderKindLink.organizationId, commerceServiceOffering.providerOrganizationId),
        eq(commerceProviderKindLink.providerKind, commerceServiceOffering.providerKind),
        publicKindLinkEligibility,
      ),
    )
    .where(
      and(
        eq(commerceServiceOffering.providerOrganizationId, provider.organizationId),
        eq(commerceServiceOffering.state, "active"),
      ),
    )
    .orderBy(asc(commerceServiceOffering.title), asc(commerceServiceOffering.id));

  const [declaredProfiles, measuredMetrics] = await Promise.all([
    loadSellerDeclaredProfiles([provider.organizationId]),
    loadOrganizationMeasuredMetrics([provider.organizationId]),
  ]);

  return {
    success: true,
    value: {
      provider: enrichedProvider,
      declaredProfile: declaredProfiles.get(provider.organizationId) ?? null,
      measuredMetrics: measuredMetrics.get(provider.organizationId) ?? EMPTY_MEASURED_METRICS,
      offerings: offerings.map((row) => toPublicOfferingCard(row.offering)),
    },
  };
}

export async function getPublicServiceOfferingBySlug(offeringSlug: string): Promise<
  Result<
    {
      readonly offering: PublicOfferingCard & { readonly state: "active" };
      readonly provider: PublicProviderCard;
      readonly detail: ServiceOfferingDetailProjection;
      readonly coverage: readonly PublicCoverageProjection[];
    },
    CommerceProvidersError
  >
> {
  const [row] = await db
    .select({
      offering: commerceServiceOffering,
      ...publicProviderSelect,
    })
    .from(commerceServiceOffering)
    .innerJoin(
      commerceProviderProfile,
      eq(commerceProviderProfile.organizationId, commerceServiceOffering.providerOrganizationId),
    )
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceServiceOffering.providerOrganizationId),
    )
    .innerJoin(
      commerceProviderKindLink,
      and(
        eq(commerceProviderKindLink.organizationId, commerceServiceOffering.providerOrganizationId),
        eq(commerceProviderKindLink.providerKind, commerceServiceOffering.providerKind),
        publicKindLinkEligibility,
      ),
    )
    .where(
      and(
        eq(commerceServiceOffering.slug, offeringSlug),
        eq(commerceServiceOffering.state, "active"),
        publicProviderEligibility,
      ),
    )
    .limit(1);
  if (!row) return { success: false, error: { type: "NOT_FOUND" } };

  const [detail, coverageRows] = await Promise.all([
    loadOfferingDetail(row.offering.id, row.offering.providerKind),
    db
      .select({
        originCountryCode: commerceServiceCoverage.originCountryCode,
        destinationCountryCode: commerceServiceCoverage.destinationCountryCode,
        originRegionLabel: commerceServiceCoverage.originRegionLabel,
        destinationRegionLabel: commerceServiceCoverage.destinationRegionLabel,
        locationIdentifier: commerceServiceCoverage.locationIdentifier,
        supportsHazardousGoods: commerceServiceCoverage.supportsHazardousGoods,
        supportsConsolidation: commerceServiceCoverage.supportsConsolidation,
      })
      .from(commerceServiceCoverage)
      .where(eq(commerceServiceCoverage.offeringId, row.offering.id))
      .orderBy(asc(commerceServiceCoverage.id)),
  ]);
  if (!detail) return { success: false, error: { type: "NOT_FOUND" } };

  const [provider] = await attachPublicProviderTrustMetrics([
    {
      organizationId: row.organizationId,
      slug: row.slug,
      displayName: row.displayName,
      countryCode: tradingOrganizationCountryCode(row.countryCode, row.organizationId),
      logoUrl: row.logoUrl,
      publicSummary: row.publicSummary,
      verificationState: row.verificationState,
      acceptingRequests: row.acceptingRequests,
      serviceRegionSummary: row.serviceRegionSummary,
      declaredResponseTimeHours: row.declaredResponseTimeHours,
    },
  ]);
  if (!provider) return { success: false, error: { type: "NOT_FOUND" } };

  return {
    success: true,
    value: {
      offering: { ...toPublicOfferingCard(row.offering), state: "active" },
      provider,
      detail,
      coverage: coverageRows,
    },
  };
}

/** Resolve eligible public offerings for merchandising placements. */
export async function resolveEligiblePublicOfferingsByIds(offeringIds: readonly string[]): Promise<
  readonly {
    readonly offering: PublicOfferingCard;
    readonly provider: PublicProviderCard;
  }[]
> {
  if (offeringIds.length === 0) return [];

  const rows = await db
    .select({
      offering: commerceServiceOffering,
      ...publicProviderSelect,
    })
    .from(commerceServiceOffering)
    .innerJoin(
      commerceProviderProfile,
      eq(commerceProviderProfile.organizationId, commerceServiceOffering.providerOrganizationId),
    )
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceServiceOffering.providerOrganizationId),
    )
    .innerJoin(
      commerceProviderKindLink,
      and(
        eq(commerceProviderKindLink.organizationId, commerceServiceOffering.providerOrganizationId),
        eq(commerceProviderKindLink.providerKind, commerceServiceOffering.providerKind),
        publicKindLinkEligibility,
      ),
    )
    .where(
      and(
        inArray(commerceServiceOffering.id, [...offeringIds]),
        eq(commerceServiceOffering.state, "active"),
        publicProviderEligibility,
      ),
    );

  const providers = await attachPublicProviderTrustMetrics(
    rows.map((row) => ({
      organizationId: row.organizationId,
      slug: row.slug,
      displayName: row.displayName,
      countryCode: tradingOrganizationCountryCode(row.countryCode, row.organizationId),
      logoUrl: row.logoUrl,
      publicSummary: row.publicSummary,
      verificationState: row.verificationState,
      acceptingRequests: row.acceptingRequests,
      serviceRegionSummary: row.serviceRegionSummary,
      declaredResponseTimeHours: row.declaredResponseTimeHours,
    })),
  );
  const providersByOrganizationId = new Map(
    providers.map((provider) => [provider.organizationId, provider]),
  );

  const byId = new Map(
    rows.flatMap((row) => {
      const provider = providersByOrganizationId.get(row.organizationId);
      if (!provider) return [];
      return [
        [
          row.offering.id,
          {
            offering: toPublicOfferingCard(row.offering),
            provider,
          },
        ] as const,
      ];
    }),
  );

  return offeringIds.flatMap((offeringId) => {
    const entry = byId.get(offeringId);
    return entry === undefined ? [] : [entry];
  });
}

export async function listMineOfferings(
  organizationId: string,
  memberRole: MemberRole,
): Promise<Result<readonly ServiceOffering[], CommerceProvidersError>> {
  const access = requireProviderRole(memberRole);
  if (!access.success) return access;

  const offerings = await db
    .select()
    .from(commerceServiceOffering)
    .where(eq(commerceServiceOffering.providerOrganizationId, organizationId))
    .orderBy(asc(commerceServiceOffering.createdAt), asc(commerceServiceOffering.id));

  return { success: true, value: offerings };
}
