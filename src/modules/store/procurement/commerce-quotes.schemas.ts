/**
 * Request schemas for commerce-quotes, extracted from commerce-quotes.controller.ts.
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

export const EmptyObjectSchema = z.object({}).strict();

export const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

export const RfqIdParamsSchema = z.object({ rfqId: z.string().trim().min(1).max(200) }).strict();

/**
 * A38. `status` is the full `commerce_quote_status` enum, `draft` included — this is the
 * provider's own work and the only list that yields a draft's id.
 */
export const ListProviderQuotesQuerySchema = z
  .object({
    status: z
      .enum(["draft", "submitted", "superseded", "accepted", "declined", "withdrawn", "expired"])
      .optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/**
 * `GET /commerce/sourcing/quote-lines` — A44. No filters beyond paging.
 *
 * NO `status` FILTER, unlike the provider queue above: this read returns ONLY lines on accepted
 * revisions by construction, so every other status is already excluded. A filter admitting them
 * would offer a seller a line the listing save then refuses.
 */
export const ListSourcingQuoteLinesQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const QuoteIdParamsSchema = z
  .object({ quoteId: z.string().trim().min(1).max(200) })
  .strict();

export const QuoteRevisionParamsSchema = z
  .object({
    quoteId: z.string().trim().min(1).max(200),
    revision: z.coerce.number().int().positive(),
  })
  .strict();

export const CurrencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/);

export const CountryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/);

export const NonNegativeCentsSchema = z.number().int().min(0);

export const FreightQuoteDetailSchema = z
  .object({
    kind: z.enum(["freight_forwarder", "logistics_operator"]),
    transportModes: z
      .array(z.enum(["air", "sea", "land", "rail", "multimodal"]))
      .min(1)
      .max(5),
    originCountryCode: CountryCodeSchema.optional(),
    destinationCountryCode: CountryCodeSchema.optional(),
    estimatedTransitDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict();

export const CustomsQuoteDetailSchema = z
  .object({
    kind: z.literal("customs_broker"),
    jurisdictions: z.array(z.string().trim().min(1).max(80)).max(50),
    filingSummary: z.string().trim().max(4000).optional(),
  })
  .strict();

export const InsuranceQuoteDetailSchema = z
  .object({
    kind: z.literal("insurance_provider"),
    coverageClasses: z.array(z.string().trim().min(1).max(80)).max(50),
    coverageLimitInCents: z.number().int().min(0).optional(),
    currency: CurrencyCodeSchema.optional(),
  })
  .strict();

export const InspectionQuoteDetailSchema = z
  .object({
    kind: z.literal("inspection_agency"),
    includedStages: z.array(z.string().trim().min(1).max(80)).max(20),
  })
  .strict();

export const TestingQuoteDetailSchema = z
  .object({
    kind: z.literal("testing_certification_lab"),
    standards: z.array(z.string().trim().min(1).max(120)).max(50),
    laboratoryLocation: z.string().trim().max(200).optional(),
  })
  .strict();

export const MarketingQuoteDetailSchema = z
  .object({
    kind: z.literal("marketing_agency"),
    channels: z.array(z.string().trim().min(1).max(80)).max(50),
    deliverablesSummary: z.string().trim().max(4000).optional(),
  })
  .strict();

export const WarehouseQuoteDetailSchema = z
  .object({
    kind: z.literal("warehouse_provider"),
    storageTypes: z.array(z.string().trim().min(1).max(80)).max(50),
    capacityUnits: z.string().trim().max(80).optional(),
    temperatureControlled: z.boolean(),
  })
  .strict();

export const FxQuoteDetailSchema = z
  .object({
    kind: z.literal("foreign_exchange_facilitator"),
    currencyPair: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}\/[A-Z]{3}$/),
    rateFixedPoint: z.number().int().positive(),
    rateScale: z.number().int().min(0).max(12),
    settlementRail: z.string().trim().max(80).optional(),
    notionalAmountInCents: z.number().int().min(0).optional(),
    notionalCurrency: CurrencyCodeSchema.optional(),
  })
  .strict();

export const QuoteServiceDetailSchema = z
  .discriminatedUnion("kind", [
    FreightQuoteDetailSchema,
    CustomsQuoteDetailSchema,
    InsuranceQuoteDetailSchema,
    InspectionQuoteDetailSchema,
    TestingQuoteDetailSchema,
    MarketingQuoteDetailSchema,
    WarehouseQuoteDetailSchema,
    FxQuoteDetailSchema,
  ])
  .superRefine((details, refinementContext) => {
    if (details.kind === "insurance_provider") {
      const hasCoverageLimit = details.coverageLimitInCents !== undefined;
      const hasCurrency = details.currency !== undefined;
      if (hasCoverageLimit !== hasCurrency) {
        refinementContext.addIssue({
          code: "custom",
          message: "coverageLimitInCents and currency must be provided together.",
          path: hasCoverageLimit ? ["currency"] : ["coverageLimitInCents"],
        });
      }
    }

    if (details.kind === "foreign_exchange_facilitator") {
      const hasNotionalAmount = details.notionalAmountInCents !== undefined;
      const hasNotionalCurrency = details.notionalCurrency !== undefined;
      if (hasNotionalAmount !== hasNotionalCurrency) {
        refinementContext.addIssue({
          code: "custom",
          message: "notionalAmountInCents and notionalCurrency must be provided together.",
          path: hasNotionalAmount ? ["notionalCurrency"] : ["notionalAmountInCents"],
        });
      }
    }
  });

export const QuoteDeliverablePlanSchema = z
  .array(
    z
      .object({
        sequence: z.number().int().min(0),
        title: z.string().trim().min(1).max(200),
        isRequired: z.boolean().default(true),
        dueAt: z.coerce.date().optional(),
      })
      .strict(),
  )
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

export const QuoteProductLineSchema = z
  .object({
    rfqProductLineId: z.string().trim().min(1).max(200),
    quantity: z.number().int().positive(),
    unitPriceInCents: NonNegativeCentsSchema,
    titleSnapshot: z.string().trim().min(1).max(200),
    specificationSnapshot: z.string().trim().min(1).max(10_000),
    leadTimeDays: z.number().int().min(0).max(3650).optional(),
    exclusionsSnapshot: z.string().trim().max(10_000).optional(),
    siblingOrder: z.number().int().min(0),
  })
  .strict();

export const QuoteServiceLineSchema = z
  .object({
    rfqServiceLineId: z.string().trim().min(1).max(200),
    feeInCents: NonNegativeCentsSchema,
    titleSnapshot: z.string().trim().min(1).max(200),
    scopeSnapshot: z.string().trim().min(1).max(10_000),
    leadTimeDays: z.number().int().min(0).max(3650).optional(),
    exclusionsSnapshot: z.string().trim().max(10_000).optional(),
    deliverableSnapshot: z.string().trim().max(10_000).optional(),
    deliverables: QuoteDeliverablePlanSchema,
    siblingOrder: z.number().int().min(0),
    serviceDetail: QuoteServiceDetailSchema,
  })
  .strict();

export const AppendQuoteRevisionSchema = z
  .object({
    currency: CurrencyCodeSchema,
    validityDeadlineAt: z.coerce.date(),
    taxInCents: NonNegativeCentsSchema,
    serviceFeeInCents: NonNegativeCentsSchema,
    shippingInCents: NonNegativeCentsSchema,
    discountInCents: NonNegativeCentsSchema,
    paymentTerms: z.string().trim().max(2000).optional(),
    /**
     * A40. Incoterms 2020, the eleven the ICC publishes. Was `z.string().max(20)`, which
     * accepted `BANANA` — and `commerce_prevent_submitted_quote_revision_mutation` then froze
     * it on the revision forever, so the bad value could not even be corrected afterwards.
     *
     * A `422` naming the field is the right answer for a term nobody trades under. Silently
     * dropping it would lose a commercial term the seller meant to state.
     */
    incoterm: z
      .enum(["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"])
      .optional(),
    notes: z.string().trim().max(10_000).optional(),
    productLines: z.array(QuoteProductLineSchema).max(200),
    serviceLines: z.array(QuoteServiceLineSchema).max(200),
    /**
     * A30's provider half — drawings, spec sheets, certificates supporting THIS offer.
     *
     * Same shape and cap as `CreateDraftRfqSchema.documentIds`, the buyer's half, so the two sides
     * of one feature cannot drift apart. Each id must name a `commerce_encrypted_document` the
     * PROVIDER's organization owns and that is `available` — a document still being virus-scanned
     * is not attachable.
     *
     * THEY BELONG TO THE REVISION, NOT THE QUOTE. Each revision carries its own set, because a
     * revision is the immutable offer and its documents are part of what a buyer judged.
     */
    documentIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict()
  .superRefine((revision, refinementContext) => {
    const seenProductLineIds = new Set<string>();
    for (const [lineIndex, productLine] of revision.productLines.entries()) {
      if (seenProductLineIds.has(productLine.rfqProductLineId)) {
        refinementContext.addIssue({
          code: "custom",
          message: "rfqProductLineId values must be unique.",
          path: ["productLines", lineIndex, "rfqProductLineId"],
        });
      }
      seenProductLineIds.add(productLine.rfqProductLineId);
    }

    const seenServiceLineIds = new Set<string>();
    for (const [lineIndex, serviceLine] of revision.serviceLines.entries()) {
      if (seenServiceLineIds.has(serviceLine.rfqServiceLineId)) {
        refinementContext.addIssue({
          code: "custom",
          message: "rfqServiceLineId values must be unique.",
          path: ["serviceLines", lineIndex, "rfqServiceLineId"],
        });
      }
      seenServiceLineIds.add(serviceLine.rfqServiceLineId);
    }
  });

export const AcceptQuoteSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    /**
     * STORE Phase 14. The agreed escrow terms this acceptance settles under.
     *
     * OMITTING IT IS THE DEFAULT AND NOT AN ERROR: the order settles `direct_offline`,
     * the parties arrange payment between themselves, and Qatoto holds nothing and
     * observes nothing. Naming one does not establish it — the service revalidates it
     * under a row lock and refuses the acceptance outright if it has lapsed.
     */
    settlementAgreementId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();
