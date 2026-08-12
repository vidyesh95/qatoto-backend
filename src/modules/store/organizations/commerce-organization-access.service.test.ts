import { beforeEach, describe, expect, it, vi } from "vitest";

interface ActiveAccessRow {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: "owner" | "seller" | "buyer";
  readonly tradeState: "active" | "suspended";
}

const limitMock = vi.fn<(rowLimit: number) => Promise<ActiveAccessRow[]>>();
const whereMock = vi.fn<(condition: unknown) => { limit: typeof limitMock }>(() => ({
  limit: limitMock,
}));
const innerJoinMock = vi.fn<(table: unknown, condition: unknown) => { where: typeof whereMock }>(() => ({
  where: whereMock,
}));
const fromMock = vi.fn<(table: unknown) => { innerJoin: typeof innerJoinMock }>(() => ({
  innerJoin: innerJoinMock,
}));
const selectMock = vi.fn<(columns: unknown) => { from: typeof fromMock }>(() => ({
  from: fromMock,
}));
const updateReturningMock = vi.fn<(columns: unknown) => Promise<readonly { readonly id: string }[]>>();
const updateWhereMock = vi.fn<(condition: unknown) => { returning: typeof updateReturningMock }>(() => ({
  returning: updateReturningMock,
}));
const setMock = vi.fn<(values: unknown) => { where: typeof updateWhereMock }>(() => ({
  where: updateWhereMock,
}));
const updateMock = vi.fn<(table: unknown) => { set: typeof setMock }>(() => ({
  set: setMock,
}));

vi.mock("#src/db/index.js", () => ({ db: { select: selectMock, update: updateMock } }));

const { resolveActiveCommerceOrganization, resolveActiveSellerCommerceOrganization } =
  await import("#src/modules/store/organizations/commerce-organization-access.service.js");

describe("active commerce organization access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
    updateReturningMock.mockResolvedValue([{ id: "session-1" }]);
  });

  it("does not query when the session has no active organization", async () => {
    expect(
      await resolveActiveCommerceOrganization({
        userId: "user-1",
        activeOrganizationId: null,
      }),
    ).toEqual({ success: false, error: { type: "ACTIVE_ORGANIZATION_REQUIRED" } });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns a freshly proven active member and trade context", async () => {
    limitMock.mockResolvedValue([
      {
        organizationId: "organization-1",
        memberId: "member-1",
        memberRole: "owner",
        tradeState: "active",
      },
    ]);

    expect(
      await resolveActiveCommerceOrganization({
        userId: "user-1",
        activeOrganizationId: "organization-1",
      }),
    ).toEqual({
      success: true,
      value: {
        organizationId: "organization-1",
        memberId: "member-1",
        memberRole: "owner",
        tradeState: "active",
      },
    });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("collapses revoked membership and inactive trade state into one refusal", async () => {
    expect(
      await resolveActiveCommerceOrganization({
        userId: "user-1",
        activeOrganizationId: "organization-1",
      }),
    ).toEqual({
      success: false,
      error: { type: "ACTIVE_COMMERCE_ACCESS_REQUIRED" },
    });
  });

  it("accepts a freshly proven active seller membership", async () => {
    limitMock.mockResolvedValue([
      {
        organizationId: "organization-1",
        memberId: "member-1",
        memberRole: "seller",
        tradeState: "active",
      },
    ]);

    expect(
      await resolveActiveSellerCommerceOrganization({
        userId: "user-1",
        sessionId: "session-1",
        activeOrganizationId: "organization-1",
      }),
    ).toEqual({
      success: true,
      value: {
        organizationId: "organization-1",
        memberId: "member-1",
        memberRole: "seller",
        tradeState: "active",
      },
    });
  });

  it("auto-selects and persists the sole active seller organization for a legacy session", async () => {
    limitMock.mockResolvedValue([
      {
        organizationId: "commerce_org_legacy_opaque",
        memberId: "member-1",
        memberRole: "owner",
        tradeState: "active",
      },
    ]);

    const result = await resolveActiveSellerCommerceOrganization({
      userId: "user-1",
      sessionId: "session-1",
      activeOrganizationId: null,
    });

    expect(result.success).toBe(true);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ activeOrganizationId: "commerce_org_legacy_opaque" }),
    );
  });

  it("does not guess when a legacy session has multiple seller organizations", async () => {
    limitMock.mockResolvedValue([
      {
        organizationId: "organization-1",
        memberId: "member-1",
        memberRole: "owner",
        tradeState: "active",
      },
      {
        organizationId: "organization-2",
        memberId: "member-2",
        memberRole: "seller",
        tradeState: "active",
      },
    ]);

    expect(
      await resolveActiveSellerCommerceOrganization({
        userId: "user-1",
        sessionId: "session-1",
        activeOrganizationId: null,
      }),
    ).toEqual({
      success: false,
      error: { type: "ACTIVE_SELLER_ORGANIZATION_REQUIRED" },
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a concurrent explicit organization switch", async () => {
    limitMock.mockResolvedValue([
      {
        organizationId: "commerce_org_legacy_opaque",
        memberId: "member-1",
        memberRole: "owner",
        tradeState: "active",
      },
    ]);
    updateReturningMock.mockResolvedValue([]);

    expect(
      await resolveActiveSellerCommerceOrganization({
        userId: "user-1",
        sessionId: "session-1",
        activeOrganizationId: null,
      }),
    ).toEqual({
      success: false,
      error: { type: "ACTIVE_SELLER_ORGANIZATION_REQUIRED" },
    });
  });
});
