import type { Request, Response } from "express";
import { z } from "zod";

import * as platformRolesService from "#src/services/platform-roles-admin.service.js";
import type { PlatformRoleAdminError } from "#src/services/platform-roles-admin.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Staff role administration (§4a Layer 3).
 *
 * THE CAPABILITY CHECK LIVES IN THE SERVICE, before any email is read — the shape every
 * staff route here uses, and the reason a `403` from these routes is not an oracle for
 * whether an account exists.
 *
 * `whoami` is the exception and deliberately so: it needs no capability because it reports
 * only on the caller, and a caller learning their own staff status learns nothing they could
 * not already get by calling a staff route and reading the status code.
 */

/** The assignable roles, plus `null` to revoke. */
export const SetPlatformRoleSchema = z
  .object({
    email: z.string().trim().email().max(320),
    /**
     * `null` REVOKES. Nullable rather than a `"none"` sentinel because JSON has a spelling
     * for absence and the column is genuinely nullable — the script's `--role=none` exists
     * only because a shell argument cannot be null.
     */
    role: z.enum(["moderator", "auditor", "admin"]).nullable(),
  })
  .strict();

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

export const LookupUserQuerySchema = z
  .object({ email: z.string().trim().email().max(320) })
  .strict();

/** `GET /admin/platform-roles/lookup?email=` — ONE account, exact match. */
export async function lookupUserForRoleGrant(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = LookupUserQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Validation failed.",
      data: parsedQuery.error.flatten().fieldErrors,
    } satisfies ApiResponse);
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

/** `PUT /admin/platform-roles` — grant, change or revoke. Idempotent by value. */
export async function setPlatformRole(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = SetPlatformRoleSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Validation failed.",
      data: parsedBody.error.flatten().fieldErrors,
    } satisfies ApiResponse);
    return;
  }

  const updated = await platformRolesService.setPlatformRole(req.user.id, {
    email: parsedBody.data.email,
    nextPlatformRole: parsedBody.data.role,
  });
  if (!updated.success) {
    respondPlatformRoleError(res, updated.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Platform role updated.",
    data: updated.value,
  } satisfies ApiResponse);
}
