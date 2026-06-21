import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
import { auth } from "#src/lib/auth.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Body for POST /signup/start. `.strict()` rejects unknown keys.
 */
const StartSignupSchema = z
  .object({
    email: z.email("A valid email is required."),
  })
  .strict();

/**
 * Body for POST /signup/complete. `.strict()` rejects unknown keys.
 */
const CompleteSignupSchema = z
  .object({
    email: z.email("A valid email is required."),
    otp: z.string().min(1, "Verification code is required."),
    password: z.string().min(8, "Password must be at least 8 characters."),
    name: z.string().min(1).optional(),
  })
  .strict();

/**
 * Emit a 422 validation-failure envelope from a Zod parse error.
 */
function respondValidationFailed(res: Response, fieldErrors: Record<string, string[] | undefined>): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "Validation failed",
    errors: fieldErrors,
  });
}

/**
 * POST /signup/start — phase 1 of signup.
 *
 * Sends a one-time code to the email. Crucially, this does NOT create a user:
 * `disableSignUp: true` on the OTP plugin means an OTP alone can never mint an
 * account. The account is created only by /signup/complete once the password is
 * also supplied. Always returns a generic 200 so the endpoint can't be used to
 * probe which emails are registered.
 */
export async function startSignup(req: Request, res: Response): Promise<void> {
  const parsedBody = StartSignupSchema.safeParse(req.body);

  if (!parsedBody.success) {
    respondValidationFailed(res, z.flattenError(parsedBody.error).fieldErrors);
    return;
  }

  await auth.api.sendVerificationOTP({
    body: { email: parsedBody.data.email, type: "sign-in" },
  });

  const response: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 200,
    message: "If that email can sign up, a verification code has been sent.",
    data: { ok: true },
  };
  res.status(200).json(response);
}

/**
 * POST /signup/complete — phase 2 of signup, and the ONLY place a user is created.
 *
 * Atomic: the OTP is verified first; only if it is valid is the account created
 * with its password. A wrong/expired code, or a missing password (rejected at the
 * schema boundary), leaves no user behind — there are no password-less orphans.
 *
 * Order matters:
 *   1. checkVerificationOTP — proves the caller owns the email. No user touched.
 *   2. signUpEmail          — creates the user + credential, opens the session.
 *   3. mark emailVerified   — the OTP just proved ownership.
 */
export async function completeSignup(req: Request, res: Response): Promise<void> {
  const parsedBody = CompleteSignupSchema.safeParse(req.body);

  if (!parsedBody.success) {
    respondValidationFailed(res, z.flattenError(parsedBody.error).fieldErrors);
    return;
  }

  const { email, otp, password } = parsedBody.data;
  const displayName = parsedBody.data.name ?? email.split("@")[0];

  // 1. Verify the code BEFORE any account exists. Invalid/expired → no user created.
  try {
    await auth.api.checkVerificationOTP({ body: { email, otp, type: "sign-in" } });
  } catch (error) {
    if (error instanceof APIError) {
      res.status(401).json({
        status: "error",
        statusCode: 401,
        message: "Invalid or expired verification code.",
      });
      return;
    }
    throw error;
  }

  // 2. OTP is valid — now (and only now) create the account with its password.
  let sessionSetCookies: string[];
  try {
    const { headers: authHeaders } = await auth.api.signUpEmail({
      body: { email, password, name: displayName },
      returnHeaders: true,
    });
    sessionSetCookies = authHeaders.getSetCookie();
  } catch (error) {
    if (error instanceof APIError) {
      // Most likely: the email already belongs to a complete account.
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "An account with this email already exists. Please sign in instead.",
      });
      return;
    }
    throw error;
  }

  // 3. The OTP proved email ownership, so the account is verified from the start.
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));

  // Forward Better Auth's session cookie so the new user is logged in immediately.
  if (sessionSetCookies.length > 0) {
    res.setHeader("set-cookie", sessionSetCookies);
  }

  const response: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 201,
    message: "Account created successfully.",
    data: { ok: true },
  };
  res.status(201).json(response);
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
