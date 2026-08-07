import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceCheckoutService from "#src/services/commerce-checkout.service.js";
import type { CommerceCheckoutError } from "#src/services/commerce-checkout.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();

export const PrepareCheckoutSchema = z
  .object({
    deliveryAddressId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const ConfirmCheckoutSchema = z
  .object({
    prepareId: z.string().trim().min(1).max(200),
    deliveryAddressId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const IDEMPOTENCY_HEADER = "idempotency-key";

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

/**
 * The SAME client-supplied `Idempotency-Key` the `idempotency` middleware already fingerprints
 * for byte-level response replay is also forwarded to the service as the domain-level
 * `prepareIdempotencyKey`/`confirmIdempotencyKey` — the value the unique partial indexes on
 * `commerce_checkout_prepare` and `commerce_checkout_group` key on. One header, two purposes:
 * the middleware replays an identical retried request; the service turns a concurrent
 * duplicate that raced past it into a reload of the same prepare/group rather than a second one.
 */
function extractIdempotencyKeyHeader(req: Request): string | undefined {
  const rawHeader = req.headers[IDEMPOTENCY_HEADER];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return headerValue === undefined || headerValue === "" ? undefined : headerValue;
}

function mapCheckoutError(res: Response, error: CommerceCheckoutError): void {
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
    case "ADDRESS_NOT_OWNED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message:
          error.type === "VALIDATION_FAILED"
            ? error.message
            : "Delivery address is not owned by the buyer organization.",
      } satisfies ApiResponse);
      return;
    case "SAMPLE_NOT_AVAILABLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "This listing does not offer a sample.",
        data: { productId: error.productId },
      } satisfies ApiResponse);
      return;
    case "CUSTOMIZATION_REJECTED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "A cart line's customization cannot be applied.",
        data: { productId: error.productId, customizationError: error.customizationError },
      } satisfies ApiResponse);
      return;
    case "ADDRESS_KIND_INVALID":
      // 422, and a message that names the real problem: the address is theirs, it is
      // simply not one for receiving goods (A15).
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Choose a delivery address. That address is saved for another purpose.",
        data: { addressKind: error.addressKind },
      } satisfies ApiResponse);
      return;
    case "EMPTY_CART":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "The cart has no lines to check out.",
      } satisfies ApiResponse);
      return;
    case "PRODUCT_NOT_PURCHASABLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "A cart line is no longer purchasable.",
        data: { productId: error.productId },
      } satisfies ApiResponse);
      return;
    case "BELOW_MINIMUM_ORDER_QUANTITY":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "A cart line is below the minimum order quantity.",
        data: { productId: error.productId, minimumOrderQuantity: error.minimumOrderQuantity },
      } satisfies ApiResponse);
      return;
    case "INSUFFICIENT_STOCK":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "A cart line has insufficient stock.",
        data: { productId: error.productId, availableQuantity: error.availableQuantity },
      } satisfies ApiResponse);
      return;
    case "VARIANT_REQUIRED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "A cart line is missing its variant. Choose a variant before checking out.",
        data: { productId: error.productId },
      } satisfies ApiResponse);
      return;
    case "VARIANT_NOT_PURCHASABLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "A cart line references a variant that is no longer purchasable.",
        data: { productId: error.productId },
      } satisfies ApiResponse);
      return;
    case "PRICE_CHANGED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "A product's price changed since checkout was prepared.",
        data: {
          productId: error.productId,
          previousUnitPriceInCents: error.previousUnitPriceInCents,
          currentUnitPriceInCents: error.currentUnitPriceInCents,
        },
      } satisfies ApiResponse);
      return;
    case "PREPARE_EXPIRED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This checkout preparation has expired. Prepare checkout again.",
      } satisfies ApiResponse);
      return;
    case "PREPARE_NOT_ACTIVE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This checkout preparation is no longer active.",
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
      throw new Error(`Unhandled commerce checkout error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function prepareCheckout(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const body = PrepareCheckoutSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceCheckoutService.prepareCheckout(
    actor,
    body.data,
    extractIdempotencyKeyHeader(req),
  );
  if (!result.success) {
    mapCheckoutError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Checkout prepared.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function confirmCheckout(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const body = ConfirmCheckoutSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceCheckoutService.confirmCheckout(
    actor,
    body.data,
    extractIdempotencyKeyHeader(req),
  );
  if (!result.success) {
    mapCheckoutError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Checkout confirmed.",
    data: result.value,
  } satisfies ApiResponse);
}
