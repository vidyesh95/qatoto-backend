import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceOrdersService from "#src/services/commerce-orders.service.js";
import type { CommerceOrdersError } from "#src/services/commerce-orders.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();
const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);
const OrderIdParamsSchema = z.object({ orderId: z.string().trim().min(1).max(200) }).strict();
const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
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
