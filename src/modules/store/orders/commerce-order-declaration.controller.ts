import type { Request, Response } from "express";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  DeclarationParamsSchema,
  OrderIdParamsSchema,
  RecordDeclarationBodySchema,
} from "#src/modules/store/orders/commerce-order-declaration.schemas.js";
import * as commerceOrderDeclarationService from "#src/modules/store/orders/commerce-order-declaration.service.js";
import type { CommerceOrderDeclarationError } from "#src/modules/store/orders/commerce-order-declaration.service.js";
import { EmptyObjectSchema } from "#src/modules/store/orders/commerce-settlement-attestation.schemas.js";
import type { ApiResponse } from "#src/types/index.js";

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
 * Every refusal carries the backend's own sentence. The stale-disclaimer 409 also carries the
 * current version in `data`, so a client can tell the reader to reload rather than guess.
 */
function mapDeclarationError(res: Response, error: CommerceOrderDeclarationError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Order not found.",
      } satisfies ApiResponse);
      return;
    case "DECLARATION_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That declaration is not on this order.",
      } satisfies ApiResponse);
      return;
    case "ORDER_CANCELLED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This order was cancelled, so nothing new can be recorded against it.",
      } satisfies ApiResponse);
      return;
    case "DISCLAIMER_VERSION_STALE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "The notice you acknowledged has since changed. Reload the page, read the current notice and try again.",
        data: { currentDisclaimerVersion: error.currentVersion },
      } satisfies ApiResponse);
      return;
    case "LEG_NOT_ON_ORDER":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That shipment leg is not part of this order.",
      } satisfies ApiResponse);
      return;
    case "DOCUMENT_NOT_AVAILABLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message:
          "That document is not yours, or has not finished its safety scan. Attach it once it shows as ready.",
      } satisfies ApiResponse);
      return;
    case "NOT_AUTHOR":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Only the party that recorded this can withdraw it.",
      } satisfies ApiResponse);
      return;
    case "ALREADY_WITHDRAWN":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This was already withdrawn.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled order declaration error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function listOrderDeclarations(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = EmptyObjectSchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }
  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const result = await commerceOrderDeclarationService.listOrderDeclarations(
    actor,
    params.data.orderId,
  );
  if (!result.success) {
    mapDeclarationError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Declarations loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function recordOrderDeclaration(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = EmptyObjectSchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }
  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }
  const body = RecordDeclarationBodySchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await commerceOrderDeclarationService.recordOrderDeclaration(
    actor,
    params.data.orderId,
    body.data,
  );
  if (!result.success) {
    mapDeclarationError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Declaration recorded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function withdrawOrderDeclaration(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = EmptyObjectSchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }
  const params = DeclarationParamsSchema.safeParse(req.params);
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }
  const body = EmptyObjectSchema.safeParse(req.body ?? {});
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await commerceOrderDeclarationService.withdrawOrderDeclaration(
    actor,
    params.data.orderId,
    params.data.declarationId,
  );
  if (!result.success) {
    mapDeclarationError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Declaration withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}
