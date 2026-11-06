import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "#src/config/index.js";

/**
 * The token in a reminder email's off link.
 *
 * SIGNED, NOT STORED. It proves only "this address received a reminder for this user", which is
 * enough to switch one nudge off and nothing else. It never expires, on purpose: an off link in a
 * six-week-old email must still work. Rotating `BETTER_AUTH_SECRET` retires every old link, which
 * costs a person a sign-in rather than exposing anything.
 *
 * The purpose string keeps this signature from being valid anywhere else the secret is used.
 */
const TOKEN_PURPOSE = "daily-log-reminder-off";
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

function signUserId(userId: string): string {
  return createHmac("sha256", config.BETTER_AUTH_SECRET)
    .update(`${TOKEN_PURPOSE}:${userId}`)
    .digest("hex");
}

export function buildDailyLogReminderOffToken(userId: string): string {
  return `${userId}.${signUserId(userId)}`;
}

/** The user the token belongs to, or null for anything not signed by this server. */
export function readDailyLogReminderOffToken(token: string): string | null {
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex <= 0) return null;

  const userId = token.slice(0, separatorIndex);
  const presentedSignature = token.slice(separatorIndex + 1);
  // `timingSafeEqual` throws on a length mismatch, so the shape is pinned first.
  if (!SIGNATURE_PATTERN.test(presentedSignature)) return null;

  const isSignatureValid = timingSafeEqual(
    Buffer.from(signUserId(userId), "hex"),
    Buffer.from(presentedSignature, "hex"),
  );
  return isSignatureValid ? userId : null;
}
