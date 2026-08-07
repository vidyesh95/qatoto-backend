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

const SELLER_ORGANIZATION_ID = "commerce_org_seller_reveal";
const MEMBER_ID = "member-seller-reveal";

function attachOrganization(req: Request, _res: Response, next: NextFunction): void {
  req.commerceOrganization = {
    organizationId: SELLER_ORGANIZATION_ID,
    memberId: MEMBER_ID,
    memberRole: "seller",
    tradeState: "active",
  };
  next();
}

vi.mock("#src/middleware/require-active-commerce-organization.js", () => ({
  attachOptionalSellerCommerceOrganization: attachOrganization,
  requireActiveCommerceOrganization: attachOrganization,
  requireActiveBuyerCommerceOrganization: attachOrganization,
  requireActiveProviderCommerceOrganization: attachOrganization,
  requireActiveSellerCommerceOrganization: attachOrganization,
}));

const deliveryAddressStubs = vi.hoisted(() => ({
  revealOrderDeliveryAddress: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-delivery-address.service.js", () => deliveryAddressStubs);

const REVEALED_ADDRESS = {
  orderId: "order_1",
  addressId: "address_1",
  recipientName: "Priya Rao",
  addressLineOne: "12 Baner Road",
  addressLineTwo: null,
  phone: "+91 99999 99999",
  countryCode: "IN",
  regionCode: "MH",
  locality: "Pune",
  postalCode: "411045",
};

describe("order delivery address reveal route (A15)", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    const ordersRouter = (await import("#src/routes/commerce-orders.routes.js")).default;
    app.use("/commerce", ordersRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signInAs();
  });

  it("returns the decrypted address to an authorized counterparty", async () => {
    deliveryAddressStubs.revealOrderDeliveryAddress.mockResolvedValue({
      success: true,
      value: REVEALED_ADDRESS,
    });

    const response = await request(app).get("/commerce/orders/order_1/delivery-address");

    expect(response.status).toBe(200);
    expect(response.body.data.addressLineOne).toBe("12 Baner Road");
    expect(deliveryAddressStubs.revealOrderDeliveryAddress).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: SELLER_ORGANIZATION_ID }),
      "order_1",
    );
  });

  /**
   * Decrypted PII must not sit in a shared cache, a proxy, or a browser's disk cache
   * after the tab closes.
   */
  it("marks the response no-store", async () => {
    deliveryAddressStubs.revealOrderDeliveryAddress.mockResolvedValue({
      success: true,
      value: REVEALED_ADDRESS,
    });

    const response = await request(app).get("/commerce/orders/order_1/delivery-address");

    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("hides an order the caller is not a party to behind 404", async () => {
    deliveryAddressStubs.revealOrderDeliveryAddress.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app).get("/commerce/orders/order_stranger/delivery-address");

    expect(response.status).toBe(404);
  });

  it("refuses a member whose role cannot operate the counterparty", async () => {
    deliveryAddressStubs.revealOrderDeliveryAddress.mockResolvedValue({
      success: false,
      error: { type: "FORBIDDEN" },
    });

    const response = await request(app).get("/commerce/orders/order_1/delivery-address");

    expect(response.status).toBe(403);
  });

  it("refuses an order that has not reached a shipping stage", async () => {
    deliveryAddressStubs.revealOrderDeliveryAddress.mockResolvedValue({
      success: false,
      error: { type: "INVALID_STATE", orderState: "pending_payment" },
    });

    const response = await request(app).get("/commerce/orders/order_1/delivery-address");

    expect(response.status).toBe(409);
    expect(response.body.data).toEqual({ orderState: "pending_payment" });
  });

  it("reports a quote-originated order as having no buyer-chosen address", async () => {
    deliveryAddressStubs.revealOrderDeliveryAddress.mockResolvedValue({
      success: false,
      error: { type: "ADDRESS_UNAVAILABLE" },
    });

    const response = await request(app).get("/commerce/orders/order_quote/delivery-address");

    expect(response.status).toBe(404);
  });

  it("rejects a query string on the reveal route", async () => {
    const response = await request(app).get("/commerce/orders/order_1/delivery-address?include=everything");

    expect(response.status).toBe(422);
    expect(deliveryAddressStubs.revealOrderDeliveryAddress).not.toHaveBeenCalled();
  });
});
