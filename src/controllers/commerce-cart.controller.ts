import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceCartService from "#src/services/commerce-cart.service.js";
import type { CommerceCartError } from "#src/services/commerce-cart.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();
const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

const ProductIdParamsSchema = z.object({ productId: z.string().trim().min(1).max(200) }).strict();

export const SetCartItemSchema = z
  .object({
    quantity: z.number().int().positive(),
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
  if (!parseNoQuery(req, res)) return;

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

  const result = await commerceCartService.removeCartItem(actor, params.data.productId);
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
