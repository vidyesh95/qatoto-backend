/**
 * Request schemas for commerce-providers, extracted from commerce-providers.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

export const ProviderKindSchema = z.enum([
  "freight_forwarder",
  "logistics_operator",
  "customs_broker",
  "insurance_provider",
  "inspection_agency",
  "testing_certification_lab",
  "marketing_agency",
  "warehouse_provider",
  "foreign_exchange_facilitator",
]);

export const UpsertProfileSchema = z
  .object({
    publicSummary: z.string().trim().max(4000).optional(),
    supportPolicy: z.string().trim().max(4000).optional(),
    acceptingRequests: z.boolean().optional(),
    serviceRegionSummary: z.string().trim().max(1000).optional(),
  })
  .strict();

export const AddKindLinkSchema = z.object({ providerKind: ProviderKindSchema }).strict();

export const FreightDetailSchema = z
  .object({
    kind: z.enum(["freight_forwarder", "logistics_operator"]),
    transportModes: z
      .array(z.enum(["air", "sea", "land", "rail", "multimodal"]))
      .min(1)
      .max(5),
    supportsConsolidation: z.boolean(),
    supportsContainers: z.boolean(),
    supportsHazardousGoods: z.boolean(),
  })
  .strict();

export const CustomsDetailSchema = z
  .object({
    kind: z.literal("customs_broker"),
    jurisdictions: z.array(z.string().trim().min(1).max(80)).max(50),
    importSupported: z.boolean(),
    exportSupported: z.boolean(),
    commodityCoverageSummary: z.string().trim().max(2000).optional(),
  })
  .strict();

export const InsuranceDetailSchema = z
  .object({
    kind: z.literal("insurance_provider"),
    cargoCoverageClasses: z.array(z.string().trim().min(1).max(80)).max(50),
    coverageLimitMinInCents: z.number().int().min(0).optional(),
    coverageLimitMaxInCents: z.number().int().min(0).optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    exclusionsDocumentReference: z.string().trim().max(200).optional(),
  })
  .strict();

export const InspectionDetailSchema = z
  .object({
    kind: z.literal("inspection_agency"),
    preProduction: z.boolean(),
    duringProduction: z.boolean(),
    preShipment: z.boolean(),
    loadingSupervision: z.boolean(),
  })
  .strict();

export const TestingDetailSchema = z
  .object({
    kind: z.literal("testing_certification_lab"),
    standards: z.array(z.string().trim().min(1).max(120)).max(50),
    accreditationBodies: z.array(z.string().trim().min(1).max(120)).max(50),
    laboratoryLocations: z.array(z.string().trim().min(1).max(120)).max(50),
  })
  .strict();

export const MarketingDetailSchema = z
  .object({
    kind: z.literal("marketing_agency"),
    channels: z.array(z.string().trim().min(1).max(80)).max(50),
    targetRegions: z.array(z.string().trim().min(1).max(80)).max(50),
    languageCapabilities: z.array(z.string().trim().min(1).max(40)).max(50),
    engagementModel: z.string().trim().max(200).optional(),
  })
  .strict();

export const WarehouseDetailSchema = z
  .object({
    kind: z.literal("warehouse_provider"),
    storageTypes: z.array(z.string().trim().min(1).max(80)).max(50),
    temperatureControlled: z.boolean(),
    bondedStatus: z.boolean(),
    capacityUnits: z.string().trim().max(80).optional(),
  })
  .strict();

export const FxDetailSchema = z
  .object({
    kind: z.literal("foreign_exchange_facilitator"),
    currencyPairs: z.array(z.string().trim().min(1).max(20)).max(100),
    settlementRails: z.array(z.string().trim().min(1).max(80)).max(50),
    minimumNotionalInCents: z.number().int().min(0).optional(),
    maximumNotionalInCents: z.number().int().min(0).optional(),
    notionalCurrency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();

export const OfferingDetailSchema = z.discriminatedUnion("kind", [
  FreightDetailSchema,
  CustomsDetailSchema,
  InsuranceDetailSchema,
  InspectionDetailSchema,
  TestingDetailSchema,
  MarketingDetailSchema,
  WarehouseDetailSchema,
  FxDetailSchema,
]);

export const CreateOfferingSchema = z
  .object({
    providerKind: ProviderKindSchema,
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(4000).optional(),
    pricingModel: z.enum(["quote_only", "fixed_fee", "per_unit", "subscription"]),
    indicativePriceMinInCents: z.number().int().min(0).optional(),
    indicativePriceMaxInCents: z.number().int().min(0).optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    minimumLeadTimeDays: z.number().int().min(0).max(3650).optional(),
    maximumLeadTimeDays: z.number().int().min(0).max(3650).optional(),
    detail: OfferingDetailSchema,
  })
  .strict()
  .refine((value) => value.detail.kind === value.providerKind, {
    error: "detail.kind must match providerKind.",
    path: ["detail", "kind"],
  });

export const UpdateOfferingSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(4000).nullable().optional(),
    pricingModel: z.enum(["quote_only", "fixed_fee", "per_unit", "subscription"]).optional(),
    indicativePriceMinInCents: z.number().int().min(0).nullable().optional(),
    indicativePriceMaxInCents: z.number().int().min(0).nullable().optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    minimumLeadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
    maximumLeadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  })
  .strict();

export const CoverageSchema = z
  .object({
    originCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    destinationCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    originRegionLabel: z.string().trim().max(120).optional(),
    destinationRegionLabel: z.string().trim().max(120).optional(),
    locationIdentifier: z.string().trim().max(120).optional(),
    supportsHazardousGoods: z.boolean().default(false),
    supportsConsolidation: z.boolean().default(false),
  })
  .strict();

export const SetCoverageSchema = z
  .object({
    coverages: z.array(CoverageSchema).max(50),
  })
  .strict();

export const OfferingParamsSchema = z
  .object({ offeringId: z.string().trim().min(1).max(200) })
  .strict();

export const ProductParamsSchema = z
  .object({ productId: z.string().trim().min(1).max(200) })
  .strict();

export const SupplierParamsSchema = z
  .object({ supplierId: z.string().trim().min(1).max(200) })
  .strict();

export const RouteOrganizationIdSchema = z.string().trim().min(1).max(200);

export const ModerateOfferingSchema = z
  .object({
    decision: z.enum(["approve", "reject", "suspend"]),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

export const ModerateProductSchema = z
  .object({
    moderationState: z.enum(["approved", "rejected", "suspended"]),
  })
  .strict();

export const LinkSupplierSchema = z
  .object({
    commerceOrganizationId: z.string().trim().min(1).max(200),
  })
  .strict();
