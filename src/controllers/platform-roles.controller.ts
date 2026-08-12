import type { Request, Response } from "express";

import { firstParam, optionalBody } from "#src/controllers/project-error-response.js";
import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import {
  CountersignPlatformRoleSchema,
  LookupUserQuerySchema,
  ProposePlatformRoleSchema,
} from "#src/schemas/platform-roles.schemas.js";
import * as platformRolesService from "#src/services/platform-roles-admin.service.js";
import type { PlatformRoleAdminError } from "#src/services/platform-roles-admin.service.js";
import type { ApiResponse } from "#src/types/index.js";

function respondPlatformRoleError(res: Response, error: PlatformRoleAdminError): void {
  switch (error.type) {
    case "PLATFORM_CAPABILITY_REQUIRED":
      // Names no role and no resource. Decided before the email was read, so it is identical
      // for a real address and an invented one.
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This action requires a platform staff role.",
      } satisfies ApiResponse);
      return;
    case "USER_NOT_FOUND":
      // Only ever reached by a caller who already proved `manage_platform_roles`, so naming
      // the miss is help rather than disclosure.
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "No account with that email address.",
      } satisfies ApiResponse);
      return;
    case "CANNOT_CHANGE_OWN_ROLE":
      // 409: the request is well-formed and the caller is authorized — the state it targets
      // is the one thing they may not touch. Ask another admin.
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "You cannot change your own platform role. Ask another admin.",
      } satisfies ApiResponse);
      return;
    case "SELF_COUNTERSIGN_FORBIDDEN":
      // 422, matching §7A.5's mapping for the same rule on compensation statements, and for
      // the same reason: EVEN FOR A FOUNDER. One signature is not two.
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "You proposed this change, so you cannot countersign it. It needs another admin.",
      } satisfies ApiResponse);
      return;
    case "ROLE_ALREADY_SET":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: `That account already has the platform role ${error.platformRole ?? "none"}.`,
      } satisfies ApiResponse);
      return;
    case "PROPOSAL_ALREADY_EXISTS":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "A role change for that account is already waiting for a countersignature.",
      } satisfies ApiResponse);
      return;
    case "PROPOSAL_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That role change proposal does not exist.",
      } satisfies ApiResponse);
      return;
    case "PROPOSAL_ALREADY_DECIDED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That proposal has already been countersigned or withdrawn.",
      } satisfies ApiResponse);
      return;
    case "SUBJECT_ROLE_CHANGED":
      // The transition the second signature was given for no longer exists. Refused rather
      // than applied — the same posture `SNAPSHOT_STALE` takes on an equity bake.
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: `That account's role changed to ${error.platformRole ?? "none"} since this was proposed. Withdraw it and propose again.`,
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled platform role error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function respondUnauthenticated(res: Response): void {
  res.status(401).json({
    status: "error",
    statusCode: 401,
    message: "Please sign in.",
  } satisfies ApiResponse);
}

/** `GET /admin/whoami` — the caller's own role and capabilities. Never anyone else's. */
export async function getOwnStaffContext(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const selfView = await platformRolesService.readOwnStaffContext(req.user.id);
  if (selfView === null) {
    // A live session whose user row is gone. Not a 404 about someone else's id — the caller
    // simply has no account any more.
    respondUnauthenticated(res);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Staff context loaded.",
    data: selfView,
  } satisfies ApiResponse);
}

/** `GET /admin/platform-roles/lookup?email=` — ONE account, exact match. */
export async function lookupUserForRoleGrant(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = LookupUserQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const found = await platformRolesService.findUserForRoleGrant(
    req.user.id,
    parsedQuery.data.email,
  );
  if (!found.success) {
    respondPlatformRoleError(res, found.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Account loaded.",
    data: found.value,
  } satisfies ApiResponse);
}

/** `GET /admin/platform-roles/proposals` — everything waiting for a second signature. */
export async function listPlatformRoleProposals(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const proposals = await platformRolesService.listPendingPlatformRoleProposals(req.user.id);
  if (!proposals.success) {
    respondPlatformRoleError(res, proposals.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pending role changes loaded.",
    data: proposals.value,
  } satisfies ApiResponse);
}

/**
 * `POST /admin/platform-roles/proposals` — proposes a change. CHANGES NO ROLE.
 *
 * `201`, and the created row is a proposal, not a grant. Nothing about the subject's access
 * moves until a different admin countersigns.
 */
export async function proposePlatformRoleChange(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ProposePlatformRoleSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const proposed = await platformRolesService.proposePlatformRoleChange(req.user.id, {
    email: parsedBody.data.email,
    nextPlatformRole: parsedBody.data.role,
    note: parsedBody.data.note,
  });
  if (!proposed.success) {
    respondPlatformRoleError(res, proposed.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Role change proposed. It takes effect once another admin countersigns.",
    data: proposed.value,
  } satisfies ApiResponse);
}

/** `POST /admin/platform-roles/proposals/:proposalId/countersign` — the second pair of eyes. */
export async function countersignPlatformRoleChange(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  // `optionalBody`, not `req.body`: a countersignature with no note is the normal case, and
  // Express 5 leaves `req.body` undefined on a bodyless request. Reading it through the
  // helper is also what makes `required: false` in the OpenAPI body map true rather than a
  // spec that quietly loosens — `openapi-rnd-bodies.test.ts` asserts the correspondence.
  const parsedBody = CountersignPlatformRoleSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const applied = await platformRolesService.countersignPlatformRoleChange(
    req.user.id,
    firstParam(req.params.proposalId ?? ""),
    { note: parsedBody.data.note },
  );
  if (!applied.success) {
    respondPlatformRoleError(res, applied.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Platform role updated.",
    data: applied.value,
  } satisfies ApiResponse);
}

/** `DELETE /admin/platform-roles/proposals/:proposalId` — withdraws a live proposal. */
export async function cancelPlatformRoleProposal(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const cancelled = await platformRolesService.cancelPlatformRoleProposal(
    req.user.id,
    firstParam(req.params.proposalId ?? ""),
  );
  if (!cancelled.success) {
    respondPlatformRoleError(res, cancelled.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Role change withdrawn.",
    data: cancelled.value,
  } satisfies ApiResponse);
}
