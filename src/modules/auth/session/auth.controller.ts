import { timingSafeEqual } from "node:crypto";

import { APIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";

import { db } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";
import { auth, sendSignupOtp } from "#src/lib/auth.js";
import { CompleteSignupSchema, StartSignupSchema } from "#src/modules/auth/session/auth.schemas.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse, Result } from "#src/types/index.js";

/**
 * Constant-time string equality. Length mismatch short-circuits to false (the
 * lengths are not secret); equal lengths are compared without early-out so a
 * guessed OTP can't be narrowed by response timing.
 */
function timingSafeStringEqual(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, providedBytes);
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
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  // Mint + send the code ourselves (see sendSignupOtp): Better Auth's own send
  // endpoint no-ops for brand-new emails under `disableSignUp: true`. A send failure
  // is logged for ops but NEVER surfaced to the caller — the generic 200 below must
  // not become a probe for which emails exist or whether delivery succeeded.
  const sendResult = await sendSignupOtp(parsedBody.data.email);
  if (!sendResult.success) {
    console.error(
      `Failed to send signup OTP to ${parsedBody.data.email}: ${JSON.stringify(sendResult.error)}`,
    );
  }

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
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const { email, otp, password } = parsedBody.data;
  const displayName = parsedBody.data.name ?? email.split("@")[0];

  const [existingUser] = await db.select().from(user).where(eq(user.email, email)).limit(1);

  const outcome = existingUser
    ? await linkPasswordOrReject({ email, otp, password, existingUser })
    : await createNewUserAccount({ email, otp, password, displayName });

  respondSignup(res, outcome);
}

/**
 * A resolved signup: either a 201 (with the session cookies to replay) or a
 * predictable operational failure (bad OTP → 401, email already claimed → 409).
 * Path helpers return this instead of touching `res` — response writing lives
 * only in `respondSignup`.
 */
type SignupSuccess = { readonly message: string; readonly setCookies: readonly string[] };

type SignupFailure = { readonly statusCode: 401 | 409; readonly message: string };

type SignupOutcome = Result<SignupSuccess, SignupFailure>;

/**
 * Path A — brand-new email. Verify OTP ownership before any account exists, then
 * create the user + credential and mark the email verified.
 *
 * Better Auth's checkVerificationOTP requires the user to already exist (404s
 * otherwise), which a brand-new signup does not — so we read the stored code via
 * the server-only getVerificationOTP (no user required, still enforces expiry)
 * and compare it ourselves in constant time. Invalid/expired → no user created.
 */
async function createNewUserAccount(input: {
  readonly email: string;
  readonly otp: string;
  readonly password: string;
  readonly displayName: string;
}): Promise<SignupOutcome> {
  const { email, otp, password, displayName } = input;

  const storedVerification = await auth.api.getVerificationOTP({
    query: { email, type: "sign-in" },
  });
  if (storedVerification.otp === null || !timingSafeStringEqual(storedVerification.otp, otp)) {
    return {
      success: false,
      error: { statusCode: 401, message: "Invalid or expired verification code." },
    };
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
      return {
        success: false,
        error: {
          statusCode: 409,
          message: "An account with this email already exists. Please sign in instead.",
        },
      };
    }
    throw error;
  }

  // The OTP proved email ownership, so the account is verified from the start.
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));

  return {
    success: true,
    value: { message: "Account created successfully.", setCookies: sessionSetCookies },
  };
}

/**
 * Paths B & C — the email already resolves to a user.
 *
 *  - Path B: that user already has a `credential` account → genuine re-signup →
 *            409; the caller should sign in or use forgot-password.
 *  - Path C: OAuth-only user adding a password — sign in via OTP (proves ownership
 *            AND mints a session for this exact user), then attach the password to
 *            that same user with setPassword. No new user row.
 */
async function linkPasswordOrReject(input: {
  readonly email: string;
  readonly otp: string;
  readonly password: string;
  readonly existingUser: typeof user.$inferSelect;
}): Promise<SignupOutcome> {
  const { email, otp, password, existingUser } = input;

  const [credentialAccount] = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, existingUser.id), eq(account.providerId, "credential")))
    .limit(1);

  if (credentialAccount) {
    return {
      success: false,
      error: {
        statusCode: 409,
        message: "An account with this email already exists. Please sign in instead.",
      },
    };
  }

  let sessionSetCookies: string[];
  try {
    const { headers: signInHeaders } = await auth.api.signInEmailOTP({
      body: { email, otp },
      returnHeaders: true,
    });
    sessionSetCookies = signInHeaders.getSetCookie();
  } catch (error) {
    if (error instanceof APIError) {
      return {
        success: false,
        error: { statusCode: 401, message: "Invalid or expired verification code." },
      };
    }
    throw error;
  }

  // setPassword is session-scoped: replay the session we just minted so the
  // credential is attached to the existing user (no new user row).
  await auth.api.setPassword({
    body: { newPassword: password },
    headers: new Headers({ cookie: setCookiesToCookieHeader(sessionSetCookies) }),
  });

  return {
    success: true,
    value: {
      message: "Password added to your existing account. You're signed in.",
      setCookies: sessionSetCookies,
    },
  };
}

/**
 * Map a resolved `SignupOutcome` onto the HTTP response — the single place the
 * signup paths touch `res`. Success is always a 201 (+ any session cookies).
 */
function respondSignup(res: Response, outcome: SignupOutcome): void {
  if (!outcome.success) {
    res.status(outcome.error.statusCode).json({
      status: "error",
      statusCode: outcome.error.statusCode,
      message: outcome.error.message,
    });
    return;
  }

  if (outcome.value.setCookies.length > 0) {
    res.setHeader("set-cookie", [...outcome.value.setCookies]);
  }

  const body: ApiResponse<{ ok: true }> = {
    status: "success",
    statusCode: 201,
    message: outcome.value.message,
    data: { ok: true },
  };
  res.status(201).json(body);
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
