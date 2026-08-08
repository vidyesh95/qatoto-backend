import { createHmac, timingSafeEqual } from "node:crypto";

import type { Result } from "#src/types/index.js";

/**
 * Shared HMAC verification for inbound connector webhooks (STORE Phase 14).
 *
 * THIS IS THE ONLY AUTHENTICATION ON THE `/webhooks/*` ROUTES. They carry no session and
 * no organization context — the signature is the entire reason a request is believed. It
 * lives here rather than in each adapter so that five connectors cannot end up with five
 * subtly different comparisons, and so the one that matters can be tested once.
 *
 * ## The scheme
 *
 * The digest covers `${timestamp}.${rawBody}` and is compared in constant time against a
 * hex signature header, with the timestamp required to be recent.
 *
 * SIGNING THE BODY ALONE WOULD BE BROKEN. The timestamp has to be inside the signed
 * payload, because a header that is checked but not covered can simply be refreshed: an
 * attacker replays a captured body with today's timestamp and it verifies forever. Putting
 * it inside means a replay must reuse the original timestamp, which the tolerance window
 * then rejects.
 *
 * The window is not a replay defence on its own. Within it, a captured request IS
 * replayable — that is what the `(provider_id, provider_event_id)` unique index on
 * `commerce_connector_webhook_event` is for. Signature verification decides whether a
 * request is heard; the inbox decides whether hearing it twice costs anything.
 *
 * RAW BYTES, NEVER A RE-SERIALIZED OBJECT. The digest must be computed over exactly what
 * arrived. `JSON.stringify(req.body)` reorders keys and drops whitespace, so a body that
 * round-trips through the JSON parser will not match a signature computed by the sender.
 * This is why `/webhooks/*` mounts a raw-body parser ahead of the JSON one.
 */

export type WebhookSignatureError =
  | { type: "SIGNATURE_HEADERS_MISSING" }
  | { type: "TIMESTAMP_MALFORMED" }
  | { type: "TIMESTAMP_OUTSIDE_TOLERANCE"; skewSeconds: number }
  | { type: "SIGNATURE_MISMATCH" };

export interface WebhookSignatureInput {
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly timestampHeader: string | undefined;
  readonly signingSecret: string;
  /** Defaults to five minutes: long enough for a slow redelivery, short enough to expire a capture. */
  readonly toleranceSeconds?: number;
  /** Injectable so a test can pin the clock without touching global time. */
  readonly nowMs?: number;
}

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature(
  input: WebhookSignatureInput,
): Result<true, WebhookSignatureError> {
  if (input.signatureHeader === undefined || input.timestampHeader === undefined) {
    return { success: false, error: { type: "SIGNATURE_HEADERS_MISSING" } };
  }

  /**
   * `Number.parseInt` would accept "123abc" and a leading "+". A signed payload's
   * timestamp has to be exactly the digits that were signed, so the format is pinned
   * before it is parsed.
   */
  if (!/^\d{1,15}$/.test(input.timestampHeader)) {
    return { success: false, error: { type: "TIMESTAMP_MALFORMED" } };
  }
  const timestampSeconds = Number(input.timestampHeader);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return { success: false, error: { type: "TIMESTAMP_MALFORMED" } };
  }

  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const skewSeconds = Math.abs(nowSeconds - timestampSeconds);
  if (skewSeconds > toleranceSeconds) {
    return { success: false, error: { type: "TIMESTAMP_OUTSIDE_TOLERANCE", skewSeconds } };
  }

  const expectedDigest = createHmac("sha256", input.signingSecret)
    .update(`${input.timestampHeader}.`)
    .update(input.rawBody)
    .digest("hex");

  const expectedBuffer = Buffer.from(expectedDigest, "utf8");
  const presentedBuffer = Buffer.from(input.signatureHeader, "utf8");
  /**
   * `timingSafeEqual` THROWS on a length mismatch rather than returning false, so the
   * cheap length check has to come first — without it a truncated signature is a 500
   * instead of a 401. A differing length is already a mismatch and leaks nothing that
   * rejecting it does not.
   */
  if (expectedBuffer.length !== presentedBuffer.length) {
    return { success: false, error: { type: "SIGNATURE_MISMATCH" } };
  }
  if (!timingSafeEqual(expectedBuffer, presentedBuffer)) {
    return { success: false, error: { type: "SIGNATURE_MISMATCH" } };
  }

  return { success: true, value: true };
}

/**
 * Produces the header pair a provider would send. Used by the fake connectors and by the
 * HTTP smoke; a real provider signs on its own side and never calls this.
 */
export function signWebhookPayload(
  rawBody: Buffer,
  signingSecret: string,
  nowMs: number = Date.now(),
): { readonly timestampHeader: string; readonly signatureHeader: string } {
  const timestampHeader = String(Math.floor(nowMs / 1000));
  const signatureHeader = createHmac("sha256", signingSecret)
    .update(`${timestampHeader}.`)
    .update(rawBody)
    .digest("hex");
  return { timestampHeader, signatureHeader };
}
