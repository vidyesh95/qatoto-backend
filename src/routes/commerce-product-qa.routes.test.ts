import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const ORGANIZATION_ID = "commerce_org_voter";
const MEMBER_ID = "member-voter";

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => {
  const attach = (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  };
  // Phase 21 (§14). A SEPARATE property from `commerceOrganization`, deliberately, so a
  // handler cannot read an unactivated workspace as a trading one.
  const attachWorkspace = (req: Request, _res: Response, next: NextFunction): void => {
    req.buyerCommerceWorkspace = {
      organizationId: ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  };
  return {
    attachOptionalSellerCommerceOrganization: attach,
    requireActiveCommerceOrganization: attach,
    requireActiveBuyerCommerceOrganization: attach,
    requireActiveProviderCommerceOrganization: attach,
    requireActiveSellerCommerceOrganization: attach,
    requireProvisionedBuyerCommerceWorkspace: attachWorkspace,
  };
});

const qaStubs = vi.hoisted(() => ({
  setAnswerHelpfulVote: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  clearAnswerHelpfulVote: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listProductQuestions: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listProductQuestionAnswers: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-product-qa.service.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("#src/services/commerce-product-qa.service.js")),
  ...qaStubs,
}));

const catalogStubs = vi.hoisted(() => ({
  resolveEligibleProductRefBySlug: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/catalog/store-catalog.service.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("#src/modules/store/catalog/store-catalog.service.js")),
  ...catalogStubs,
}));

describe("product Q&A vote routes (A24)", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signInAs();
    catalogStubs.resolveEligibleProductRefBySlug.mockResolvedValue({
      id: "prd_1",
      sellerOrganizationId: "org_seller",
    });
  });

  /**
   * PUT and DELETE of a boolean are idempotent by verb, which is why neither route
   * carries `idempotency()` — the same reasoning `commerce-trust.routes.ts` records for
   * the identical review-vote pair.
   */
  describe("PUT /commerce/answers/:answerId/helpful", () => {
    it("records a vote and returns the new count", async () => {
      qaStubs.setAnswerHelpfulVote.mockResolvedValue({
        success: true,
        value: { answerId: "ans_1", isHelpful: true, helpfulCount: 4 },
      });

      const response = await request(app).put("/commerce/answers/ans_1/helpful");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        answerId: "ans_1",
        isHelpful: true,
        helpfulCount: 4,
      });
      expect(qaStubs.setAnswerHelpfulVote).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORGANIZATION_ID, memberId: MEMBER_ID }),
        "ans_1",
      );
    });

    it("succeeds without an Idempotency-Key", async () => {
      qaStubs.setAnswerHelpfulVote.mockResolvedValue({
        success: true,
        value: { answerId: "ans_1", isHelpful: true, helpfulCount: 1 },
      });

      const response = await request(app).put("/commerce/answers/ans_1/helpful");

      expect(response.status).toBe(200);
    });

    /** 403, because it discloses only the caller's own standing, which they already know. */
    it("refuses an author endorsing its own answer with 403", async () => {
      qaStubs.setAnswerHelpfulVote.mockResolvedValue({
        success: false,
        error: { type: "SELF_VOTE_FORBIDDEN" },
      });

      const response = await request(app).put("/commerce/answers/ans_1/helpful");

      expect(response.status).toBe(403);
    });

    it("maps a hidden or missing answer to 404", async () => {
      qaStubs.setAnswerHelpfulVote.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND" },
      });

      const response = await request(app).put("/commerce/answers/ans_gone/helpful");

      expect(response.status).toBe(404);
    });

    it("requires a session", async () => {
      signOut();

      const response = await request(app).put("/commerce/answers/ans_1/helpful");

      expect(response.status).toBe(401);
      expect(qaStubs.setAnswerHelpfulVote).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /commerce/answers/:answerId/helpful", () => {
    it("withdraws a vote", async () => {
      qaStubs.clearAnswerHelpfulVote.mockResolvedValue({
        success: true,
        value: { answerId: "ans_1", isHelpful: false, helpfulCount: 3 },
      });

      const response = await request(app).delete("/commerce/answers/ans_1/helpful");

      expect(response.status).toBe(200);
      expect(response.body.data.isHelpful).toBe(false);
      expect(response.body.data.helpfulCount).toBe(3);
    });

    /**
     * Withdrawing twice is not an error. The count is what it is, and refusing the
     * second call would make the toggle's own state a thing the client must track.
     */
    it("is idempotent when no vote exists", async () => {
      qaStubs.clearAnswerHelpfulVote.mockResolvedValue({
        success: true,
        value: { answerId: "ans_1", isHelpful: false, helpfulCount: 3 },
      });

      const first = await request(app).delete("/commerce/answers/ans_1/helpful");
      const second = await request(app).delete("/commerce/answers/ans_1/helpful");

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.helpfulCount).toBe(3);
    });
  });

  /**
   * A24's read half, following A11's `engagement.viewer`: a nullable object, never a
   * defaulted `false`, because "you have not endorsed this" and "we do not know who you
   * are" are different facts.
   */
  describe("public answer reads carry viewer state", () => {
    it("projects the caller's own vote alongside the count", async () => {
      qaStubs.listProductQuestionAnswers.mockResolvedValue({
        success: true,
        value: {
          items: [
            {
              id: "ans_1",
              questionId: "qst_1",
              authorKind: "seller",
              bodyText: "Yes, 220V is available.",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              helpfulCount: 7,
              viewer: { hasVotedHelpful: true },
              author: null,
            },
          ],
          page: { nextCursor: null, hasMore: false },
        },
      });

      const response = await request(app).get("/store/products/solar-freezer/questions/qst_1/answers");

      expect(response.status).toBe(200);
      expect(response.body.data.items[0].helpfulCount).toBe(7);
      expect(response.body.data.items[0].viewer).toEqual({ hasVotedHelpful: true });
    });

    it("reports a null viewer for an anonymous caller rather than a defaulted false", async () => {
      signOut();
      qaStubs.listProductQuestionAnswers.mockResolvedValue({
        success: true,
        value: {
          items: [
            {
              id: "ans_1",
              questionId: "qst_1",
              authorKind: "seller",
              bodyText: "Yes, 220V is available.",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              helpfulCount: 7,
              viewer: null,
              author: null,
            },
          ],
          page: { nextCursor: null, hasMore: false },
        },
      });

      const response = await request(app).get("/store/products/solar-freezer/questions/qst_1/answers");

      expect(response.status).toBe(200);
      expect(response.body.data.items[0].viewer).toBeNull();
      // The count is public; only the per-viewer state is withheld.
      expect(response.body.data.items[0].helpfulCount).toBe(7);
    });
  });
});
