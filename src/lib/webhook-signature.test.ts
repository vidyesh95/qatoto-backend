import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  signWebhookPayload,
  verifyWebhookSignature,
} from "#src/lib/webhook-signature.js";

const SIGNING_SECRET = "connector_signing_secret";
const FIXED_NOW_MS = 1_775_000_000_000;

function signedAt(rawBody: Buffer, nowMs: number) {
  return signWebhookPayload(rawBody, SIGNING_SECRET, nowMs);
}

describe("connector webhook signature verification", () => {
  const rawBody = Buffer.from('{"providerEventId":"evt_1","eventType":"x"}', "utf8");

  it("accepts a payload signed at the current instant", () => {
    const { timestampHeader, signatureHeader } = signedAt(rawBody, FIXED_NOW_MS);

    const verified = verifyWebhookSignature({
      rawBody,
      signatureHeader,
      timestampHeader,
      signingSecret: SIGNING_SECRET,
      nowMs: FIXED_NOW_MS,
    });

    expect(verified).toEqual({ success: true, value: true });
  });

  it("accepts a delivery at the very edge of the tolerance window", () => {
    const signedMs = FIXED_NOW_MS - DEFAULT_WEBHOOK_TOLERANCE_SECONDS * 1000;
    const { timestampHeader, signatureHeader } = signedAt(rawBody, signedMs);

    const verified = verifyWebhookSignature({
      rawBody,
      signatureHeader,
      timestampHeader,
      signingSecret: SIGNING_SECRET,
      nowMs: FIXED_NOW_MS,
    });

    expect(verified).toEqual({ success: true, value: true });
  });

  it("rejects one second past the window", () => {
    const signedMs = FIXED_NOW_MS - (DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1) * 1000;
    const { timestampHeader, signatureHeader } = signedAt(rawBody, signedMs);

    const verified = verifyWebhookSignature({
      rawBody,
      signatureHeader,
      timestampHeader,
      signingSecret: SIGNING_SECRET,
      nowMs: FIXED_NOW_MS,
    });

    expect(verified).toEqual({
      success: false,
      error: {
        type: "TIMESTAMP_OUTSIDE_TOLERANCE",
        skewSeconds: DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1,
      },
    });
  });

  /**
   * A clock ahead of ours is as suspicious as one behind it: the skew is absolute. A
   * far-future timestamp would otherwise let a signature be minted now and remain valid
   * indefinitely.
   */
  it("rejects a timestamp far in the future", () => {
    const signedMs = FIXED_NOW_MS + 86_400_000;
    const { timestampHeader, signatureHeader } = signedAt(rawBody, signedMs);

    const verified = verifyWebhookSignature({
      rawBody,
      signatureHeader,
      timestampHeader,
      signingSecret: SIGNING_SECRET,
      nowMs: FIXED_NOW_MS,
    });

    expect(verified.success).toBe(false);
    if (verified.success) return;
    expect(verified.error.type).toBe("TIMESTAMP_OUTSIDE_TOLERANCE");
  });

  /**
   * `Number.parseInt` accepts all three of these and yields a plausible number, which
   * would let a signed timestamp differ from the string that was actually signed. The
   * format is pinned before it is parsed.
   */
  it.each(["1775000000abc", "+1775000000", " 1775000000", "1.775e9", ""])(
    "rejects the malformed timestamp %j",
    (timestampHeader) => {
      const verified = verifyWebhookSignature({
        rawBody,
        signatureHeader: "0".repeat(64),
        timestampHeader,
        signingSecret: SIGNING_SECRET,
        nowMs: FIXED_NOW_MS,
      });

      expect(verified).toEqual({ success: false, error: { type: "TIMESTAMP_MALFORMED" } });
    },
  );

  it("reports missing headers distinctly from a bad signature", () => {
    const verified = verifyWebhookSignature({
      rawBody,
      signatureHeader: undefined,
      timestampHeader: undefined,
      signingSecret: SIGNING_SECRET,
      nowMs: FIXED_NOW_MS,
    });

    expect(verified).toEqual({ success: false, error: { type: "SIGNATURE_HEADERS_MISSING" } });
  });

  /**
   * The digest covers `${timestamp}.${body}`. Moving a byte from the end of the timestamp
   * to the front of the body would collide if the two were merely concatenated, so the
   * separator is what stops that.
   */
  it("does not confuse a shifted timestamp/body boundary", () => {
    const bodyA = Buffer.from("0.payload", "utf8");
    const signedA = signWebhookPayload(bodyA, SIGNING_SECRET, FIXED_NOW_MS);

    const verified = verifyWebhookSignature({
      rawBody: Buffer.from("payload", "utf8"),
      signatureHeader: signedA.signatureHeader,
      timestampHeader: `${signedA.timestampHeader}0`,
      signingSecret: SIGNING_SECRET,
      nowMs: FIXED_NOW_MS,
    });

    expect(verified.success).toBe(false);
  });
});
