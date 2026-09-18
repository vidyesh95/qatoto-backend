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

const PROVIDER_ORGANIZATION_ID = "commerce_org_forwarder";
const MEMBER_ID = "commerce_member_provider_operator";

const organizationAttachment = vi.hoisted(() => ({ attach: true }));

function attachProviderOrganization(req: Request, res: Response, next: NextFunction): void {
  if (!organizationAttachment.attach) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active provider organization membership is required.",
    });
    return;
  }
  req.commerceOrganization = {
    organizationId: PROVIDER_ORGANIZATION_ID,
    memberId: MEMBER_ID,
    memberRole: "provider_operator",
    tradeState: "active",
  };
  next();
}

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
  attachOptionalSellerCommerceOrganization: attachProviderOrganization,
  requireActiveCommerceOrganization: attachProviderOrganization,
  requireActiveBuyerCommerceOrganization: attachProviderOrganization,
  requireActiveProviderCommerceOrganization: attachProviderOrganization,
  requireActiveSellerCommerceOrganization: attachProviderOrganization,
  requireProvisionedBuyerCommerceWorkspace: attachProviderOrganization,
}));

const serviceStubs = vi.hoisted(() => ({
  createProviderFreightRateCard: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateProviderFreightRateCard: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  appendProviderFreightRateBreak: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replaceProviderFreightRateBreaks: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listProviderFreightRateCards: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/fulfillment/commerce-provider-freight-rates.service.js", () => serviceStubs);

const RATE_CARD_PROJECTION = {
  id: "rate_card_1",
  providerOrganizationId: PROVIDER_ORGANIZATION_ID,
  originCountryCode: "IN",
  destinationCountryCode: "DE",
  mode: "sea",
  currency: "USD",
  sourceForwarderName: "Blue Anchor Logistics",
  state: "active",
  bandsEditable: true,
  breaks: [],
};

/** §19.11 step 4's floor band: without one the lane publishes no option at all. */
const FLOOR_BAND = {
  minBillableWeightGrams: 0,
  minVolumeCubicCm: 0,
  unitPriceInCents: 420,
  minimumChargeInCents: 15_000,
  transitDaysMin: 24,
  transitDaysMax: 34,
};

const HEAVY_BAND = {
  ...FLOOR_BAND,
  minBillableWeightGrams: 45_000,
  unitPriceInCents: 380,
};

/** A day out, so `validFrom` is future at parse time however slow the suite is. */
function futureInstant(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function validCreateBody(): Record<string, unknown> {
  return {
    originCountryCode: "IN",
    destinationCountryCode: "DE",
    mode: "sea",
    currency: "USD",
    validFrom: futureInstant(),
    // §19.9. Ocean LCL's W/M convention: one cubic metre bills as 1000 kg.
    volumetricDivisorCm3PerKg: 1000,
    breaks: [FLOOR_BAND, HEAVY_BAND],
  };
}

describe("commerce provider freight rate card routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const providerFreightRatesRouter = (
      await import("#src/modules/store/fulfillment/commerce-provider-freight-rates.routes.js")
    ).default;
    app.use("/commerce", providerFreightRatesRouter);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    organizationAttachment.attach = true;
    signInAs();
    await resetRateLimiters();
  });

  // -------------------------------------------------------------------------
  // What the session owns, and the body may not claim
  // -------------------------------------------------------------------------

  it("REFUSES a body-supplied providerOrganizationId and names the field", async () => {
    // §0. A submitted one is a forwarder authoring a competitor's tariff. It must be a 422
    // that names the field, never a silently dropped key — a dropped key is an attempt that
    // looked like it worked.
    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-provider-org-0001")
      .send({ ...validCreateBody(), providerOrganizationId: "commerce_org_rival" });

    expect(response.status).toBe(422);
    // A `.strict()` rejection is an OBJECT-level parse issue, so it lands under the reserved
    // `errors.form` rather than under a field key — `project-error-response.ts` reserves it for
    // exactly this, "a rejected server-owned field". What matters is that the key is NAMED.
    expect(JSON.stringify(response.body.errors.form)).toContain("providerOrganizationId");
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("REFUSES a body-supplied sourceForwarderName and names the field", async () => {
    // The provenance §19.6 puts on the wire is derived from the caller's own organization.
    // A free-text one would let a forwarder publish a rate under a carrier's or a rival's name.
    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-forwarder-name-0001")
      .send({ ...validCreateBody(), sourceForwarderName: "Maersk" });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.errors.form)).toContain("sourceForwarderName");
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("derives the actor from the session, never from the body", async () => {
    serviceStubs.createProviderFreightRateCard.mockResolvedValue({
      success: true,
      value: { rateCard: RATE_CARD_PROJECTION, supersededRateCardId: null },
    });

    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-actor-0001")
      .send(validCreateBody());

    expect(response.status).toBe(201);
    expect(serviceStubs.createProviderFreightRateCard).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_test_caller",
        organizationId: PROVIDER_ORGANIZATION_ID,
        memberRole: "provider_operator",
      }),
      expect.objectContaining({ originCountryCode: "IN", destinationCountryCode: "DE" }),
    );
  });

  // -------------------------------------------------------------------------
  // §19.11's three traps, as refusals
  // -------------------------------------------------------------------------

  it("requires validFrom — the staff default would mint an uneditable card", async () => {
    const { validFrom: _omitted, ...withoutValidFrom } = validCreateBody();
    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-no-valid-from-0001")
      .send(withoutValidFrom);

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("validFrom");
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses a past validFrom and names the field", async () => {
    // §19.11 step 1. A card in force the instant it exists can never have its bands edited,
    // and `validFrom` is absent from every PATCH schema, so there is no correcting it.
    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-past-valid-from-0001")
      .send({ ...validCreateBody(), validFrom: new Date(Date.now() - 60_000).toISOString() });

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("validFrom");
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses a ladder with no 0 g floor band on CREATE", async () => {
    // §19.11 step 4. Without a floor every lighter consignment rates `below_smallest_break`
    // and the lane publishes NO option — which reaches the buyer as an empty delivery sheet,
    // indistinguishable from having loaded nothing at all.
    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-no-floor-0001")
      .send({ ...validCreateBody(), breaks: [HEAVY_BAND] });

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("breaks");
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses a ladder with no 0 g floor band on REPLACE", async () => {
    // The verb that matters most: replace is the only write that can DELETE the floor band
    // off a card that already had one, blanking a live lane.
    const response = await request(app)
      .patch("/commerce/provider/freight-rate-cards/rate_card_1/breaks")
      .set("Idempotency-Key", "idem-replace-no-floor-0001")
      .send({ breaks: [HEAVY_BAND] });

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("breaks");
    expect(serviceStubs.replaceProviderFreightRateBreaks).not.toHaveBeenCalled();
  });

  it("requires volumetricDivisorCm3PerKg and never defaults it", async () => {
    const { volumetricDivisorCm3PerKg: _omitted, ...withoutDivisor } = validCreateBody();
    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-no-divisor-0001")
      .send(withoutDivisor);

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("volumetricDivisorCm3PerKg");
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("bounds the volumetric divisor at 100–20000", async () => {
    // The bound catches a decimal slip and nothing subtler — a road divisor on an air card
    // is inside it and underbills every bulky consignment silently.
    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-divisor-bound-0001")
      .send({ ...validCreateBody(), volumetricDivisorCm3PerKg: 60 });

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("volumetricDivisorCm3PerKg");
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("refuses more than twenty bands", async () => {
    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-too-many-bands-0001")
      .send({
        ...validCreateBody(),
        breaks: Array.from({ length: 21 }, (_unused, index) => ({
          ...FLOOR_BAND,
          minBillableWeightGrams: index * 1000,
        })),
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  it("maps COMMERCE_PROVIDER_FREIGHT_NOT_APPROVED to 403", async () => {
    serviceStubs.createProviderFreightRateCard.mockResolvedValue({
      success: false,
      error: { type: "COMMERCE_PROVIDER_FREIGHT_NOT_APPROVED" },
    });

    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-not-approved-0001")
      .send(validCreateBody());

    expect(response.status).toBe(403);
  });

  it("maps another provider's card to 404, not 403", async () => {
    // A 403 there would confirm the card exists, which makes this surface an id oracle for a
    // rival's lane portfolio.
    serviceStubs.updateProviderFreightRateCard.mockResolvedValue({
      success: false,
      error: { type: "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND", rateCardId: "rate_card_rival" },
    });

    const response = await request(app)
      .patch("/commerce/provider/freight-rate-cards/rate_card_rival")
      .set("Idempotency-Key", "idem-rival-0001")
      .send({ intent: "withdraw", reasonNote: "Not ours." });

    expect(response.status).toBe(404);
  });

  it("maps COMMERCE_FREIGHT_RATE_CARD_IN_FORCE to 409", async () => {
    serviceStubs.appendProviderFreightRateBreak.mockResolvedValue({
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_IN_FORCE",
        rateCardId: "rate_card_1",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards/rate_card_1/breaks")
      .set("Idempotency-Key", "idem-in-force-0001")
      .send(HEAVY_BAND);

    expect(response.status).toBe(409);
  });

  it("maps COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE to 409", async () => {
    serviceStubs.replaceProviderFreightRateBreaks.mockResolvedValue({
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE",
        rateCardId: "rate_card_1",
        state: "withdrawn",
      },
    });

    const response = await request(app)
      .patch("/commerce/provider/freight-rate-cards/rate_card_1/breaks")
      .set("Idempotency-Key", "idem-not-active-0001")
      .send({ breaks: [FLOOR_BAND] });

    expect(response.status).toBe(409);
  });

  it("maps a service-side past validFrom to 422 naming the field", async () => {
    // The boundary refine read the clock at parse time; the service read it against the
    // write. This is the copy that counts, and it must still reach the client as a field.
    serviceStubs.createProviderFreightRateCard.mockResolvedValue({
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_VALID_FROM_NOT_FUTURE",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-service-past-0001")
      .send(validCreateBody());

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("validFrom");
  });

  it("maps a duplicated floor to 422 naming breaks", async () => {
    serviceStubs.appendProviderFreightRateBreak.mockResolvedValue({
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED",
        minBillableWeightGrams: 45_000,
        minVolumeCubicCm: 0,
      },
    });

    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards/rate_card_1/breaks")
      .set("Idempotency-Key", "idem-dup-floor-0001")
      .send(HEAVY_BAND);

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("breaks");
  });

  it("maps a widened window to 422 naming validUntil", async () => {
    serviceStubs.updateProviderFreightRateCard.mockResolvedValue({
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_WIDENED",
        currentValidUntil: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    const response = await request(app)
      .patch("/commerce/provider/freight-rate-cards/rate_card_1")
      .set("Idempotency-Key", "idem-widened-0001")
      .send({ intent: "shorten_window", validUntil: "2026-12-01T00:00:00.000Z" });

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("validUntil");
  });

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  it("requires an Idempotency-Key on every write", async () => {
    const response = await request(app).post("/commerce/provider/freight-rate-cards").send(validCreateBody());

    expect(response.status).toBe(400);
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("replays a retried create rather than superseding the card it just minted", async () => {
    serviceStubs.createProviderFreightRateCard.mockResolvedValue({
      success: true,
      value: { rateCard: RATE_CARD_PROJECTION, supersededRateCardId: null },
    });

    const body = validCreateBody();
    const first = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-replay-0001")
      .send(body);
    const second = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-replay-0001")
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(serviceStubs.createProviderFreightRateCard).toHaveBeenCalledTimes(1);
  });

  it("answers 401 without reaching the service when signed out", async () => {
    signOut();

    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-signed-out-0001")
      .send(validCreateBody());

    expect(response.status).toBe(401);
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  it("answers 403 without reaching the service when the caller has no provider organization", async () => {
    organizationAttachment.attach = false;

    const response = await request(app)
      .post("/commerce/provider/freight-rate-cards")
      .set("Idempotency-Key", "idem-no-org-0001")
      .send(validCreateBody());

    expect(response.status).toBe(403);
    expect(serviceStubs.createProviderFreightRateCard).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The read
  // -------------------------------------------------------------------------

  it("lists the caller's own cards and passes the filters through", async () => {
    serviceStubs.listProviderFreightRateCards.mockResolvedValue({
      success: true,
      value: { items: [RATE_CARD_PROJECTION], page: { nextCursor: null, hasMore: false } },
    });

    const response = await request(app)
      .get("/commerce/provider/freight-rate-cards")
      .query({ originCountryCode: "IN", mode: "sea", state: "active", limit: "10" });

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(serviceStubs.listProviderFreightRateCards).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: PROVIDER_ORGANIZATION_ID }),
      expect.objectContaining({
        originCountryCode: "IN",
        mode: "sea",
        state: "active",
        limit: 10,
      }),
    );
  });

  it("REFUSES a providerOrganizationId query filter and names it", async () => {
    // There is no spelling for anybody else's cards, and a filter with exactly one legal value
    // would be an invitation to try another.
    const response = await request(app)
      .get("/commerce/provider/freight-rate-cards")
      .query({ providerOrganizationId: "commerce_org_rival" });

    expect(response.status).toBe(422);
    expect(serviceStubs.listProviderFreightRateCards).not.toHaveBeenCalled();
  });

  it("refuses an unknown query key with 422 rather than silently unfiltering", async () => {
    const response = await request(app).get("/commerce/provider/freight-rate-cards").query({ chargeableUnit: "cbm" });

    expect(response.status).toBe(422);
    expect(serviceStubs.listProviderFreightRateCards).not.toHaveBeenCalled();
  });

  it("maps an invalid cursor to 422 naming the cursor", async () => {
    serviceStubs.listProviderFreightRateCards.mockResolvedValue({
      success: false,
      error: { type: "INVALID_CURSOR" },
    });

    const response = await request(app).get("/commerce/provider/freight-rate-cards").query({ cursor: "not-a-cursor" });

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.errors ?? {})).toContain("cursor");
  });
});
