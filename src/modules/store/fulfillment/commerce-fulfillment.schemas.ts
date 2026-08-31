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

/**
 * `POST /commerce/shipments/:shipmentId/legs` — add legs to a shipment that already exists.
 *
 * WHY THIS ROUTE EXISTS AT ALL. Until now `legs` could be declared ONLY on
 * `CreateShipmentWithLegsSchema` above, so a shipment created before its route was known could
 * never grow one, and a seller who booked a forwarder afterwards had nowhere to record it.
 *
 * SAME `ShipmentLegInputSchema`, SAME CEILING. Reusing the leg schema is what keeps one leg shape
 * across both entry points; a second one would drift on the first field either side added. The
 * `.max(50)` matches the create route rather than being a fresh opinion about how many legs a
 * journey may have.
 *
 * `.min(1)` because an empty array is not a request — `insertShipmentLegs` short-circuits on it and
 * would answer 201 having done nothing, which reads as success to a client that sent a broken body.
 */
export const AddShipmentLegsSchema = z
  .object({
    legs: z.array(ShipmentLegInputSchema).min(1).max(50),
  })
  .strict();

export type AddShipmentLegsInput = z.infer<typeof AddShipmentLegsSchema>;

/**
 * `POST /commerce/shipment-legs/:legId/assignment` — who is carrying this leg.
 *
 * ⚠️ **`null` IS AN EXPLICIT DETACH AND IS THE REASON THIS IS A ROUTE.** `logisticsEngagementId`
 * decides which organization may command the leg: `executeShipmentLegCommand` hands authority to
 * the assigned provider and keeps it with the counterparty otherwise. Without a way to send `null`,
 * attaching an engagement would be a one-way door the seller could not undo.
 *
 * `.nullable()` NOT `.optional()`. An absent key and an explicit `null` would mean the same thing
 * to `.strip()`, but this schema is `.strict()` and the difference is the whole point: the caller
 * must SAY which of attach or detach they mean, because there is no third option and no default.
 *
 * `expectedVersion` for the same reason every leg command carries one — assignment mutates the row
 * and bumps its version, so a concurrent `book` must lose rather than silently interleave.
 */
export const ShipmentLegAssignmentSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    logisticsEngagementId: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

export type ShipmentLegAssignmentInput = z.infer<typeof ShipmentLegAssignmentSchema>;

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

const DeliverablePlanListSchema = z
  .array(DeliverablePlanSchema)
  .max(50)
  .default([])
  .superRefine((deliverables, refinementContext) => {
    const seenSequences = new Set<number>();
    for (const [deliverableIndex, deliverable] of deliverables.entries()) {
      if (seenSequences.has(deliverable.sequence)) {
        refinementContext.addIssue({
          code: "custom",
          message: "Deliverable sequences must be unique.",
          path: [deliverableIndex, "sequence"],
        });
      }
      seenSequences.add(deliverable.sequence);
    }
  });

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

export const EngagementExecutionDetailSchema = z
  .discriminatedUnion("kind", [
    FreightDetailSchema,
    CustomsDetailSchema,
    InsuranceDetailSchema,
    InspectionDetailSchema,
    TestingDetailSchema,
    MarketingDetailSchema,
    WarehouseDetailSchema,
    FxDetailSchema,
  ])
  .superRefine((details, refinementContext) => {
    if (details.kind === "insurance_provider") {
      const hasCoverageLimit = details.coverageLimitMinorUnits !== undefined;
      const hasCurrency = details.currency !== undefined;
      if (hasCoverageLimit !== hasCurrency) {
        refinementContext.addIssue({
          code: "custom",
          message: "coverageLimitMinorUnits and currency must be provided together.",
          path: hasCoverageLimit ? ["currency"] : ["coverageLimitMinorUnits"],
        });
      }
    }

    if (details.kind === "foreign_exchange_facilitator") {
      const hasNotionalAmount = details.notionalAmountMinorUnits !== undefined;
      const hasNotionalCurrency = details.notionalCurrency !== undefined;
      if (hasNotionalAmount !== hasNotionalCurrency) {
        refinementContext.addIssue({
          code: "custom",
          message: "notionalAmountMinorUnits and notionalCurrency must be provided together.",
          path: hasNotionalAmount ? ["notionalCurrency"] : ["notionalAmountMinorUnits"],
        });
      }
    }
  });

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

export const TypedDeliverableResultSchema = z
  .discriminatedUnion("kind", [
    FreightDeliverableResultSchema,
    CustomsDeliverableResultSchema,
    InsuranceDeliverableResultSchema,
    InspectionDeliverableResultSchema,
    TestingDeliverableResultSchema,
    WarehouseDeliverableResultSchema,
    MarketingDeliverableResultSchema,
    FxDeliverableResultSchema,
  ])
  .superRefine((result, refinementContext) => {
    if (result.kind !== "insurance_provider") return;

    const hasInsuredValue = result.insuredValueMinorUnits !== undefined;
    const hasCoverageLimit = result.coverageLimitMinorUnits !== undefined;
    const hasCurrency = result.currency !== undefined;
    if ((hasInsuredValue || hasCoverageLimit) !== hasCurrency) {
      refinementContext.addIssue({
        code: "custom",
        message: "currency is required exactly when an insurance amount is provided.",
        path: ["currency"],
      });
    }
  });

export const ServiceEngagementCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("initialize"),
      expectedVersion: z.number().int().min(0),
      details: EngagementExecutionDetailSchema,
      deliverables: DeliverablePlanListSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal("normalize_deliverables"),
      expectedVersion: z.number().int().min(0),
      deliverables: DeliverablePlanListSchema.refine(
        (deliverables) => deliverables.length > 0,
        "At least one structured deliverable is required to clear a free-text obligation.",
      ),
      note: z.string().trim().min(1).max(2000).optional(),
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

export const EmptyObjectSchema = z.object({}).strict();

export const OrderIdParamsSchema = z
  .object({ orderId: z.string().trim().min(1).max(200) })
  .strict();

export const ShipmentIdParamsSchema = z
  .object({ shipmentId: z.string().trim().min(1).max(200) })
  .strict();

export const LegIdParamsSchema = z.object({ legId: z.string().trim().min(1).max(200) }).strict();

export const EngagementIdParamsSchema = z
  .object({ engagementId: z.string().trim().min(1).max(200) })
  .strict();

export const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * `role` picks WHICH SIDE of the engagement the caller is listing; `state` narrows within it.
 *
 * `state` matches the shape `ListShipmentsQuerySchema` below already has, and for the same reason:
 * these lists are worked as queues — "what is awaiting me", "what is still running" — and without
 * a server-side filter the client's only options are a 422 against this `.strict()` schema or
 * filtering the fetched page, which short-pages the result.
 *
 * All seven states are filterable, `disputed` included: an engagement in dispute is precisely the
 * one an operator goes looking for.
 */
export const ListServiceEngagementsQuerySchema = ListQuerySchema.extend({
  role: z.enum(["buyer", "provider"]).optional(),
  state: z
    .enum([
      "awaiting_provider",
      "scheduled",
      "in_progress",
      "awaiting_buyer",
      "completed",
      "cancelled",
      "disputed",
    ])
    .optional(),
}).strict();

export const ListShipmentsQuerySchema = ListQuerySchema.extend({
  state: z.enum(["planned", "in_transit", "delivered", "cancelled"]).optional(),
  estimatedArrivalFrom: z.coerce.date().optional(),
  estimatedArrivalTo: z.coerce.date().optional(),
}).strict();

export const AppendShipmentEventSchema = z
  .object({
    eventKind: z.enum(["picked_up", "in_transit", "delivered", "exception", "cancelled"]),
    occurredAt: z.iso.datetime().optional(),
    description: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const TransitionServiceEngagementSchema = z
  .object({
    targetState: z.enum(["scheduled", "in_progress", "awaiting_buyer", "completed", "cancelled"]),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
