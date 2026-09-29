import type { Request, Response } from "express";

import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-engagement-error-response.js";
import { respondBlueprintRightsClaimError } from "#src/modules/home/blueprints/blueprint-rights-claim-error-response.js";
import {
  BlueprintRightsClaimQueueQuerySchema,
  CreateBlueprintRightsClaimSchema,
  DismissBlueprintRightsClaimSchema,
} from "#src/modules/home/blueprints/blueprint-rights-claim.schemas.js";
import * as blueprintRightsClaimService from "#src/modules/home/blueprints/blueprint-rights-claim.service.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The rights-claim intake and the moderator queue that answers it.
 */

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

/**
 * ⚠️ RESOLVED BEFORE `req.params` IS READ AND BEFORE THE BODY IS PARSED — §3.6. Reversed, a 403 that
 * only arrives for claims that exist is an existence oracle over the queue.
 */
async function resolveModerator(req: Request, res: Response): Promise<PlatformStaffContext | null> {
  const viewerId = req.user?.id;
  if (!viewerId) {
    respondUnauthenticated(res);
    return null;
  }
  const capabilityResult = await requirePlatformCapability(viewerId, "moderate_content");
  if (!capabilityResult.success) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "You do not have permission to moderate content.",
    });
    return null;
  }
  return capabilityResult.value;
}

/** `POST /blueprints/teardowns/:teardownSlug/claims`. */
export async function createRightsClaim(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateBlueprintRightsClaimSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await blueprintRightsClaimService.createBlueprintRightsClaim({
    teardownSlug: firstParam(req.params.teardownSlug ?? ""),
    claimantUserId: req.user.id,
    claimKind: parsedBody.data.claimKind,
    target: parsedBody.data.target,
    claimantFullName: parsedBody.data.claimantFullName,
    claimantOrganizationName: parsedBody.data.claimantOrganizationName,
    claimantEmail: parsedBody.data.claimantEmail,
    relationshipToRightsHolder: parsedBody.data.relationshipToRightsHolder,
    claimSubstance: parsedBody.data.claimSubstance,
  });

  if (!result.success) {
    respondBlueprintRightsClaimError(res, result.error);
    return;
  }

  /*
   * ⚠️ 201 AND A RECEIPT, NOTHING ELSE. The row exists; no verdict does, and nothing about the
   * teardown changed. "Received" is the whole claim this response makes.
   */
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Received. A moderator will read it.",
    data: {
      claimId: result.value.claimId,
      status: result.value.status,
      receivedAt: result.value.receivedAt.toISOString(),
    },
  } satisfies ApiResponse);
}

/** `GET /blueprints/admin/rights-claims`. */
export async function listRightsClaimQueue(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const parsedQuery = BlueprintRightsClaimQueueQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const result = await blueprintRightsClaimService.listRightsClaimQueue({
    status: parsedQuery.data.status,
    limit: parsedQuery.data.limit,
    cursor: parsedQuery.data.cursor,
    staff,
  });

  if (!result.success) {
    respondBlueprintRightsClaimError(res, result.error);
    return;
  }

  respondOk(res, "Rights claims.", result.value);
}

/** `POST /blueprints/admin/rights-claims/:claimId/dismiss`. */
export async function dismissRightsClaim(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const parsedBody = DismissBlueprintRightsClaimSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await blueprintRightsClaimService.dismissBlueprintRightsClaim({
    claimId: firstParam(req.params.claimId ?? ""),
    resolutionNote: parsedBody.data.resolutionNote,
    staff,
  });

  if (!result.success) {
    respondBlueprintRightsClaimError(res, result.error);
    return;
  }

  respondOk(res, "Dismissed.", result.value);
}
