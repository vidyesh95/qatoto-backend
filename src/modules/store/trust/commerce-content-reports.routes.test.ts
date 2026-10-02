import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * The HTTP contract of the staff moderation routes: what reaches the service, and how each service
 * refusal is spelled on the wire. What the service WRITES is `commerce-content-reports.service.test.ts`.
 *
 * Idempotency is stubbed to its one rule these routes depend on — a REQUIRED key that is missing is
 * a 400 before the handler — because the real middleware stores replays in the database.
 */
vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      if (options.required === true && !req.header("Idempotency-Key")) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "This request requires an Idempotency-Key header.",
        });
        return;
      }
      next();
    },
}));

const reportStubs = vi.hoisted(() => ({
  listWithdrawnProductAnswers: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  decideContentReport: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  restoreContent: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/trust/commerce-content-reports.service.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("#src/modules/store/trust/commerce-content-reports.service.js")),
  ...reportStubs,
}));

const WITHDRAWN_ANSWERS_PATH = "/commerce/admin/withdrawn-answers";

const WITHDRAWN_ANSWER = {
  auditEntryId: "audit_1",
  withdrawnAt: new Date("2026-10-02T08:30:00.123Z"),
  withdrawnBy: "author",
  actorUserId: "user_seller_author",
  actorMemberRoleSnapshot: "owner",
  answerId: "answer_1",
  answerBodyText: "It does leak at the seam.",
  authorKind: "seller",
  answeringOrganizationId: "commerce_org_seller",
  currentVisibilityState: "removed_by_author",
  questionId: "question_1",
  questionBodyText: "Is it waterproof?",
  productId: "product_1",
  productTitle: "Solar pump",
  productPublicSlug: "solar-pump",
};

describe("staff commerce moderation routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe(`GET ${WITHDRAWN_ANSWERS_PATH}`, () => {
    it("401s a signed-out caller without reaching the service", async () => {
      signOut();

      const response = await request(app).get(WITHDRAWN_ANSWERS_PATH);

      expect(response.status).toBe(401);
      expect(reportStubs.listWithdrawnProductAnswers).not.toHaveBeenCalled();
    });

    it("passes the defaults — still_withdrawn, 20 — to the service as the caller", async () => {
      reportStubs.listWithdrawnProductAnswers.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      const response = await request(app).get(WITHDRAWN_ANSWERS_PATH);

      expect(response.status).toBe(200);
      expect(reportStubs.listWithdrawnProductAnswers).toHaveBeenCalledWith("user_test_caller", {
        state: "still_withdrawn",
        limit: 20,
      });
    });

    it("forwards state, limit and cursor", async () => {
      reportStubs.listWithdrawnProductAnswers.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      await request(app).get(`${WITHDRAWN_ANSWERS_PATH}?state=all&limit=5&cursor=abc_def`);

      expect(reportStubs.listWithdrawnProductAnswers).toHaveBeenCalledWith("user_test_caller", {
        state: "all",
        limit: 5,
        cursor: "abc_def",
      });
    });

    it.each([
      ["a targetKind the read cannot honour", "?targetKind=answer"],
      ["the shared queue's status", "?status=open"],
      ["a kebab-cased state", "?state=still-withdrawn"],
      ["an unknown state", "?state=withdrawn"],
      ["a zero limit", "?limit=0"],
      ["a limit over 50", "?limit=51"],
    ])("422s %s", async (_label, queryString) => {
      const response = await request(app).get(`${WITHDRAWN_ANSWERS_PATH}${queryString}`);

      expect(response.status).toBe(422);
      expect(reportStubs.listWithdrawnProductAnswers).not.toHaveBeenCalled();
    });

    it("403s with the capability named when the service refuses the caller", async () => {
      reportStubs.listWithdrawnProductAnswers.mockResolvedValue({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
      });

      const response = await request(app).get(WITHDRAWN_ANSWERS_PATH);

      expect(response.status).toBe(403);
      expect(response.body.data).toEqual({ capability: "moderate_commerce" });
    });

    it("422s an invalid cursor", async () => {
      reportStubs.listWithdrawnProductAnswers.mockResolvedValue({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get(`${WITHDRAWN_ANSWERS_PATH}?cursor=nonsense`);

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("Invalid cursor.");
    });

    it("answers the page under data, with the instant as an ISO string", async () => {
      reportStubs.listWithdrawnProductAnswers.mockResolvedValue({
        success: true,
        value: {
          items: [WITHDRAWN_ANSWER],
          page: { nextCursor: "next_cursor", hasMore: true },
        },
      });

      const response = await request(app).get(WITHDRAWN_ANSWERS_PATH);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        items: [{ ...WITHDRAWN_ANSWER, withdrawnAt: "2026-10-02T08:30:00.123Z" }],
        page: { nextCursor: "next_cursor", hasMore: true },
      });
    });
  });

  describe("POST /commerce/admin/content-reports/:reportId/decisions", () => {
    it("400s without an Idempotency-Key, before the service", async () => {
      const response = await request(app)
        .post("/commerce/admin/content-reports/report_1/decisions")
        .send({ decision: "dismissed" });

      expect(response.status).toBe(400);
      expect(reportStubs.decideContentReport).not.toHaveBeenCalled();
    });

    it("422s a decision outside actioned | dismissed", async () => {
      const response = await request(app)
        .post("/commerce/admin/content-reports/report_1/decisions")
        .set("Idempotency-Key", "key_decide_1")
        .send({ decision: "restored" });

      expect(response.status).toBe(422);
      expect(reportStubs.decideContentReport).not.toHaveBeenCalled();
    });

    it("403s a moderator who belongs to the reported organization", async () => {
      reportStubs.decideContentReport.mockResolvedValue({
        success: false,
        error: { type: "MODERATOR_IS_PARTY" },
      });

      const response = await request(app)
        .post("/commerce/admin/content-reports/report_1/decisions")
        .set("Idempotency-Key", "key_decide_2")
        .send({ decision: "dismissed" });

      expect(response.status).toBe(403);
      expect(reportStubs.decideContentReport).toHaveBeenCalledWith("user_test_caller", "report_1", {
        decision: "dismissed",
      });
    });

    it("409s a report that is already resolved", async () => {
      reportStubs.decideContentReport.mockResolvedValue({
        success: false,
        error: { type: "REPORT_ALREADY_RESOLVED" },
      });

      const response = await request(app)
        .post("/commerce/admin/content-reports/report_1/decisions")
        .set("Idempotency-Key", "key_decide_3")
        .send({ decision: "actioned" });

      expect(response.status).toBe(409);
    });
  });

  describe("POST /commerce/admin/content/restore", () => {
    it("422s a restore with no reasonNote — an un-hide nobody justified is not a record", async () => {
      const response = await request(app)
        .post("/commerce/admin/content/restore")
        .set("Idempotency-Key", "key_restore_1")
        .send({ targetKind: "answer", targetId: "answer_1" });

      expect(response.status).toBe(422);
      expect(reportStubs.restoreContent).not.toHaveBeenCalled();
    });

    it("400s without an Idempotency-Key", async () => {
      const response = await request(app)
        .post("/commerce/admin/content/restore")
        .send({ targetKind: "answer", targetId: "answer_1", reasonNote: "Wrongly withdrawn." });

      expect(response.status).toBe(400);
      expect(reportStubs.restoreContent).not.toHaveBeenCalled();
    });
  });
});
