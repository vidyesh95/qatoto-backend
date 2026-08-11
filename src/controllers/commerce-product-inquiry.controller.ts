import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import {
  CreateProductInquiryParamsSchema,
  ListProductInquiriesQuerySchema,
} from "#src/schemas/commerce-product-inquiry.schemas.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import * as commerceProductInquiryService from "#src/services/commerce-product-inquiry.service.js";
import type { CommerceProductInquiryError } from "#src/services/commerce-product-inquiry.service.js";
import { resolveEligibleProductRefById } from "#src/services/store-catalog.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();

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

function requireCommerceActor(
  req: Request,
  res: Response,
): {
  organizationId: string;
  memberId: string;
  memberRole: CommerceOrganizationMemberRole;
  actorUserId: string;
} | null {
  // §14. Possibly-`pending` since Phase 21 — see the router's header comment for why the
  // organization requirement stayed while the activation requirement went.
  const inquiryActor = req.buyerCommerceWorkspace ?? req.commerceOrganization;
  if (!req.user || !inquiryActor) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    organizationId: inquiryActor.organizationId,
    memberId: inquiryActor.memberId,
    memberRole: inquiryActor.memberRole,
    actorUserId: req.user.id,
  };
}

function mapInquiryError(res: Response, error: CommerceProductInquiryError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You are not allowed to perform this action.",
      } satisfies ApiResponse);
      return;
    case "SELF_INQUIRY_FORBIDDEN":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "You cannot open an inquiry on your own listing.",
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
      throw new Error(`Unhandled product inquiry error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createOrGetProductInquiry(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = EmptyObjectSchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }
  const params = CreateProductInquiryParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  /**
   * Resolved through the catalog's single public-eligibility rule. An inquiry about a
   * draft, suspended or privately-owned listing must 404 exactly as the listing does,
   * or the route confirms that a hidden product id exists.
   */
  const productRef = await resolveEligibleProductRefById(params.data.productId);
  if (!productRef) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Product not found.",
    } satisfies ApiResponse);
    return;
  }

  const result = await commerceProductInquiryService.createOrGetProductInquiry(actor, {
    productId: productRef.id,
    sellerOrganizationId: productRef.sellerOrganizationId,
  });
  if (!result.success) {
    mapInquiryError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Inquiry opened.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listProductInquiries(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListProductInquiriesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceProductInquiryService.listProductInquiries(actor, query.data);
  if (!result.success) {
    mapInquiryError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product inquiries.",
    data: result.value,
  } satisfies ApiResponse);
}
