import type { Request, Response } from "express";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import { ListPlatformAuditQuerySchema } from "#src/modules/platform/audit/platform-audit.schemas.js";
import * as platformAuditService from "#src/modules/platform/audit/platform-audit.service.js";
import type { PlatformAuditError } from "#src/modules/platform/audit/platform-audit.service.js";
import type { ApiResponse } from "#src/types/index.js";

function respondPlatformAuditError(res: Response, error: PlatformAuditError): void {
  switch (error.type) {
    case "PLATFORM_CAPABILITY_REQUIRED":
      // 403, decided before any id was read, so it discloses only the caller's own staff
      // status — which they already know (§4a Layer 3).
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This action requires a platform staff role.",
      } satisfies ApiResponse);
      return;
    case "PLATFORM_CHAIN_BROKEN":
      // 409, NEVER `200 { valid: false }` — the rule §9's verifier follows. A 200 saying
      // the moderation log is broken is a response a monitor reads as healthy.
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "The platform audit chain does not verify.",
        data: { sequenceNumber: error.sequenceNumber, reason: error.reason },
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled platform audit error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** `GET /admin/audit-trail` — what moderators have done, in sequence order. */
export async function listPlatformAuditTrail(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const parsedQuery = ListPlatformAuditQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const page = await platformAuditService.listPlatformAuditTrail(req.user.id, parsedQuery.data);

  if (!page.success) {
    respondPlatformAuditError(res, page.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Platform audit trail loaded.",
    data: page.value,
  } satisfies ApiResponse);
}

/** `GET /admin/audit-trail/verify` — re-walks the chain. A break is a `409`. */
export async function verifyPlatformAuditChain(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const verified = await platformAuditService.verifyPlatformAuditChain(req.user.id);

  if (!verified.success) {
    respondPlatformAuditError(res, verified.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Platform audit chain verified.",
    data: verified.value,
  } satisfies ApiResponse);
}
