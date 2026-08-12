import type { Request, Response } from "express";
import type { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  EmptyObjectSchema,
  OrderIdParamsSchema,
  RecordSettlementAttestationBodySchema,
} from "#src/modules/store/orders/commerce-settlement-attestation.schemas.js";
import * as commerceSettlementAttestationService from "#src/modules/store/orders/commerce-settlement-attestation.service.js";
import type { CommerceSettlementAttestationError } from "#src/modules/store/orders/commerce-settlement-attestation.service.js";
import type { ApiResponse } from "#src/types/index.js";

function sendZodError(res: Response, error: z.ZodError): void {
  respondValidationFailed(res, error);
}

function requireCommerceActor(
  req: Request,
  res: Response,
): { organizationId: string; memberId: string; actorUserId: string } | null {
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
    actorUserId: req.user.id,
  };
}

/**
 * Every refusal carries the backend's own sentence, and the two 409s carry the fact that
 * distinguishes them in `data`. A client cannot render "this order settles through a processor,
 * there is nothing to attest" from a bare status code, and guessing at the reason is how a page
 * ends up telling a seller to retry something that will never succeed.
 */
function mapAttestationError(res: Response, error: CommerceSettlementAttestationError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Order not found.",
      } satisfies ApiResponse);
      return;
    case "RAIL_NOT_ATTESTABLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "This order does not settle directly between the two parties, so there is nothing to attest.",
        data: { settlementRail: error.settlementRail },
      } satisfies ApiResponse);
      return;
    case "ALREADY_ATTESTED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "You have already recorded this payment. Recorded payments are not edited.",
        data: { attestationKind: error.attestationKind },
      } satisfies ApiResponse);
      return;
    case "VALIDATION_FAILED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: error.message,
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(
        `Unhandled settlement attestation error: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

export async function listSettlementAttestations(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = EmptyObjectSchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }
  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceSettlementAttestationService.listSettlementAttestations(
    actor,
    params.data.orderId,
  );
  if (!result.success) {
    mapAttestationError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Settlement attestations loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function recordSettlementAttestation(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = EmptyObjectSchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }
  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = RecordSettlementAttestationBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceSettlementAttestationService.recordSettlementAttestation(
    actor,
    params.data.orderId,
    {
      amountInCents: body.data.amountInCents,
      occurredAt: body.data.occurredAt,
      referenceNote: body.data.referenceNote ?? null,
    },
  );
  if (!result.success) {
    mapAttestationError(res, result.error);
    return;
  }

  /**
   * 201, and the body is the WHOLE list rather than the created row — see the service. The
   * counterparty's claim beside your own is the answer to the question that made you open this
   * form, and a client that had to issue a second GET to see it would race its own write.
   */
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Payment recorded.",
    data: result.value,
  } satisfies ApiResponse);
}
