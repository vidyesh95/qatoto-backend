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

const idempotencyCache = vi.hoisted(() => new Map<string, { statusCode: number; body: unknown }>());

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const key = req.header("Idempotency-Key");
      if (!key) {
        if (options.required === true) {
          res.status(400).json({
            status: "error",
            statusCode: 400,
            message: "This request requires an Idempotency-Key header.",
          });
          return;
        }
        next();
        return;
      }
      const cached = idempotencyCache.get(key);
      if (cached) {
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          idempotencyCache.set(key, { statusCode: res.statusCode, body });
        }
        return originalJson(body);
      }) as typeof res.json;
      next();
    },
}));

const serviceStubs = vi.hoisted(() => ({
  createFreightRateCard: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateFreightRateCard: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  appendFreightRateBreak: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replaceFreightRateBreaks: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  createCustomsDwellEstimate: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  retireCustomsDwellEstimate: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listFreightRateCards: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listCustomsDwellEstimates: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-freight-rates.service.js", () => serviceStubs);

const RATE_CARD_PROJECTION = {
  id: "rate_card_1",
  providerOrganizationId: "commerce_org_forwarder",
  originCountryCode: "IN",
  destinationCountryCode: "DE",
  mode: "sea",
  currency: "USD",
  sourceForwarderName: "Blue Anchor Logistics",
  state: "active",
  breaks: [],
};

const VALID_BAND = {
  minBillableWeightGrams: 0,
  minVolumeCubicCm: 0,
  unitPriceInCents: 420,
  minimumChargeInCents: 15_000,
  transitDaysMin: 24,
  transitDaysMax: 34,
};

const VALID_CREATE_BODY = {
  providerOrganizationId: "commerce_org_forwarder",
  originCountryCode: "IN",
  destinationCountryCode: "DE",
  mode: "sea",
  currency: "USD",
  sourceForwarderName: "Blue Anchor Logistics",
  // §19.9. Ocean LCL's W/M convention: one cubic metre bills as 1000 kg.
  volumetricDivisorCm3PerKg: 1000,
  breaks: [VALID_BAND],
};

describe("commerce freight rate card admin routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const freightRatesRouter = (await import("#src/routes/commerce-freight-rates.routes.js")).default;
    app.use("/commerce", freightRatesRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
  });

  it("requires an Idempotency-Key to create a rate card", async () => {
    const response = await request(app).post("/commerce/admin/freight-rate-cards").send(VALID_CREATE_BODY);

    expect(response.status).toBe(400);
    expect(serviceStubs.createFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses an unknown body key with 422 AND names it", async () => {
    const response = await request(app)
      .post("/commerce/admin/freight-rate-cards")
      .set("Idempotency-Key", "idem-unknown-key-0001")
      .send({ ...VALID_CREATE_BODY, chargeableUnit: "cbm" });

    expect(response.status).toBe(422);
    expect(serviceStubs.createFreightRateCard).not.toHaveBeenCalled();

    /**
     * ASSERTING THE STATUS ALONE IS WHAT LET THE BUG SURVIVE. `.strict()`'s `unrecognized_keys`
     * is an OBJECT-level issue, so it lands in `formErrors` and reaches the client under the
     * reserved `errors.form`. Twenty-five controllers used to forward `fieldErrors` alone and
     * answered 422 with an empty `errors` — a refusal naming nothing.
     */
    expect(response.body.errors.form).toBeDefined();
    expect(JSON.stringify(response.body.errors.form)).toContain("chargeableUnit");
  });

  it("refuses a card with no bands: a card that prices nothing reads as an uncovered lane", async () => {
    const response = await request(app)
      .post("/commerce/admin/freight-rate-cards")
      .set("Idempotency-Key", "idem-no-bands-0001")
      .send({ ...VALID_CREATE_BODY, breaks: [] });

    expect(response.status).toBe(422);
    expect(serviceStubs.createFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses a zero unit price — §19.6's forbidden zero", async () => {
    const response = await request(app)
      .post("/commerce/admin/freight-rate-cards")
      .set("Idempotency-Key", "idem-zero-price-0001")
      .send({
        ...VALID_CREATE_BODY,
        breaks: [{ ...VALID_BAND, unitPriceInCents: 0 }],
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.createFreightRateCard).not.toHaveBeenCalled();
  });

  it("creates a card and reports the predecessor it superseded", async () => {
    serviceStubs.createFreightRateCard.mockResolvedValue({
      success: true,
      value: { rateCard: RATE_CARD_PROJECTION, supersededRateCardId: "rate_card_0" },
    });

    const response = await request(app)
      .post("/commerce/admin/freight-rate-cards")
      .set("Idempotency-Key", "idem-create-0001")
      .send(VALID_CREATE_BODY);

    expect(response.status).toBe(201);
    expect(response.body.data.supersededRateCardId).toBe("rate_card_0");
    expect(serviceStubs.createFreightRateCard).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        providerOrganizationId: "commerce_org_forwarder",
        mode: "sea",
        volumetricDivisorCm3PerKg: 1000,
        // Absent `validFrom` means "live now", resolved at the controller boundary.
        validFrom: expect.any(Date),
        validUntil: null,
      }),
    );
  });

  it("answers a missing capability with 403, never 401", async () => {
    serviceStubs.createFreightRateCard.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    });

    const response = await request(app)
      .post("/commerce/admin/freight-rate-cards")
      .set("Idempotency-Key", "idem-capability-0001")
      .send(VALID_CREATE_BODY);

    expect(response.status).toBe(403);
  });

  it("answers a card already in force with 409 when its bands are rewritten", async () => {
    serviceStubs.replaceFreightRateBreaks.mockResolvedValue({
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_IN_FORCE",
        rateCardId: "rate_card_1",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const response = await request(app)
      .patch("/commerce/admin/freight-rate-cards/rate_card_1/breaks")
      .set("Idempotency-Key", "idem-in-force-0001")
      .send({ breaks: [VALID_BAND] });

    expect(response.status).toBe(409);
  });

  it("refuses a card with no volumetric divisor — the platform must not pick one", async () => {
    const { volumetricDivisorCm3PerKg: _omitted, ...withoutDivisor } = VALID_CREATE_BODY;

    const response = await request(app)
      .post("/commerce/admin/freight-rate-cards")
      .set("Idempotency-Key", "idem-no-divisor-0001")
      .send(withoutDivisor);

    expect(response.status).toBe(422);
    expect(serviceStubs.createFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses a transposed divisor on either side of the bound", async () => {
    for (const [index, divisor] of [50, 999_999].entries()) {
      const response = await request(app)
        .post("/commerce/admin/freight-rate-cards")
        .set("Idempotency-Key", `idem-bad-divisor-${String(index)}`)
        .send({ ...VALID_CREATE_BODY, volumetricDivisorCm3PerKg: divisor });

      expect(response.status).toBe(422);
    }
    expect(serviceStubs.createFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses a PATCH that restates the divisor — it reprices every past quote", async () => {
    const response = await request(app)
      .patch("/commerce/admin/freight-rate-cards/rate_card_1")
      .set("Idempotency-Key", "idem-restate-divisor-0001")
      .send({
        intent: "shorten_window",
        validUntil: "2026-09-30T00:00:00.000Z",
        volumetricDivisorCm3PerKg: 6000,
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.updateFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses a PATCH that restates a price, as an unrecognized key", async () => {
    const response = await request(app)
      .patch("/commerce/admin/freight-rate-cards/rate_card_1")
      .set("Idempotency-Key", "idem-restate-0001")
      .send({ intent: "shorten_window", validUntil: "2026-09-30T00:00:00.000Z", unitPriceInCents: 500 });

    expect(response.status).toBe(422);
    expect(serviceStubs.updateFreightRateCard).not.toHaveBeenCalled();
  });

  it("requires a reason to withdraw a card", async () => {
    const response = await request(app)
      .patch("/commerce/admin/freight-rate-cards/rate_card_1")
      .set("Idempotency-Key", "idem-withdraw-0001")
      .send({ intent: "withdraw" });

    expect(response.status).toBe(422);
    expect(serviceStubs.updateFreightRateCard).not.toHaveBeenCalled();
  });

  it("reports a widened validity window as 422 naming the field", async () => {
    serviceStubs.updateFreightRateCard.mockResolvedValue({
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_WIDENED",
        currentValidUntil: new Date("2026-09-30T00:00:00.000Z"),
      },
    });

    const response = await request(app)
      .patch("/commerce/admin/freight-rate-cards/rate_card_1")
      .set("Idempotency-Key", "idem-widen-0001")
      .send({ intent: "shorten_window", validUntil: "2027-09-30T00:00:00.000Z" });

    expect(response.status).toBe(422);
    expect(response.body.errors.validUntil).toBeDefined();
  });
});

describe("commerce customs dwell estimate admin routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const freightRatesRouter = (await import("#src/routes/commerce-freight-rates.routes.js")).default;
    app.use("/commerce", freightRatesRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
  });

  it("refuses a domestic lane: an absent customs leg is not a zero-day one", async () => {
    const response = await request(app)
      .post("/commerce/admin/customs-dwell-estimates")
      .set("Idempotency-Key", "idem-domestic-0001")
      .send({
        destinationCountryCode: "IN",
        originCountryCode: "IN",
        commodityScopeCategoryId: null,
        clearanceDaysMin: 3,
        clearanceDaysMax: 10,
        source: "Broker circular",
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.createCustomsDwellEstimate).not.toHaveBeenCalled();
  });

  it("requires the scope nulls to be explicit rather than absent", async () => {
    const response = await request(app)
      .post("/commerce/admin/customs-dwell-estimates")
      .set("Idempotency-Key", "idem-implicit-scope-0001")
      .send({
        destinationCountryCode: "DE",
        clearanceDaysMin: 3,
        clearanceDaysMax: 10,
        source: "Broker circular",
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.createCustomsDwellEstimate).not.toHaveBeenCalled();
  });

  it("records an any-origin, any-commodity estimate", async () => {
    serviceStubs.createCustomsDwellEstimate.mockResolvedValue({
      success: true,
      value: { dwellEstimate: { id: "dwell_1" }, closedDwellEstimateId: null },
    });

    const response = await request(app)
      .post("/commerce/admin/customs-dwell-estimates")
      .set("Idempotency-Key", "idem-dwell-create-0001")
      .send({
        destinationCountryCode: "DE",
        originCountryCode: null,
        commodityScopeCategoryId: null,
        clearanceDaysMin: 3,
        clearanceDaysMax: 10,
        source: "Broker circular",
      });

    expect(response.status).toBe(201);
    expect(serviceStubs.createCustomsDwellEstimate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ originCountryCode: null, commodityScopeCategoryId: null }),
    );
  });

  it("answers a second retirement with 409", async () => {
    serviceStubs.retireCustomsDwellEstimate.mockResolvedValue({
      success: false,
      error: {
        type: "COMMERCE_CUSTOMS_DWELL_ALREADY_CLOSED",
        dwellEstimateId: "dwell_1",
        validUntil: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    const response = await request(app)
      .patch("/commerce/admin/customs-dwell-estimates/dwell_1")
      .set("Idempotency-Key", "idem-dwell-retire-0001")
      .send({ validUntil: "2026-07-01T00:00:00.000Z" });

    expect(response.status).toBe(409);
  });
});

/**
 * §19.10. The two reads that make the writes reachable.
 *
 * The service is stubbed wholesale in this file, so what these prove is the BOUNDARY: which
 * query shapes get through, what the parsed object looks like when it does, and that a refusal
 * from the service lands on the right status. The keyset and the single-query band fetch are
 * not exercised here and cannot be — there is no DB in this suite.
 */
describe("commerce freight rate card admin reads", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const freightRatesRouter = (await import("#src/routes/commerce-freight-rates.routes.js")).default;
    app.use("/commerce", freightRatesRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
  });

  it("returns the §7 list envelope", async () => {
    serviceStubs.listFreightRateCards.mockResolvedValue({
      success: true,
      value: {
        items: [RATE_CARD_PROJECTION],
        page: { nextCursor: null, hasMore: false },
      },
    });

    const response = await request(app).get("/commerce/admin/freight-rate-cards");

    expect(response.status).toBe(200);
    expect(response.body.data.items[0].id).toBe("rate_card_1");
    expect(response.body.data.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("passes every filter through verbatim, enum values snake_case and limit coerced", async () => {
    serviceStubs.listFreightRateCards.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get(
      "/commerce/admin/freight-rate-cards?state=superseded&mode=sea&originCountryCode=IN&limit=5",
    );

    expect(response.status).toBe(200);
    /**
     * The enum values reach the service as the database spells them. A camelCase alias
     * anywhere in this path would be a third spelling of `commerce_freight_rate_card_state`
     * needing translation in both directions forever.
     */
    expect(serviceStubs.listFreightRateCards).toHaveBeenCalledWith("user_test_caller", {
      state: "superseded",
      mode: "sea",
      originCountryCode: "IN",
      limit: 5,
    });
  });

  it("refuses an unknown filter key with 422 AND names it, rather than answering unfiltered", async () => {
    const response = await request(app).get("/commerce/admin/freight-rate-cards?transportMode=sea");

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.errors.form)).toContain("transportMode");
    expect(serviceStubs.listFreightRateCards).not.toHaveBeenCalled();
  });

  it("refuses `multimodal` — a leg mode has four members, not freight_transport_mode's five", async () => {
    const response = await request(app).get("/commerce/admin/freight-rate-cards?mode=multimodal");

    expect(response.status).toBe(422);
    expect(serviceStubs.listFreightRateCards).not.toHaveBeenCalled();
  });

  it("refuses a page size past the ceiling every commerce list shares", async () => {
    const response = await request(app).get("/commerce/admin/freight-rate-cards?limit=500");

    expect(response.status).toBe(422);
    expect(serviceStubs.listFreightRateCards).not.toHaveBeenCalled();
  });

  it("answers a malformed cursor with 422 naming the field, never a silent first page", async () => {
    serviceStubs.listFreightRateCards.mockResolvedValue({
      success: false,
      error: { type: "INVALID_CURSOR" },
    });

    const response = await request(app).get("/commerce/admin/freight-rate-cards?cursor=nonsense");

    expect(response.status).toBe(422);
    expect(response.body.errors.cursor).toBeDefined();
  });

  it("answers a missing capability with 403, never 401 and never an empty page", async () => {
    serviceStubs.listFreightRateCards.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    });

    const response = await request(app).get("/commerce/admin/freight-rate-cards");

    expect(response.status).toBe(403);
  });

  it("answers an anonymous caller with 401 without reaching the service", async () => {
    signOut();

    const response = await request(app).get("/commerce/admin/freight-rate-cards");

    expect(response.status).toBe(401);
    expect(serviceStubs.listFreightRateCards).not.toHaveBeenCalled();
  });
});

describe("commerce customs dwell estimate admin reads", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const freightRatesRouter = (await import("#src/routes/commerce-freight-rates.routes.js")).default;
    app.use("/commerce", freightRatesRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
  });

  it("returns the §7 list envelope", async () => {
    serviceStubs.listCustomsDwellEstimates.mockResolvedValue({
      success: true,
      value: {
        items: [{ id: "dwell_1", destinationCountryCode: "DE", originCountryCode: null }],
        page: { nextCursor: "2026-01-01T00:00:00.000Z_dwell_1", hasMore: true },
      },
    });

    const response = await request(app).get("/commerce/admin/customs-dwell-estimates");

    expect(response.status).toBe(200);
    expect(response.body.data.page.hasMore).toBe(true);
    expect(response.body.data.page.nextCursor).toBe("2026-01-01T00:00:00.000Z_dwell_1");
  });

  /**
   * THE DISTINCTION THIS FILTER EXISTS FOR. `originCountryCode` is nullable on the row and NULL
   * means "any origin" — the create body refuses omission and demands an explicit `null` for
   * that reason. So the sentinel and the absent key must reach the service as different things,
   * or the any-origin rows, which are the broadest claims the platform makes, become
   * unfindable.
   */
  it("forwards the `any` sentinel as a value, distinct from the key being absent", async () => {
    serviceStubs.listCustomsDwellEstimates.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    await request(app).get("/commerce/admin/customs-dwell-estimates?originCountryCode=any");
    expect(serviceStubs.listCustomsDwellEstimates).toHaveBeenLastCalledWith("user_test_caller", {
      originCountryCode: "any",
    });

    await request(app).get("/commerce/admin/customs-dwell-estimates");
    expect(serviceStubs.listCustomsDwellEstimates).toHaveBeenLastCalledWith("user_test_caller", {});

    await request(app).get("/commerce/admin/customs-dwell-estimates?originCountryCode=IN");
    expect(serviceStubs.listCustomsDwellEstimates).toHaveBeenLastCalledWith("user_test_caller", {
      originCountryCode: "IN",
    });
  });

  it("parses `openOnly` into a boolean rather than forwarding the string", async () => {
    serviceStubs.listCustomsDwellEstimates.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get(
      "/commerce/admin/customs-dwell-estimates?openOnly=true&destinationCountryCode=DE",
    );

    expect(response.status).toBe(200);
    expect(serviceStubs.listCustomsDwellEstimates).toHaveBeenCalledWith("user_test_caller", {
      openOnly: true,
      destinationCountryCode: "DE",
    });
  });

  /**
   * `openOnly=false` REACHES THE SERVICE AS `false`, which narrows nothing — the same result as
   * omitting the key, and NOT a request for the retired rows. Pinned because the two spellings
   * agreeing is a decision rather than an accident: a `false` that meant "closed only" would
   * leave no spelling for "show me everything".
   */
  it("treats `openOnly=false` as no narrowing, not as a request for retired rows", async () => {
    serviceStubs.listCustomsDwellEstimates.mockResolvedValue({
      success: true,
      value: { items: [], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app).get("/commerce/admin/customs-dwell-estimates?openOnly=false");

    expect(response.status).toBe(200);
    expect(serviceStubs.listCustomsDwellEstimates).toHaveBeenCalledWith("user_test_caller", {
      openOnly: false,
    });
  });

  it("refuses a lowercase country code, which the column's own check would also refuse", async () => {
    const response = await request(app).get("/commerce/admin/customs-dwell-estimates?destinationCountryCode=de");

    expect(response.status).toBe(422);
    expect(serviceStubs.listCustomsDwellEstimates).not.toHaveBeenCalled();
  });

  it("refuses an unknown filter key with 422", async () => {
    const response = await request(app).get("/commerce/admin/customs-dwell-estimates?commodityScope=cat_1");

    expect(response.status).toBe(422);
    expect(serviceStubs.listCustomsDwellEstimates).not.toHaveBeenCalled();
  });

  it("answers a missing capability with 403, never 401", async () => {
    serviceStubs.listCustomsDwellEstimates.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    });

    const response = await request(app).get("/commerce/admin/customs-dwell-estimates");

    expect(response.status).toBe(403);
  });

  it("answers an anonymous caller with 401 without reaching the service", async () => {
    signOut();

    const response = await request(app).get("/commerce/admin/customs-dwell-estimates");

    expect(response.status).toBe(401);
    expect(serviceStubs.listCustomsDwellEstimates).not.toHaveBeenCalled();
  });
});
