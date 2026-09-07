import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";
import { buildSignedWebhookRequest, signWebhookBody } from "#src/test-support/webhook-signing.js";

/**
 * ROUTE-LEVEL tests for `POST /webhooks/escrow/:providerId` — the one UNAUTHENTICATED,
 * HMAC-verified route in the repo (STORE Phase 14). Previously untested end-to-end: the
 * signature scheme has its own unit suite (`external-escrow-provider.adapter.test.ts`),
 * but nothing exercised the actual route — mount order, the raw-body parser, the
 * provider lookup, or the 202/400/401/404 mapping.
 *
 * DELIBERATELY NO `signInAs`/`signOut`/`requireAuth` boilerplate anywhere in this file.
 * The route's own docblock is explicit that there is no session and the signature IS the
 * authentication — copying the usual auth scaffolding here would test something this
 * route deliberately does not have.
 *
 * The signature is produced with `webhook-signing.ts`, the helper extracted from the
 * adapter's own test so the two suites cannot drift on the signing scheme.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const loadProviderById = vi.fn<(...args: readonly unknown[]) => unknown>();
const resolveWebhookSigningSecret = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/store/fulfillment/commerce-connector.service.js", () => ({
  loadProviderById: (...args: readonly unknown[]) => loadProviderById(...args),
  resolveWebhookSigningSecret: (...args: readonly unknown[]) => resolveWebhookSigningSecret(...args),
}));

const applyNormalizedEscrowEvent = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/store/orders/commerce-escrow.service.js", () => ({
  applyNormalizedEscrowEvent: (...args: readonly unknown[]) => applyNormalizedEscrowEvent(...args),
}));

// `external-escrow-provider.adapter.js` is NOT mocked — it is a pure, synchronous
// registry + signature verifier with no database access, and the real one is what
// proves the route's signature handling actually works end-to-end.

const SIGNING_SECRET = "escrow_webhook_secret_for_route_tests";

/** What `loadProviderById` resolves for an active, real (fake-adapter) escrow provider. */
const ACTIVE_FAKE_PROVIDER = {
  success: true,
  value: {
    id: "provider_1",
    providerSlug: "fake",
    connectorKind: "external_escrow",
  },
};

const RELEASE_EVENT_BODY = {
  providerEventId: "evt_release_1",
  eventType: "milestone.released",
  event: {
    kind: "milestone_released",
    providerSessionRef: "fake_es_abc",
    providerMilestoneRef: "fake_em_abc_1",
    releasedAmountInCents: 30_000,
    currency: "USD",
  },
};

function signedRequest(body: unknown = RELEASE_EVENT_BODY, timestampSeconds?: number) {
  return buildSignedWebhookRequest(body, SIGNING_SECRET, { timestampSeconds });
}

describe("commerce webhooks routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetRateLimiters();
  });

  describe("POST /webhooks/escrow/:providerId", () => {
    it("accepts a correctly signed event and applies it", async () => {
      loadProviderById.mockResolvedValue(ACTIVE_FAKE_PROVIDER);
      resolveWebhookSigningSecret.mockReturnValue({ success: true, value: SIGNING_SECRET });
      applyNormalizedEscrowEvent.mockResolvedValue({ success: true, value: { applied: true, deduplicated: false } });

      const { rawBody, headers } = signedRequest();

      const response = await request(app)
        .post("/webhooks/escrow/provider_1")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(202);
      expect(loadProviderById).toHaveBeenCalledWith("provider_1");
      expect(applyNormalizedEscrowEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "provider_1",
          providerEventId: "evt_release_1",
          eventType: "milestone.released",
        }),
      );
    });

    it("answers 202 for a deduplicated replay without re-applying", async () => {
      loadProviderById.mockResolvedValue(ACTIVE_FAKE_PROVIDER);
      resolveWebhookSigningSecret.mockReturnValue({ success: true, value: SIGNING_SECRET });
      applyNormalizedEscrowEvent.mockResolvedValue({ success: true, value: { applied: false, deduplicated: true } });

      const { rawBody, headers } = signedRequest();

      const response = await request(app)
        .post("/webhooks/escrow/provider_1")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(202);
      expect(response.body.message).toBe("Event already recorded.");
    });

    it("rejects a body altered after it was signed, without touching the database", async () => {
      loadProviderById.mockResolvedValue(ACTIVE_FAKE_PROVIDER);
      resolveWebhookSigningSecret.mockReturnValue({ success: true, value: SIGNING_SECRET });

      const { headers } = signedRequest();
      const tamperedBody = Buffer.from(
        JSON.stringify({ ...RELEASE_EVENT_BODY, providerEventId: "evt_swapped" }),
        "utf8",
      );

      const response = await request(app)
        .post("/webhooks/escrow/provider_1")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(tamperedBody);

      expect(response.status).toBe(401);
      expect(applyNormalizedEscrowEvent).not.toHaveBeenCalled();
    });

    it("rejects a stale, replayed timestamp", async () => {
      loadProviderById.mockResolvedValue(ACTIVE_FAKE_PROVIDER);
      resolveWebhookSigningSecret.mockReturnValue({ success: true, value: SIGNING_SECRET });

      const staleTimestamp = Math.floor(Date.now() / 1000) - 3_600;
      const { rawBody, headers } = signedRequest(RELEASE_EVENT_BODY, staleTimestamp);

      const response = await request(app)
        .post("/webhooks/escrow/provider_1")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(401);
      expect(applyNormalizedEscrowEvent).not.toHaveBeenCalled();
    });

    it("rejects a signature produced with the wrong secret", async () => {
      loadProviderById.mockResolvedValue(ACTIVE_FAKE_PROVIDER);
      resolveWebhookSigningSecret.mockReturnValue({ success: true, value: SIGNING_SECRET });

      const rawBody = Buffer.from(JSON.stringify(RELEASE_EVENT_BODY), "utf8");
      const timestampSeconds = Math.floor(Date.now() / 1000);
      const { headers } = buildSignedWebhookRequest(RELEASE_EVENT_BODY, "some_other_secret", {
        timestampSeconds,
      });

      const response = await request(app)
        .post("/webhooks/escrow/provider_1")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(401);
      expect(applyNormalizedEscrowEvent).not.toHaveBeenCalled();
    });

    it("answers 404 for an unknown or inactive provider, with no distinguishing detail", async () => {
      loadProviderById.mockResolvedValue({ success: false, error: { type: "PROVIDER_NOT_FOUND" } });

      const { rawBody, headers } = signedRequest();

      const response = await request(app)
        .post("/webhooks/escrow/provider_unknown")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(404);
      expect(resolveWebhookSigningSecret).not.toHaveBeenCalled();
    });

    it("answers 404 for a provider that is not an external_escrow connector", async () => {
      loadProviderById.mockResolvedValue({
        success: true,
        value: { id: "provider_2", providerSlug: "fake", connectorKind: "payment_gateway" },
      });

      const { rawBody, headers } = signedRequest();

      const response = await request(app)
        .post("/webhooks/escrow/provider_2")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(404);
    });

    it("answers 401, not 500, when the provider's signing secret is unavailable", async () => {
      loadProviderById.mockResolvedValue(ACTIVE_FAKE_PROVIDER);
      resolveWebhookSigningSecret.mockReturnValue({
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "no secret configured" },
      });

      const { rawBody, headers } = signedRequest();

      const response = await request(app)
        .post("/webhooks/escrow/provider_1")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(401);
      expect(applyNormalizedEscrowEvent).not.toHaveBeenCalled();
    });

    it("answers 404 for a registered provider slug with no written adapter, rather than falling back to the fake", async () => {
      loadProviderById.mockResolvedValue({
        success: true,
        value: { id: "provider_3", providerSlug: "escrow_com", connectorKind: "external_escrow" },
      });
      resolveWebhookSigningSecret.mockReturnValue({ success: true, value: SIGNING_SECRET });

      const { rawBody, headers } = signedRequest();

      const response = await request(app)
        .post("/webhooks/escrow/provider_3")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(404);
      expect(applyNormalizedEscrowEvent).not.toHaveBeenCalled();
    });

    it("still answers 202 (accepted-but-not-applied) when the event is well-formed but the service cannot apply it", async () => {
      loadProviderById.mockResolvedValue(ACTIVE_FAKE_PROVIDER);
      resolveWebhookSigningSecret.mockReturnValue({ success: true, value: SIGNING_SECRET });
      applyNormalizedEscrowEvent.mockResolvedValue({
        success: false,
        error: { type: "SESSION_NOT_FOUND" },
      });

      const { rawBody, headers } = signedRequest();

      const response = await request(app)
        .post("/webhooks/escrow/provider_1")
        .set(headers)
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      // A provider retry storm achieves nothing once we've recorded and cannot apply the
      // event, and telling the provider *why* would leak whether the session exists.
      expect(response.status).toBe(202);
      expect(response.body.message).toBe("Event accepted.");
    });

    it("rejects a correctly signed body that isn't valid JSON", async () => {
      loadProviderById.mockResolvedValue(ACTIVE_FAKE_PROVIDER);
      resolveWebhookSigningSecret.mockReturnValue({ success: true, value: SIGNING_SECRET });

      // Signed directly with `signWebhookBody`, not `buildSignedWebhookRequest` — that
      // helper JSON.stringifies its body argument, so a plain string would sign as valid
      // JSON (a quoted string) instead of the malformed bytes this case needs.
      const rawBody = Buffer.from("not json at all", "utf8");
      const timestampSeconds = Math.floor(Date.now() / 1000);
      const signature = signWebhookBody(rawBody, timestampSeconds, SIGNING_SECRET);

      const response = await request(app)
        .post("/webhooks/escrow/provider_1")
        .set({
          "x-qatoto-escrow-timestamp": String(timestampSeconds),
          "x-qatoto-escrow-signature": signature,
        })
        .set("Content-Type", "application/octet-stream")
        .send(rawBody);

      expect(response.status).toBe(400);
      expect(applyNormalizedEscrowEvent).not.toHaveBeenCalled();
    });
  });
});
