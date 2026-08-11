import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import { FreightModeSchema } from "#src/schemas/commerce-freight-rates.schemas.js";
import * as commerceArrivalWindowService from "#src/services/commerce-arrival-window.service.js";
import * as commerceDeliveryAddressService from "#src/services/commerce-delivery-address.service.js";
import type { CommerceDeliveryAddressError } from "#src/services/commerce-delivery-address.service.js";
import * as commerceOrdersService from "#src/services/commerce-orders.service.js";
import type { CommerceOrdersError } from "#src/services/commerce-orders.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();
const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);
const OrderIdParamsSchema = z.object({ orderId: z.string().trim().min(1).max(200) }).strict();
/**
 * §19.4's mode selection, and the whole of it.
 *
 * OPTIONAL, AND NOTHING IS AUTO-SELECTED WHEN IT IS ABSENT. Omitting it is a legitimate state
 * the projection reports — `freight: unknown / mode_not_selected`, with the covered modes
 * listed — rather than a prompt for the server to guess. Picking the cheapest would publish
 * the slowest window as though the buyer had chosen it.
 */
const ArrivalWindowQuerySchema = z.object({ mode: FreightModeSchema.optional() }).strict();

const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
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

function parseListQuery(req: Request, res: Response): z.infer<typeof ListQuerySchema> | null {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return null;
  }
  return parsed.data;
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

function mapOrdersError(res: Response, error: CommerceOrdersError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Order not found.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This order's current state does not allow this action.",
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
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
      throw new Error(`Unhandled commerce orders error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function listBuyerOrders(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  const listQuery = parseListQuery(req, res);
  if (!listQuery) return;

  const result = await commerceOrdersService.listBuyerOrders(actor, listQuery);
  if (!result.success) {
    mapOrdersError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Buyer orders loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listCounterpartyOrders(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  const listQuery = parseListQuery(req, res);
  if (!listQuery) return;

  const result = await commerceOrdersService.listCounterpartyOrders(actor, listQuery);
  if (!result.success) {
    mapOrdersError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Counterparty orders loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceOrdersService.getOrder(actor, params.data.orderId);
  if (!result.success) {
    mapOrdersError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Order loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function cancelOrder(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceOrdersService.cancelOrder(actor, params.data.orderId);
  if (!result.success) {
    mapOrdersError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Order cancelled.",
    data: result.value,
  } satisfies ApiResponse);
}

function mapDeliveryAddressError(res: Response, error: CommerceDeliveryAddressError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Order not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Your role cannot read delivery details for this order.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This order is not at a stage where delivery details are released.",
        data: { orderState: error.orderState },
      } satisfies ApiResponse);
      return;
    case "ADDRESS_UNAVAILABLE":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "This order carries no buyer-chosen delivery address.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveError: never = error;
      throw new Error(`Unhandled delivery address error: ${JSON.stringify(exhaustiveError)}`);
    }
  }
}

/**
 * GET /commerce/orders/:orderId/delivery-address
 *
 * A15. The order snapshot records a city and a postcode by design; this is how a seller
 * with an active order reaches the street lines, recipient name and phone that the
 * snapshot deliberately omits. Every counterparty read is audited on the buyer's stream.
 */
/**
 * §19.4's arrival window. A read, so no idempotency and no body.
 *
 * The service reuses `CommerceOrdersError`, so `mapOrdersError` handles the refusals unchanged
 * — including the 404 a non-party gets, which is byte-identical to the one an unknown id gets.
 */
export async function getOrderArrivalWindow(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const query = ArrivalWindowQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const arrivalWindowResult = await commerceArrivalWindowService.getOrderArrivalWindow(
    { organizationId: actor.organizationId },
    params.data.orderId,
    { mode: query.data.mode, asOf: new Date() },
  );

  if (!arrivalWindowResult.success) {
    mapOrdersError(res, arrivalWindowResult.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Order arrival window.",
    data: { arrivalWindow: arrivalWindowResult.value },
  } satisfies ApiResponse);
}

export async function getOrderDeliveryAddress(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceDeliveryAddressService.revealOrderDeliveryAddress(
    actor,
    params.data.orderId,
  );
  if (!result.success) {
    mapDeliveryAddressError(res, result.error);
    return;
  }

  /**
   * `no-store`: this response is decrypted PII. It must not sit in a shared cache, a
   * proxy, or a browser's disk cache after the tab closes.
   */
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Delivery address.",
    data: result.value,
  } satisfies ApiResponse);
}
