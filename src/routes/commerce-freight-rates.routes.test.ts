import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs } from "#src/test-support/auth-mock.js";
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
    const response = await request(app)
      .post("/commerce/admin/freight-rate-cards")
      .send(VALID_CREATE_BODY);

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
