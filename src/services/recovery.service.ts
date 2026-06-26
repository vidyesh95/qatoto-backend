import { randomUUID } from "node:crypto";

import { hash } from "@node-rs/argon2";
import { and, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { account, session, user } from "#src/db/schema.js";
import {
  issueRecoveryOtp,
  verifyAndConsumeRecoveryOtp,
} from "#src/services/recovery-otp.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Account recovery via the verified recovery email — for a user who LOST access to
 * their primary inbox and so can't get the normal forgot-password OTP. They prove
 * ownership of their backup address instead, then set a new password on their
 * PRIMARY account. Both endpoints are PUBLIC (the user is locked out — no session).
 *
 * The single failure value is intentionally coarse: every "this didn't work"
 * outcome (no such verified recovery email, wrong/expired/exhausted code) collapses
 * to INVALID so the response can stay generic and never reveal whether a given
 * recovery email is on file (anti-enumeration, mirroring /signup/start).
 */
export type RecoveryResetError = { type: "INVALID" };

/**
 * Resolve the user who owns this recovery email, but ONLY if it is verified. An
 * unverified recovery email must never recover an account — this AND-verified
 * lookup is the single most important invariant of the whole flow.
 */
async function findVerifiedRecoveryOwner(recoveryEmail: string): Promise<{ id: string } | null> {
  const [owner] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.recoveryEmail, recoveryEmail), eq(user.recoveryEmailVerified, true)))
    .limit(1);
  return owner ?? null;
}

/**
 * Public step 1: if (and only if) a VERIFIED recovery email is on file, email a
 * reset OTP to it. Returns nothing the caller should branch on — the controller
 * ALWAYS responds with the same generic 200 whether or not an owner was found, so
 * the endpoint can't be used to probe which recovery emails exist. A send failure
 * is logged server-side (without the address) but never surfaced to the caller.
 */
export async function sendRecoveryResetOtp(recoveryEmail: string): Promise<void> {
  const owner = await findVerifiedRecoveryOwner(recoveryEmail);
  if (!owner) {
    return;
  }

  const issued = await issueRecoveryOtp(owner.id, recoveryEmail, "reset_password");
  if (!issued.success) {
    console.error(`Failed to send recovery reset OTP: ${issued.error.type}`);
  }
}

/**
 * Public step 2: verify the reset OTP that was mailed to the recovery email, then
 * set a new password on the user's PRIMARY (credential) account WITHOUT a session.
 *
 * We do this with plain Drizzle on the `account` table we own, hashing with the
 * SAME argon2 the Better Auth instance uses (src/lib/auth.ts) — an argon2 hash is
 * self-describing, so the new password verifies on the next normal sign-in. An
 * OAuth-only user (no credential row) gets one created, mirroring how Better
 * Auth's own reset flow attaches a credential. Finally we revoke ALL of the user's
 * sessions: a recovery implies the account may be compromised, so any live session
 * (possibly an attacker's) is killed and the user signs in fresh.
 */
export async function resetPasswordViaRecovery(
  recoveryEmail: string,
  otp: string,
  newPassword: string,
): Promise<Result<{ ok: true }, RecoveryResetError>> {
  const owner = await findVerifiedRecoveryOwner(recoveryEmail);
  // Generic INVALID (not a 404) keeps "no such recovery email" indistinguishable
  // from "wrong code" at the boundary.
  if (!owner) {
    return { success: false, error: { type: "INVALID" } };
  }

  const otpResult = await verifyAndConsumeRecoveryOtp(owner.id, "reset_password", otp);
  if (!otpResult.success) {
    return { success: false, error: { type: "INVALID" } };
  }

  const passwordHash = await hash(newPassword);

  const [credentialAccount] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, owner.id), eq(account.providerId, "credential")))
    .limit(1);

  if (credentialAccount) {
    await db
      .update(account)
      .set({ password: passwordHash })
      .where(eq(account.id, credentialAccount.id));
  } else {
    // OAuth-only user adding a password for the first time via recovery. Better
    // Auth uses the user id as the credential row's accountId; the column is an
    // opaque text PK so any unique id works.
    await db.insert(account).values({
      id: randomUUID(),
      accountId: owner.id,
      providerId: "credential",
      userId: owner.id,
      password: passwordHash,
      updatedAt: new Date(),
    });
  }

  // Revoke every session for this user — fail closed on a possible compromise.
  await db.delete(session).where(eq(session.userId, owner.id));

  return { success: true, value: { ok: true } };
}
