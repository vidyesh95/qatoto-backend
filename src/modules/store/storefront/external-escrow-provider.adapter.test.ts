import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const {
  FakeExternalEscrowProviderAdapter,
  parseExternalEscrowProviderName,
  resolveExternalEscrowProvider,
  verifyEscrowWebhookSignature,
} = await import("#src/modules/store/storefront/external-escrow-provider.adapter.js");

const SIGNING_SECRET = "escrow_signing_secret_for_tests";

function signBody(rawBody: Buffer, timestampSeconds: number, secret = SIGNING_SECRET): string {
  return createHmac("sha256", secret)
    .update(`${String(timestampSeconds)}.`)
    .update(rawBody)
    .digest("hex");
}

function buildSignedWebhook(
  body: unknown,
  options: { readonly timestampSeconds?: number; readonly secret?: string } = {},
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
      "x-qatoto-escrow-signature": signBody(rawBody, timestampSeconds, options.secret),
    },
  };
}

const MILESTONE_PLAN = [
  {
    milestoneId: "agreement_milestone_1",
    sequence: 1,
    milestoneKind: "deposit" as const,
    amountInCents: 30_000,
    releaseConditionNote: "30% on order confirmation",
  },
  {
    milestoneId: "agreement_milestone_2",
    sequence: 2,
    milestoneKind: "shipment" as const,
    amountInCents: 70_000,
    releaseConditionNote: "balance against the bill of lading",
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("escrow webhook signature verification", () => {
  it("accepts a body signed with the shared secret inside the tolerance window", () => {
    const rawBody = Buffer.from('{"providerEventId":"evt_1"}', "utf8");
    const timestampSeconds = Math.floor(Date.now() / 1000);

    const verified = verifyEscrowWebhookSignature({
      rawBody,
      signatureHeader: signBody(rawBody, timestampSeconds),
      timestampHeader: String(timestampSeconds),
      signingSecret: SIGNING_SECRET,
    });

    expect(verified.success).toBe(true);
  });

  /**
   * The signature covers `${timestamp}.${body}`, so flipping one byte of the body after
   * signing must fail. This is the property that makes the whole route safe to expose.
   */
  it("rejects a body altered after it was signed", () => {
    const originalBody = Buffer.from('{"releasedAmountInCents":100}', "utf8");
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signatureHeader = signBody(originalBody, timestampSeconds);

    const verified = verifyEscrowWebhookSignature({
      rawBody: Buffer.from('{"releasedAmountInCents":900}', "utf8"),
      signatureHeader,
      timestampHeader: String(timestampSeconds),
      signingSecret: SIGNING_SECRET,
    });

    expect(verified).toEqual({
      success: false,
      error: { type: "SIGNATURE_INVALID", reason: "signature_mismatch" },
    });
  });

  /**
   * The timestamp is INSIDE the signed payload. If it were only a header, a captured
   * request could be replayed forever by refreshing it, because the refreshed value would
   * not be covered by the signature it is checked against.
   */
  it("rejects a captured request replayed outside the tolerance window", () => {
    const rawBody = Buffer.from('{"providerEventId":"evt_replay"}', "utf8");
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3_600;

    const verified = verifyEscrowWebhookSignature({
      rawBody,
      signatureHeader: signBody(rawBody, staleTimestamp),
      timestampHeader: String(staleTimestamp),
      signingSecret: SIGNING_SECRET,
    });

    expect(verified).toEqual({
      success: false,
      error: { type: "SIGNATURE_INVALID", reason: "timestamp_outside_tolerance" },
    });
  });

  it("rejects a signature produced with a different secret", () => {
    const rawBody = Buffer.from('{"providerEventId":"evt_2"}', "utf8");
    const timestampSeconds = Math.floor(Date.now() / 1000);

    const verified = verifyEscrowWebhookSignature({
      rawBody,
      signatureHeader: signBody(rawBody, timestampSeconds, "some_other_secret"),
      timestampHeader: String(timestampSeconds),
      signingSecret: SIGNING_SECRET,
    });

    expect(verified).toEqual({
      success: false,
      error: { type: "SIGNATURE_INVALID", reason: "signature_mismatch" },
    });
  });

  /**
   * `timingSafeEqual` throws on a length mismatch rather than returning false, so a short
   * signature must be caught before it reaches the comparison. Without the length guard
   * this input is a 500 instead of a 401.
   */
  it("rejects a truncated signature without throwing", () => {
    const rawBody = Buffer.from('{"providerEventId":"evt_3"}', "utf8");
    const timestampSeconds = Math.floor(Date.now() / 1000);

    const verified = verifyEscrowWebhookSignature({
      rawBody,
      signatureHeader: "abc123",
      timestampHeader: String(timestampSeconds),
      signingSecret: SIGNING_SECRET,
    });

    expect(verified).toEqual({
      success: false,
      error: { type: "SIGNATURE_INVALID", reason: "signature_mismatch" },
    });
  });

  it("rejects a non-numeric timestamp header", () => {
    const rawBody = Buffer.from("{}", "utf8");

    const verified = verifyEscrowWebhookSignature({
      rawBody,
      signatureHeader: "0".repeat(64),
      timestampHeader: "not-a-timestamp",
      signingSecret: SIGNING_SECRET,
    });

    expect(verified).toEqual({
      success: false,
      error: { type: "SIGNATURE_INVALID", reason: "malformed_timestamp" },
    });
  });
});

describe("escrow webhook parsing", () => {
  const adapter = new FakeExternalEscrowProviderAdapter();

  it("parses a signed release event into the normalized union", () => {
    const { rawBody, headers } = buildSignedWebhook({
      providerEventId: "evt_release_1",
      eventType: "milestone.released",
      event: {
        kind: "milestone_released",
        providerSessionRef: "fake_es_abc",
        providerMilestoneRef: "fake_em_abc_1",
        releasedAmountInCents: 30_000,
        currency: "USD",
      },
    });

    const parsed = adapter.parseWebhook(rawBody, headers, SIGNING_SECRET);

    expect(parsed).toEqual({
      success: true,
      value: {
        providerEventId: "evt_release_1",
        eventType: "milestone.released",
        event: {
          kind: "milestone_released",
          providerSessionRef: "fake_es_abc",
          providerMilestoneRef: "fake_em_abc_1",
          releasedAmountInCents: 30_000,
          currency: "USD",
        },
      },
    });
  });

  it("refuses a request with no signature headers at all", () => {
    const rawBody = Buffer.from("{}", "utf8");

    const parsed = adapter.parseWebhook(rawBody, {}, SIGNING_SECRET);

    expect(parsed).toEqual({
      success: false,
      error: { type: "SIGNATURE_INVALID", reason: "missing_signature_headers" },
    });
  });

  /**
   * `.strict()` on every union member. A provider quietly adding a field to a release
   * event should be something we investigate, not something we ignore while moving the
   * money the rest of the payload describes.
   */
  it("refuses an event carrying a field the union does not declare", () => {
    const { rawBody, headers } = buildSignedWebhook({
      providerEventId: "evt_extra",
      eventType: "milestone.released",
      event: {
        kind: "milestone_released",
        providerSessionRef: "fake_es_abc",
        providerMilestoneRef: "fake_em_abc_1",
        releasedAmountInCents: 30_000,
        currency: "USD",
        alsoReleaseTo: "attacker_account",
      },
    });

    const parsed = adapter.parseWebhook(rawBody, headers, SIGNING_SECRET);

    expect(parsed).toEqual({
      success: false,
      error: { type: "PROVIDER_REJECTED", reason: "webhook_schema_invalid" },
    });
  });

  it("refuses an unknown event kind rather than ignoring it", () => {
    const { rawBody, headers } = buildSignedWebhook({
      providerEventId: "evt_unknown",
      eventType: "milestone.teleported",
      event: { kind: "milestone_teleported", providerSessionRef: "fake_es_abc" },
    });

    const parsed = adapter.parseWebhook(rawBody, headers, SIGNING_SECRET);

    expect(parsed).toEqual({
      success: false,
      error: { type: "PROVIDER_REJECTED", reason: "webhook_schema_invalid" },
    });
  });

  it("refuses a negative released amount", () => {
    const { rawBody, headers } = buildSignedWebhook({
      providerEventId: "evt_negative",
      eventType: "milestone.released",
      event: {
        kind: "milestone_released",
        providerSessionRef: "fake_es_abc",
        providerMilestoneRef: "fake_em_abc_1",
        releasedAmountInCents: -5,
        currency: "USD",
      },
    });

    const parsed = adapter.parseWebhook(rawBody, headers, SIGNING_SECRET);

    expect(parsed).toEqual({
      success: false,
      error: { type: "PROVIDER_REJECTED", reason: "webhook_schema_invalid" },
    });
  });

  it("refuses a body that is not JSON", () => {
    const rawBody = Buffer.from("not json at all", "utf8");
    const timestampSeconds = Math.floor(Date.now() / 1000);

    const parsed = adapter.parseWebhook(
      rawBody,
      {
        "x-qatoto-escrow-timestamp": String(timestampSeconds),
        "x-qatoto-escrow-signature": signBody(rawBody, timestampSeconds),
      },
      SIGNING_SECRET,
    );

    expect(parsed).toEqual({
      success: false,
      error: { type: "PROVIDER_REJECTED", reason: "malformed_json_body" },
    });
  });
});

describe("the fake escrow adapter", () => {
  const adapter = new FakeExternalEscrowProviderAdapter();

  it("mints a session reference derived from our own idempotency key", async () => {
    const created = await adapter.createSession({
      idempotencyKey: "escrow_session_fixed",
      sessionId: "session_1",
      orderId: "order_1",
      currency: "USD",
      totalInCents: 100_000,
      buyerOrganizationLegalName: "Buyer Industries Ltd",
      sellerOrganizationLegalName: "Seller Manufacturing Co",
      escrowFeeBearer: "buyer",
      milestones: MILESTONE_PLAN,
    });

    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.value.providerSessionRef).toBe("fake_es_escrow_session_fixed");
    expect(created.value.milestones).toHaveLength(2);
  });

  /**
   * The fake answers `awaiting_funding`, never `funded`. Escrow's entire risk is a state
   * machine driven from OUTSIDE this backend, so a fake that advanced itself would
   * exercise a flow that cannot happen and hide every ordering bug the real thing
   * produces. This is deliberately unlike the fake payment adapter, which settles at once.
   */
  it("does not advance itself to funded", async () => {
    const created = await adapter.createSession({
      idempotencyKey: "escrow_session_2",
      sessionId: "session_2",
      orderId: "order_2",
      currency: "USD",
      totalInCents: 100_000,
      buyerOrganizationLegalName: "Buyer Industries Ltd",
      sellerOrganizationLegalName: "Seller Manufacturing Co",
      escrowFeeBearer: "seller",
      milestones: MILESTONE_PLAN,
    });

    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.value.state).toBe("awaiting_funding");
  });

  it("refuses a milestone plan that does not sum to the session total", async () => {
    const created = await adapter.createSession({
      idempotencyKey: "escrow_session_3",
      sessionId: "session_3",
      orderId: "order_3",
      currency: "USD",
      // The plan sums to 100_000; this total does not.
      totalInCents: 90_000,
      buyerOrganizationLegalName: "Buyer Industries Ltd",
      sellerOrganizationLegalName: "Seller Manufacturing Co",
      escrowFeeBearer: "split",
      milestones: MILESTONE_PLAN,
    });

    expect(created).toEqual({
      success: false,
      error: { type: "PROVIDER_REJECTED", reason: "milestones_do_not_sum_to_total" },
    });
  });

  /**
   * A release REQUEST is an instruction, not a movement. If this ever returned `released`
   * the ledger would be tempted to post from the command's return value instead of from
   * the provider's event, which is the one rule Phase 14's accounting rests on.
   */
  it("answers a release request with release_requested, never released", async () => {
    const requested = await adapter.requestRelease({
      idempotencyKey: "escrow_release_1",
      providerSessionRef: "fake_es_abc",
      providerMilestoneRef: "fake_em_abc_1",
      amountInCents: 30_000,
      currency: "USD",
    });

    expect(requested.success).toBe(true);
    if (!requested.success) return;
    expect(requested.value.state).toBe("release_requested");
  });

  it("submits verification as pending rather than grading its own evidence", async () => {
    const submitted = await adapter.submitVerification({
      idempotencyKey: "escrow_verification_1",
      providerSessionRef: "fake_es_abc",
      providerMilestoneRef: "fake_em_abc_1",
      sourceKind: "shipment_leg_event",
      sourceId: "shipment_leg_event_1",
      evidenceSummary: "Bill of lading uploaded",
    });

    expect(submitted.success).toBe(true);
    if (!submitted.success) return;
    expect(submitted.value.state).toBe("verification_pending");
  });

  it("does not recognise a reference it never minted", async () => {
    const retrieved = await adapter.retrieveSession("stripe_pi_not_ours");

    expect(retrieved).toEqual({
      success: false,
      error: { type: "PROVIDER_NOT_FOUND", providerRef: "stripe_pi_not_ours" },
    });
  });
});

describe("provider resolution", () => {
  it("rejects a slug outside the closed set", () => {
    const parsed = parseExternalEscrowProviderName("definitely_not_a_provider");

    expect(parsed.success).toBe(false);
  });

  it("resolves the fake outside production", () => {
    const resolved = resolveExternalEscrowProvider("fake");

    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.value.providerName).toBe("fake");
  });

  /**
   * A registered provider with no adapter must fail loudly. Falling back to the fake would
   * mean an order believing a licensed third party holds its money when nothing does.
   */
  it("refuses a registered provider whose adapter is not written yet", () => {
    const resolved = resolveExternalEscrowProvider("escrow_com");

    expect(resolved.success).toBe(false);
    if (resolved.success) return;
    expect(resolved.error.type).toBe("PROVIDER_UNAVAILABLE");
  });
});
