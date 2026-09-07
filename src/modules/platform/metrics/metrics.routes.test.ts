import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL, BEHAVIOR-ONLY tests for platform metrics (HOME_BACKEND_STRUCTURE.md §3.3a).
 * `metrics.routes.order.test.ts` already covers route declaration order via a `.stack`
 * walk with no HTTP requests — this file is deliberately the other half: status codes,
 * query parsing, and the `view_platform_metrics` capability, none of which that file
 * touches.
 *
 * `view_platform_metrics` is checked INSIDE each service call for the first four routes
 * (`platform-metrics.service.ts`), and explicitly in the CONTROLLER for `/users` via
 * `requirePlatformCapability` — both are mocked here, matching the real import graph.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const getActiveUsers = vi.fn<(...args: readonly unknown[]) => unknown>();
const getWatchTimeDistribution = vi.fn<(...args: readonly unknown[]) => unknown>();
const getActivityByHour = vi.fn<(...args: readonly unknown[]) => unknown>();
const getRetentionCohorts = vi.fn<(...args: readonly unknown[]) => unknown>();
const listUserSegment = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/platform/metrics/platform-metrics.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/modules/platform/metrics/platform-metrics.service.js")>();
  return {
    USER_SEGMENTS: actual.USER_SEGMENTS,
    getActiveUsers: (...args: readonly unknown[]) => getActiveUsers(...args),
    getWatchTimeDistribution: (...args: readonly unknown[]) => getWatchTimeDistribution(...args),
    getActivityByHour: (...args: readonly unknown[]) => getActivityByHour(...args),
    getRetentionCohorts: (...args: readonly unknown[]) => getRetentionCohorts(...args),
    listUserSegment: (...args: readonly unknown[]) => listUserSegment(...args),
  };
});

const requirePlatformCapability = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (...args: readonly unknown[]) => requirePlatformCapability(...args),
}));

const CAPABILITY_REQUIRED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED" },
} as const;

describe("platform metrics routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication", () => {
    it.each([
      "/admin/metrics/active-users?fromDate=2026-01-01&toDate=2026-01-31",
      "/admin/metrics/watch-time?fromDate=2026-01-01&toDate=2026-01-31",
      "/admin/metrics/activity-hours?fromDate=2026-01-01&toDate=2026-01-31",
      "/admin/metrics/retention-cohorts",
      "/admin/metrics/users?segment=top_watchers",
    ])("answers 401 for a signed-out caller on %s", async (path) => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
    });
  });

  describe("GET /admin/metrics/active-users", () => {
    const path = "/admin/metrics/active-users?fromDate=2026-01-01&toDate=2026-01-31";

    it("requires view_platform_metrics", async () => {
      getActiveUsers.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
    });

    it("defaults window to day and passes the rolling day count through", async () => {
      getActiveUsers.mockResolvedValue({ success: true, value: { series: [] } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(getActiveUsers).toHaveBeenCalledWith(
        "user_test_caller",
        { fromDate: "2026-01-01", toDate: "2026-01-31" },
        1,
      );
    });

    it("resolves window=month to 30 rolling days", async () => {
      getActiveUsers.mockResolvedValue({ success: true, value: { series: [] } });

      await request(app).get(`${path}&window=month`);

      expect(getActiveUsers).toHaveBeenCalledWith(
        "user_test_caller",
        { fromDate: "2026-01-01", toDate: "2026-01-31" },
        30,
      );
    });

    it("rejects fromDate after toDate with 422", async () => {
      const response = await request(app).get("/admin/metrics/active-users?fromDate=2026-02-01&toDate=2026-01-01");

      expect(response.status).toBe(422);
      expect(getActiveUsers).not.toHaveBeenCalled();
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get(`${path}&segment=top_watchers`);

      expect(response.status).toBe(422);
      expect(getActiveUsers).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/metrics/watch-time", () => {
    const path = "/admin/metrics/watch-time?fromDate=2026-01-01&toDate=2026-01-31";

    it("requires view_platform_metrics", async () => {
      getWatchTimeDistribution.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
    });

    it("loads the distribution for the window", async () => {
      getWatchTimeDistribution.mockResolvedValue({ success: true, value: { buckets: [] } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(getWatchTimeDistribution).toHaveBeenCalledWith("user_test_caller", {
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
      });
    });

    it("rejects a window wider than the retention cap with 422", async () => {
      const response = await request(app).get("/admin/metrics/watch-time?fromDate=2020-01-01&toDate=2026-01-31");

      expect(response.status).toBe(422);
      expect(getWatchTimeDistribution).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/metrics/activity-hours", () => {
    const path = "/admin/metrics/activity-hours?fromDate=2026-01-01&toDate=2026-01-31";

    it("requires view_platform_metrics", async () => {
      getActivityByHour.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
    });

    it("loads the UTC hour-of-day histogram", async () => {
      getActivityByHour.mockResolvedValue({ success: true, value: { hours: [] } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(getActivityByHour).toHaveBeenCalledWith("user_test_caller", {
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
      });
      expect(response.body.message).toContain("UTC");
    });
  });

  describe("GET /admin/metrics/retention-cohorts", () => {
    it("requires view_platform_metrics", async () => {
      getRetentionCohorts.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get("/admin/metrics/retention-cohorts");

      expect(response.status).toBe(403);
    });

    it("defaults months to 12", async () => {
      getRetentionCohorts.mockResolvedValue({ success: true, value: { cohorts: [] } });

      const response = await request(app).get("/admin/metrics/retention-cohorts");

      expect(response.status).toBe(200);
      expect(getRetentionCohorts).toHaveBeenCalledWith("user_test_caller", 12);
    });

    it("rejects months over the 25-month cap with 422", async () => {
      const response = await request(app).get("/admin/metrics/retention-cohorts?months=26");

      expect(response.status).toBe(422);
      expect(getRetentionCohorts).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/metrics/users — the audited route", () => {
    const path = "/admin/metrics/users?segment=top_watchers";

    it("requires view_platform_metrics, checked in the controller before the service runs", async () => {
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
      expect(requirePlatformCapability).toHaveBeenCalledWith("user_test_caller", "view_platform_metrics");
      expect(listUserSegment).not.toHaveBeenCalled();
    });

    /**
     * The audit write itself lives inside `platform-metrics.service.ts::listUserSegment`,
     * which is mocked here (Pattern B mocks the service layer, not its internals) — so what
     * this route-tier test CAN and must prove is the thing the audit write depends on: the
     * proven role is resolved in the controller via `requirePlatformCapability` and handed
     * to the service, rather than trusted from the caller or re-derived later where it
     * could have drifted. That resolved-role argument is the traceable half of "this
     * route writes to the platform chain" available at this layer.
     */
    it("resolves the caller's proven role and passes it to the service that performs the audited read", async () => {
      requirePlatformCapability.mockResolvedValue({
        success: true,
        value: { platformRole: "admin" },
      });
      listUserSegment.mockResolvedValue({ success: true, value: { users: [] } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listUserSegment).toHaveBeenCalledWith("user_test_caller", "admin", "top_watchers", 25);
    });

    it("defaults limit to 25 and accepts the at_risk segment", async () => {
      requirePlatformCapability.mockResolvedValue({ success: true, value: { platformRole: "admin" } });
      listUserSegment.mockResolvedValue({ success: true, value: { users: [] } });

      const response = await request(app).get("/admin/metrics/users?segment=at_risk&limit=10");

      expect(response.status).toBe(200);
      expect(listUserSegment).toHaveBeenCalledWith("user_test_caller", "admin", "at_risk", 10);
    });

    it("rejects a segment outside the closed set with 422", async () => {
      const response = await request(app).get("/admin/metrics/users?segment=everyone");

      expect(response.status).toBe(422);
      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });

    it("rejects limit over 100 with 422", async () => {
      const response = await request(app).get("/admin/metrics/users?segment=top_watchers&limit=500");

      expect(response.status).toBe(422);
      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });
  });
});
