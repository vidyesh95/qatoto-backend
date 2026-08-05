import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceFulfillmentService from "#src/services/commerce-fulfillment.service.js";
import type { CommerceFulfillmentError } from "#src/services/commerce-fulfillment.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();
const OrderIdParamsSchema = z.object({ orderId: z.string().trim().min(1).max(200) }).strict();
const ShipmentIdParamsSchema = z.object({ shipmentId: z.string().trim().min(1).max(200) }).strict();
const EngagementIdParamsSchema = z
  .object({ engagementId: z.string().trim().min(1).max(200) })
  .strict();
const CountryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/);

const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const ListServiceEngagementsQuerySchema = ListQuerySchema.extend({
  role: z.enum(["buyer", "provider"]).optional(),
}).strict();

const ShipmentProductLineSchema = z
  .object({
    orderProductLineId: z.string().trim().min(1).max(200),
    quantity: z.number().int().positive(),
  })
  .strict();

export const CreateShipmentSchema = z
  .object({
    lines: z.array(ShipmentProductLineSchema).min(1).max(200),
    originCountryCode: CountryCodeSchema.optional(),
    originLocality: z.string().trim().min(1).max(150).optional(),
    destinationCountryCode: CountryCodeSchema.optional(),
    destinationLocality: z.string().trim().min(1).max(150).optional(),
    packageCount: z.number().int().positive(),
    totalWeightGrams: z.number().int().positive().optional(),
  })
  .strict();

export const AppendShipmentEventSchema = z
  .object({
    eventKind: z.enum(["picked_up", "in_transit", "delivered", "exception", "cancelled"]),
    occurredAt: z.iso.datetime().optional(),
    description: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const TransitionServiceEngagementSchema = z
  .object({
    targetState: z.enum(["scheduled", "in_progress", "awaiting_buyer", "completed", "cancelled"]),
    note: z.string().trim().min(1).max(2000).optional(),
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

function mapFulfillmentError(res: Response, error: CommerceFulfillmentError): void {
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
        message: "This action is not permitted.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This action conflicts with the current state.",
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    case "VALIDATION_FAILED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: error.message,
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
      throw new Error(`Unhandled commerce fulfillment error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createShipment(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = CreateShipmentSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceFulfillmentService.createShipment(
    actor,
    params.data.orderId,
    body.data,
  );
  if (!result.success) {
    mapFulfillmentError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Shipment created.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function appendShipmentEvent(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ShipmentIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = AppendShipmentEventSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceFulfillmentService.appendShipmentEvent(
    actor,
    params.data.shipmentId,
    {
      eventKind: body.data.eventKind,
      occurredAt: body.data.occurredAt === undefined ? undefined : new Date(body.data.occurredAt),
      description: body.data.description,
    },
  );
  if (!result.success) {
    mapFulfillmentError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Shipment event recorded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listServiceEngagements(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const parsedQuery = ListServiceEngagementsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    sendZodError(res, parsedQuery.error);
    return;
  }

  const result = await commerceFulfillmentService.listServiceEngagements(actor, parsedQuery.data);
  if (!result.success) {
    mapFulfillmentError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Service engagements loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function transitionServiceEngagement(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = EngagementIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = TransitionServiceEngagementSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceFulfillmentService.transitionServiceEngagement(
    actor,
    params.data.engagementId,
    body.data,
  );
  if (!result.success) {
    mapFulfillmentError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Service engagement transitioned.",
    data: result.value,
  } satisfies ApiResponse);
}
