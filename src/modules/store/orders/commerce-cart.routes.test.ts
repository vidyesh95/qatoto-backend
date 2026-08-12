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

const BUYER_ORGANIZATION_ID = "commerce_org_buyer_cart";
const MEMBER_ID = "member-buyer-cart";

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

vi.mock("#src/modules/store/organizations/require-active-commerce-organization.js", () => ({
  // Phase 9 authoring routes attach an organization optionally, because a platform
  // merchandiser may not belong to one. Mounted through app.ts, so every suite that
  // mocks this module must provide it.
  attachOptionalSellerCommerceOrganization: (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
  requireActiveCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  // Phase 21 (§14). Attaches `buyerCommerceWorkspace`, never `commerceOrganization` — the
  // two are separate properties so a handler cannot read an unactivated workspace as a
  // trading one. Mounted through app.ts, so every suite that mocks this module must
  // provide it.
  requireProvisionedBuyerCommerceWorkspace: (req: Request, _res: Response, next: NextFunction): void => {
    req.buyerCommerceWorkspace = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveBuyerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveProviderCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "provider_operator",
      tradeState: "active",
    };
    next();
  },
  requireActiveSellerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: BUYER_ORGANIZATION_ID,
      memberId: MEMBER_ID,
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
}));

const cartServiceStubs = vi.hoisted(() => ({
  getCart: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  setCartItem: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  removeCartItem: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

const checkoutServiceStubs = vi.hoisted(() => ({
  prepareCheckout: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  confirmCheckout: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/orders/commerce-cart.service.js", () => cartServiceStubs);
vi.mock("#src/modules/store/orders/commerce-checkout.service.js", () => checkoutServiceStubs);

describe("commerce cart and checkout routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const cartRouter = (await import("#src/modules/store/orders/commerce-cart.routes.js")).default;
    app.use("/commerce", cartRouter);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
    await resetRateLimiters();
  });

  it("requires auth: GET /cart is 401 when signed out", async () => {
    signOut();

    const response = await request(app).get("/commerce/cart");

    expect(response.status).toBe(401);
    expect(cartServiceStubs.getCart).not.toHaveBeenCalled();
  });

  it("returns 422 on a bad set-cart-item body, with the field named under `errors`", async () => {
    const response = await request(app)
      .put("/commerce/cart/items/product-1")
      .set("Idempotency-Key", "cart-set-bad-body")
      .send({ quantity: 0 });

    expect(response.status).toBe(422);
    expect(cartServiceStubs.setCartItem).not.toHaveBeenCalled();

    /**
     * `errors`, NEVER `data`. This controller used to answer with
     * `data: error.flatten().fieldErrors`, and the client's envelope reader only ever looks at
     * `errors` — so every 422 across cart, checkout, orders and quotes arrived in the browser
     * with no field detail at all. The status was right and the response was useless.
     */
    expect(response.body.errors.quantity).toBeDefined();
    expect(response.body.data).toBeUndefined();
  });

  it("names an unknown key on a cart write rather than dropping it", async () => {
    const response = await request(app)
      .put("/commerce/cart/items/product-1")
      .set("Idempotency-Key", "cart-set-unknown-key")
      .send({ quantity: 2, sellerOrganizationId: "commerce_org_attacker" });

    // A server-owned field smuggled into the body is the case §0 cares most about, and it
    // reaches the client under the reserved `errors.form`.
    expect(response.status).toBe(422);
    expect(cartServiceStubs.setCartItem).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body.errors.form)).toContain("sellerOrganizationId");
  });

  it("requires Idempotency-Key on checkout prepare", async () => {
    const response = await request(app).post("/commerce/checkout/prepare").send({});

    expect(response.status).toBe(400);
    expect(checkoutServiceStubs.prepareCheckout).not.toHaveBeenCalled();
  });

  it("maps PRICE_CHANGED from checkout confirm to 409", async () => {
    checkoutServiceStubs.confirmCheckout.mockResolvedValue({
      success: false,
      error: {
        type: "PRICE_CHANGED",
        productId: "product-1",
        previousUnitPriceInCents: 500,
        currentUnitPriceInCents: 600,
      },
    });

    const response = await request(app)
      .post("/commerce/checkout/confirm")
      .set("Idempotency-Key", "checkout-confirm-price-changed")
      .send({ prepareId: "prepare-1" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      status: "error",
      statusCode: 409,
      data: {
        productId: "product-1",
        previousUnitPriceInCents: 500,
        currentUnitPriceInCents: 600,
      },
    });
    expect(checkoutServiceStubs.confirmCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
      { prepareId: "prepare-1" },
      "checkout-confirm-price-changed",
    );
  });

  it("prepares checkout on the happy path", async () => {
    checkoutServiceStubs.prepareCheckout.mockResolvedValue({
      success: true,
      value: {
        prepareId: "prepare-1",
        expiresAt: new Date("2026-08-05T01:00:00.000Z"),
        items: [],
        currencyTotals: [],
        deliveryAddressSnapshot: null,
      },
    });

    const response = await request(app)
      .post("/commerce/checkout/prepare")
      .set("Idempotency-Key", "checkout-prepare-happy-path")
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ prepareId: "prepare-1" });
    expect(checkoutServiceStubs.prepareCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: BUYER_ORGANIZATION_ID }),
      {},
      "checkout-prepare-happy-path",
    );
  });
});
