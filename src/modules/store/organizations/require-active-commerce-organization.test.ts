import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveActiveCommerceOrganization = vi.fn<(...arguments_: readonly unknown[]) => Promise<unknown>>();
const resolveActiveBuyerCommerceOrganization = vi.fn<(...arguments_: readonly unknown[]) => Promise<unknown>>();
const provisionBuyerCommerceWorkspace = vi.fn<(...arguments_: readonly unknown[]) => Promise<unknown>>();

vi.mock("#src/modules/store/organizations/commerce-organization-access.service.js", () => ({
  resolveActiveCommerceOrganization,
  resolveActiveBuyerCommerceOrganization,
}));

// Phase 21. Mocked rather than left real because the workspace service reaches `db`, and an
// unmocked import of it pulls the whole env-validated config into a unit test.
vi.mock("#src/services/commerce-buyer-workspace.service.js", () => ({
  provisionBuyerCommerceWorkspace,
}));

const {
  requireActiveCommerceOrganization,
  requireActiveBuyerCommerceOrganization,
  requireProvisionedBuyerCommerceWorkspace,
} = await import("#src/modules/store/organizations/require-active-commerce-organization.js");

function buildProbeApp(): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      id: "user-1",
      email: "member@example.test",
      name: "Member",
      emailVerified: true,
      handle: null,
    };
    req.authSession = {
      id: "session-1",
      activeOrganizationId: "organization-1",
    };
    next();
  });
  app.get("/protected", requireActiveCommerceOrganization, (req, res) => {
    res.status(200).json(req.commerceOrganization);
  });
  app.get("/buyer-protected", requireActiveBuyerCommerceOrganization, (req, res) => {
    res.status(200).json(req.commerceOrganization);
  });
  /**
   * Answers BOTH properties so a test can prove which one was written. The separation is the
   * whole point of A37 — a pending workspace must never arrive as `commerceOrganization`.
   */
  app.get("/workspace", requireProvisionedBuyerCommerceWorkspace, (req, res) => {
    res.status(200).json({
      buyerCommerceWorkspace: req.buyerCommerceWorkspace ?? null,
      commerceOrganization: req.commerceOrganization ?? null,
    });
  });
  return app;
}

describe("requireActiveCommerceOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches only freshly proven organization context", async () => {
    resolveActiveCommerceOrganization.mockResolvedValue({
      success: true,
      value: {
        organizationId: "organization-1",
        memberId: "member-1",
        memberRole: "seller",
        tradeState: "active",
      },
    });

    const response = await request(buildProbeApp()).get("/protected");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      organizationId: "organization-1",
      memberId: "member-1",
      memberRole: "seller",
      tradeState: "active",
    });
    expect(resolveActiveCommerceOrganization).toHaveBeenCalledWith({
      userId: "user-1",
      activeOrganizationId: "organization-1",
    });
  });

  it("refuses when current membership or trade state is inactive", async () => {
    resolveActiveCommerceOrganization.mockResolvedValue({
      success: false,
      error: { type: "ACTIVE_COMMERCE_ACCESS_REQUIRED" },
    });

    const response = await request(buildProbeApp()).get("/protected");

    expect(response.status).toBe(403);
    expect(response.body.message).toBe("An active commerce organization membership is required.");
  });
});

describe("requireActiveBuyerCommerceOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches buyer organization context after a fresh membership check", async () => {
    resolveActiveBuyerCommerceOrganization.mockResolvedValue({
      success: true,
      value: {
        organizationId: "organization-1",
        memberId: "member-buyer",
        memberRole: "buyer",
        tradeState: "active",
      },
    });

    const response = await request(buildProbeApp()).get("/buyer-protected");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      organizationId: "organization-1",
      memberId: "member-buyer",
      memberRole: "buyer",
      tradeState: "active",
    });
    expect(resolveActiveBuyerCommerceOrganization).toHaveBeenCalledWith({
      userId: "user-1",
      activeOrganizationId: "organization-1",
    });
  });

  it("refuses when the active organization lacks a buyer role", async () => {
    resolveActiveBuyerCommerceOrganization.mockResolvedValue({
      success: false,
      error: { type: "ACTIVE_BUYER_MEMBERSHIP_REQUIRED" },
    });

    const response = await request(buildProbeApp()).get("/buyer-protected");

    expect(response.status).toBe(403);
    expect(response.body.message).toBe("An active buyer organization membership is required.");
  });
});

describe("requireProvisionedBuyerCommerceWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches a PENDING workspace and never writes commerceOrganization", async () => {
    provisionBuyerCommerceWorkspace.mockResolvedValue({
      success: true,
      value: {
        organizationId: "organization-1",
        memberId: "member-owner",
        memberRole: "owner",
        tradeState: "pending",
      },
    });

    const response = await request(buildProbeApp()).get("/workspace");

    expect(response.status).toBe(200);
    expect(response.body.buyerCommerceWorkspace).toEqual({
      organizationId: "organization-1",
      memberId: "member-owner",
      memberRole: "owner",
      tradeState: "pending",
    });
    /**
     * THE ASSERTION THIS SUITE EXISTS FOR. `commerceOrganization` carries the compile-time
     * claim that its organization may trade, and about thirty handlers read it — including
     * `checkout/confirm`. A pending shell leaking into it would open every one of §14's gates
     * at once, and no type would catch it because both properties are optional.
     */
    expect(response.body.commerceOrganization).toBeNull();
  });

  it("passes the session pointer through so provisioning can re-prove it", async () => {
    provisionBuyerCommerceWorkspace.mockResolvedValue({
      success: true,
      value: {
        organizationId: "organization-1",
        memberId: "member-owner",
        memberRole: "owner",
        tradeState: "active",
      },
    });

    await request(buildProbeApp()).get("/workspace");

    expect(provisionBuyerCommerceWorkspace).toHaveBeenCalledWith({
      userId: "user-1",
      sessionId: "session-1",
      activeOrganizationId: "organization-1",
    });
  });

  it("refuses with 403 when the caller lost access to their selected workspace", async () => {
    provisionBuyerCommerceWorkspace.mockResolvedValue({
      success: false,
      error: { type: "BUYER_WORKSPACE_ACCESS_LOST" },
    });

    const response = await request(buildProbeApp()).get("/workspace");

    expect(response.status).toBe(403);
    // Deliberately indistinguishable from the other guards' refusal: telling a caller that
    // their seat was revoked, rather than that they lack one, is a disclosure about a
    // membership change they were not otherwise shown.
    expect(response.body.message).toBe("An active buyer organization membership is required.");
  });
});
