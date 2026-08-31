import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  ProductIdParamsSchema,
  RelationIdParamsSchema,
  ListProductRelationsForModerationQuerySchema,
  ReplaceProductRelationsSchema,
} from "#src/modules/store/catalog/commerce-catalog.schemas.js";
import {
  EmptyObjectSchema,
  EmptyRequestBodySchema,
} from "#src/modules/store/catalog/commerce-catalog.schemas.js";
import * as commerceProductRelationsService from "#src/modules/store/catalog/commerce-product-relations.service.js";
import type { CommerceProductRelationError } from "#src/modules/store/catalog/commerce-product-relations.service.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
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
    case "RELATION_ALREADY_CURATED":
      // 409: the edge exists with MORE authority than the seller was claiming. Not a retry, and
      // not a validation failure — the seller's list is fine, it just names something a moderator
      // already confirmed.
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "A moderator has already confirmed one of these related products. Remove it from your list — their version stays.",
      } satisfies ApiResponse);
      return;
    case "RELATION_DISMISSED":
      /**
       * 409, and deliberately NOT the `RELATION_ALREADY_CURATED` message. Both arrive from the same
       * unique index, but telling a seller "a moderator confirmed this" about a claim a moderator
       * REFUSED is a lie in the one direction that matters. The service distinguishes them with an
       * explicit diff rather than from the `23505`, which cannot.
       */
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "A moderator reviewed one of these related products and did not confirm it. Remove it from your list.",
        data: { productIds: error.productIds },
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      // A page token this service did not mint. A caller error, never a 500.
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    case "ALREADY_VERIFIED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This relation is already verified.",
      } satisfies ApiResponse);
      return;
    case "SELF_MODERATION_FORBIDDEN":
      // 403: they hold `moderate_commerce` but belong to the selling organization, so they are a
      // party to the claim. The client cannot know a moderator's memberships, so this is surfaced
      // on the row that produced it rather than by hiding the control.
      // ⚠️ Wording is deliberately "moderate", not "confirm" — this arm serves BOTH verify and
      // dismiss, and "cannot confirm its own claim" reads as nonsense on a dismissal.
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "A member of the selling organization cannot moderate its own claim.",
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
 * GET /commerce/admin/product-relations
 *
 * The claims a moderator may promote. ⚠️ **`moderate_commerce` is checked inside the SERVICE**, not
 * in the route chain, so a caller without it learns nothing about whether rows exist.
 *
 * ⚠️ **THE DEFAULT IS APPLIED HERE RATHER THAN IN THE SCHEMA** — see its docblock. Unreviewed means
 * `seller_declared`; it must never be expressed as `verifiedAt IS NULL`, which would also match
 * every row the nightly co-occurrence job writes.
 */
export async function listProductRelationsForModeration(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const query = ListProductRelationsForModerationQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const listed = await commerceProductRelationsService.listRelationsForModeration(userId, {
    sourceKind: query.data.sourceKind ?? "seller_declared",
    limit: query.data.limit,
    ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
  });
  if (!listed.success) {
    mapRelationError(res, listed.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product relations awaiting review.",
    data: listed.value,
  } satisfies ApiResponse);
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
 * POST /commerce/admin/product-relations/:relationId/dismiss
 *
 * Refuse a claim. ⚠️ This SUPPRESSES it from buyers, not just from the queue, and it survives the
 * seller's next save — see `dismissRelation`.
 */
export async function dismissProductRelation(req: Request, res: Response): Promise<void> {
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

  const result = await commerceProductRelationsService.dismissRelation(
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
    message: "Product relation dismissed.",
    data: result.value,
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
