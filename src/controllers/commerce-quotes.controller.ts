import type { Request, Response } from "express";
import { z } from "zod";

import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import * as commerceQuotesService from "#src/services/commerce-quotes.service.js";
import type { CommerceQuotesError } from "#src/services/commerce-quotes.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();
const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

const RfqIdParamsSchema = z.object({ rfqId: z.string().trim().min(1).max(200) }).strict();
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

const QuoteServiceDetailSchema = z.discriminatedUnion("kind", [
  FreightQuoteDetailSchema,
  CustomsQuoteDetailSchema,
  InsuranceQuoteDetailSchema,
  InspectionQuoteDetailSchema,
  TestingQuoteDetailSchema,
  MarketingQuoteDetailSchema,
  WarehouseQuoteDetailSchema,
  FxQuoteDetailSchema,
]);

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
    siblingOrder: z.number().int().min(0),
    serviceDetail: QuoteServiceDetailSchema.optional(),
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
    incoterm: z.string().trim().min(1).max(20).optional(),
    notes: z.string().trim().max(10_000).optional(),
    productLines: z.array(QuoteProductLineSchema).max(200),
    serviceLines: z.array(QuoteServiceLineSchema).max(200),
  })
  .strict();

export const AcceptQuoteSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();

function sendZodError(res: Response, error: z.ZodError): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "Validation failed.",
    data: error.flatten().fieldErrors,
  } satisfies ApiResponse);
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
