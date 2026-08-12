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

const SELLER_ORGANIZATION_ID = "commerce_org_seller_pathways";
const MEMBER_ID = "member-seller-pathways";

/**
 * Toggled per test so one suite can exercise both of §15.5's authors: a seller with an
 * organization, and a platform merchandiser with none.
 */
const organizationAttachment = vi.hoisted(() => ({ attach: true }));

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

function attachSellerOrganization(req: Request, _res: Response, next: NextFunction): void {
  req.commerceOrganization = {
    organizationId: SELLER_ORGANIZATION_ID,
    memberId: MEMBER_ID,
    memberRole: "seller",
    tradeState: "active",
  };
  next();
}

// Phase 21 (§14). A SEPARATE property from `commerceOrganization`, deliberately, so a
// handler cannot read an unactivated workspace as a trading one.
function attachBuyerWorkspace(req: Request, _res: Response, next: NextFunction): void {
  req.buyerCommerceWorkspace = {
    organizationId: SELLER_ORGANIZATION_ID,
    memberId: MEMBER_ID,
    memberRole: "seller",
    tradeState: "active",
  };
  next();
}

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
  attachOptionalSellerCommerceOrganization: (req: Request, res: Response, next: NextFunction): void => {
    if (!organizationAttachment.attach) {
      next();
      return;
    }
    attachSellerOrganization(req, res, next);
  },
  requireActiveCommerceOrganization: attachSellerOrganization,
  requireActiveBuyerCommerceOrganization: attachSellerOrganization,
  requireActiveProviderCommerceOrganization: attachSellerOrganization,
  requireActiveSellerCommerceOrganization: attachSellerOrganization,
  requireProvisionedBuyerCommerceWorkspace: attachBuyerWorkspace,
}));

const serviceStubs = vi.hoisted(() => ({
  createPathway: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updatePathway: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replacePathwaySlots: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  replacePathwaySlotCandidates: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  submitPathway: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  moderatePathway: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listAuthoredPathways: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listPathwayModerationQueue: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  seedCartFromPathway: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-pathways.service.js", () => serviceStubs);

const PATHWAY_PROJECTION = {
  id: "pathway_1",
  slug: "autumn-hotel-room-refit",
  title: "Autumn hotel-room refit",
  state: "draft",
  slots: [],
};

describe("commerce guided pathway routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const merchandisingRouter = (await import("#src/routes/commerce-merchandising.routes.js")).default;
    const cartRouter = (await import("#src/routes/commerce-cart.routes.js")).default;
    app.use("/commerce", merchandisingRouter);
    app.use("/commerce", cartRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    organizationAttachment.attach = true;
    signInAs();
  });

  it("requires an Idempotency-Key to create a pathway", async () => {
    const response = await request(app)
      .post("/commerce/pathways")
      .send({ slug: "autumn-hotel-room-refit", title: "Autumn hotel-room refit" });

    expect(response.status).toBe(400);
    expect(serviceStubs.createPathway).not.toHaveBeenCalled();
  });

  it("rejects an unknown body key with 422", async () => {
    const response = await request(app)
      .post("/commerce/pathways")
      .set("Idempotency-Key", "pathway-key-unknown")
      .send({ slug: "autumn-hotel-room-refit", title: "Autumn refit", state: "active" });

    expect(response.status).toBe(422);
    expect(serviceStubs.createPathway).not.toHaveBeenCalled();
  });

  it("rejects a non-kebab-case slug with 422", async () => {
    const response = await request(app)
      .post("/commerce/pathways")
      .set("Idempotency-Key", "pathway-key-slug")
      .send({ slug: "Autumn Refit", title: "Autumn refit" });

    expect(response.status).toBe(422);
    expect(serviceStubs.createPathway).not.toHaveBeenCalled();
  });

  it("creates a pathway as an organization actor when the caller has one", async () => {
    serviceStubs.createPathway.mockResolvedValue({ success: true, value: PATHWAY_PROJECTION });

    const response = await request(app)
      .post("/commerce/pathways")
      .set("Idempotency-Key", "pathway-key-create")
      .send({ slug: "autumn-hotel-room-refit", title: "Autumn hotel-room refit" });

    expect(response.status).toBe(201);
    expect(serviceStubs.createPathway).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "organization", organizationId: SELLER_ORGANIZATION_ID }),
      expect.objectContaining({ slug: "autumn-hotel-room-refit" }),
    );
  });

  it("creates a pathway as a platform actor when the caller has no organization", async () => {
    organizationAttachment.attach = false;
    serviceStubs.createPathway.mockResolvedValue({ success: true, value: PATHWAY_PROJECTION });

    const response = await request(app)
      .post("/commerce/pathways")
      .set("Idempotency-Key", "pathway-key-platform")
      .send({ slug: "autumn-hotel-room-refit", title: "Autumn hotel-room refit" });

    expect(response.status).toBe(201);
    expect(serviceStubs.createPathway).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "platform" }),
      expect.anything(),
    );
  });

  it("maps a missing platform capability to 403, not 401", async () => {
    organizationAttachment.attach = false;
    serviceStubs.createPathway.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    });

    const response = await request(app)
      .post("/commerce/pathways")
      .set("Idempotency-Key", "pathway-key-capability")
      .send({ slug: "autumn-hotel-room-refit", title: "Autumn hotel-room refit" });

    expect(response.status).toBe(403);
  });

  it("maps a duplicate slug to 409", async () => {
    serviceStubs.createPathway.mockResolvedValue({
      success: false,
      error: { type: "SLUG_TAKEN" },
    });

    const response = await request(app)
      .post("/commerce/pathways")
      .set("Idempotency-Key", "pathway-key-duplicate")
      .send({ slug: "autumn-hotel-room-refit", title: "Autumn hotel-room refit" });

    expect(response.status).toBe(409);
  });

  it("refuses a candidate that omits a required variant with 422", async () => {
    serviceStubs.replacePathwaySlotCandidates.mockResolvedValue({
      success: false,
      error: { type: "VARIANT_REQUIRED", productIds: ["prd_1"] },
    });

    const response = await request(app)
      .put("/commerce/pathways/pathway_1/slots/slot_1/candidates")
      .set("Idempotency-Key", "candidates-key-variant")
      .send({ candidates: [{ productId: "prd_1" }] });

    expect(response.status).toBe(422);
    expect(response.body.data).toEqual({ productIds: ["prd_1"] });
  });

  it("refuses a candidate list that tries to set sourceKind", async () => {
    const response = await request(app)
      .put("/commerce/pathways/pathway_1/slots/slot_1/candidates")
      .set("Idempotency-Key", "candidates-key-source")
      .send({ candidates: [{ productId: "prd_1", sourceKind: "derived" }] });

    expect(response.status).toBe(422);
    expect(serviceStubs.replacePathwaySlotCandidates).not.toHaveBeenCalled();
  });

  it("refuses a slot quantity below a candidate's minimum order quantity", async () => {
    serviceStubs.replacePathwaySlotCandidates.mockResolvedValue({
      success: false,
      error: {
        type: "QUANTITY_BELOW_MINIMUM",
        productId: "prd_bolt",
        minimumOrderQuantity: 100,
        quantity: 12,
      },
    });

    const response = await request(app)
      .put("/commerce/pathways/pathway_1/slots/slot_1/candidates")
      .set("Idempotency-Key", "candidates-key-moq")
      .send({ candidates: [{ productId: "prd_bolt" }] });

    expect(response.status).toBe(422);
    expect(response.body.data).toMatchObject({ minimumOrderQuantity: 100 });
  });

  it("conceals a pathway the caller does not own as 404", async () => {
    serviceStubs.replacePathwaySlots.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app)
      .put("/commerce/pathways/pathway_someone_else/slots")
      .set("Idempotency-Key", "slots-key-not-found")
      .send({ slots: [{ roleLabel: "Footwear" }] });

    expect(response.status).toBe(404);
  });

  it("refuses to edit a pathway that is already under review with 409", async () => {
    serviceStubs.replacePathwaySlots.mockResolvedValue({
      success: false,
      error: { type: "INVALID_STATE", message: "A pathway in state pending_review cannot be edited." },
    });

    const response = await request(app)
      .put("/commerce/pathways/pathway_1/slots")
      .set("Idempotency-Key", "slots-key-state")
      .send({ slots: [{ roleLabel: "Footwear" }] });

    expect(response.status).toBe(409);
  });

  it("refuses a rejection with no reason", async () => {
    const response = await request(app)
      .post("/commerce/admin/pathways/pathway_1/moderate")
      .set("Idempotency-Key", "moderate-key-noreason")
      .send({ decision: "reject" });

    expect(response.status).toBe(422);
    expect(serviceStubs.moderatePathway).not.toHaveBeenCalled();
  });

  it("blocks a moderator from deciding their own organization's proposal", async () => {
    serviceStubs.moderatePathway.mockResolvedValue({
      success: false,
      error: { type: "SELF_MODERATION_FORBIDDEN" },
    });

    const response = await request(app)
      .post("/commerce/admin/pathways/pathway_1/moderate")
      .set("Idempotency-Key", "moderate-key-self")
      .send({ decision: "publish" });

    expect(response.status).toBe(403);
  });

  it("publishes a pathway and replays the same key without a second decision", async () => {
    serviceStubs.moderatePathway.mockResolvedValue({
      success: true,
      value: { ...PATHWAY_PROJECTION, state: "active" },
    });

    const first = await request(app)
      .post("/commerce/admin/pathways/pathway_1/moderate")
      .set("Idempotency-Key", "moderate-key-publish")
      .send({ decision: "publish" });
    const replay = await request(app)
      .post("/commerce/admin/pathways/pathway_1/moderate")
      .set("Idempotency-Key", "moderate-key-publish")
      .send({ decision: "publish" });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(serviceStubs.moderatePathway).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid moderation-queue cursor with 422", async () => {
    serviceStubs.listPathwayModerationQueue.mockResolvedValue({
      success: false,
      error: { type: "INVALID_CURSOR" },
    });

    const response = await request(app).get("/commerce/admin/pathways?cursor=tampered");

    expect(response.status).toBe(422);
  });

  it("seeds a cart and reports the slots it could not fill", async () => {
    serviceStubs.seedCartFromPathway.mockResolvedValue({
      success: true,
      value: {
        cart: { id: "cart_1", items: [], currencyTotals: [] },
        filledSlotCount: 2,
        unfilledSlots: [{ slotId: "slot_3", roleLabel: "Front light", reason: "NO_ELIGIBLE_CANDIDATE" }],
      },
    });

    const response = await request(app)
      .post("/commerce/cart/from-pathway/autumn-hotel-room-refit")
      .set("Idempotency-Key", "seed-key-1")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data.filledSlotCount).toBe(2);
    expect(response.body.data.unfilledSlots).toHaveLength(1);
  });

  it("refuses a cart seed that selects one slot twice", async () => {
    const response = await request(app)
      .post("/commerce/cart/from-pathway/autumn-hotel-room-refit")
      .set("Idempotency-Key", "seed-key-duplicate")
      .send({
        selections: [
          { slotId: "slot_1", productId: "prd_1" },
          { slotId: "slot_1", productId: "prd_2" },
        ],
      });

    expect(response.status).toBe(422);
    expect(serviceStubs.seedCartFromPathway).not.toHaveBeenCalled();
  });
});
