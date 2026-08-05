import { beforeEach, describe, expect, it, vi } from "vitest";

// The service imports the db pool, which pulls in the config env parser. Stub the query
// chain so these tests exercise the CAPABILITY LOGIC only.
interface PlatformRoleRow {
  readonly platformRole: string;
}

const limitMock = vi.fn<(rowLimit: number) => Promise<PlatformRoleRow[]>>();
const whereMock = vi.fn<(condition: unknown) => { limit: typeof limitMock }>(() => ({
  limit: limitMock,
}));
const fromMock = vi.fn<(table: unknown) => { where: typeof whereMock }>(() => ({
  where: whereMock,
}));
const selectMock = vi.fn<(columns: unknown) => { from: typeof fromMock }>(() => ({
  from: fromMock,
}));

vi.mock("#src/db/index.js", () => ({ db: { select: selectMock } }));

const { requirePlatformCapability } = await import("#src/services/platform-role.service.js");

function stubPlatformRole(platformRole: string | null): void {
  limitMock.mockResolvedValue(platformRole === null ? [] : [{ platformRole }]);
}

/**
 * §4a Layer 3.
 *
 * The property that matters most here is NOT which role maps to which capability — it is
 * that `moderator` and `auditor` are DISJOINT. A rank ladder (the shape
 * `requireProjectRole` correctly uses) would make one imply the other, silently granting a
 * content moderator read access to the §7 escrow ledger, or an escrow auditor the power to
 * approve taxonomy. These tests pin the disjointness so a future refactor to a rank map
 * fails loudly.
 */
describe("requirePlatformCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("grants a moderator content and commerce moderation capabilities", async () => {
    for (const capability of [
      "moderate_taxonomy",
      "moderate_clusters",
      "moderate_content",
      "moderate_commerce",
    ] as const) {
      stubPlatformRole("moderator");
      const result = await requirePlatformCapability("user-1", capability);
      expect(result.success).toBe(true);
    }
  });

  it("REFUSES a moderator the escrow-audit capability", async () => {
    stubPlatformRole("moderator");
    const result = await requirePlatformCapability("user-1", "audit_escrow");

    // Asserting the WHOLE result rather than narrowing then probing: it is a stronger
    // claim (the payload shape is pinned too) and it avoids a conditional expect, which
    // silently passes if the narrowing branch is never entered.
    expect(result).toEqual({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "audit_escrow" },
    });
  });

  it("REFUSES an auditor every content capability", async () => {
    for (const capability of [
      "moderate_taxonomy",
      "moderate_clusters",
      "moderate_content",
      "moderate_commerce",
    ] as const) {
      stubPlatformRole("auditor");
      const result = await requirePlatformCapability("user-1", capability);
      expect(result.success).toBe(false);
    }
  });

  it("grants an auditor only escrow audit", async () => {
    stubPlatformRole("auditor");
    expect((await requirePlatformCapability("user-1", "audit_escrow")).success).toBe(true);
  });

  it("grants an admin everything", async () => {
    for (const capability of [
      "moderate_taxonomy",
      "moderate_clusters",
      "moderate_content",
      "moderate_commerce",
      "audit_escrow",
    ] as const) {
      stubPlatformRole("admin");
      expect((await requirePlatformCapability("user-1", capability)).success).toBe(true);
    }
  });

  it("refuses an ordinary user with no platform role", async () => {
    stubPlatformRole(null);
    const result = await requirePlatformCapability("user-1", "moderate_taxonomy");

    expect(result.success).toBe(false);
  });

  it("returns an IDENTICAL error whether the role is absent or merely insufficient", async () => {
    // A distinguishable refusal is a probe. Both paths must be indistinguishable to the
    // caller, exactly as requireProjectRole collapses its three cases into one NOT_FOUND.
    stubPlatformRole(null);
    const noRoleResult = await requirePlatformCapability("user-1", "audit_escrow");

    stubPlatformRole("moderator");
    const wrongRoleResult = await requirePlatformCapability("user-1", "audit_escrow");

    const expectedRefusal = {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "audit_escrow" },
    };
    expect(noRoleResult).toEqual(expectedRefusal);
    expect(wrongRoleResult).toEqual(expectedRefusal);
  });

  it("names the capability but never the caller's actual role", async () => {
    // Telling an attacker which role they would need is free reconnaissance.
    stubPlatformRole("auditor");
    const result = await requirePlatformCapability("user-1", "moderate_taxonomy");

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("auditor");
  });
});
