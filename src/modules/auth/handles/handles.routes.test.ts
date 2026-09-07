import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `GET /handles/availability` — previously untested at this tier.
 * `handle.service.test.ts` only unit-tests the pure `normalizeHandle`/`validateHandle`
 * helpers directly; it never reaches this route, so there is no overlap here.
 *
 * `handleAvailabilityLimiter` has no `keyGenerator` override, so it defaults to the
 * user-id key — `resetRateLimiters()` handles it fine, no loop-until-blocked pattern
 * needed here (unlike the IP/email-keyed signup limiters in `auth.routes.test.ts`).
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const checkHandleAvailability = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/auth/handles/handle.service.js", () => ({
  checkHandleAvailability: (...args: readonly unknown[]) => checkHandleAvailability(...args),
}));

describe("handles routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /handles/availability", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/handles/availability?handle=someone");

      expect(response.status).toBe(401);
      expect(checkHandleAvailability).not.toHaveBeenCalled();
    });

    it("passes the raw handle and the caller's own id to the service", async () => {
      checkHandleAvailability.mockResolvedValue({ status: "available" });

      const response = await request(app).get("/handles/availability?handle=@New_Handle");

      expect(response.status).toBe(200);
      expect(checkHandleAvailability).toHaveBeenCalledWith("@New_Handle", "user_test_caller");
      expect(response.body.data).toEqual({ status: "available" });
    });

    it("answers 200 for a taken handle — never a 409, this is a preview", async () => {
      checkHandleAvailability.mockResolvedValue({ status: "taken" });

      const response = await request(app).get("/handles/availability?handle=already-taken");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ status: "taken" });
    });

    it("answers 200 for the caller's own current handle", async () => {
      checkHandleAvailability.mockResolvedValue({ status: "current" });

      const response = await request(app).get("/handles/availability?handle=my-own-handle");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ status: "current" });
    });

    it("answers 200 for a revertable handle", async () => {
      checkHandleAvailability.mockResolvedValue({ status: "revertable" });

      const response = await request(app).get("/handles/availability?handle=old-handle");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ status: "revertable" });
    });

    /**
     * Malformed content (too short, bad characters) is NOT a 422 — the schema only bounds
     * length, and the service reports `status: "invalid"` as a normal 200 preview so the
     * client can render live feedback while the caller is still typing.
     */
    it("answers 200 with status: invalid for malformed content, not a 422", async () => {
      checkHandleAvailability.mockResolvedValue({ status: "invalid", reason: "Too short." });

      const response = await request(app).get("/handles/availability?handle=a");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ status: "invalid", reason: "Too short." });
    });

    it("rejects a missing handle query param with 422", async () => {
      const response = await request(app).get("/handles/availability");

      expect(response.status).toBe(422);
      expect(checkHandleAvailability).not.toHaveBeenCalled();
    });

    it("rejects a handle over the 100-character cap with 422", async () => {
      const response = await request(app).get(`/handles/availability?handle=${"a".repeat(101)}`);

      expect(response.status).toBe(422);
      expect(checkHandleAvailability).not.toHaveBeenCalled();
    });
  });
});
