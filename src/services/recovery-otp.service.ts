import { randomInt } from "node:crypto";

import { hash, verify } from "@node-rs/argon2";
import { and, eq } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { recoveryEmailOtp } from "#src/db/schema.js";
import { sendTransactionalEmail } from "#src/lib/email.js";
import type { Result } from "#src/types/index.js";

/**
 * Which flow an OTP belongs to. The recovery_email_otp PK is (userId, purpose),
 * so a user can have at most one pending challenge per purpose at a time.
 *
 *  - "verify_address"  → Half 1: prove ownership of a NEW backup address before
 *                        storing it on the user (sent to the candidate address).
 *  - "reset_password"  → Half 2: recover the account by sending a reset code to
 *                        the ALREADY-verified backup address.
 */
export type RecoveryOtpPurpose = "verify_address" | "reset_password";

/** Domain failures for {@link verifyAndConsumeRecoveryOtp}. */
export type VerifyRecoveryOtpError =
  | { type: "OTP_INVALID" }
  | { type: "OTP_EXPIRED" }
  | { type: "TOO_MANY_ATTEMPTS" };

/** Domain failures for {@link issueRecoveryOtp}. */
export type IssueRecoveryOtpError = { type: "EMAIL_SEND_FAILED" };

// 6 digits to match the shape of the Better Auth signup OTP the user already
// knows. Cryptographically random (node:crypto), zero-padded so every code is
// exactly 6 chars.
const OTP_DIGITS = 6;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Brute-force budget. The 10^6 space plus argon2's per-guess cost plus this hard
// cap (the row is destroyed once exceeded) make guessing impractical.
const MAX_OTP_ATTEMPTS = 3;

/** A fresh cryptographically-random 6-digit code, e.g. "048213". */
function generateNumericOtp(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, "0");
}

/** Subject + body for the email, branded per purpose so it can't be mistaken for a login code. */
function buildOtpEmail(
  purpose: RecoveryOtpPurpose,
  otp: string,
): {
  subject: string;
  htmlContent: string;
  textContent: string;
} {
  if (purpose === "reset_password") {
    return {
      subject: "Reset your Qatoto password",
      htmlContent: `<p>Use this code to reset your Qatoto password via your recovery email: <strong>${otp}</strong>.</p><p>It expires shortly. If you did not request this, ignore this email.</p>`,
      textContent: `Use this code to reset your Qatoto password via your recovery email: ${otp}. It expires shortly. If you did not request this, ignore this email.`,
    };
  }
  return {
    subject: "Verify your Qatoto recovery email",
    htmlContent: `<p>Confirm this address as your Qatoto recovery email with the code <strong>${otp}</strong>.</p><p>It expires shortly. If you did not request this, ignore this email.</p>`,
    textContent: `Confirm this address as your Qatoto recovery email with the code ${otp}. It expires shortly. If you did not request this, ignore this email.`,
  };
}

/**
 * Generate, store (hashed), and email a recovery OTP to `toEmail`. Overwrites any
 * pending challenge for the same (userId, purpose). Mirrors the dev behavior of
 * the Better Auth OTP plugin: the code is also console.log'd in development so you
 * can test without an email provider, and a NOT_CONFIGURED mailer is tolerated in
 * dev (the code was already logged) but fails loudly otherwise.
 *
 * `userId` MUST come from a server-derived source (the session for Half 1, or a
 * DB lookup by verified recovery email for Half 2) — never a client field.
 */
export async function issueRecoveryOtp(
  userId: string,
  toEmail: string,
  purpose: RecoveryOtpPurpose,
): Promise<Result<{ ok: true }, IssueRecoveryOtpError>> {
  const otp = generateNumericOtp();
  const otpHash = await hash(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db
    .insert(recoveryEmailOtp)
    .values({ userId, purpose, candidateEmail: toEmail, otpHash, expiresAt, attempts: 0 })
    .onConflictDoUpdate({
      target: [recoveryEmailOtp.userId, recoveryEmailOtp.purpose],
      // A new request invalidates the old code and resets the attempt budget.
      set: { candidateEmail: toEmail, otpHash, expiresAt, attempts: 0, createdAt: new Date() },
    });

  if (config.NODE_ENV === "development") {
    console.log(`Recovery OTP for ${toEmail} (${purpose}): ${otp}`);
  }

  const { subject, htmlContent, textContent } = buildOtpEmail(purpose, otp);
  const sendResult = await sendTransactionalEmail({ toEmail, subject, htmlContent, textContent });

  if (!sendResult.success) {
    // NOT_CONFIGURED in dev is expected (code already logged above); otherwise the
    // user can never receive the code, so surface a real failure.
    if (sendResult.error.type === "NOT_CONFIGURED" && config.NODE_ENV === "development") {
      return { success: true, value: { ok: true } };
    }
    return { success: false, error: { type: "EMAIL_SEND_FAILED" } };
  }

  return { success: true, value: { ok: true } };
}

/**
 * Validate a submitted code against the stored hash for (userId, purpose) and
 * CONSUME it on success (single-use — deleted so it can never be replayed).
 *
 * On a wrong code the attempt counter is incremented; once it exceeds
 * MAX_OTP_ATTEMPTS the row is destroyed and further tries report TOO_MANY_ATTEMPTS.
 * Expired rows are deleted on touch. Returns the `candidateEmail` the code was
 * issued for so the caller can persist exactly what was proven.
 */
export async function verifyAndConsumeRecoveryOtp(
  userId: string,
  purpose: RecoveryOtpPurpose,
  submittedOtp: string,
): Promise<Result<{ candidateEmail: string }, VerifyRecoveryOtpError>> {
  const [pending] = await db
    .select()
    .from(recoveryEmailOtp)
    .where(and(eq(recoveryEmailOtp.userId, userId), eq(recoveryEmailOtp.purpose, purpose)))
    .limit(1);

  if (!pending) {
    return { success: false, error: { type: "OTP_INVALID" } };
  }

  const deletePending = () =>
    db
      .delete(recoveryEmailOtp)
      .where(and(eq(recoveryEmailOtp.userId, userId), eq(recoveryEmailOtp.purpose, purpose)));

  if (pending.expiresAt.getTime() < Date.now()) {
    await deletePending();
    return { success: false, error: { type: "OTP_EXPIRED" } };
  }

  const isMatch = await verify(pending.otpHash, submittedOtp);
  if (!isMatch) {
    const nextAttempts = pending.attempts + 1;
    if (nextAttempts >= MAX_OTP_ATTEMPTS) {
      await deletePending();
      return { success: false, error: { type: "TOO_MANY_ATTEMPTS" } };
    }
    await db
      .update(recoveryEmailOtp)
      .set({ attempts: nextAttempts })
      .where(and(eq(recoveryEmailOtp.userId, userId), eq(recoveryEmailOtp.purpose, purpose)));
    return { success: false, error: { type: "OTP_INVALID" } };
  }

  // Correct code — consume it so it can never be replayed (single-use).
  await deletePending();
  return { success: true, value: { candidateEmail: pending.candidateEmail } };
}
