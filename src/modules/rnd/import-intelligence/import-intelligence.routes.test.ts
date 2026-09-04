import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * §11m's routes, against the REAL app with the services mocked.
 *
 * WHAT THIS PROVES THAT A SERVICE TEST CANNOT: that the routes are mounted, in the right
 * order, behind the right middleware, and wired to the right controller. Every assertion
 * below passes on a route that is mounted in the wrong order, guarded by the wrong
 * middleware, or wired to the wrong handler — which is why they are written against the
 * assembled app rather than against the controller functions.
 *
 * No database: `#src/db/index.js` is mocked wholesale, and every service call is stubbed.
 */
stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` queries `user`, `account` and `passkey` to prove the caller is
 * not an anonymous throwaway. It is stubbed to a pass-through here because this suite is
 * about ROUTING, and the guard has its own dedicated suite
 * (`src/middleware/require-identified-user.test.ts`) that exercises both of its clauses
 * against a real query builder. Leaving it live would mean every write test asserted
 * nothing but that the database mock is empty.
 *
 * ⚠️ THE ROUTES STILL DECLARE IT — `rate-limit-coverage.test.ts` walks the real router
 * stack, so a write that dropped the guard would still be caught there rather than here.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const listImportReporters = vi.fn<(...args: readonly unknown[]) => unknown>();
const listImportCommodities = vi.fn<(...args: readonly unknown[]) => unknown>();
const getImportCommodityByHsCode = vi.fn<(...args: readonly unknown[]) => unknown>();
const getCommodityAssessment = vi.fn<(...args: readonly unknown[]) => unknown>();
const listTradeFlowsForCommodity = vi.fn<(...args: readonly unknown[]) => unknown>();
const listSubstitutesForCommodity = vi.fn<(...args: readonly unknown[]) => unknown>();
const listLocalizationAssessments = vi.fn<(...args: readonly unknown[]) => unknown>();
const createDomesticSubstitute = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateDomesticSubstitute = vi.fn<(...args: readonly unknown[]) => unknown>();
const decidePathwaySuggestion = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/import-intelligence/import-intelligence.service.js", () => ({
  listImportReporters: (...args: readonly unknown[]) => listImportReporters(...args),
  listImportCommodities: (...args: readonly unknown[]) => listImportCommodities(...args),
  getImportCommodityByHsCode: (...args: readonly unknown[]) => getImportCommodityByHsCode(...args),
  getCommodityAssessment: (...args: readonly unknown[]) => getCommodityAssessment(...args),
  listTradeFlowsForCommodity: (...args: readonly unknown[]) => listTradeFlowsForCommodity(...args),
  listSubstitutesForCommodity: (...args: readonly unknown[]) => listSubstitutesForCommodity(...args),
  listLocalizationAssessments: (...args: readonly unknown[]) => listLocalizationAssessments(...args),
  createDomesticSubstitute: (...args: readonly unknown[]) => createDomesticSubstitute(...args),
  updateDomesticSubstitute: (...args: readonly unknown[]) => updateDomesticSubstitute(...args),
  decidePathwaySuggestion: (...args: readonly unknown[]) => decidePathwaySuggestion(...args),
}));

const requirePlatformCapability = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (...args: readonly unknown[]) => requirePlatformCapability(...args),
}));

const COMMODITY = {
  hsCode: "854231",
  displayLabel: "Electronic integrated circuits",
  descriptionText: null,
  commodityKind: "electronic_subassembly",
  researchCategoryId: "cat-1",
  researchCategorySlug: "manufacturing",
  defaultQuantityUnit: "units",
};

let app: Express;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(async () => {
  vi.clearAllMocks();
  signInAs();
  await resetRateLimiters();
  // Default: the caller is NOT staff. Each test that needs staff says so.
  requirePlatformCapability.mockResolvedValue({
    success: false,
    error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_taxonomy" },
  });
});

describe("the six reads are public", () => {
  it("serves the commodity directory signed out", async () => {
    signOut();
    listImportCommodities.mockResolvedValue({ rows: [COMMODITY], total: 1 });

    const response = await request(app).get("/import-commodities");

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.pagination).toStrictEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
  });

  it("serves the kind vocabulary signed out, unpaginated", async () => {
    signOut();
    const response = await request(app).get("/import-commodity-kinds");

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(16);
    expect(response.body.pagination).toBeUndefined();
  });

  it("serves the reporter list signed out, unpaginated", async () => {
    signOut();
    listImportReporters.mockResolvedValue([
      {
        countryCode: "IN",
        regionSlug: "india",
        displayLabel: "India",
        commodityCount: 5_668,
        flowCount: 60_550,
        earliestPeriodYear: 2019,
        latestPeriodYear: 2024,
      },
    ]);

    const response = await request(app).get("/import-reporters");

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    // The counts ride along so a picker can say how much is behind a chip before it is clicked.
    expect(response.body.data[0].commodityCount).toBe(5_668);
    expect(response.body.pagination).toBeUndefined();
  });

  it("serves the leaderboard signed out", async () => {
    signOut();
    listLocalizationAssessments.mockResolvedValue({ rows: [], total: 0 });

    const response = await request(app).get("/localization-assessments");
    expect(response.status).toBe(200);
  });

  it("passes parsed filters through to the service, never the raw query", async () => {
    listImportCommodities.mockResolvedValue({ rows: [], total: 0 });

    await request(app).get("/import-commodities?commodityKind=metal&reporterCountryCode=IN&limit=5&page=2");

    expect(listImportCommodities).toHaveBeenCalledWith({
      commodityKind: "metal",
      reporterCountryCode: "IN",
      page: 2,
      limit: 5,
    });
  });

  it("422s an unknown query key rather than ignoring it", async () => {
    const response = await request(app).get("/import-commodities?sortBy=score");

    expect(response.status).toBe(422);
    expect(listImportCommodities).not.toHaveBeenCalled();
  });
});

describe("route order", () => {
  it("does not let /:hsCode swallow the nested literals", async () => {
    getImportCommodityByHsCode.mockResolvedValue({ success: true, value: COMMODITY });
    listTradeFlowsForCommodity.mockResolvedValue({
      success: true,
      value: { rows: [], total: 0 },
    });

    const response = await request(app).get("/import-commodities/854231/trade-flows");

    expect(response.status).toBe(200);
    expect(listTradeFlowsForCommodity).toHaveBeenCalled();
    // The detail handler must NOT have answered this path.
    expect(getCommodityAssessment).not.toHaveBeenCalled();
  });

  it("does not let /import-commodities swallow /import-commodity-kinds", async () => {
    const response = await request(app).get("/import-commodity-kinds");

    expect(response.status).toBe(200);
    expect(listImportCommodities).not.toHaveBeenCalled();
  });
});

describe("the commodity detail read", () => {
  it("404s an unknown commodity", async () => {
    getImportCommodityByHsCode.mockResolvedValue({
      success: false,
      error: { type: "COMMODITY_NOT_FOUND", hsCode: "999999" },
    });

    const response = await request(app).get("/import-commodities/999999");
    expect(response.status).toBe(404);
  });

  it("returns a NULL assessment rather than 404ing a commodity nobody has scored", async () => {
    // "Not scored yet" and "no such commodity" are different facts.
    getImportCommodityByHsCode.mockResolvedValue({ success: true, value: COMMODITY });
    getCommodityAssessment.mockResolvedValue({ assessment: null, suggestions: [] });

    const response = await request(app).get("/import-commodities/854231");

    expect(response.status).toBe(200);
    expect(response.body.data.assessment).toBeNull();
    expect(response.body.data.commodity.hsCode).toBe("854231");
  });

  it("422s a malformed HS code before touching the service", async () => {
    const response = await request(app).get("/import-commodities/not-a-code");

    expect(response.status).toBe(422);
    expect(getImportCommodityByHsCode).not.toHaveBeenCalled();
  });
});

describe("the substitutes read widens for a moderator", () => {
  it("hides drafts from a signed-out reader", async () => {
    signOut();
    getImportCommodityByHsCode.mockResolvedValue({ success: true, value: COMMODITY });
    listSubstitutesForCommodity.mockResolvedValue({ success: true, value: { rows: [], total: 0 } });

    await request(app).get("/import-commodities/854231/substitutes");

    expect(listSubstitutesForCommodity).toHaveBeenCalledWith("854231", expect.anything(), { includeDrafts: false });
  });

  it("hides drafts from a signed-in NON-moderator", async () => {
    getImportCommodityByHsCode.mockResolvedValue({ success: true, value: COMMODITY });
    listSubstitutesForCommodity.mockResolvedValue({ success: true, value: { rows: [], total: 0 } });

    await request(app).get("/import-commodities/854231/substitutes");

    expect(listSubstitutesForCommodity).toHaveBeenCalledWith("854231", expect.anything(), { includeDrafts: false });
  });

  it("shows drafts to a moderator", async () => {
    requirePlatformCapability.mockResolvedValue({ success: true, value: {} });
    getImportCommodityByHsCode.mockResolvedValue({ success: true, value: COMMODITY });
    listSubstitutesForCommodity.mockResolvedValue({ success: true, value: { rows: [], total: 0 } });

    await request(app).get("/import-commodities/854231/substitutes");

    expect(listSubstitutesForCommodity).toHaveBeenCalledWith("854231", expect.anything(), { includeDrafts: true });
  });
});

describe("the three writes", () => {
  const CREATE_BODY = {
    hsCode: "854231",
    regionSlug: "india",
    substituteKind: "domestic_component",
    substituteLabel: "Domestic OSAT packaging",
    maturityLevel: "pilot_scale",
  };

  it.each([
    ["post", "/domestic-substitutes"],
    ["patch", "/domestic-substitutes/sub-1"],
    ["post", "/localization-pathway-suggestions/sug-1/decision"],
  ])("401s %s %s when signed out, without reaching the service", async (method, path) => {
    signOut();

    const response = await (method === "post"
      ? request(app).post(path).send(CREATE_BODY)
      : request(app).patch(path).send({ isPublished: true }));

    expect(response.status).toBe(401);
    expect(createDomesticSubstitute).not.toHaveBeenCalled();
    expect(updateDomesticSubstitute).not.toHaveBeenCalled();
    expect(decidePathwaySuggestion).not.toHaveBeenCalled();
  });

  it("403s a non-moderator with a payload naming the CAPABILITY, never the role", async () => {
    createDomesticSubstitute.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_taxonomy" },
    });

    const response = await request(app).post("/domestic-substitutes").send(CREATE_BODY);

    expect(response.status).toBe(403);
    expect(response.body.errors.capability).toStrictEqual(["moderate_taxonomy"]);
  });

  it("gives a BYTE-IDENTICAL 403 for a real and a garbage id, so it is not an oracle", async () => {
    // The capability check runs before any id is read, so both refusals are the same.
    decidePathwaySuggestion.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_taxonomy" },
    });

    const real = await request(app)
      .post("/localization-pathway-suggestions/a-real-looking-id/decision")
      .send({ decision: "accepted" });
    const garbage = await request(app)
      .post("/localization-pathway-suggestions/zzzz/decision")
      .send({ decision: "accepted" });

    expect(real.status).toBe(403);
    expect(garbage.status).toBe(403);
    expect(real.body).toStrictEqual(garbage.body);
  });

  it("201s a created substitute and passes the actor from the SESSION", async () => {
    createDomesticSubstitute.mockResolvedValue({
      success: true,
      value: { id: "sub-1", ...CREATE_BODY },
    });

    const response = await request(app).post("/domestic-substitutes").send(CREATE_BODY);

    expect(response.status).toBe(201);
    // The actor is the first argument and comes from the session, never from the body.
    expect(createDomesticSubstitute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ hsCode: "854231" }),
    );
  });

  it("422s a body carrying a server-owned key, before reaching the service", async () => {
    const response = await request(app)
      .post("/domestic-substitutes")
      .send({ ...CREATE_BODY, feasibilityScorePoints: 99 });

    expect(response.status).toBe(422);
    expect(createDomesticSubstitute).not.toHaveBeenCalled();
  });

  it("409s a duplicate mapping with a message that says what to do instead", async () => {
    createDomesticSubstitute.mockResolvedValue({
      success: false,
      error: { type: "SUBSTITUTE_ALREADY_MAPPED", substituteLabel: "Domestic OSAT packaging" },
    });

    const response = await request(app).post("/domestic-substitutes").send(CREATE_BODY);

    expect(response.status).toBe(409);
    expect(response.body.message).toContain("Edit the existing mapping");
  });

  it("409s a second decision rather than overwriting the first reviewer", async () => {
    decidePathwaySuggestion.mockResolvedValue({
      success: false,
      error: { type: "SUGGESTION_ALREADY_DECIDED", suggestionId: "sug-1" },
    });

    const response = await request(app)
      .post("/localization-pathway-suggestions/sug-1/decision")
      .send({ decision: "accepted" });

    expect(response.status).toBe(409);
  });

  it("422s a decision of `open`, which is an initial state and not a verdict", async () => {
    const response = await request(app)
      .post("/localization-pathway-suggestions/sug-1/decision")
      .send({ decision: "open" });

    expect(response.status).toBe(422);
    expect(decidePathwaySuggestion).not.toHaveBeenCalled();
  });
});
