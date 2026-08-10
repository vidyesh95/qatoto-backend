import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceRfqsService from "#src/services/commerce-rfqs.service.js";
import type { CommerceRfqsError } from "#src/services/commerce-rfqs.service.js";
import type { ApiResponse } from "#src/types/index.js";
import { respondValidationFailed } from "#src/controllers/project-error-response.js";

const ProviderKindSchema = z.enum([
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

const TransportModeSchema = z.enum(["air", "sea", "land", "rail", "multimodal"]);
const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

const FreightRequirementFields = {
  transportModes: z.array(TransportModeSchema).min(1).max(5),
  originCountryCode: CountryCodeSchema.nullable().optional(),
  destinationCountryCode: CountryCodeSchema.nullable().optional(),
  requiresConsolidation: z.boolean().optional(),
  requiresHazardousGoodsSupport: z.boolean().optional(),
  cargoDescription: z.string().trim().max(4000).nullable().optional(),
} as const;

const FreightForwarderRequirementDetailSchema = z
  .object({
    providerKind: z.literal("freight_forwarder"),
    ...FreightRequirementFields,
  })
  .strict();

const LogisticsOperatorRequirementDetailSchema = z
  .object({
    providerKind: z.literal("logistics_operator"),
    ...FreightRequirementFields,
  })
  .strict();

const CustomsRequirementDetailSchema = z
  .object({
    providerKind: z.literal("customs_broker"),
    jurisdictions: z.array(z.string().trim().min(1).max(80)).max(50),
    importRequired: z.boolean().optional(),
    exportRequired: z.boolean().optional(),
    commoditySummary: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const InsuranceRequirementDetailSchema = z
  .object({
    providerKind: z.literal("insurance_provider"),
    cargoCoverageClasses: z.array(z.string().trim().min(1).max(80)).max(50),
    coverageLimitInCents: z.number().int().min(0).nullable().optional(),
    currency: CurrencyCodeSchema.optional(),
  })
  .strict();

const InspectionRequirementDetailSchema = z
  .object({
    providerKind: z.literal("inspection_agency"),
    preProduction: z.boolean().optional(),
    duringProduction: z.boolean().optional(),
    preShipment: z.boolean().optional(),
    loadingSupervision: z.boolean().optional(),
  })
  .strict();

const TestingRequirementDetailSchema = z
  .object({
    providerKind: z.literal("testing_certification_lab"),
    standards: z.array(z.string().trim().min(1).max(120)).max(50),
    laboratoryLocationPreference: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const MarketingRequirementDetailSchema = z
  .object({
    providerKind: z.literal("marketing_agency"),
    channels: z.array(z.string().trim().min(1).max(80)).max(50),
    targetRegions: z.array(z.string().trim().min(1).max(80)).max(50),
    languageCapabilities: z.array(z.string().trim().min(1).max(40)).max(50),
  })
  .strict();

const WarehouseRequirementDetailSchema = z
  .object({
    providerKind: z.literal("warehouse_provider"),
    storageTypes: z.array(z.string().trim().min(1).max(80)).max(50),
    temperatureControlled: z.boolean().optional(),
    bondedStatusRequired: z.boolean().optional(),
    capacityUnits: z.string().trim().max(80).nullable().optional(),
  })
  .strict();

const ForeignExchangeRequirementDetailSchema = z
  .object({
    providerKind: z.literal("foreign_exchange_facilitator"),
    currencyPairs: z.array(z.string().trim().min(1).max(20)).max(100),
    settlementRails: z.array(z.string().trim().min(1).max(80)).max(50),
    notionalAmountInCents: z.number().int().min(0).nullable().optional(),
    notionalCurrency: CurrencyCodeSchema.optional(),
  })
  .strict();

const RequirementDetailSchema = z.discriminatedUnion("providerKind", [
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

const ProductLineSchema = z
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

const ServiceLineSchema = z
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

const RfqIdParamsSchema = z.object({ rfqId: z.string().uuid() }).strict();
const EmptyObjectSchema = z.object({}).strict();
const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);
const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

function validationError(res: Response, error: z.ZodError): void {
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

function respondRfqError(
  res: Response,
  error: CommerceRfqsError,
  options?: { prefer404?: boolean },
): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "RFQ not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
      if (options?.prefer404 === true) {
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "RFQ not found.",
        } satisfies ApiResponse);
        return;
      }
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This RFQ action is not permitted.",
      } satisfies ApiResponse);
      return;
    case "ORGANIZATION_NOT_ACTIVE":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "The commerce organization is not active for trade.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
    case "CONFLICT":
    case "PROVIDER_INELIGIBLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          error.type === "PROVIDER_INELIGIBLE"
            ? "One or more providers are not eligible for invitation."
            : error.type === "INVALID_STATE"
              ? (error.message ?? "RFQ state does not allow this action.")
              : error.message,
      } satisfies ApiResponse);
      return;
    case "VALIDATION_FAILED":
    case "DEADLINE_INVALID":
    case "LINES_REQUIRED":
    case "DOCUMENT_NOT_OWNED":
    case "ADDRESS_NOT_OWNED":
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message:
          error.type === "VALIDATION_FAILED"
            ? error.message
            : error.type === "DEADLINE_INVALID"
              ? "RFQ response deadline must be in the future."
              : error.type === "LINES_REQUIRED"
                ? "RFQ requires at least one product or service line."
                : error.type === "DOCUMENT_NOT_OWNED"
                  ? "One or more documents are not owned by the buyer organization."
                  : error.type === "ADDRESS_NOT_OWNED"
                    ? "Destination address is not owned by the buyer organization."
                    : "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce RFQ error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function requireBuyerCommerceContext(req: Request, res: Response) {
  if (!req.user || !req.authSession) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  if (!req.commerceOrganization) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active buyer organization membership is required.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    actorUserId: req.user.id,
    buyerOrganizationId: req.commerceOrganization.organizationId,
    memberId: req.commerceOrganization.memberId,
    memberRole: req.commerceOrganization.memberRole,
  };
}

function requireActiveCommerceContext(req: Request, res: Response) {
  if (!req.user || !req.authSession) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  if (!req.commerceOrganization) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active commerce organization membership is required.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    actorUserId: req.user.id,
    organizationId: req.commerceOrganization.organizationId,
    memberId: req.commerceOrganization.memberId,
    memberRole: req.commerceOrganization.memberRole,
  };
}

function requireProviderCommerceContext(req: Request, res: Response) {
  if (!req.user || !req.authSession) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  if (!req.commerceOrganization) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active provider organization membership is required.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    actorUserId: req.user.id,
    providerOrganizationId: req.commerceOrganization.organizationId,
    memberId: req.commerceOrganization.memberId,
    memberRole: req.commerceOrganization.memberRole,
  };
}

function parseRfqId(req: Request, res: Response): string | null {
  const parsed = RfqIdParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return null;
  }
  return parsed.data.rfqId;
}

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return false;
  }
  return true;
}

function parseListQuery(req: Request, res: Response): z.infer<typeof ListQuerySchema> | null {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return null;
  }
  return parsed.data;
}

export async function createDraftRfq(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const parsedBody = CreateDraftRfqSchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const created = await commerceRfqsService.createDraftRfq({
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
    body: parsedBody.data,
  });
  if (!created.success) return respondRfqError(res, created.error);

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "RFQ draft created.",
    data: created.value,
  } satisfies ApiResponse);
}

export async function listMyRfqs(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  const listQuery = parseListQuery(req, res);
  if (!listQuery) return;

  const listed = await commerceRfqsService.listMyRfqs({
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    limit: listQuery.limit,
    cursor: listQuery.cursor,
  });
  if (!listed.success) return respondRfqError(res, listed.error);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Buyer RFQs loaded.",
    data: listed.value,
  } satisfies ApiResponse);
}

export async function getRfq(req: Request, res: Response): Promise<void> {
  const commerceContext = requireActiveCommerceContext(req, res);
  if (!commerceContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;

  const loaded = await commerceRfqsService.getRfq({
    rfqId,
    callerOrganizationId: commerceContext.organizationId,
  });
  if (!loaded.success) return respondRfqError(res, loaded.error, { prefer404: true });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "RFQ loaded.",
    data: loaded.value,
  } satisfies ApiResponse);
}

export async function updateDraftRfq(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;
  const parsedBody = UpdateDraftRfqSchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const updated = await commerceRfqsService.updateDraftRfq({
    rfqId,
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
    patch: parsedBody.data,
  });
  if (!updated.success) return respondRfqError(res, updated.error, { prefer404: true });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "RFQ draft updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

export async function openRfq(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;
  const parsedBody = EmptyRequestBodySchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const opened = await commerceRfqsService.openRfq({
    rfqId,
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
  });
  if (!opened.success) return respondRfqError(res, opened.error, { prefer404: true });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "RFQ opened.",
    data: opened.value,
  } satisfies ApiResponse);
}

export async function inviteProviders(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;
  const parsedBody = InviteProvidersSchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const invited = await commerceRfqsService.inviteProviders({
    rfqId,
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
    providerOrganizationIds: parsedBody.data.providerOrganizationIds,
  });
  if (!invited.success) return respondRfqError(res, invited.error, { prefer404: true });

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Providers invited.",
    data: invited.value,
  } satisfies ApiResponse);
}

export async function closeRfq(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;
  const parsedBody = EmptyRequestBodySchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const closed = await commerceRfqsService.closeRfq({
    rfqId,
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
  });
  if (!closed.success) return respondRfqError(res, closed.error, { prefer404: true });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "RFQ closed.",
    data: closed.value,
  } satisfies ApiResponse);
}

export async function listProviderRfqs(req: Request, res: Response): Promise<void> {
  const providerContext = requireProviderCommerceContext(req, res);
  if (!providerContext) return;
  const listQuery = parseListQuery(req, res);
  if (!listQuery) return;

  const listed = await commerceRfqsService.listProviderRfqs({
    providerOrganizationId: providerContext.providerOrganizationId,
    limit: listQuery.limit,
    cursor: listQuery.cursor,
  });
  if (!listed.success) return respondRfqError(res, listed.error);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Provider RFQs loaded.",
    data: listed.value,
  } satisfies ApiResponse);
}
