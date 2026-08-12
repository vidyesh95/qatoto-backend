import type { Request, Response } from "express";
import type { ZodError } from "zod";

import * as sellerProfileService from "#src/modules/store/organizations/commerce-seller-profile.service.js";
import * as manufacturingInquiryService from "#src/modules/store/procurement/commerce-manufacturing-inquiry.service.js";
import {
  firstParam,
  respondManufacturingInquiryError,
  respondStoreFactoriesError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/store/storefront/store-factories-error-response.js";
import {
  AuditIdParamsSchema,
  CreateManufacturingInquirySchema,
  FactorySlugParamsSchema,
  InquiryIdParamsSchema,
  ListFactoriesQuerySchema,
  ListManufacturingInquiriesQuerySchema,
  OrganizationIdParamsSchema,
  RecordSiteAuditSchema,
  ReplaceFactoryTermsSchema,
  ReplaceOrganizationSitesSchema,
  ReplaceProductionLinesSchema,
  WithdrawSiteAuditSchema,
} from "#src/modules/store/storefront/store-factories.schemas.js";
import * as storeFactoriesService from "#src/modules/store/storefront/store-factories.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The manufacturer directory's HTTP boundary (STORE_BACKEND_STRUCTURE.md §16).
 *
 * NO DOMAIN DECISIONS HERE. Every `verificationState`, expiry comparison and export-market
 * derivation lives in the service; this file parses, calls, and maps.
 */

function sendZodError(res: Response, error: ZodError): void {
  respondValidationFailed(res, error);
}

/**
 * Refuses any query on a route that documents none.
 *
 * A route with no query schema silently ignores `?limit=1000`, which is exactly the
 * failure `.strict()` exists to prevent everywhere else in this domain.
 */
function parseNoQuery(req: Request, res: Response): boolean {
  if (Object.keys(req.query).length === 0) return true;
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "This route accepts no query parameters.",
    errors: { query: ["Unexpected query parameters."] },
  } satisfies ApiResponse & { errors: Record<string, string[]> });
  return false;
}

interface CommerceActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly memberId: string;
}

/**
 * The caller's proven organization context.
 *
 * `req.commerceOrganization` is set by `requireActiveCommerceOrganization`, which has
 * ALREADY re-checked the membership against the database. Nothing here reads an
 * organization id out of a body or a query — §0's rule that identity is server-derived.
 */
function requireCommerceActor(req: Request, res: Response): CommerceActor | null {
  const user = req.user;
  const organization = req.commerceOrganization;
  if (!user || !organization) {
    respondUnauthenticated(res);
    return null;
  }
  return {
    userId: user.id,
    organizationId: organization.organizationId,
    memberId: organization.memberId,
  };
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export async function listFactories(req: Request, res: Response): Promise<void> {
  const query = ListFactoriesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await storeFactoriesService.listFactories(query.data);
  if (!result.success) {
    respondStoreFactoriesError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Factories loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getFactory(req: Request, res: Response): Promise<void> {
  const params = FactorySlugParamsSchema.safeParse({
    factorySlug: firstParam(req.params.factorySlug),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await storeFactoriesService.getFactoryBySlug(params.data.factorySlug);
  if (!result.success) {
    respondStoreFactoriesError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Factory loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Manufacturing inquiries (§16.5)
// ---------------------------------------------------------------------------

/**
 * `POST /commerce/factories/:factorySlug/inquiries`.
 *
 * ANSWERS `201` AND `state: "draft"`, ALWAYS. Creating notifies nobody, so the success
 * copy must not say "sent" — sending is `POST .../send`.
 */
export async function createManufacturingInquiry(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const params = FactorySlugParamsSchema.safeParse({
    factorySlug: firstParam(req.params.factorySlug),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = CreateManufacturingInquirySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await manufacturingInquiryService.createManufacturingInquiry({
    factorySlug: params.data.factorySlug,
    buyerOrganizationId: actor.organizationId,
    buyerMemberId: actor.memberId,
    createdByUserId: actor.userId,
    capabilityKind: body.data.capabilityKind,
    productDescription: body.data.productDescription,
    estimatedAnnualQuantity: body.data.estimatedAnnualQuantity ?? null,
    unitLabel: body.data.unitLabel ?? null,
    targetUnitPriceInCents: body.data.targetUnitPriceInCents ?? null,
    currency: body.data.currency ?? null,
    requiredCertifications: body.data.requiredCertifications ?? [],
    desiredFirstDeliveryAt: body.data.desiredFirstDeliveryAt ?? null,
    notes: body.data.notes ?? null,
  });
  if (!result.success) {
    respondManufacturingInquiryError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Manufacturing inquiry drafted. Send it when you are ready.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listMyManufacturingInquiries(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListManufacturingInquiriesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await manufacturingInquiryService.listBuyerManufacturingInquiries({
    organizationId: actor.organizationId,
    state: query.data.state,
    limit: query.data.limit,
    cursor: query.data.cursor,
  });
  if (!result.success) {
    respondManufacturingInquiryError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Manufacturing inquiries loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listReceivedManufacturingInquiries(
  req: Request,
  res: Response,
): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListManufacturingInquiriesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await manufacturingInquiryService.listFactoryManufacturingInquiries({
    organizationId: actor.organizationId,
    state: query.data.state,
    limit: query.data.limit,
    cursor: query.data.cursor,
  });
  if (!result.success) {
    respondManufacturingInquiryError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Received manufacturing inquiries loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getManufacturingInquiry(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const params = InquiryIdParamsSchema.safeParse({ inquiryId: firstParam(req.params.inquiryId) });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await manufacturingInquiryService.getManufacturingInquiry({
    inquiryId: params.data.inquiryId,
    organizationId: actor.organizationId,
  });
  if (!result.success) {
    respondManufacturingInquiryError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Manufacturing inquiry loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function sendManufacturingInquiry(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const params = InquiryIdParamsSchema.safeParse({ inquiryId: firstParam(req.params.inquiryId) });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await manufacturingInquiryService.sendManufacturingInquiry({
    inquiryId: params.data.inquiryId,
    organizationId: actor.organizationId,
    memberId: actor.memberId,
    actorUserId: actor.userId,
  });
  if (!result.success) {
    respondManufacturingInquiryError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Manufacturing inquiry sent to the factory.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function answerManufacturingInquiry(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const params = InquiryIdParamsSchema.safeParse({ inquiryId: firstParam(req.params.inquiryId) });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await manufacturingInquiryService.answerManufacturingInquiry({
    inquiryId: params.data.inquiryId,
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
  });
  if (!result.success) {
    respondManufacturingInquiryError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Manufacturing inquiry marked answered.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function closeManufacturingInquiry(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const params = InquiryIdParamsSchema.safeParse({ inquiryId: firstParam(req.params.inquiryId) });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await manufacturingInquiryService.closeManufacturingInquiry({
    inquiryId: params.data.inquiryId,
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
  });
  if (!result.success) {
    respondManufacturingInquiryError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Manufacturing inquiry closed.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Seller-owned factory depth (§16.3)
// ---------------------------------------------------------------------------

/**
 * These four reuse the seller-profile service's error union, so they share its mapper
 * rather than growing a second one for the same errors.
 */
function respondSellerProfileError(
  res: Response,
  error: sellerProfileService.CommerceSellerProfileError,
): void {
  switch (error.type) {
    case "NOT_FOUND":
      res
        .status(404)
        .json({ status: "error", statusCode: 404, message: "Organization not found." });
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Recording a site audit requires the moderator or admin role.",
      });
      return;
    case "CONFLICT":
      res.status(409).json({ status: "error", statusCode: 409, message: error.message });
      return;
    default:
      /**
       * The remaining variants are image, evidence and self-review failures that only the
       * media and certification routes can produce. Reaching one here would mean this
       * controller called a function it does not call.
       */
      res.status(500).json({
        status: "error",
        statusCode: 500,
        message: "The request could not be completed.",
      });
      return;
  }
}

export async function replaceProductionLines(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = OrganizationIdParamsSchema.safeParse({
    organizationId: firstParam(req.params.organizationId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ReplaceProductionLinesSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await sellerProfileService.replaceProductionLines({
    userId: user.id,
    organizationId: params.data.organizationId,
    rows: body.data.productionLines,
  });
  if (!result.success) {
    respondSellerProfileError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Production lines replaced.",
    data: { productionLines: result.value },
  } satisfies ApiResponse);
}

export async function replaceOrganizationSites(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = OrganizationIdParamsSchema.safeParse({
    organizationId: firstParam(req.params.organizationId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ReplaceOrganizationSitesSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await sellerProfileService.replaceOrganizationSites({
    userId: user.id,
    organizationId: params.data.organizationId,
    rows: body.data.sites,
  });
  if (!result.success) {
    respondSellerProfileError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Sites replaced.",
    data: { sites: result.value },
  } satisfies ApiResponse);
}

export async function replaceFactoryTerms(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = OrganizationIdParamsSchema.safeParse({
    organizationId: firstParam(req.params.organizationId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ReplaceFactoryTermsSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await sellerProfileService.replaceFactoryTerms({
    userId: user.id,
    organizationId: params.data.organizationId,
    terms: body.data,
  });
  if (!result.success) {
    respondSellerProfileError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Factory terms replaced.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Staff site audits (§16.2, conflict 3)
// ---------------------------------------------------------------------------

export async function listSiteAudits(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = OrganizationIdParamsSchema.safeParse({
    organizationId: firstParam(req.params.organizationId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await sellerProfileService.listSiteAudits({
    moderatorUserId: user.id,
    organizationId: params.data.organizationId,
  });
  if (!result.success) {
    respondSellerProfileError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Site audits loaded.",
    data: { siteAudits: result.value },
  } satisfies ApiResponse);
}

export async function recordSiteAudit(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = OrganizationIdParamsSchema.safeParse({
    organizationId: firstParam(req.params.organizationId),
  });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = RecordSiteAuditSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await sellerProfileService.recordSiteAudit({
    moderatorUserId: user.id,
    organizationId: params.data.organizationId,
    auditedAt: body.data.auditedAt,
    auditorName: body.data.auditorName,
    auditorOrganizationName: body.data.auditorOrganizationName ?? null,
    scopeSummary: body.data.scopeSummary,
    siteIds: body.data.siteIds ?? [],
  });
  if (!result.success) {
    respondSellerProfileError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Site audit recorded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function withdrawSiteAudit(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    respondUnauthenticated(res);
    return;
  }

  const params = AuditIdParamsSchema.safeParse({ auditId: firstParam(req.params.auditId) });
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = WithdrawSiteAuditSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await sellerProfileService.withdrawSiteAudit({
    moderatorUserId: user.id,
    auditId: params.data.auditId,
    reason: body.data.reason,
  });
  if (!result.success) {
    respondSellerProfileError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Site audit withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}
