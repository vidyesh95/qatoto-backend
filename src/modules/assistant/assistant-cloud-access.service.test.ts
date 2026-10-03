import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

const requirePlatformCapabilityMock = vi.fn<(userId: string, capability: string) => Promise<{ success: boolean }>>();
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (userId: string, capability: string) => requirePlatformCapabilityMock(userId, capability),
}));

// Drizzle mock
let selectQueue: unknown[][] = [];
let insertQueue: unknown[][] = [];
let updateQueue: unknown[][] = [];
let insertErrorToThrow: unknown = null;

function resolveNextSelect(): Promise<unknown[]> {
  return Promise.resolve(selectQueue.shift() ?? []);
}

interface MockQueryChain {
  readonly from: ReturnType<typeof vi.fn<(...args: readonly unknown[]) => MockQueryChain>>;
  readonly innerJoin: ReturnType<typeof vi.fn<(...args: readonly unknown[]) => MockQueryChain>>;
  readonly leftJoin: ReturnType<typeof vi.fn<(...args: readonly unknown[]) => MockQueryChain>>;
  readonly where: ReturnType<typeof vi.fn<(...args: readonly unknown[]) => MockQueryChain>>;
  readonly orderBy: ReturnType<typeof vi.fn<(...args: readonly unknown[]) => MockQueryChain>>;
  readonly limit: ReturnType<typeof vi.fn<(_n: number) => Promise<unknown[]>>>;
}

const createQueryChain = (): MockQueryChain => {
  const chain: MockQueryChain = {
    from: vi.fn<(...args: readonly unknown[]) => MockQueryChain>(() => chain),
    innerJoin: vi.fn<(...args: readonly unknown[]) => MockQueryChain>(() => chain),
    leftJoin: vi.fn<(...args: readonly unknown[]) => MockQueryChain>(() => chain),
    where: vi.fn<(...args: readonly unknown[]) => MockQueryChain>(() => chain),
    orderBy: vi.fn<(...args: readonly unknown[]) => MockQueryChain>(() => chain),
    limit: vi.fn<(_n: number) => Promise<unknown[]>>((_n: number) => resolveNextSelect()),
  };
  return chain;
};

const insertReturning = vi.fn<(...args: readonly unknown[]) => Promise<unknown[]>>(() => {
  if (insertErrorToThrow) {
    const error = insertErrorToThrow;
    insertErrorToThrow = null;
    return Promise.reject(error);
  }
  return Promise.resolve(insertQueue.shift() ?? []);
});

const updateReturning = vi.fn<(...args: readonly unknown[]) => Promise<unknown[]>>(() =>
  Promise.resolve(updateQueue.shift() ?? []),
);

const valuesMock = vi.fn<(...args: readonly unknown[]) => { returning: typeof insertReturning }>(() => ({
  returning: insertReturning,
}));

const whereUpdateMock = vi.fn<(...args: readonly unknown[]) => { returning: typeof updateReturning }>(() => ({
  returning: updateReturning,
}));

const setMock = vi.fn<(...args: readonly unknown[]) => { where: typeof whereUpdateMock }>(() => ({
  where: whereUpdateMock,
}));

const mockDb = {
  select: vi.fn<(...args: readonly unknown[]) => MockQueryChain>(() => createQueryChain()),
  insert: vi.fn<(...args: readonly unknown[]) => { values: typeof valuesMock }>(() => ({
    values: valuesMock,
  })),
  update: vi.fn<(...args: readonly unknown[]) => { set: typeof setMock }>(() => ({
    set: setMock,
  })),
};

vi.mock("#src/db/index.js", () => ({ db: mockDb }));

const { hasActiveCloudAccess, listActiveCloudAccessGrants, grantCloudAccess, revokeCloudAccess } =
  await import("#src/modules/assistant/assistant-cloud-access.service.js");

describe("assistant-cloud-access.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue = [];
    insertQueue = [];
    updateQueue = [];
    insertErrorToThrow = null;
    requirePlatformCapabilityMock.mockResolvedValue({ success: true });
  });

  describe("hasActiveCloudAccess", () => {
    it("returns true when an active entitlement row exists", async () => {
      selectQueue.push([{ id: "grant_123" }]);

      const result = await hasActiveCloudAccess("user_1");
      expect(result).toBe(true);
    });

    it("returns false when no active entitlement row exists", async () => {
      selectQueue.push([]);

      const result = await hasActiveCloudAccess("user_1");
      expect(result).toBe(false);
    });
  });

  describe("grantCloudAccess", () => {
    it("refuses callers without grant_ai_assistant_cloud capability", async () => {
      requirePlatformCapabilityMock.mockResolvedValue({ success: false });

      const result = await grantCloudAccess("staff_1", {
        email: "test@example.com",
        note: null,
      });

      expect(result).toEqual({
        success: false,
        error: {
          type: "PLATFORM_CAPABILITY_REQUIRED",
          capability: "grant_ai_assistant_cloud",
        },
      });
    });

    it("returns USER_NOT_FOUND when email does not match any user", async () => {
      selectQueue.push([]); // user query returns empty

      const result = await grantCloudAccess("staff_1", {
        email: "unknown@example.com",
        note: "Testing",
      });

      expect(result).toEqual({
        success: false,
        error: { type: "USER_NOT_FOUND" },
      });
    });

    it("returns ALREADY_GRANTED when insert violates unique index (code 23505)", async () => {
      selectQueue.push([{ id: "user_target" }]);
      insertErrorToThrow = Object.assign(new Error("Unique violation"), { code: "23505" });

      const result = await grantCloudAccess("staff_1", {
        email: "existing@example.com",
        note: null,
      });

      expect(result).toEqual({
        success: false,
        error: { type: "ALREADY_GRANTED" },
      });
    });

    it("successfully creates a grant and returns userId and grantedAt", async () => {
      const grantDate = new Date("2026-10-01T12:00:00Z");
      selectQueue.push([{ id: "user_target" }]);
      insertQueue.push([{ grantedAt: grantDate }]);

      const result = await grantCloudAccess("staff_1", {
        email: "success@example.com",
        note: "Early adopter",
      });

      expect(result).toEqual({
        success: true,
        value: {
          userId: "user_target",
          grantedAt: grantDate,
        },
      });
    });
  });

  describe("revokeCloudAccess", () => {
    it("refuses callers without grant_ai_assistant_cloud capability", async () => {
      requirePlatformCapabilityMock.mockResolvedValue({ success: false });

      const result = await revokeCloudAccess("staff_1", "user_target");

      expect(result).toEqual({
        success: false,
        error: {
          type: "PLATFORM_CAPABILITY_REQUIRED",
          capability: "grant_ai_assistant_cloud",
        },
      });
    });

    it("returns NOT_GRANTED if no active grant was found to revoke", async () => {
      updateQueue.push([]); // nothing updated

      const result = await revokeCloudAccess("staff_1", "user_target");

      expect(result).toEqual({
        success: false,
        error: { type: "NOT_GRANTED" },
      });
    });

    it("successfully revokes and returns revokedAt date", async () => {
      const revokeDate = new Date("2026-10-02T12:00:00Z");
      updateQueue.push([{ revokedAt: revokeDate }]);

      const result = await revokeCloudAccess("staff_1", "user_target");

      expect(result).toEqual({
        success: true,
        value: { revokedAt: revokeDate },
      });
    });
  });

  describe("listActiveCloudAccessGrants", () => {
    it("refuses callers without grant_ai_assistant_cloud capability", async () => {
      requirePlatformCapabilityMock.mockResolvedValue({ success: false });

      const result = await listActiveCloudAccessGrants("staff_1", { limit: 10 });

      expect(result).toEqual({
        success: false,
        error: {
          type: "PLATFORM_CAPABILITY_REQUIRED",
          capability: "grant_ai_assistant_cloud",
        },
      });
    });

    it("returns INVALID_CURSOR on malformed cursor string", async () => {
      const result = await listActiveCloudAccessGrants("staff_1", {
        limit: 10,
        cursor: "not-a-valid-base64-instant-cursor",
      });

      expect(result).toEqual({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });
    });

    it("returns list of grants and computes nextCursor when more rows exist", async () => {
      const grantedDate = new Date("2026-10-01T10:00:00Z");
      // Simulate limit = 1, DB query returning 2 rows (limit + 1)
      selectQueue.push([
        {
          grantId: "grant_1",
          grantedAt: grantedDate,
          note: "Note 1",
          userId: "u1",
          email: "u1@test.com",
          name: "User One",
          handle: "userone",
          granterUserId: "staff_1",
          granterName: "Staff Member",
        },
        {
          grantId: "grant_2",
          grantedAt: new Date("2026-10-01T09:00:00Z"),
          note: "Note 2",
          userId: "u2",
          email: "u2@test.com",
          name: "User Two",
          handle: "usertwo",
          granterUserId: null,
          granterName: null,
        },
      ]);

      const result = await listActiveCloudAccessGrants("staff_1", { limit: 1 });

      expect(result).toEqual({
        success: true,
        value: {
          items: [
            expect.objectContaining({
              email: "u1@test.com",
              grantedBy: {
                userId: "staff_1",
                name: "Staff Member",
              },
            }),
          ],
          nextCursor: expect.any(String),
        },
      });
    });
  });
});
