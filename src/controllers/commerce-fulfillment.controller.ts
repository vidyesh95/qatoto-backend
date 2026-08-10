import type { Request, Response } from "express";
import { z } from "zod";

import {
  CreateShipmentWithLegsSchema,
  ServiceEngagementCommandSchema,
  ShipmentLegCommandSchema,
} from "#src/schemas/commerce-fulfillment.schemas.js";
import * as commerceFulfillmentPhase6Service from "#src/services/commerce-fulfillment-phase6.service.js";
import type { CommercePhase6Error } from "#src/services/commerce-fulfillment-phase6.service.js";
import * as commerceFulfillmentService from "#src/services/commerce-fulfillment.service.js";
import type { CommerceFulfillmentError } from "#src/services/commerce-fulfillment.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import type { ApiResponse } from "#src/types/index.js";
import { respondValidationFailed } from "#src/controllers/project-error-response.js";

const EmptyObjectSchema = z.object({}).strict();
const OrderIdParamsSchema = z.object({ orderId: z.string().trim().min(1).max(200) }).strict();
const ShipmentIdParamsSchema = z.object({ shipmentId: z.string().trim().min(1).max(200) }).strict();
const LegIdParamsSchema = z.object({ legId: z.string().trim().min(1).max(200) }).strict();
const EngagementIdParamsSchema = z
  .object({ engagementId: z.string().trim().min(1).max(200) })
  .strict();

const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const ListServiceEngagementsQuerySchema = ListQuerySchema.extend({
  role: z.enum(["buyer", "provider"]).optional(),
}).strict();

/**
 * A29. The logistics queue's filters.
 *
 * The two ETA bounds are strict ISO instants rather than dates, because the value they
 * filter (`commerce_shipment_leg.estimated_arrival_at`) is an instant — accepting a bare
 * `2026-08-08` would silently mean midnight UTC and quietly exclude the whole day.
 */
const ListShipmentsQuerySchema = ListQuerySchema.extend({
  state: z.enum(["planned", "in_transit", "delivered", "cancelled"]).optional(),
  estimatedArrivalFrom: z.coerce.date().optional(),
  estimatedArrivalTo: z.coerce.date().optional(),
}).strict();

export const CreateShipmentSchema = CreateShipmentWithLegsSchema;

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

function requireIdempotencyKey(req: Request, res: Response): string | null {
  const rawHeader = req.headers["idempotency-key"];
  const key = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (key === undefined || key.length < 8 || key.length > 200) {
    res.status(400).json({
      status: "error",
      statusCode: 400,
      message: "This request requires an Idempotency-Key header between 8 and 200 characters.",
    } satisfies ApiResponse);
    return null;
  }
  return key;
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

function mapPhase6Error(res: Response, error: CommercePhase6Error): void {
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
        message: `Command ${error.command} is not valid from state ${error.currentState}.`,
        data: { currentState: error.currentState, command: error.command },
      } satisfies ApiResponse);
      return;
    case "VERSION_CONFLICT":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "The resource version changed. Reload and retry.",
        data: { currentVersion: error.currentVersion },
      } satisfies ApiResponse);
      return;
    case "IDEMPOTENCY_CONFLICT":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This Idempotency-Key was already used for a different request.",
      } satisfies ApiResponse);
      return;
    case "PROVIDER_KIND_MISMATCH":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Provider kind does not match the engagement.",
      } satisfies ApiResponse);
      return;
    case "CONTRACT_SNAPSHOT_MISSING":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "This engagement is missing an accepted typed execution snapshot. Initialize it before continuing.",
      } satisfies ApiResponse);
      return;
    case "DELIVERABLE_NORMALIZATION_REQUIRED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "This engagement has an unresolved free-text deliverable obligation. Normalize structured deliverables before completing.",
      } satisfies ApiResponse);
      return;
    case "REQUIRED_DELIVERABLES_INCOMPLETE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Required deliverables are incomplete.",
        data: { deliverableIds: error.deliverableIds },
      } satisfies ApiResponse);
      return;
    case "DOCUMENT_NOT_AVAILABLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Evidence document is not available.",
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
      throw new Error(`Unhandled Phase 6 fulfillment error: ${JSON.stringify(exhaustiveCheck)}`);
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

/**
 * A29. The cross-order logistics queue, scoped to the active organization as the order
 * counterparty — a freight forwarder carrying forty shipments across thirty-one orders
 * had no route that listed them.
 */
export async function listCounterpartyShipments(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const parsedQuery = ListShipmentsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    sendZodError(res, parsedQuery.error);
    return;
  }

  const result = await commerceFulfillmentService.listCounterpartyShipments(
    actor,
    parsedQuery.data,
  );
  if (!result.success) {
    mapFulfillmentError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Shipments loaded.",
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

export async function getOrderFulfillment(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceFulfillmentPhase6Service.getOrderFulfillment(
    actor,
    params.data.orderId,
  );
  if (!result.success) {
    mapPhase6Error(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Order fulfillment loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getShipment(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ShipmentIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceFulfillmentPhase6Service.getShipmentDetail(
    actor,
    params.data.shipmentId,
  );
  if (!result.success) {
    mapPhase6Error(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Shipment loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getServiceEngagement(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = EngagementIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceFulfillmentPhase6Service.getServiceEngagementDetail(
    actor,
    params.data.engagementId,
  );
  if (!result.success) {
    mapPhase6Error(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Service engagement loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function executeShipmentLegCommand(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;
  const idempotencyKey = requireIdempotencyKey(req, res);
  if (!idempotencyKey) return;

  const params = LegIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ShipmentLegCommandSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceFulfillmentPhase6Service.executeShipmentLegCommand(
    actor,
    params.data.legId,
    {
      idempotencyKey,
      requestFingerprint: commerceFulfillmentPhase6Service.buildFulfillmentRequestFingerprint({
        path: req.originalUrl,
        body: body.data,
      }),
    },
    body.data,
  );
  if (!result.success) {
    mapPhase6Error(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Shipment leg command executed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function executeServiceEngagementCommand(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;
  const idempotencyKey = requireIdempotencyKey(req, res);
  if (!idempotencyKey) return;

  const params = EngagementIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ServiceEngagementCommandSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceFulfillmentPhase6Service.executeServiceEngagementCommand(
    actor,
    params.data.engagementId,
    {
      idempotencyKey,
      requestFingerprint: commerceFulfillmentPhase6Service.buildFulfillmentRequestFingerprint({
        path: req.originalUrl,
        body: body.data,
      }),
    },
    body.data,
  );
  if (!result.success) {
    mapPhase6Error(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Service engagement command executed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listShipmentLegEvents(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = LegIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceFulfillmentPhase6Service.listShipmentLegEvents(
    actor,
    params.data.legId,
  );
  if (!result.success) {
    mapPhase6Error(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Shipment leg events loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listServiceEngagementEvents(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = EngagementIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceFulfillmentPhase6Service.listServiceEngagementEvents(
    actor,
    params.data.engagementId,
  );
  if (!result.success) {
    mapPhase6Error(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Service engagement events loaded.",
    data: result.value,
  } satisfies ApiResponse);
}
