import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import * as commerceQuotesService from "#src/services/commerce-quotes.service.js";
import type { CommerceQuotesError } from "#src/services/commerce-quotes.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();
const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

const RfqIdParamsSchema = z.object({ rfqId: z.string().trim().min(1).max(200) }).strict();

/**
 * A38. `status` is the full `commerce_quote_status` enum, `draft` included — this is the
 * provider's own work and the only list that yields a draft's id.
 */
const ListProviderQuotesQuerySchema = z
  .object({
    status: z
      .enum(["draft", "submitted", "superseded", "accepted", "declined", "withdrawn", "expired"])
      .optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const QuoteIdParamsSchema = z.object({ quoteId: z.string().trim().min(1).max(200) }).strict();
const QuoteRevisionParamsSchema = z
  .object({
    quoteId: z.string().trim().min(1).max(200),
    revision: z.coerce.number().int().positive(),
  })
  .strict();

const CurrencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/);
const CountryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/);
const NonNegativeCentsSchema = z.number().int().min(0);

const FreightQuoteDetailSchema = z
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

const CustomsQuoteDetailSchema = z
  .object({
    kind: z.literal("customs_broker"),
    jurisdictions: z.array(z.string().trim().min(1).max(80)).max(50),
    filingSummary: z.string().trim().max(4000).optional(),
  })
  .strict();

const InsuranceQuoteDetailSchema = z
  .object({
    kind: z.literal("insurance_provider"),
    coverageClasses: z.array(z.string().trim().min(1).max(80)).max(50),
    coverageLimitInCents: z.number().int().min(0).optional(),
    currency: CurrencyCodeSchema.optional(),
  })
  .strict();

const InspectionQuoteDetailSchema = z
  .object({
    kind: z.literal("inspection_agency"),
    includedStages: z.array(z.string().trim().min(1).max(80)).max(20),
  })
  .strict();

const TestingQuoteDetailSchema = z
  .object({
    kind: z.literal("testing_certification_lab"),
    standards: z.array(z.string().trim().min(1).max(120)).max(50),
    laboratoryLocation: z.string().trim().max(200).optional(),
  })
  .strict();

const MarketingQuoteDetailSchema = z
  .object({
    kind: z.literal("marketing_agency"),
    channels: z.array(z.string().trim().min(1).max(80)).max(50),
    deliverablesSummary: z.string().trim().max(4000).optional(),
  })
  .strict();

const WarehouseQuoteDetailSchema = z
  .object({
    kind: z.literal("warehouse_provider"),
    storageTypes: z.array(z.string().trim().min(1).max(80)).max(50),
    capacityUnits: z.string().trim().max(80).optional(),
    temperatureControlled: z.boolean(),
  })
  .strict();

const FxQuoteDetailSchema = z
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

const QuoteServiceDetailSchema = z
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

const QuoteDeliverablePlanSchema = z
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

const QuoteProductLineSchema = z
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

const QuoteServiceLineSchema = z
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

function sendZodError(res: Response, error: z.ZodError): void {
  /**
   * Delegates to the ONE shared responder (§0).
   *
   * This used to build its own body, and got two things wrong that only showed up in the browser:
   * it forwarded `fieldErrors` alone, so `.strict()`'s `unrecognized_keys` — the way EVERY rejected
   * server-owned field arrives — vanished into an empty object; and it put the payload under `data`,
   * which the client's envelope reader never looks at. The result was a 422 that said "Validation
   * failed." and named nothing.
   */
  respondValidationFailed(res, error);
}

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return false;
  }
  return true;
}

function requireCommerceActor(
  req: Request,
  res: Response,
): {
  organizationId: string;
  memberId: string;
  memberRole: CommerceOrganizationMemberRole;
  actorUserId: string;
} | null {
  if (!req.user || !req.commerceOrganization) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    organizationId: req.commerceOrganization.organizationId,
    memberId: req.commerceOrganization.memberId,
    memberRole: req.commerceOrganization.memberRole,
    actorUserId: req.user.id,
  };
}

function mapQuotesError(res: Response, error: CommerceQuotesError): void {
  switch (error.type) {
    case "NOT_FOUND":
    case "FORBIDDEN":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "ORGANIZATION_NOT_ACTIVE":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Commerce organization is not active for trade.",
      } satisfies ApiResponse);
      return;
    case "VALIDATION_FAILED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "QUOTE_EXPIRED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Quote revision has expired.",
        data: { expiredAt: error.expiredAt.toISOString() },
      } satisfies ApiResponse);
      return;
    case "REVISION_CHANGED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Quote revision changed.",
        data: { currentRevision: error.currentRevision },
      } satisfies ApiResponse);
      return;
    case "RFQ_NOT_OPEN":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "RFQ is not open for this action.",
      } satisfies ApiResponse);
      return;
    case "CONFLICTING_ACCEPTANCE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Another quote was already accepted for this RFQ.",
        data: { orderId: error.orderId },
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This action conflicts with the current quote state.",
      } satisfies ApiResponse);
      return;
    case "INSUFFICIENT_STOCK":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Insufficient stock to accept this quote.",
        data: {
          productId: error.productId,
          availableQuantity: error.availableQuantity,
        },
      } satisfies ApiResponse);
      return;
    case "CONFLICT":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    /**
     * STORE Phase 14. 409 rather than 422: the request was well-formed and was true when
     * the buyer made it — the agreed escrow terms lapsed underneath it. Nothing was
     * accepted, so the quote is still there to accept once the terms are re-agreed.
     */
    case "SETTLEMENT_UNAVAILABLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "The agreed escrow terms are no longer usable, so the quote was not accepted and no order exists.",
        data: { reason: error.reason },
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce quotes error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createQuoteShell(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = RfqIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.createQuoteShell(actor, params.data.rfqId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Quote shell created.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function appendRevision(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = AppendQuoteRevisionSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.appendRevision(actor, params.data.quoteId, body.data);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Quote revision appended.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function submitRevision(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteRevisionParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.submitRevision(
    actor,
    params.data.quoteId,
    params.data.revision,
  );
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote revision submitted.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * GET /commerce/provider/quotes — a provider's own bids, across every RFQ (Appendix A38).
 *
 * The twin of `GET /commerce/provider/rfqs`, which lists the WORK. An RFQ leaves that queue
 * when it closes and takes any quote on it out of reach, so before this the only way to
 * enumerate one's own bids was to fan out per RFQ from the browser.
 */
export async function listProviderQuotes(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListProviderQuotesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceQuotesService.listProviderQuotes(actor, {
    status: query.data.status,
    cursor: query.data.cursor,
    limit: query.data.limit,
  });
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Provider quotes listed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listQuotesForRfq(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = RfqIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceQuotesService.listQuotesForRfq(actor, params.data.rfqId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quotes listed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getQuote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceQuotesService.getQuote(actor, params.data.quoteId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function acceptQuote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = AcceptQuoteSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.acceptQuote(
    actor,
    params.data.quoteId,
    body.data.expectedRevision,
    body.data.settlementAgreementId ?? null,
  );
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Quote accepted and order created.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function declineQuote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.declineQuote(actor, params.data.quoteId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote declined.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function withdrawQuote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.withdrawQuote(actor, params.data.quoteId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}
