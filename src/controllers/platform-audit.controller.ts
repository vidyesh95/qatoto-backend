import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import * as platformAuditService from "#src/services/platform-audit.service.js";
import type { PlatformAuditError } from "#src/services/platform-audit.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The platform moderation log (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 2).
 *
 * THE CAPABILITY CHECK LIVES IN THE SERVICE, before any id is read — the same shape every
 * `/discovery/admin/*` route uses, and the reason its `403` is not an id oracle (§4a Layer
 * 3). It is not middleware for the reason `discovery-moderation.controller.ts` states:
 * middleware cannot return a `Result` and so cannot participate in the exhaustive switch
 * that maps domain errors to statuses.
 */

const PLATFORM_AUDIT_EVENT_KINDS = [
  "taxonomy_category_approved",
  "taxonomy_category_rejected",
  "cluster_merge_approved",
  "cluster_merge_rejected",
  "discovery_skill_created",
  "discovery_skill_updated",
  "discovery_skill_deleted",
  "discovery_region_created",
  "discovery_region_updated",
  "discovery_region_deleted",
  "market_insight_created",
  "market_insight_updated",
  "market_insight_deleted",
  "market_insight_published",
  "market_insight_unpublished",
  "supplier_created",
  "supplier_updated",
  "content_review_approved",
  "content_review_rejected",
  "platform_role_granted",
  "platform_role_revoked",
] as const;

/**
 * `fromSequence`, not `page`. The sequence is gapless and monotonic by construction, so it
 * is a better cursor than any timestamp — and an append-only log is exactly the shape where
 * OFFSET drifts under concurrent writes (§4c rule 4).
 */
export const ListPlatformAuditQuerySchema = z
  .object({
    fromSequence: z.coerce.number().int().min(1).optional(),
    eventKind: z.enum(PLATFORM_AUDIT_EVENT_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

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
