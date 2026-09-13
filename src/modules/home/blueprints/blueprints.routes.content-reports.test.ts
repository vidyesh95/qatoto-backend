import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the reader-report intake, the reporter's own list, and the queue.
 *
 * ⚠️ THREE CONTRACTS:
 *
 *   1. THE INTAKE IS NOT BARE. The bare rule is about READS whose payload is identical for every
 *      visitor. Beyond that, the partial unique index — one report per person per target — is the
 *      anti-brigading control, and an anonymous report cannot be deduplicated.
 *   2. A 201 IS A RECEIPT, NOT A VERDICT. It carries a report id and nothing else: no count, no
 *      state, no "this will be hidden". Nothing is hidden automatically on this surface.
 *   3. THE QUEUE'S CAPABILITY IS RESOLVED BEFORE THE QUERY IS PARSED — §3.6 — so a non-moderator
 *      sending a malformed query gets 403, not 422.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      if (!req.header("Idempotency-Key") && options.required === true) {
        res.status(400).json({ status: "error", statusCode: 400, message: "key required" });
        return;
      }
      next();
    },
}));

const requirePlatformCapability = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (...args: readonly unknown[]) => requirePlatformCapability(...args),
}));

const createBlueprintContentReport = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyBlueprintReports = vi.fn<(...args: readonly unknown[]) => unknown>();
const listBlueprintReportQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const dismissBlueprintContentReport = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/blueprint-content-report.service.js", () => ({
  createBlueprintContentReport: (...args: readonly unknown[]) => createBlueprintContentReport(...args),
  listMyBlueprintReports: (...args: readonly unknown[]) => listMyBlueprintReports(...args),
  listBlueprintReportQueue: (...args: readonly unknown[]) => listBlueprintReportQueue(...args),
  dismissBlueprintContentReport: (...args: readonly unknown[]) => dismissBlueprintContentReport(...args),
}));

const MODERATOR_CONTEXT = {
  success: true,
  value: { staffUserId: "user_test_caller", platformRole: "admin" },
} as const;

const CAPABILITY_REFUSED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

describe("blueprint content reports", () => {
  let app: Express;
  const teardownReportPath = "/blueprints/teardowns/some-teardown/reports";

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    signOut();
    vi.clearAllMocks();
    await resetRateLimiters();
  });

  describe("the intake", () => {
    it("refuses a signed-out reporter with 401 — an anonymous report cannot be deduplicated", async () => {
      const response = await request(app).post(teardownReportPath).send({ reason: "spam", detailText: null });

      expect(response.status).toBe(401);
      expect(createBlueprintContentReport).not.toHaveBeenCalled();
    });

    /** ⚠️ CONTRACT 2. */
    it("answers 201 with a report id AND NOTHING ELSE", async () => {
      signInAs();
      createBlueprintContentReport.mockResolvedValue({
        success: true,
        value: { reportId: "rep_1" },
      });

      const response = await request(app)
        .post(teardownReportPath)
        .send({ reason: "fabricated_measurements", detailText: "The figures do not match." });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ reportId: "rep_1" });
    });

    it("routes each arm to its own tables", async () => {
      signInAs();
      createBlueprintContentReport.mockResolvedValue({ success: true, value: { reportId: "r" } });

      await request(app).post(teardownReportPath).send({ reason: "spam", detailText: null });
      await request(app)
        .post("/blueprints/case-studies/some-lesson/reports")
        .send({ reason: "spam", detailText: null });
      await request(app).post("/blueprints/showcases/some-launch/reports").send({ reason: "spam", detailText: null });

      expect(createBlueprintContentReport.mock.calls[0]?.[0]).toMatchObject({ arm: "teardown" });
      expect(createBlueprintContentReport.mock.calls[1]?.[0]).toMatchObject({ arm: "case_study" });
      expect(createBlueprintContentReport.mock.calls[2]?.[0]).toMatchObject({ arm: "showcase" });
    });

    /**
     * ⚠️ THE SHOWCASE INTAKE TAKES THE SAME GUARDS AS THE OTHER TWO, and the anonymous case is the
     * one worth asserting per arm rather than once: the two partial unique indexes are the
     * anti-brigading control, and an anonymous report cannot be deduplicated — so an arm that
     * accepted one would make the queue's depth something anybody could manufacture.
     */
    it("refuses a signed-out reporter on the showcase arm with 401", async () => {
      const response = await request(app)
        .post("/blueprints/showcases/some-launch/reports")
        .send({ reason: "spam", detailText: null });

      expect(response.status).toBe(401);
      expect(createBlueprintContentReport).not.toHaveBeenCalled();
    });

    it("carries the launch slug through as the target slug", async () => {
      signInAs();
      createBlueprintContentReport.mockResolvedValue({ success: true, value: { reportId: "r" } });

      await request(app)
        .post("/blueprints/showcases/solar-lamp-v2/reports")
        .send({ reason: "not_the_stated_product", detailText: null });

      expect(createBlueprintContentReport.mock.calls[0]?.[0]).toMatchObject({
        arm: "showcase",
        slug: "solar-lamp-v2",
      });
    });

    it("refuses an unknown reason with 422 — the labels are snake_case and sent verbatim", async () => {
      signInAs();

      const response = await request(app).post(teardownReportPath).send({ reason: "copyright", detailText: null });

      expect(response.status).toBe(422);
      expect(createBlueprintContentReport).not.toHaveBeenCalled();
    });

    it("refuses a body-carried reporter id with 422 — the schema is .strict()", async () => {
      signInAs();

      const response = await request(app)
        .post(teardownReportPath)
        .send({ reason: "spam", detailText: null, reporterUserId: "user_someone_else" });

      expect(response.status).toBe(422);
      expect(createBlueprintContentReport).not.toHaveBeenCalled();
    });

    it("answers 409 for a repeat report and 403 for reporting your own work", async () => {
      signInAs();

      createBlueprintContentReport.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_ALREADY_REPORTED" },
      });
      const repeat = await request(app).post(teardownReportPath).send({ reason: "spam", detailText: null });
      expect(repeat.status).toBe(409);

      createBlueprintContentReport.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_SELF_REPORT_FORBIDDEN" },
      });
      const ownWork = await request(app).post(teardownReportPath).send({ reason: "spam", detailText: null });
      expect(ownWork.status).toBe(403);
    });

    /**
     * ⚠️ THE REPEAT REFUSAL SAYS "YOU", AND THAT IS THE WHOLE SENTENCE. Telling a reader that other
     * people have also reported something would make brigading measurable.
     */
    it("does not disclose that anybody else has reported the same row", async () => {
      signInAs();
      createBlueprintContentReport.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_ALREADY_REPORTED" },
      });

      const response = await request(app).post(teardownReportPath).send({ reason: "spam", detailText: null });

      expect(response.body.message).toContain("You have already reported this");
      expect(JSON.stringify(response.body)).not.toMatch(/\d+\s*(other|report)/i);
    });
  });

  describe("the reporter's own list", () => {
    it("refuses a signed-out caller and serves a signed-in one", async () => {
      expect((await request(app).get("/blueprints/reports/mine")).status).toBe(401);

      signInAs();
      listMyBlueprintReports.mockResolvedValue([]);
      const response = await request(app).get("/blueprints/reports/mine");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });
  });

  describe("the moderator queue", () => {
    it("refuses a non-moderator with 403", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).get("/blueprints/admin/content-reports");

      expect(response.status).toBe(403);
      expect(listBlueprintReportQueue).not.toHaveBeenCalled();
    });

    /** ⚠️ CONTRACT 3 — the §3.6 ordering proof, on the queue. */
    it("answers 403 — NOT 422 — when the caller lacks the capability AND the query is malformed", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app)
        .get("/blueprints/admin/content-reports")
        .query({ status: "sideways", limit: "9999" });

      expect(response.status).toBe(403);
      expect(listBlueprintReportQueue).not.toHaveBeenCalled();
    });

    it("defaults to the open queue and answers 422 for a malformed cursor", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      listBlueprintReportQueue.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      const defaulted = await request(app).get("/blueprints/admin/content-reports");
      expect(defaulted.status).toBe(200);
      expect(listBlueprintReportQueue.mock.calls[0]?.[0]).toMatchObject({ status: "open" });

      listBlueprintReportQueue.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_CURSOR_MALFORMED" },
      });
      const badCursor = await request(app).get("/blueprints/admin/content-reports").query({ cursor: "nope" });
      expect(badCursor.status).toBe(422);
    });
  });

  describe("the dismissal", () => {
    it("requires a resolution note", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await request(app)
        .post("/blueprints/admin/content-reports/rep_1/dismiss")
        .set("Idempotency-Key", "key-no-note")
        .send({ resolutionNote: "   " });

      expect(response.status).toBe(422);
      expect(dismissBlueprintContentReport).not.toHaveBeenCalled();
    });

    it("answers 409 for a report that has already been answered", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      dismissBlueprintContentReport.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_REPORT_ALREADY_RESOLVED" },
      });

      const response = await request(app)
        .post("/blueprints/admin/content-reports/rep_1/dismiss")
        .set("Idempotency-Key", "key-twice")
        .send({ resolutionNote: "Checked; the figures are consistent." });

      expect(response.status).toBe(409);
    });
  });
});
