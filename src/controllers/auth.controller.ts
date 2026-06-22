import { APIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";
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
function respondValidationFailed(
  res: Response,
  fieldErrors: Record<string, string[] | undefined>,
): void {
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
 * Reduce a list of `Set-Cookie` response headers to a single `Cookie` request
 * header (only `name=value`, attributes like `Path`/`HttpOnly` dropped). Lets us
 * replay a freshly minted session back into another server-side `auth.api` call.
 */
function setCookiesToCookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((setCookie) => setCookie.split(";")[0]).join("; ");
}

/**
 * POST /signup/complete — phase 2 of signup. Resolves an email + verified OTP +
 * password into exactly ONE user, whichever of two paths the email is on:
 *
 *  - Brand-new email           → create user + credential + session (signUpEmail).
 *  - Existing OAuth-only user  → attach a password to that SAME user (no second
 *                                row), then sign them in. This is what makes
 *                                google/github → email-password collapse to one
 *                                account instead of erroring.
 *  - Existing user that ALREADY has a password → genuine re-signup → 409; the
 *                                caller should sign in or use forgot-password.
 *
 * Every path requires a valid OTP first, so a wrong/expired code (or a missing
 * password, rejected at the schema boundary) never mutates an account.
 */
export async function completeSignup(req: Request, res: Response): Promise<void> {
  const parsedBody = CompleteSignupSchema.safeParse(req.body);

  if (!parsedBody.success) {
    respondValidationFailed(res, z.flattenError(parsedBody.error).fieldErrors);
    return;
  }

  const { email, otp, password } = parsedBody.data;
  const displayName = parsedBody.data.name ?? email.split("@")[0];

  const [existingUser] = await db.select().from(user).where(eq(user.email, email)).limit(1);

  // ── Path A: no user yet — verify ownership, then create the account. ──────────
  if (!existingUser) {
    // Verify the code BEFORE any account exists. Invalid/expired → no user created.
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

    // OTP is valid — now (and only now) create the account with its password.
    let sessionSetCookies: string[];
    try {
      const { headers: authHeaders } = await auth.api.signUpEmail({
        body: { email, password, name: displayName },
        returnHeaders: true,
      });
      sessionSetCookies = authHeaders.getSetCookie();
    } catch (error) {
      if (error instanceof APIError) {
        // Lost a race: the email was claimed between the lookup and signUpEmail.
        res.status(409).json({
          status: "error",
          statusCode: 409,
          message: "An account with this email already exists. Please sign in instead.",
        });
        return;
      }
      throw error;
    }

    // The OTP proved email ownership, so the account is verified from the start.
    await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));

    if (sessionSetCookies.length > 0) {
      res.setHeader("set-cookie", sessionSetCookies);
    }

    const createdResponse: ApiResponse<{ ok: true }> = {
      status: "success",
      statusCode: 201,
      message: "Account created successfully.",
      data: { ok: true },
    };
    res.status(201).json(createdResponse);
    return;
  }

  // ── Path B: user exists. If they already have a password, this is a re-signup. ─
  const [credentialAccount] = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, existingUser.id), eq(account.providerId, "credential")))
    .limit(1);

  if (credentialAccount) {
    res.status(409).json({
      status: "error",
      statusCode: 409,
      message: "An account with this email already exists. Please sign in instead.",
    });
    return;
  }

  // ── Path C: existing OAuth-only user adding a password — link, do not duplicate.
  // Sign in via OTP (proves ownership AND mints a session for this exact user),
  // then attach the password to that same user with setPassword.
  let sessionSetCookies: string[];
  try {
    const { headers: signInHeaders } = await auth.api.signInEmailOTP({
      body: { email, otp },
      returnHeaders: true,
    });
    sessionSetCookies = signInHeaders.getSetCookie();
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

  // setPassword is session-scoped: replay the session we just minted so the
  // credential is attached to the existing user (no new user row).
  await auth.api.setPassword({
    body: { newPassword: password },
    headers: new Headers({ cookie: setCookiesToCookieHeader(sessionSetCookies) }),
  });

  if (sessionSetCookies.length > 0) {
    res.setHeader("set-cookie", sessionSetCookies);
  }

  const linkedResponse: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 201,
    message: "Password added to your existing account. You're signed in.",
    data: { ok: true },
  };
  res.status(201).json(linkedResponse);
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
