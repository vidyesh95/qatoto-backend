import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the fair-market-rate subtree of `proof-of-effort.routes.ts`
 * (§9/§9.6, §11e). The existing `proof-of-effort.routes.test.ts` covers only the roster
 * read (`GET …/fair-market-rates`); every write in this lifecycle — propose, accept, lock —
 * had zero coverage before this file.
 *
 * `lockFairMarketRate` is the irreversible step: once locked, a rate prices every hour of
 * effort claimed from its effective date onward (`RATE_ALREADY_LOCKED`/`RATE_NOT_LOCKED` in
 * `proof-of-effort-error-response.ts`), and `compensation.routes.ts` depends on it being
 * locked before a statement can be finalized. It is founder-only in the controller
 * (`requireRoleOrRespond(req, res, "founder")`), which this file asserts directly rather
 * than assuming.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` hits the real `db` query builder; it has its own dedicated suite
 * (`src/middleware/require-identified-user.test.ts`). Stubbed to a pass-through here so this
 * suite stays about routing/wiring, following the precedent in
 * `import-intelligence.routes.test.ts`.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const requireProjectRole = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRole(...args),
  PROJECT_ROLE_RANK: { founder: 4, admin: 3, maintainer: 2, contributor: 1 },
}));

const proposeFairMarketRate = vi.fn<(...args: readonly unknown[]) => unknown>();
const listFairMarketRateHistory = vi.fn<(...args: readonly unknown[]) => unknown>();
const acceptFairMarketRate = vi.fn<(...args: readonly unknown[]) => unknown>();
const lockFairMarketRate = vi.fn<(...args: readonly unknown[]) => unknown>();
const listProjectFairMarketRates = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/funding/fair-market-rate.service.js", () => ({
  proposeFairMarketRate: (...args: readonly unknown[]) => proposeFairMarketRate(...args),
  listFairMarketRateHistory: (...args: readonly unknown[]) => listFairMarketRateHistory(...args),
  acceptFairMarketRate: (...args: readonly unknown[]) => acceptFairMarketRate(...args),
  lockFairMarketRate: (...args: readonly unknown[]) => lockFairMarketRate(...args),
  listProjectFairMarketRates: (...args: readonly unknown[]) => listProjectFairMarketRates(...args),
}));

/** What `requireProjectRole` returns for a founder-role member of `solar-cold-storage`. */
const FOUNDER_CONTEXT = {
  success: true,
  value: {
    projectId: "project_1",
    projectSlug: "solar-cold-storage",
    projectStatus: "active",
    founderUserId: "user_test_caller",
    currency: "INR",
    memberId: "member_1",
    memberRole: "founder",
  },
} as const;

/** What it returns for a plain contributor. */
const CONTRIBUTOR_CONTEXT = {
  success: true,
  value: { ...FOUNDER_CONTEXT.value, memberId: "member_2", memberRole: "contributor" },
} as const;

const NOT_FOUND = { success: false, error: { type: "NOT_FOUND", projectRef: "solar-cold-storage" } };

const SLUG = "solar-cold-storage";
const BASE = `/research-projects/${SLUG}`;

describe("proof-of-effort fair-market-rate routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication and membership", () => {
    it("answers 401 for a signed-out caller locking a rate", async () => {
      signOut();

      const response = await request(app)
        .post(`${BASE}/fair-market-rate/lock`)
        .send({ rateId: "123e4567-e89b-12d3-a456-426614174000", acknowledgement: "LOCK" });

      expect(response.status).toBe(401);
      expect(lockFairMarketRate).not.toHaveBeenCalled();
    });

    it("answers 404 for a signed-in non-member proposing a rate", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).post(`${BASE}/members/user_2/fair-market-rate`).send({
        fairMarketRateCentsPerHour: "5000",
        paidCashRateCentsPerHour: "3000",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        rationaleNote: "Market study for this role.",
      });

      expect(response.status).toBe(404);
    });

    it("gives a non-member and an absent project byte-identical refusals on the roster read", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);
      const nonMember = await request(app).get(`${BASE}/fair-market-rates`);

      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "no-such-project" },
      });
      const absent = await request(app).get("/research-projects/no-such-project/fair-market-rates");

      expect(nonMember.status).toBe(absent.status);
      expect(nonMember.body).toEqual(absent.body);
    });
  });

  describe("POST …/members/:memberUserId/fair-market-rate — founder proposes", () => {
    const path = `${BASE}/members/user_2/fair-market-rate`;
    const validBody = {
      fairMarketRateCentsPerHour: "5000",
      paidCashRateCentsPerHour: "3000",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      rationaleNote: "Market study for this role.",
    };

    it("proposes a rate and passes the caller as proposer, never a body field", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      proposeFairMarketRate.mockResolvedValue({ success: true, value: { id: "rate_1" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(proposeFairMarketRate).toHaveBeenCalledWith(
        FOUNDER_CONTEXT.value,
        "user_2",
        "user_test_caller",
        "founder",
        expect.objectContaining({
          fairMarketRateCentsPerHour: 5000n,
          paidCashRateCentsPerHour: 3000n,
          rationaleNote: "Market study for this role.",
        }),
      );
    });

    it("rejects a body naming a currency, since currency is never client-chosen", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);

      const response = await request(app)
        .post(path)
        .send({ ...validBody, currencyCode: "USD" });

      expect(response.status).toBe(422);
      expect(proposeFairMarketRate).not.toHaveBeenCalled();
    });

    it("maps RATE_SUBJECT_NOT_A_MEMBER to 422", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      proposeFairMarketRate.mockResolvedValue({
        success: false,
        error: { type: "RATE_SUBJECT_NOT_A_MEMBER" },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(422);
    });

    it("maps RETROACTIVE_RATE_CHANGE to 409", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      proposeFairMarketRate.mockResolvedValue({
        success: false,
        error: {
          type: "RETROACTIVE_RATE_CHANGE",
          lockedEffectiveFrom: new Date("2025-06-01T00:00:00.000Z"),
        },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });
  });

  describe("GET …/members/:memberUserId/fair-market-rate — history", () => {
    it("loads the full per-member history", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      listFairMarketRateHistory.mockResolvedValue({ success: true, value: [{ id: "rate_1" }] });

      const response = await request(app).get(`${BASE}/members/user_2/fair-market-rate`);

      expect(response.status).toBe(200);
      expect(listFairMarketRateHistory).toHaveBeenCalledWith("project_1", "user_2");
      expect(response.body.data).toEqual([{ id: "rate_1" }]);
    });
  });

  describe("POST …/members/:memberUserId/fair-market-rate/:rateId/accept — the subject only", () => {
    const path = `${BASE}/members/user_2/fair-market-rate/rate_1/accept`;

    it("accepts on behalf of the resolved caller", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      acceptFairMarketRate.mockResolvedValue({ success: true, value: { status: "accepted" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(acceptFairMarketRate).toHaveBeenCalledWith(
        CONTRIBUTOR_CONTEXT.value,
        "rate_1",
        "user_test_caller",
        "contributor",
      );
    });

    it("maps NOT_THE_RATE_SUBJECT to 403", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      acceptFairMarketRate.mockResolvedValue({
        success: false,
        error: { type: "NOT_THE_RATE_SUBJECT" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(403);
    });

    it("maps RATE_ALREADY_ACCEPTED to 409", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);
      acceptFairMarketRate.mockResolvedValue({
        success: false,
        error: { type: "RATE_ALREADY_ACCEPTED" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(409);
    });
  });

  describe("POST …/fair-market-rate/lock — irreversible, founder only", () => {
    const path = `${BASE}/fair-market-rate/lock`;
    const validBody = { rateId: "123e4567-e89b-12d3-a456-426614174000", acknowledgement: "LOCK" };

    it("is refused for a plain contributor, proving the founder floor is real", async () => {
      requireProjectRole.mockResolvedValue(CONTRIBUTOR_CONTEXT);

      // requireRoleOrRespond is called with minimumRole="founder"; the mocked
      // requireProjectRole does not itself enforce rank, so this asserts the CONTROLLER
      // asked for "founder" — a contributor context can only reach here if the service
      // mock resolves success regardless of role, which would be the real bug this catches.
      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: SLUG },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(404);
      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "founder");
      expect(lockFairMarketRate).not.toHaveBeenCalled();
    });

    it("locks the rate and never accepts an amount in the body", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      lockFairMarketRate.mockResolvedValue({ success: true, value: { status: "locked" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(200);
      expect(lockFairMarketRate).toHaveBeenCalledWith(
        FOUNDER_CONTEXT.value,
        "123e4567-e89b-12d3-a456-426614174000",
        "LOCK",
        "user_test_caller",
        "founder",
      );
    });

    it("rejects a body carrying an amount rather than an acknowledgement", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);

      const response = await request(app)
        .post(path)
        .send({ rateId: "123e4567-e89b-12d3-a456-426614174000", fairMarketRateCentsPerHour: "5000" });

      expect(response.status).toBe(422);
      expect(lockFairMarketRate).not.toHaveBeenCalled();
    });

    it("maps RATE_NOT_ACCEPTED to 409 — an unaccepted rate cannot be locked", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      lockFairMarketRate.mockResolvedValue({ success: false, error: { type: "RATE_NOT_ACCEPTED" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("maps RATE_ALREADY_LOCKED to 409 — locking is a one-way door", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      lockFairMarketRate.mockResolvedValue({
        success: false,
        error: { type: "RATE_ALREADY_LOCKED" },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("maps ACKNOWLEDGEMENT_MISMATCH to 422", async () => {
      requireProjectRole.mockResolvedValue(FOUNDER_CONTEXT);
      lockFairMarketRate.mockResolvedValue({
        success: false,
        error: { type: "ACKNOWLEDGEMENT_MISMATCH", expected: "LOCK" },
      });

      const response = await request(app)
        .post(path)
        .send({ rateId: "123e4567-e89b-12d3-a456-426614174000", acknowledgement: "lock" });

      expect(response.status).toBe(422);
    });
  });
});
