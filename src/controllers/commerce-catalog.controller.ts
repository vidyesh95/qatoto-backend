import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import {
  ProductIdParamsSchema,
  RelationIdParamsSchema,
  ReplaceProductRelationsSchema,
} from "#src/schemas/commerce-catalog.schemas.js";
import {
  EmptyObjectSchema,
  EmptyRequestBodySchema,
} from "#src/schemas/commerce-catalog.schemas.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import * as commerceProductRelationsService from "#src/services/commerce-product-relations.service.js";
import type { CommerceProductRelationError } from "#src/services/commerce-product-relations.service.js";
import type { ApiResponse } from "#src/types/index.js";

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

function mapRelationError(res: Response, error: CommerceProductRelationError): void {
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
    case "INVALID_TARGET":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "One or more related products are not publicly available.",
        data: { productIds: error.productIds },
      } satisfies ApiResponse);
      return;
    case "SELF_RELATION":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "A product cannot relate to itself.",
      } satisfies ApiResponse);
      return;
    case "ALREADY_VERIFIED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This relation is already verified.",
      } satisfies ApiResponse);
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      // 403 for a non-probeable staff capability, per §7's HTTP mapping.
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Moderator capability required.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveError: never = error;
      throw new Error(`Unhandled product relation error: ${JSON.stringify(exhaustiveError)}`);
    }
  }
}

/**
 * PUT /commerce/products/:productId/relations
 * Seller declares its relation graph. Always stored `seller_declared` (§15.3).
 */
export async function replaceProductRelations(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ProductIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ReplaceProductRelationsSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceProductRelationsService.replaceSellerDeclaredRelations(
    actor,
    params.data.productId,
    body.data.relations,
  );
  if (!result.success) {
    mapRelationError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product relations updated.",
    data: { relations: result.value },
  } satisfies ApiResponse);
}

/**
 * POST /commerce/admin/product-relations/:relationId/verify
 * Promote a seller claim to `moderator_curated` — the only path that lets a client
 * render compatibility as confirmed.
 */
export async function verifyProductRelation(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const params = RelationIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceProductRelationsService.verifyRelation(
    req.user.id,
    params.data.relationId,
  );
  if (!result.success) {
    mapRelationError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product relation verified.",
    data: result.value,
  } satisfies ApiResponse);
}
