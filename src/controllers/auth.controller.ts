import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { z } from "zod";

import { auth } from "#src/lib/auth.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Body for POST /set-initial-password. `.strict()` rejects unknown keys.
 */
const SetInitialPasswordSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters."),
  })
  .strict();

/**
 * POST /set-initial-password — phase 2 of OTP signup.
 *
 * Better Auth cannot verify an OTP for a user that does not exist, so signup is
 * two phases: `sign-in/email-otp` creates the verified, credential-less user and
 * sets the session cookie, then this endpoint sets their first password.
 *
 * Idempotent: a user who already has a password is a no-op (handles the orphan
 * recovery flow in AUTH_SETUP §7b). Identity comes from the session cookie, never
 * the body.
 */
export async function setInitialPassword(req: Request, res: Response): Promise<void> {
  const parsedBody = SetInitialPasswordSchema.safeParse(req.body);

  if (!parsedBody.success) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Validation failed",
      errors: parsedBody.error.flatten().fieldErrors,
    });
    return;
  }

  const headers = fromNodeHeaders(req.headers);

  // GUARD: setPassword is for credential-less accounts only — calling it on a
  // user who already has a password errors. Check first; no-op if already set.
  const accounts = await auth.api.listUserAccounts({ headers });
  const hasPassword = accounts.some((account) => account.providerId === "credential");

  if (hasPassword) {
    const response: ApiResponse<{ ok: true; alreadySet: true }> = {
      status: "success",
      statusCode: 200,
      message: "Password already set.",
      data: { ok: true, alreadySet: true },
    };
    res.status(200).json(response);
    return;
  }

  await auth.api.setPassword({
    body: { newPassword: parsedBody.data.password },
    headers,
  });

  const response: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 200,
    message: "Password set successfully.",
    data: { ok: true },
  };
  res.status(200).json(response);
}

/**
 * GET /me — the authenticated user, derived from the session cookie.
 */
export function getCurrentUser(req: Request, res: Response): void {
  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Current user retrieved successfully",
    data: req.user,
  };
  res.status(200).json(response);
}
