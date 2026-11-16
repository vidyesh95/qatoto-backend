import { describe, expect, it, vi, beforeEach } from "vitest";

import { encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

const limitMock = vi.fn<() => Promise<unknown[]>>();
const orderByMock = vi.fn<() => { limit: typeof limitMock }>(() => ({ limit: limitMock }));
const whereMock = vi.fn<() => { orderBy: typeof orderByMock }>(() => ({ orderBy: orderByMock }));
const innerJoinMock = vi.fn<() => { where: typeof whereMock }>(() => ({ where: whereMock }));
const fromMock = vi.fn<() => { innerJoin: typeof innerJoinMock }>(() => ({ innerJoin: innerJoinMock }));
const selectMock = vi.fn<() => { from: typeof fromMock }>(() => ({ from: fromMock }));

vi.mock("#src/db/index.js", () => {
  return {
    db: {
      select: selectMock,
    },
    pool: {},
  };
});

const { listRefunds } = await import("./commerce-payments.service.js");

const mockActor = {
  organizationId: "org_1",
  memberId: "m1",
  memberRole: "buyer" as const,
  actorUserId: "u1",
};

describe("listRefunds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return successfully with no items", async () => {
    limitMock.mockResolvedValue([]);
    const result = await listRefunds(mockActor, {});
    expect(result).toMatchObject({
      success: true,
      value: { items: [], page: { hasMore: false, nextCursor: null } },
    });
  });

  it("should return invalid cursor error", async () => {
    const result = await listRefunds(mockActor, { cursor: "invalid_cursor_string" });
    expect(result.success ? null : result.error.type).toBe("INVALID_CURSOR");
  });

  it("should parse valid cursor successfully", async () => {
    limitMock.mockResolvedValue([]);
    const validCursor = encodeStoreCursor({ sortKey: new Date().toISOString(), id: "some_id" });
    const result = await listRefunds(mockActor, { cursor: validCursor });

    expect(result.success).toBe(true);
    expect(selectMock).toHaveBeenCalled();
  });

  it("should paginate correctly and return next cursor", async () => {
    const mockNow = new Date("2024-01-01T00:00:00Z");
    const mockRows = [
      {
        refund: {
          id: "r1",
          orderId: "o1",
          amount: 100,
          currency: "USD",
          status: "succeeded",
          createdAt: mockNow,
          updatedAt: mockNow,
          settledAt: mockNow,
          receiptUrl: null,
        },
      },
      {
        refund: {
          id: "r2",
          orderId: "o1",
          amount: 200,
          currency: "USD",
          status: "succeeded",
          createdAt: new Date("2023-01-01T00:00:00Z"),
          updatedAt: mockNow,
          settledAt: mockNow,
          receiptUrl: null,
        },
      },
    ];

    limitMock.mockResolvedValue(mockRows);

    const result = await listRefunds(mockActor, { limit: 1 });

    expect(result).toMatchObject({
      success: true,
      value: { items: [{ id: "r1" }], page: { hasMore: true, nextCursor: expect.any(String) } },
    });
  });

  it("should not have more pages if limit is not exceeded", async () => {
    const mockNow = new Date("2024-01-01T00:00:00Z");
    const mockRows = [
      {
        refund: {
          id: "r1",
          orderId: "o1",
          amount: 100,
          currency: "USD",
          status: "succeeded",
          createdAt: mockNow,
          updatedAt: mockNow,
          settledAt: mockNow,
          receiptUrl: null,
        },
      },
    ];

    limitMock.mockResolvedValue(mockRows);

    const result = await listRefunds(mockActor, { limit: 1 });

    expect(result).toMatchObject({
      success: true,
      value: { items: [{ id: "r1" }], page: { hasMore: false, nextCursor: null } },
    });
  });

  it("should filter by orderId", async () => {
    limitMock.mockResolvedValue([]);
    await listRefunds(mockActor, { orderId: "o1" });

    expect(selectMock).toHaveBeenCalled();
  });
});
