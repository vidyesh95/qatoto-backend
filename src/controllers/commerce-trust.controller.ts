import type { Request, Response } from "express";
import { z } from "zod";

import {
  CompletionIdParamsSchema,
  CreateDisputeSchema,
  CreateReviewSchema,
  DecideDisputeSchema,
  DisputeIdParamsSchema,
  ListDisputesQuerySchema,
  OrderIdParamsSchema,
} from "#src/schemas/commerce-trust.schemas.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import * as commerceTrustService from "#src/services/commerce-trust.service.js";
import type { CommerceTrustError } from "#src/services/commerce-trust.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();

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

function mapTrustError(res: Response, error: CommerceTrustError): void {
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
    case "SELF_REVIEW_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Self-review is not allowed.",
      } satisfies ApiResponse);
      return;
    case "DISPUTE_PARTY_MODERATION_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "A member of a dispute party cannot decide that dispute.",
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
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Platform capability required.",
        data: { capability: error.capability },
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce trust error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createReview(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = CompletionIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = CreateReviewSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceTrustService.createReview(
    actor,
    params.data.completionId,
    body.data,
  );
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Review created.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function openDispute(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = CreateDisputeSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceTrustService.openDispute(actor, params.data.orderId, body.data);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Dispute opened.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listModeratorDisputes(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const query = ListDisputesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceTrustService.listDisputesForModerator(req.user.id, query.data);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Disputes loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function decideDispute(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const params = DisputeIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = DecideDisputeSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceTrustService.decideDispute(
    req.user.id,
    params.data.disputeId,
    body.data,
  );
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Dispute decided.",
    data: result.value,
  } satisfies ApiResponse);
}
