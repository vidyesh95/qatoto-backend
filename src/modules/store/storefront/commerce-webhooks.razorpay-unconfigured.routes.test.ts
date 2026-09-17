import type { Express } from "express";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * `POST /webhooks/payments/razorpay` with no `RAZORPAY_WEBHOOK_SECRET` (Store Phase 5).
 *
 * Its own file because `config` is parsed once per module graph, and the configured suite in
 * `commerce-webhooks.routes.test.ts` needs the secret set. Unconfigured must be a 503 — a
 * signal to redeliver later — never an unverified acceptance.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const confirmRazorpayOrderFromWebhook = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/store/orders/commerce-payments.service.js", () => ({
  confirmRazorpayOrderFromWebhook: (...args: readonly unknown[]) => confirmRazorpayOrderFromWebhook(...args),
}));

describe("POST /webhooks/payments/razorpay · unconfigured", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetRateLimiters();
  });

  it("answers 503 and applies nothing when the webhook secret is not configured", async () => {
    const response = await request(app)
      .post("/webhooks/payments/razorpay")
      .set("X-Razorpay-Signature", "a".repeat(64))
      .set("Content-Type", "application/json")
      .send(Buffer.from('{"event":"order.paid","payload":{"order":{"entity":{"id":"order_X"}}}}'));

    expect(response.status).toBe(503);
    expect(confirmRazorpayOrderFromWebhook).not.toHaveBeenCalled();
  });
});
