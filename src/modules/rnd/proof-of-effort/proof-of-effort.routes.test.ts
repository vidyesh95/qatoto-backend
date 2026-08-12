import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the §9 surface — the tier this repo did not have (§11l.2 item 9).
 *
 * WHAT THESE ASSERT that no other test can. The 47 suites below this one check pure
 * functions, Zod shapes and error-map tables; every one of them passes on a route that is
 * mounted in the wrong order, guarded by the wrong middleware, or wired to the wrong
 * controller. `src/app.test.ts` drives the real app but only over `/`, `/health` and a 404.
 *
 * The three properties checked here are the ones §0 and §4a turn on:
 *
 *   1. Signed out is **401** — a client has to render it, and §14 records that this
 *      surprised the frontend once already.
 *   2. A signed-in NON-MEMBER is **404**, and the body is byte-identical to a project that
 *      does not exist. That indistinguishability IS the security property; asserting the
 *      status alone would pass on a handler that leaked "not a member of solar-x".
 *   3. The controller passes the SERVICE the ids the path named, and answers with what the
 *      service returned. That is what catches a handler wired to the wrong service function.
 *
 * The database and Better Auth are stubbed; the services under the routes are mocked so the
 * subject stays the wiring rather than the query.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const requireProjectRole = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRole(...args),
  PROJECT_ROLE_RANK: { founder: 4, admin: 3, maintainer: 2, contributor: 1 },
}));

const listOverrideQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const listClaims = vi.fn<(...args: readonly unknown[]) => unknown>();
const listProjectFairMarketRates = vi.fn<(...args: readonly unknown[]) => unknown>();
const findAllocationProposalView = vi.fn<(...args: readonly unknown[]) => unknown>();
const listAllocationProposals = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/proof-of-effort/effort-claims.service.js", () => ({
  listOverrideQueue: (...args: readonly unknown[]) => listOverrideQueue(...args),
  listClaims: (...args: readonly unknown[]) => listClaims(...args),
}));
vi.mock("#src/modules/rnd/funding/fair-market-rate.service.js", () => ({
  listProjectFairMarketRates: (...args: readonly unknown[]) => listProjectFairMarketRates(...args),
}));
vi.mock("#src/modules/rnd/funding/slice-allocation.service.js", () => ({
  findAllocationProposalView: (...args: readonly unknown[]) => findAllocationProposalView(...args),
  listAllocationProposals: (...args: readonly unknown[]) => listAllocationProposals(...args),
}));

/** What `requireProjectRole` returns for a member of `solar-cold-storage`. */
const MEMBER_CONTEXT = {
  success: true,
  value: {
    projectId: "project_1",
    projectSlug: "solar-cold-storage",
    projectStatus: "active",
    founderUserId: "user_founder",
    currency: "INR",
    memberId: "member_1",
    memberRole: "contributor",
  },
} as const;

/** What it returns for a stranger, an ex-member, an under-privileged member, or a typo. */
const NOT_FOUND = { success: false, error: { type: "NOT_FOUND", projectRef: "solar-cold-storage" } };

describe("proof-of-effort routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication and membership, on every §11l read", () => {
    const routes = [
      "/research-projects/solar-cold-storage/override-queue",
      "/research-projects/solar-cold-storage/fair-market-rates",
      "/research-projects/solar-cold-storage/allocation-proposals/proposal_1",
    ] as const;

    it.each(routes)("answers 401 for a signed-out caller on %s", async (path) => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(requireProjectRole).not.toHaveBeenCalled();
    });

    it.each(routes)("answers 404 for a signed-in non-member on %s", async (path) => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });

    it("gives a non-member and an absent project byte-identical refusals", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);
      const nonMember = await request(app).get("/research-projects/solar-cold-storage/override-queue");

      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "no-such-project" },
      });
      const absent = await request(app).get("/research-projects/no-such-project/override-queue");

      expect(nonMember.status).toBe(absent.status);
      // The BODY, not just the status: a handler that named the project in its message
      // would pass a status-only assertion and still be an existence oracle (§0).
      expect(nonMember.body).toEqual(absent.body);
    });
  });

  describe("GET …/override-queue", () => {
    it("passes the resolved project id and the parsed limit to the service", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listOverrideQueue.mockResolvedValue([]);

      const response = await request(app).get("/research-projects/solar-cold-storage/override-queue?limit=5");

      expect(response.status).toBe(200);
      expect(listOverrideQueue).toHaveBeenCalledWith("project_1", { limit: 5 });
    });

    it("defaults the limit rather than fetching an unbounded queue", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listOverrideQueue.mockResolvedValue([]);

      await request(app).get("/research-projects/solar-cold-storage/override-queue");

      expect(listOverrideQueue).toHaveBeenCalledWith("project_1", { limit: 50 });
    });

    it("rejects an unknown query key with 422 rather than ignoring it", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).get("/research-projects/solar-cold-storage/override-queue?projectId=other");

      expect(response.status).toBe(422);
      expect(listOverrideQueue).not.toHaveBeenCalled();
    });

    it("returns what the service returned", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listOverrideQueue.mockResolvedValue([{ stepId: "step_1", claimId: "claim_1" }]);

      const response = await request(app).get("/research-projects/solar-cold-storage/override-queue");

      expect(response.body.data).toEqual([{ stepId: "step_1", claimId: "claim_1" }]);
    });
  });

  describe("GET …/allocation-proposals/:proposalId", () => {
    it("scopes the lookup by project id, not by slug", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      findAllocationProposalView.mockResolvedValue({ id: "proposal_1" });

      const response = await request(app).get("/research-projects/solar-cold-storage/allocation-proposals/proposal_1");

      expect(response.status).toBe(200);
      expect(findAllocationProposalView).toHaveBeenCalledWith("project_1", "proposal_1");
    });

    it("answers 404 when the proposal belongs to another project", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      findAllocationProposalView.mockResolvedValue(null);

      const response = await request(app).get(
        "/research-projects/solar-cold-storage/allocation-proposals/proposal_elsewhere",
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET …/fair-market-rates", () => {
    it("is the roster read, not the per-member history", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listProjectFairMarketRates.mockResolvedValue([]);

      const response = await request(app).get("/research-projects/solar-cold-storage/fair-market-rates");

      expect(response.status).toBe(200);
      expect(listProjectFairMarketRates).toHaveBeenCalledWith("project_1");
    });
  });

  /**
   * The two reads §11l.2 item 4 left on OFFSET and this change moved to keyset.
   *
   * Both are DUAL MODE, and that is the property worth pinning: `page` still works, because
   * §11l is not allowed to break a client that has not asked for anything new, and `cursor`
   * wins when both arrive, because silently serving a drifting offset page to a client that
   * sent a cursor is the bug this closes. The platform audit trail rejects `page` outright
   * (see `platform-audit.routes.test.ts`); these two must not.
   */
  describe("GET …/allocation-proposals — the keyset ledger", () => {
    const path = "/research-projects/solar-cold-storage/allocation-proposals";
    const emptyPage = { rows: [], nextCursor: null };

    it("decodes the cursor before the service sees it, and passes a typed instant", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listAllocationProposals.mockResolvedValue(emptyPage);

      const response = await request(app).get(`${path}?cursor=1773479700123_proposal_1&limit=5`);

      expect(response.status).toBe(200);
      // A DECODED cursor, not the raw string: parsing untrusted input belongs at the
      // controller boundary (CLAUDE.md §3.1), so the service never sees a client string.
      expect(listAllocationProposals).toHaveBeenCalledWith("project_1", {
        limit: 5,
        cursor: { instant: new Date(1_773_479_700_123), id: "proposal_1" },
      });
    });

    it("answers 422 for a malformed cursor rather than a silent first page", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).get(`${path}?cursor=nonsense`);

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("Malformed cursor.");
      // Not called AT ALL — a first page served here is duplicate rows the client reports
      // as a backend bug (§11h).
      expect(listAllocationProposals).not.toHaveBeenCalled();
    });

    it("still accepts page, so a client that has not adopted the cursor is unaffected", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listAllocationProposals.mockResolvedValue(emptyPage);

      const response = await request(app).get(`${path}?page=3&limit=10`);

      expect(response.status).toBe(200);
      expect(listAllocationProposals).toHaveBeenCalledWith("project_1", { page: 3, limit: 10 });
    });

    it("keeps data a bare array and puts nextCursor alongside it", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listAllocationProposals.mockResolvedValue({
        rows: [{ id: "proposal_1" }],
        nextCursor: "1773479700123_proposal_1",
      });

      const response = await request(app).get(path);

      // The rows do NOT move under an envelope key — that would break every client parsing
      // this read today, which is the same shape rule the slice ledger followed.
      expect(response.body.data).toEqual([{ id: "proposal_1" }]);
      expect(response.body.nextCursor).toBe("1773479700123_proposal_1");
    });

    it("rejects an unknown query key with 422 rather than ignoring it", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).get(`${path}?projectId=other`);

      expect(response.status).toBe(422);
      expect(listAllocationProposals).not.toHaveBeenCalled();
    });
  });

  describe("GET …/effort-claims — the keyset claim list", () => {
    const path = "/research-projects/solar-cold-storage/effort-claims";

    it("decodes the date cursor and passes it typed, never as a Date", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listClaims.mockResolvedValue({ rows: [], total: null, nextCursor: null });

      const response = await request(app).get(`${path}?cursor=2026-03-14_claim_1&limit=5`);

      expect(response.status).toBe(200);
      // `calendarDate` stays a STRING. Putting a date-only value through a Date is how a day
      // shifts by one in a non-UTC zone.
      expect(listClaims).toHaveBeenCalledWith("project_1", {
        page: 1,
        limit: 5,
        cursor: { calendarDate: "2026-03-14", id: "claim_1" },
      });
    });

    it("answers 422 for a malformed cursor rather than a silent first page", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).get(`${path}?cursor=14-03-2026_claim_1`);

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("Malformed cursor.");
      expect(listClaims).not.toHaveBeenCalled();
    });

    /**
     * The `pagination` block is unchanged; `nextCursor` now rides alongside it.
     *
     * It used to be omitted here, which left keyset mode with NO ENTRANCE: a first request
     * carries no cursor by definition, so a client could never obtain the cursor it had to
     * send. Both fields are honest together — offset mode runs the COUNT, so `total` is real,
     * and the service fetches one extra row, so `nextCursor` is real.
     */
    it("keeps the pagination envelope in offset mode and carries nextCursor alongside it", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listClaims.mockResolvedValue({ rows: [], total: 42, nextCursor: "2026-03-14_claim_1" });

      const response = await request(app).get(`${path}?page=2&limit=20`);

      expect(response.status).toBe(200);
      expect(response.body.pagination).toEqual({ page: 2, limit: 20, total: 42, totalPages: 3 });
      expect(response.body.nextCursor).toBe("2026-03-14_claim_1");
    });

    it("drops the pagination envelope in keyset mode instead of reporting a total of zero", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listClaims.mockResolvedValue({
        rows: [{ id: "claim_1" }],
        total: null,
        nextCursor: "2026-03-14_claim_1",
      });

      const response = await request(app).get(`${path}?cursor=2026-03-15_claim_9`);

      // A zeroed `pagination` block would render as "no claims" beneath a list of claims.
      expect(response.body.pagination).toBeUndefined();
      expect(response.body.data).toEqual([{ id: "claim_1" }]);
      expect(response.body.nextCursor).toBe("2026-03-14_claim_1");
    });
  });
});
