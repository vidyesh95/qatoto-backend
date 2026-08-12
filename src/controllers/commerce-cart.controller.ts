import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  ProductIdParamsSchema,
  RemoveCartItemQuerySchema,
  SetCartItemSchema,
} from "#src/schemas/commerce-cart.schemas.js";
import * as commerceCartService from "#src/services/commerce-cart.service.js";
import type { CommerceCartError } from "#src/services/commerce-cart.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
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
  /**
   * §14. Reads `buyerCommerceWorkspace` since Phase 21, because every cart route now runs
   * behind `requireProvisionedBuyerCommerceWorkspace` and the workspace may be `pending` —
   * a signed-in buyer's first tap must fill a cart, not answer 403.
   *
   * `commerceOrganization` is the fallback and not the other way round, so a route that has
   * been given the workspace guard keeps working if it is ever also given an active guard,
   * and a route with neither still refuses.
   */
  const commerceActor = req.buyerCommerceWorkspace ?? req.commerceOrganization;
  if (!req.user || !commerceActor) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    organizationId: commerceActor.organizationId,
    memberId: commerceActor.memberId,
    memberRole: commerceActor.memberRole,
    actorUserId: req.user.id,
  };
}

function mapCartError(res: Response, error: CommerceCartError): void {
  switch (error.type) {
    case "NOT_FOUND":
    case "FORBIDDEN":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "SAMPLE_NOT_AVAILABLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "This listing does not offer a sample.",
      } satisfies ApiResponse);
      return;
    case "CUSTOMIZATION_REJECTED":
      /**
       * 422 across the board: every customization failure is "this request cannot be
       * satisfied as written", and the tagged `customizationError` tells the client
       * which slot and why without inventing a status code per case.
       */
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "This customization cannot be applied.",
        data: error.customizationError,
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
    case "PRODUCT_NOT_PURCHASABLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This product is no longer purchasable.",
      } satisfies ApiResponse);
      return;
    case "BELOW_MINIMUM_ORDER_QUANTITY":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Quantity is below the minimum order quantity.",
        data: { minimumOrderQuantity: error.minimumOrderQuantity },
      } satisfies ApiResponse);
      return;
    case "INSUFFICIENT_STOCK":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Insufficient stock for the requested quantity.",
        data: { availableQuantity: error.availableQuantity },
      } satisfies ApiResponse);
      return;
    // 422, not 409: the request is malformed for this product rather than in
    // conflict with current state — the buyer must name a variant to proceed.
    case "VARIANT_REQUIRED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "This product is sold by variant. Choose a variant to add it to the cart.",
      } satisfies ApiResponse);
      return;
    case "VARIANT_NOT_APPLICABLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "This product is not sold by variant.",
      } satisfies ApiResponse);
      return;
    case "VARIANT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "VARIANT_NOT_PURCHASABLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This variant is no longer purchasable.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce cart error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function getCart(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const result = await commerceCartService.getCart(actor);
  if (!result.success) {
    mapCartError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Cart retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function setCartItem(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ProductIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = SetCartItemSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceCartService.setCartItem(
    actor,
    params.data.productId,
    body.data.quantity,
    body.data.variantId ?? null,
    body.data.isSample ?? false,
    body.data.customizations ?? [],
  );
  if (!result.success) {
    mapCartError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Cart line updated.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function removeCartItem(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = RemoveCartItemQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }
  const params = ProductIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceCartService.removeCartItem(
    actor,
    params.data.productId,
    query.data.variantId ?? null,
  );
  if (!result.success) {
    mapCartError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Cart line removed.",
    data: result.value,
  } satisfies ApiResponse);
}
