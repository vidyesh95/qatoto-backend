import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  CreateRefundBodySchema,
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  ListRefundsQuerySchema,
  OrderIdParamsSchema,
  PaymentIntentIdParamsSchema,
} from "#src/schemas/commerce-payments.schemas.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import * as commercePaymentsService from "#src/services/commerce-payments.service.js";
import type { CommercePaymentsError } from "#src/services/commerce-payments.service.js";
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

function requireIdempotencyKey(req: Request, res: Response): string | null {
  const rawKey = req.header("idempotency-key") ?? req.header("Idempotency-Key");
  const parsed = z.string().trim().min(1).max(200).safeParse(rawKey);
  if (!parsed.success) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Idempotency-Key header is required.",
      data: { "Idempotency-Key": ["Required"] },
    } satisfies ApiResponse);
    return null;
  }
  return parsed.data;
}

function mapPaymentsError(res: Response, error: CommercePaymentsError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Payment resource not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You are not allowed to perform this payment action.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
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
    case "OVER_REFUND":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Refund amount exceeds the remaining refundable balance.",
        data: { refundableInCents: error.refundableInCents },
      } satisfies ApiResponse);
      return;
    case "PROVIDER_UNAVAILABLE":
      res.status(503).json({
        status: "error",
        statusCode: 503,
        message: "Payment provider is unavailable.",
        data: { reason: error.reason },
      } satisfies ApiResponse);
      return;
    case "PROVIDER_REJECTED":
      res.status(502).json({
        status: "error",
        statusCode: 502,
        message: "Payment provider rejected the request.",
        data: { reason: error.reason },
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
      throw new Error(`Unhandled commerce payments error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createPaymentIntent(req: Request, res: Response): Promise<void> {
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
  const idempotencyKey = requireIdempotencyKey(req, res);
  if (!idempotencyKey) return;

  const result = await commercePaymentsService.createPaymentIntent(
    actor,
    params.data.orderId,
    idempotencyKey,
  );
  if (!result.success) {
    mapPaymentsError(res, result.error);
    return;
  }

  // 202: local intent accepted; provider execution continues asynchronously via outbox.
  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: "Payment intent accepted for processing.",
    data: result.value.paymentIntent,
  } satisfies ApiResponse);
}

export async function getPaymentIntent(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = PaymentIntentIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commercePaymentsService.getPaymentIntent(actor, params.data.paymentIntentId);
  if (!result.success) {
    mapPaymentsError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Payment intent loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * GET /commerce/refunds — the read a refund never had (Appendix A38).
 *
 * `orderId` narrows to one order rather than being a separate route, because a refund inbox
 * and an order's refund history are the same list with a different filter, and two routes
 * would imply otherwise. Scoped to orders the caller is a party to, either side.
 */
export async function listRefunds(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListRefundsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commercePaymentsService.listRefunds(actor, {
    orderId: query.data.orderId,
    cursor: query.data.cursor,
    limit: query.data.limit,
  });
  if (!result.success) {
    mapPaymentsError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Refunds listed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function createRefund(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = CreateRefundBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }
  const idempotencyKey = requireIdempotencyKey(req, res);
  if (!idempotencyKey) return;

  const result = await commercePaymentsService.createRefund(
    actor,
    params.data.orderId,
    idempotencyKey,
    body.data,
  );
  if (!result.success) {
    mapPaymentsError(res, result.error);
    return;
  }

  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: "Refund accepted for processing.",
    data: result.value,
  } satisfies ApiResponse);
}
