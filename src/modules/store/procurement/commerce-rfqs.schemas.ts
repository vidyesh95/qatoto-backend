/**
 * Request schemas for commerce-rfqs, extracted from commerce-rfqs.controller.ts.
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

export const TransportModeSchema = z.enum(["air", "sea", "land", "rail", "multimodal"]);

export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

export const FreightRequirementFields = {
  transportModes: z.array(TransportModeSchema).min(1).max(5),
  originCountryCode: CountryCodeSchema.nullable().optional(),
  destinationCountryCode: CountryCodeSchema.nullable().optional(),
  requiresConsolidation: z.boolean().optional(),
  requiresHazardousGoodsSupport: z.boolean().optional(),
  cargoDescription: z.string().trim().max(4000).nullable().optional(),
} as const;

export const FreightForwarderRequirementDetailSchema = z
  .object({
    providerKind: z.literal("freight_forwarder"),
    ...FreightRequirementFields,
  })
  .strict();

export const LogisticsOperatorRequirementDetailSchema = z
  .object({
    providerKind: z.literal("logistics_operator"),
    ...FreightRequirementFields,
  })
  .strict();

export const CustomsRequirementDetailSchema = z
  .object({
    providerKind: z.literal("customs_broker"),
    jurisdictions: z.array(z.string().trim().min(1).max(80)).max(50),
    importRequired: z.boolean().optional(),
    exportRequired: z.boolean().optional(),
    commoditySummary: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const InsuranceRequirementDetailSchema = z
  .object({
    providerKind: z.literal("insurance_provider"),
    cargoCoverageClasses: z.array(z.string().trim().min(1).max(80)).max(50),
    coverageLimitInCents: z.number().int().min(0).nullable().optional(),
    currency: CurrencyCodeSchema.optional(),
  })
  .strict();

export const InspectionRequirementDetailSchema = z
  .object({
    providerKind: z.literal("inspection_agency"),
    preProduction: z.boolean().optional(),
    duringProduction: z.boolean().optional(),
    preShipment: z.boolean().optional(),
    loadingSupervision: z.boolean().optional(),
  })
  .strict();

export const TestingRequirementDetailSchema = z
  .object({
    providerKind: z.literal("testing_certification_lab"),
    standards: z.array(z.string().trim().min(1).max(120)).max(50),
    laboratoryLocationPreference: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const MarketingRequirementDetailSchema = z
  .object({
    providerKind: z.literal("marketing_agency"),
    channels: z.array(z.string().trim().min(1).max(80)).max(50),
    targetRegions: z.array(z.string().trim().min(1).max(80)).max(50),
    languageCapabilities: z.array(z.string().trim().min(1).max(40)).max(50),
  })
  .strict();

export const WarehouseRequirementDetailSchema = z
  .object({
    providerKind: z.literal("warehouse_provider"),
    storageTypes: z.array(z.string().trim().min(1).max(80)).max(50),
    temperatureControlled: z.boolean().optional(),
    bondedStatusRequired: z.boolean().optional(),
    capacityUnits: z.string().trim().max(80).nullable().optional(),
  })
  .strict();

export const ForeignExchangeRequirementDetailSchema = z
  .object({
    providerKind: z.literal("foreign_exchange_facilitator"),
    currencyPairs: z.array(z.string().trim().min(1).max(20)).max(100),
    settlementRails: z.array(z.string().trim().min(1).max(80)).max(50),
    notionalAmountInCents: z.number().int().min(0).nullable().optional(),
    notionalCurrency: CurrencyCodeSchema.optional(),
  })
  .strict();

export const RequirementDetailSchema = z.discriminatedUnion("providerKind", [
  FreightForwarderRequirementDetailSchema,
  LogisticsOperatorRequirementDetailSchema,
  CustomsRequirementDetailSchema,
  InsuranceRequirementDetailSchema,
  InspectionRequirementDetailSchema,
  TestingRequirementDetailSchema,
  MarketingRequirementDetailSchema,
  WarehouseRequirementDetailSchema,
  ForeignExchangeRequirementDetailSchema,
]);

export const ProductLineSchema = z
  .object({
    productId: z.string().trim().min(1).max(200).optional(),
    categoryId: z.string().trim().min(1).max(200).optional(),
    requestedTitle: z.string().trim().min(1).max(200),
    requestedSpecificationSnapshot: z.string().trim().min(1).max(10_000),
    quantity: z.number().int().positive(),
    unitLabel: z.string().trim().min(1).max(40),
    siblingOrder: z.number().int().min(0),
  })
  .strict();

export const ServiceLineSchema = z
  .object({
    providerKind: ProviderKindSchema,
    serviceOfferingId: z.string().trim().min(1).max(200).optional(),
    linkedProductLineSiblingOrder: z.number().int().min(0).optional(),
    requirementSummary: z.string().trim().min(1).max(4000),
    siblingOrder: z.number().int().min(0),
    requirementDetail: RequirementDetailSchema,
  })
  .strict()
  .refine(
    (serviceLine) => serviceLine.requirementDetail.providerKind === serviceLine.providerKind,
    {
      message: "requirementDetail.providerKind must match providerKind.",
      path: ["requirementDetail", "providerKind"],
    },
  );

export const CreateDraftRfqSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    visibility: z.enum(["invited_only", "matched_providers"]),
    responseDeadlineAt: z.iso.datetime(),
    desiredDeliveryStartsAt: z.iso.datetime().optional(),
    desiredDeliveryEndsAt: z.iso.datetime().optional(),
    destinationAddressId: z.string().uuid().optional(),
    destinationCountryCode: CountryCodeSchema.optional(),
    destinationLocality: z.string().trim().min(1).max(150).optional(),
    settlementCurrency: CurrencyCodeSchema,
    productLines: z.array(ProductLineSchema).max(100).default([]),
    serviceLines: z.array(ServiceLineSchema).max(100).default([]),
    documentIds: z.array(z.string().uuid()).max(50).optional(),
    /**
     * A14. Records that this RFQ grew out of a pre-sales inquiry.
     *
     * A POINTER, not a merge. The RFQ gets its own thread as it always has and the
     * inquiry keeps its own — folding a one-to-one pre-sales chat into an RFQ thread
     * would expose one seller's conversation to every competing bidder, because an RFQ
     * thread contains every invited provider.
     *
     * An id belonging to another buyer simply does not match and is ignored rather
     * than accepted, so this cannot be used to probe other organizations' inquiries.
     */
    sourceInquiryId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (body) =>
      (body.desiredDeliveryStartsAt === undefined) === (body.desiredDeliveryEndsAt === undefined),
    {
      message: "desiredDeliveryStartsAt and desiredDeliveryEndsAt must be set together.",
      path: ["desiredDeliveryEndsAt"],
    },
  );

export const UpdateDraftRfqSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    visibility: z.enum(["invited_only", "matched_providers"]).optional(),
    responseDeadlineAt: z.iso.datetime().optional(),
    desiredDeliveryStartsAt: z.iso.datetime().nullable().optional(),
    desiredDeliveryEndsAt: z.iso.datetime().nullable().optional(),
    destinationAddressId: z.string().uuid().nullable().optional(),
    destinationCountryCode: CountryCodeSchema.nullable().optional(),
    destinationLocality: z.string().trim().min(1).max(150).nullable().optional(),
    settlementCurrency: CurrencyCodeSchema.optional(),
    productLines: z.array(ProductLineSchema).max(100).optional(),
    serviceLines: z.array(ServiceLineSchema).max(100).optional(),
    documentIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.");

export const InviteProvidersSchema = z
  .object({
    providerOrganizationIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  })
  .strict();

export const RfqIdParamsSchema = z.object({ rfqId: z.string().uuid() }).strict();

export const EmptyObjectSchema = z.object({}).strict();

export const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

/**
 * The RFQ list filter, for both `/rfqs/mine` and `/provider/rfqs`.
 *
 * `state` IS APPLIED IN SQL, and it exists because the surfaces that read these lists are
 * state-organised: a buyer's RFQ page separates drafts from open requests from closed ones, and a
 * provider's queue is only ever interested in what is still open. Without the key the client's
 * options are a 422 (this schema is `.strict()`) or filtering the fetched page, which silently
 * short-pages every result — so the filter has to live here or the tabs cannot exist.
 *
 * OMITTING IT MEANS EVERY STATE, not a default. A buyer's drafts are theirs to see and there is no
 * state this list should hide from the organization that owns it; the provider list's own
 * visibility predicate already restricts what a provider may see, and `state` narrows within that
 * rather than widening it.
 */
export const ListQuerySchema = z
  .object({
    state: z.enum(["draft", "open", "closed", "awarded", "cancelled", "expired"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
