import { verify } from "@node-rs/argon2";
import { APIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";
import { auth } from "#src/lib/auth.js";
import {
  issueRecoveryOtp,
  verifyAndConsumeRecoveryOtp,
  type VerifyRecoveryOtpError,
} from "#src/services/recovery-otp.service.js";
import { PUBLIC_USER_COLUMNS, type PublicUser } from "#src/services/users.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Proof of identity supplied when CHANGING the recovery email. A plain logged-in
 * session is deliberately NOT enough (CLAUDE.md §1.1) — the recovery email is the
 * key to account recovery, so changing it is "step-up" gated:
 *
 *  - "password" → re-enter the account password. Only credential users have one.
 *  - "otp"      → a one-time code mailed to the PRIMARY email (works for everyone,
 *                 including OAuth-only users with no password). Requested first via
 *                 POST /users/me/recovery-email/step-up-challenge.
 */
export type StepUpCredential =
  | { kind: "password"; password: string }
  | { kind: "otp"; otp: string };

export type StartRecoveryEmailError = { type: "SAME_AS_PRIMARY" } | { type: "EMAIL_SEND_FAILED" };

export type ConfirmRecoveryEmailError =
  | { type: "STEP_UP_INVALID" }
  | VerifyRecoveryOtpError // OTP_INVALID | OTP_EXPIRED | TOO_MANY_ATTEMPTS
  | { type: "USER_NOT_FOUND"; userId: string };

export type ClearRecoveryEmailError =
  | { type: "STEP_UP_INVALID" }
  | { type: "USER_NOT_FOUND"; userId: string };

export interface RecoveryEmailStatus {
  readonly recoveryEmail: string | null;
  readonly recoveryEmailVerified: boolean;
  readonly recoveryEmailUpdatedAt: Date | null;
}

/**
 * Verify a step-up credential for the given user. Returns ok only when the proof
 * is valid; every "wrong credential" outcome collapses to STEP_UP_INVALID so the
 * caller can't tell "no password set" from "wrong password".
 */
async function verifyStepUp(
  userId: string,
  primaryEmail: string,
  stepUp: StepUpCredential,
): Promise<Result<{ ok: true }, { type: "STEP_UP_INVALID" }>> {
  if (stepUp.kind === "password") {
    // Verify against the stored argon2 hash directly (no session side effect).
    // OAuth-only users have no credential row → they cannot use this path.
    const [credentialAccount] = await db
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
      .limit(1);

    if (!credentialAccount?.password) {
      return { success: false, error: { type: "STEP_UP_INVALID" } };
    }

    const isPasswordValid = await verify(credentialAccount.password, stepUp.password);
    return isPasswordValid
      ? { success: true, value: { ok: true } }
      : { success: false, error: { type: "STEP_UP_INVALID" } };
  }

  // OTP to the PRIMARY email. The primary IS a user, so Better Auth's own
  // checkVerificationOTP works here (unlike for the recovery address, which is
  // not a user — see recovery-otp.service.ts for why we own that flow instead).
  try {
    await auth.api.checkVerificationOTP({
      body: { email: primaryEmail, otp: stepUp.otp, type: "sign-in" },
    });
    return { success: true, value: { ok: true } };
  } catch (error) {
    if (error instanceof APIError) {
      return { success: false, error: { type: "STEP_UP_INVALID" } };
    }
    throw error;
  }
}

/**
 * Half 1, step 1: email an ownership-proving OTP to a NEW candidate recovery
 * address. Does NOT touch the user row — the address is only stored once the code
 * is confirmed, so a half-finished change never clears an existing recovery email.
 *
 * `userId`/`primaryEmail` MUST come from the session (req.user), never the body.
 * `candidateRecoveryEmail` is assumed already normalized (trim+lowercase) by the
 * controller's Zod schema.
 */
export async function startRecoveryEmailChange(
  userId: string,
  primaryEmail: string,
  candidateRecoveryEmail: string,
): Promise<Result<{ ok: true }, StartRecoveryEmailError>> {
  // A recovery email that equals the primary defeats the purpose (it's the very
  // inbox you might lose access to). Compare normalized.
  if (candidateRecoveryEmail === primaryEmail.trim().toLowerCase()) {
    return { success: false, error: { type: "SAME_AS_PRIMARY" } };
  }

  const issued = await issueRecoveryOtp(userId, candidateRecoveryEmail, "verify_address");
  if (!issued.success) {
    return { success: false, error: { type: "EMAIL_SEND_FAILED" } };
  }
  return { success: true, value: { ok: true } };
}

/**
 * Half 1, step 2: step-up FIRST, then verify+consume the candidate-address OTP,
 * then persist the new recovery email as verified. The step-up gate is checked
 * before any OTP work and before any write, so a bare session can never mutate
 * state. Returns the owner PublicUser (now carrying the recovery fields).
 */
export async function confirmRecoveryEmailChange(
  userId: string,
  primaryEmail: string,
  submittedOtp: string,
  stepUp: StepUpCredential,
): Promise<Result<PublicUser, ConfirmRecoveryEmailError>> {
  const stepUpResult = await verifyStepUp(userId, primaryEmail, stepUp);
  if (!stepUpResult.success) {
    return { success: false, error: stepUpResult.error };
  }

  const otpResult = await verifyAndConsumeRecoveryOtp(userId, "verify_address", submittedOtp);
  if (!otpResult.success) {
    return { success: false, error: otpResult.error };
  }

  const [updatedUser] = await db
    .update(user)
    .set({
      recoveryEmail: otpResult.value.candidateEmail,
      recoveryEmailVerified: true,
      recoveryEmailUpdatedAt: new Date(),
    })
    .where(eq(user.id, userId))
    .returning(PUBLIC_USER_COLUMNS);

  if (!updatedUser) {
    return { success: false, error: { type: "USER_NOT_FOUND", userId } };
  }
  return { success: true, value: updatedUser };
}

/**
 * Remove the recovery email. Also step-up gated — dropping the recovery key is a
 * sensitive change just like setting it.
 */
export async function clearRecoveryEmail(
  userId: string,
  primaryEmail: string,
  stepUp: StepUpCredential,
): Promise<Result<PublicUser, ClearRecoveryEmailError>> {
  const stepUpResult = await verifyStepUp(userId, primaryEmail, stepUp);
  if (!stepUpResult.success) {
    return { success: false, error: stepUpResult.error };
  }

  const [updatedUser] = await db
    .update(user)
    .set({ recoveryEmail: null, recoveryEmailVerified: false, recoveryEmailUpdatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning(PUBLIC_USER_COLUMNS);

  if (!updatedUser) {
    return { success: false, error: { type: "USER_NOT_FOUND", userId } };
  }
  return { success: true, value: updatedUser };
}

/**
 * Bootstrap read for the settings panel: the caller's current recovery email and
 * its verification state. Owner-only (id from the session).
 */
export async function getRecoveryEmailStatus(
  userId: string,
): Promise<Result<RecoveryEmailStatus, { type: "USER_NOT_FOUND"; userId: string }>> {
  const [row] = await db
    .select({
      recoveryEmail: user.recoveryEmail,
      recoveryEmailVerified: user.recoveryEmailVerified,
      recoveryEmailUpdatedAt: user.recoveryEmailUpdatedAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!row) {
    return { success: false, error: { type: "USER_NOT_FOUND", userId } };
  }
  return { success: true, value: row };
}
