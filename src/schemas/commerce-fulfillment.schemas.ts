import { z } from "zod";

const CountryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/);

const MinorUnitsSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9][0-9]{0,37})$/);

const FixedPointRateSchema = z
  .object({
    units: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{0,37}$/),
    scale: z.number().int().min(0).max(12),
  })
  .strict();

const CurrencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/);

export const ShipmentLegInputSchema = z
  .object({
    sequence: z.number().int().min(0),
    mode: z.enum(["air", "sea", "land", "rail"]),
    originCountryCode: CountryCodeSchema,
    originLocality: z.string().trim().min(1).max(150).optional(),
    originLocationIdentifier: z.string().trim().min(1).max(80).optional(),
    destinationCountryCode: CountryCodeSchema,
    destinationLocality: z.string().trim().min(1).max(150).optional(),
    destinationLocationIdentifier: z.string().trim().min(1).max(80).optional(),
    logisticsEngagementId: z.string().trim().min(1).max(200).optional(),
    estimatedDepartureAt: z.iso.datetime().optional(),
    estimatedArrivalAt: z.iso.datetime().optional(),
  })
  .strict();

export type ShipmentLegInput = z.infer<typeof ShipmentLegInputSchema>;

export const CreateShipmentWithLegsSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            orderProductLineId: z.string().trim().min(1).max(200),
            quantity: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    originCountryCode: CountryCodeSchema.optional(),
    originLocality: z.string().trim().min(1).max(150).optional(),
    destinationCountryCode: CountryCodeSchema.optional(),
    destinationLocality: z.string().trim().min(1).max(150).optional(),
    packageCount: z.number().int().positive(),
    totalWeightGrams: z.number().int().positive().optional(),
    legs: z.array(ShipmentLegInputSchema).max(50).optional(),
  })
  .strict();

export type CreateShipmentWithLegsInput = z.infer<typeof CreateShipmentWithLegsSchema>;

export const ShipmentLegCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("book"),
      expectedVersion: z.number().int().min(0),
      carrierReference: z.string().trim().min(1).max(200).optional(),
      trackingReference: z.string().trim().min(1).max(200).optional(),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("depart"),
      expectedVersion: z.number().int().min(0),
      departedAt: z.iso.datetime().optional(),
      locationIdentifier: z.string().trim().min(1).max(80).optional(),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("arrive"),
      expectedVersion: z.number().int().min(0),
      arrivedAt: z.iso.datetime().optional(),
      locationIdentifier: z.string().trim().min(1).max(80).optional(),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("complete"),
      expectedVersion: z.number().int().min(0),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("report_exception"),
      expectedVersion: z.number().int().min(0),
      description: z.string().trim().min(1).max(2000),
      locationIdentifier: z.string().trim().min(1).max(80).optional(),
      evidenceDocumentId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("cancel"),
      expectedVersion: z.number().int().min(0),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
]);

export type ShipmentLegCommand = z.infer<typeof ShipmentLegCommandSchema>;

const DeliverablePlanSchema = z
  .object({
    sequence: z.number().int().min(0),
    title: z.string().trim().min(1).max(200),
    isRequired: z.boolean().default(true),
    dueAt: z.iso.datetime().optional(),
  })
  .strict();

const CustomsDetailSchema = z
  .object({
    kind: z.literal("customs_broker"),
    jurisdictions: z.array(z.string().trim().min(1).max(80)).max(50),
    filingSummary: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

const InsuranceDetailSchema = z
  .object({
    kind: z.literal("insurance_provider"),
    coverageClasses: z.array(z.string().trim().min(1).max(80)).max(50),
    coverageLimitMinorUnits: MinorUnitsSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
  })
  .strict();

const InspectionDetailSchema = z
  .object({
    kind: z.literal("inspection_agency"),
    includedStages: z.array(z.string().trim().min(1).max(80)).max(50),
  })
  .strict();

const TestingDetailSchema = z
  .object({
    kind: z.literal("testing_certification_lab"),
    standards: z.array(z.string().trim().min(1).max(120)).max(50),
    laboratoryLocation: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const MarketingDetailSchema = z
  .object({
    kind: z.literal("marketing_agency"),
    channels: z.array(z.string().trim().min(1).max(80)).max(50),
    deliverablesSummary: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

const WarehouseDetailSchema = z
  .object({
    kind: z.literal("warehouse_provider"),
    storageTypes: z.array(z.string().trim().min(1).max(80)).max(50),
    capacityUnits: z.string().trim().min(1).max(80).optional(),
    temperatureControlled: z.boolean(),
  })
  .strict();

const FxDetailSchema = z
  .object({
    kind: z.literal("foreign_exchange_facilitator"),
    currencyPair: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}\/[A-Z]{3}$/),
    rate: FixedPointRateSchema,
    settlementRail: z.string().trim().min(1).max(80).optional(),
    notionalAmountMinorUnits: MinorUnitsSchema.optional(),
    notionalCurrency: CurrencyCodeSchema.optional(),
  })
  .strict();

const FreightDetailSchema = z
  .object({
    kind: z.enum(["freight_forwarder", "logistics_operator"]),
    transportModes: z.array(z.enum(["air", "sea", "land", "rail", "multimodal"])).max(5),
    originCountryCode: CountryCodeSchema.optional(),
    destinationCountryCode: CountryCodeSchema.optional(),
    estimatedTransitDays: z.number().int().min(0).optional(),
  })
  .strict();

export const EngagementExecutionDetailSchema = z.discriminatedUnion("kind", [
  FreightDetailSchema,
  CustomsDetailSchema,
  InsuranceDetailSchema,
  InspectionDetailSchema,
  TestingDetailSchema,
  MarketingDetailSchema,
  WarehouseDetailSchema,
  FxDetailSchema,
]);

const CustomsDeliverableResultSchema = z
  .object({
    kind: z.literal("customs_broker"),
    filingKind: z.string().trim().min(1).max(80),
    jurisdiction: z.string().trim().min(1).max(80),
    providerFilingReference: z.string().trim().min(1).max(200).optional(),
    declarationReference: z.string().trim().min(1).max(200).optional(),
    decision: z.enum(["cleared", "rejected", "pending"]).optional(),
  })
  .strict();

const InsuranceDeliverableResultSchema = z
  .object({
    kind: z.literal("insurance_provider"),
    policyReference: z.string().trim().min(1).max(200),
    coverageClass: z.string().trim().min(1).max(80),
    insuredValueMinorUnits: MinorUnitsSchema.optional(),
    coverageLimitMinorUnits: MinorUnitsSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
    effectiveFrom: z.iso.datetime().optional(),
    effectiveTo: z.iso.datetime().optional(),
  })
  .strict();

const InspectionDeliverableResultSchema = z
  .object({
    kind: z.literal("inspection_agency"),
    stage: z.string().trim().min(1).max(80),
    result: z.enum(["passed", "conditional", "failed"]),
    findingsSummary: z.string().trim().min(1).max(4000).optional(),
    inspectedQuantity: z.number().int().positive().optional(),
    inspectedAt: z.iso.datetime().optional(),
  })
  .strict();

const TestingDeliverableResultSchema = z
  .object({
    kind: z.literal("testing_certification_lab"),
    standard: z.string().trim().min(1).max(120),
    specimenReference: z.string().trim().min(1).max(200).optional(),
    result: z.enum(["passed", "failed", "inconclusive"]),
    laboratoryLocation: z.string().trim().min(1).max(200).optional(),
    reportedAt: z.iso.datetime().optional(),
  })
  .strict();

const WarehouseDeliverableResultSchema = z
  .object({
    kind: z.literal("warehouse_provider"),
    movementKind: z.enum(["receipt", "putaway", "pick", "release", "adjustment"]),
    quantityUnits: MinorUnitsSchema,
    quantityScale: z.number().int().min(0).max(12),
    unitLabel: z.string().trim().min(1).max(40),
    facilityIdentifier: z.string().trim().min(1).max(120).optional(),
    occurredAt: z.iso.datetime().optional(),
  })
  .strict();

const MarketingDeliverableResultSchema = z
  .object({
    kind: z.literal("marketing_agency"),
    deliverableKind: z.string().trim().min(1).max(80),
    channel: z.string().trim().min(1).max(80),
    artifactUrl: z.string().trim().url().max(2000).optional(),
    metricsSummary: z.string().trim().min(1).max(4000).optional(),
    publishedAt: z.iso.datetime().optional(),
  })
  .strict();

const FxDeliverableResultSchema = z
  .object({
    kind: z.literal("foreign_exchange_facilitator"),
    currencyPair: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}\/[A-Z]{3}$/),
    rate: FixedPointRateSchema,
    sellAmountMinorUnits: MinorUnitsSchema,
    buyAmountMinorUnits: MinorUnitsSchema,
    sellCurrency: CurrencyCodeSchema,
    buyCurrency: CurrencyCodeSchema,
    providerExecutionReference: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const FreightDeliverableResultSchema = z
  .object({
    kind: z.enum(["freight_forwarder", "logistics_operator"]),
    summary: z.string().trim().min(1).max(2000),
  })
  .strict();

export const TypedDeliverableResultSchema = z.discriminatedUnion("kind", [
  FreightDeliverableResultSchema,
  CustomsDeliverableResultSchema,
  InsuranceDeliverableResultSchema,
  InspectionDeliverableResultSchema,
  TestingDeliverableResultSchema,
  WarehouseDeliverableResultSchema,
  MarketingDeliverableResultSchema,
  FxDeliverableResultSchema,
]);

export const ServiceEngagementCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("initialize"),
      expectedVersion: z.number().int().min(0),
      details: EngagementExecutionDetailSchema,
      deliverables: z.array(DeliverablePlanSchema).max(50).default([]),
    })
    .strict(),
  z
    .object({
      command: z.literal("schedule"),
      expectedVersion: z.number().int().min(0),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("start"),
      expectedVersion: z.number().int().min(0),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("request_buyer_action"),
      expectedVersion: z.number().int().min(0),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("submit_deliverable"),
      expectedVersion: z.number().int().min(0),
      deliverableId: z.string().trim().min(1).max(200),
      result: TypedDeliverableResultSchema,
      evidenceDocumentId: z.string().trim().min(1).max(200).optional(),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("accept_deliverable"),
      expectedVersion: z.number().int().min(0),
      deliverableId: z.string().trim().min(1).max(200),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("reject_deliverable"),
      expectedVersion: z.number().int().min(0),
      deliverableId: z.string().trim().min(1).max(200),
      note: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      command: z.literal("waive_deliverable"),
      expectedVersion: z.number().int().min(0),
      deliverableId: z.string().trim().min(1).max(200),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("complete"),
      expectedVersion: z.number().int().min(0),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal("cancel"),
      expectedVersion: z.number().int().min(0),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
]);

export type ServiceEngagementCommand = z.infer<typeof ServiceEngagementCommandSchema>;
