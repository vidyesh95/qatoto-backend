import { createHmac } from "node:crypto";

/**
 * Signs a raw webhook body the same way `verifyEscrowWebhookSignature` checks it:
 * HMAC-SHA256 over `${timestampSeconds}.` followed by the raw bytes, never the
 * re-serialized JSON. Shared between the adapter's own signature tests and any
 * route-level test that needs to produce a request the real handler will accept.
 */
export function signWebhookBody(
  rawBody: Buffer,
  timestampSeconds: number,
  signingSecret: string,
): string {
  return createHmac("sha256", signingSecret)
    .update(`${String(timestampSeconds)}.`)
    .update(rawBody)
    .digest("hex");
}

/**
 * Builds a signed webhook request body plus the two headers the real route reads
 * (`x-qatoto-escrow-timestamp`, `x-qatoto-escrow-signature`). `timestampSeconds` defaults
 * to now so a test only has to override it to exercise the staleness check.
 */
export function buildSignedWebhookRequest(
  body: unknown,
  signingSecret: string,
  options: { readonly timestampSeconds?: number } = {},
): {
  readonly rawBody: Buffer;
  readonly headers: Record<string, string>;
} {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  return {
    rawBody,
    headers: {
      "x-qatoto-escrow-timestamp": String(timestampSeconds),
      "x-qatoto-escrow-signature": signWebhookBody(rawBody, timestampSeconds, signingSecret),
    },
  };
}
