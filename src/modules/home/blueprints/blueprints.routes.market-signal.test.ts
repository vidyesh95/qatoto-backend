import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `GET /blueprints/teardowns/:teardownSlug/market-signal`.
 *
 * ⚠️ THREE CONTRACTS, each with its own case:
 *
 *   1. IT IS BARE. No session is read, no limiter is mounted. The payload is a list of public
 *      listings and published launches with nothing keyed to a viewer, and an IP-keyed limiter on
 *      a detail-page element behind a CDN or a corporate NAT is a self-inflicted outage.
 *   2. A MALFORMED SLUG ANSWERS 404, NOT 422 — byte-identically to a slug that simply does not
 *      exist. A 422 sitting beside a 404 would together tell a stranger which slug SHAPES exist,
 *      one request at a time.
 *   3. IT ANSWERS TWO ARRAYS, NEVER `null`, even when both are empty. Hiding an empty band is a
 *      RENDERING decision that belongs on the page; `null` on the wire would make "nothing is
 *      selling" and "the backend answered" the same shape.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const getTeardownMarketSignal = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/teardown-market-signal.service.js", () => ({
  getTeardownMarketSignal: (...args: readonly unknown[]) => getTeardownMarketSignal(...args),
}));

const POPULATED_SIGNAL = {
  success: true,
  value: {
    storeListings: [
      {
        productSlug: "bp-solar-chest-fridge-120l",
        title: "120 L solar chest refrigerator",
        organizationDisplayName: "Store Demo Furnishings",
        priceInCents: 7_800_000,
        currency: "USD",
      },
    ],
    showcases: [],
  },
} as const;

const EMPTY_SIGNAL = {
  success: true,
  value: { storeListings: [], showcases: [] },
} as const;

describe("GET /blueprints/teardowns/:teardownSlug/market-signal", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    signOut();
    vi.clearAllMocks();
    await resetRateLimiters();
  });

  it("serves a signed-out reader — it is a bare public read", async () => {
    getTeardownMarketSignal.mockResolvedValue(POPULATED_SIGNAL);

    const response = await request(app).get(
      "/blueprints/teardowns/solar-cold-storage-controller-teardown/market-signal",
    );

    expect(response.status).toBe(200);
    expect(response.body.data.storeListings).toHaveLength(1);
  });

  it("answers two ARRAYS when there is nothing to show, never null", async () => {
    getTeardownMarketSignal.mockResolvedValue(EMPTY_SIGNAL);

    const response = await request(app).get("/blueprints/teardowns/some-quiet-teardown/market-signal");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ storeListings: [], showcases: [] });
  });

  it("answers 404 for a teardown that is not readable", async () => {
    getTeardownMarketSignal.mockResolvedValue({
      success: false,
      error: { type: "TEARDOWN_NOT_FOUND" },
    });

    const response = await request(app).get("/blueprints/teardowns/not-a-teardown/market-signal");

    expect(response.status).toBe(404);
  });

  /** ⚠️ CONTRACT 2. A 422 here would leak which slug shapes are valid. */
  it("answers a malformed slug byte-identically to a missing one", async () => {
    getTeardownMarketSignal.mockResolvedValue({
      success: false,
      error: { type: "TEARDOWN_NOT_FOUND" },
    });

    const missing = await request(app).get("/blueprints/teardowns/not-a-teardown/market-signal");
    const malformed = await request(app).get("/blueprints/teardowns/NOT%20A%20VALID%20SLUG/market-signal");

    expect(malformed.status).toBe(missing.status);
    expect(malformed.body.message).toBe(missing.body.message);
    expect(malformed.status).toBe(404);
  });

  it("does not confuse the band with the detail read or the claim picker", async () => {
    getTeardownMarketSignal.mockResolvedValue(EMPTY_SIGNAL);

    await request(app).get("/blueprints/teardowns/some-teardown/market-signal");

    expect(getTeardownMarketSignal).toHaveBeenCalledTimes(1);
    expect(getTeardownMarketSignal.mock.calls[0]?.[0]).toBe("some-teardown");
  });
});
