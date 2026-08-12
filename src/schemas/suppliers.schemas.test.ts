import { describe, expect, it, vi } from "vitest";

// The controller imports its services, which pull in the db pool at module scope. Stub the
// modules so the schemas can be parsed without a configured environment — nothing here
// calls a handler. Same arrangement as compensation.controller.schemas.test.ts.
vi.mock("#src/services/suppliers.service.js", () => ({}));
vi.mock("#src/services/launch-readiness.service.js", () => ({}));
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({}));
vi.mock("#src/services/supplier-engagements.service.js", () => ({}));

const {
  CreateSupplierEngagementSchema,
  CreateSupplierSchema,
  LaunchReadyProjectsQuerySchema,
  ListSuppliersQuerySchema,
  UpdateSupplierEngagementSchema,
  UpdateSupplierSchema,
} = await import("#src/schemas/suppliers.schemas.js");

/**
 * R_AND_D_BACKEND_STRUCTURE.md §11i's rejected-keys list, §0 and §13.
 *
 * A COMMENT CLAIMING A KEY IS REJECTED AND A TEST PROVING IT ARE DIFFERENT ARTIFACTS.
 * `suppliers.controller.ts` enumerates the list; this file asserts it against every body
 * and query the go-to-market router accepts.
 *
 * TWO ENTRIES CARRY THE MOST WEIGHT, and each has its own block below:
 *   `verificationState` on CREATE — a directory whose rows assert their own trust level is
 *   worse than no directory.
 *   `slug` on UPDATE — it is the public identity a client has already linked to.
 */

/** §11i's list, verbatim. */
const SERVER_OWNED_KEYS = [
  "id",
  "createdAt",
  "updatedAt",
  "createdByUserId",
  "projectId",
  "researchProjectId",
  "metCount",
  "state",
  "observedCount",
  "asOf",
] as const;

describe("CreateSupplierSchema", () => {
  const validBody = { slug: "acme-tooling", name: "Acme Tooling", capabilitySlugs: ["tool-and-die"] };

  it("accepts the minimum a moderator must send", () => {
    const parsed = CreateSupplierSchema.safeParse(validBody);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.capabilitySlugs).toEqual(["tool-and-die"]);
  });

  it("defaults capabilitySlugs to an empty list rather than undefined", () => {
    const parsed = CreateSupplierSchema.safeParse({ slug: "acme", name: "Acme" });

    expect(parsed.success && parsed.data.capabilitySlugs).toEqual([]);
  });

  it.each(SERVER_OWNED_KEYS)("rejects the server-owned key %s", (rejectedKey) => {
    const parsed = CreateSupplierSchema.safeParse({ ...validBody, [rejectedKey]: "anything" });

    expect(parsed.success).toBe(false);
  });

  it("rejects verificationState — a new listing is always unverified", () => {
    const parsed = CreateSupplierSchema.safeParse({ ...validBody, verificationState: "verified" });

    expect(parsed.success).toBe(false);
  });

  it("rejects isActive — retirement is an edit, not a property of creation", () => {
    expect(CreateSupplierSchema.safeParse({ ...validBody, isActive: false }).success).toBe(false);
  });

  it.each([
    ["uppercase", "Acme-Tooling"],
    ["spaces", "acme tooling"],
    ["underscores", "acme_tooling"],
    ["leading hyphen", "-acme"],
    ["trailing hyphen", "acme-"],
    ["double hyphen", "acme--tooling"],
    ["empty", ""],
  ])("rejects a slug with %s", (_label, slug) => {
    expect(CreateSupplierSchema.safeParse({ ...validBody, slug }).success).toBe(false);
  });

  it("rejects a capability slug that is not slug-shaped", () => {
    const parsed = CreateSupplierSchema.safeParse({
      ...validBody,
      capabilitySlugs: ["Tool And Die"],
    });

    expect(parsed.success).toBe(false);
  });

  it.each([
    ["negative lead time", { leadTimeDays: -1 }],
    ["fractional lead time", { leadTimeDays: 1.5 }],
    ["lead time past a decade", { leadTimeDays: 4_000 }],
    ["negative minimum order quantity", { minimumOrderQuantity: -1 }],
    ["fractional minimum order quantity", { minimumOrderQuantity: 2.5 }],
  ])("rejects %s", (_label, overrides) => {
    expect(CreateSupplierSchema.safeParse({ ...validBody, ...overrides }).success).toBe(false);
  });

  it("rejects a price in any shape — a directory row carries no money (§4b)", () => {
    for (const priceKey of ["priceInCents", "unitPriceInCents", "indicativePriceInCents"]) {
      expect(CreateSupplierSchema.safeParse({ ...validBody, [priceKey]: 100 }).success).toBe(false);
    }
  });

  it("rejects a currency — there is no project here to derive one from", () => {
    expect(CreateSupplierSchema.safeParse({ ...validBody, currency: "USD" }).success).toBe(false);
    expect(CreateSupplierSchema.safeParse({ ...validBody, currencyCode: "USD" }).success).toBe(false);
  });
});

describe("UpdateSupplierSchema", () => {
  it("accepts an empty body — a PATCH that changes nothing is not an error", () => {
    expect(UpdateSupplierSchema.safeParse({}).success).toBe(true);
  });

  it("rejects slug — the public identity is frozen once linked to", () => {
    expect(UpdateSupplierSchema.safeParse({ slug: "renamed" }).success).toBe(false);
  });

  it("lets a moderator move verificationState, unlike on create", () => {
    const parsed = UpdateSupplierSchema.safeParse({ verificationState: "verified" });

    expect(parsed.success).toBe(true);
  });

  it("rejects a verificationState outside the enum", () => {
    expect(UpdateSupplierSchema.safeParse({ verificationState: "trusted" }).success).toBe(false);
  });

  it("keeps explicit null distinguishable from absent", () => {
    const cleared = UpdateSupplierSchema.safeParse({ summary: null });
    const untouched = UpdateSupplierSchema.safeParse({});

    expect(cleared.success && "summary" in cleared.data).toBe(true);
    expect(untouched.success && "summary" in untouched.data).toBe(false);
  });

  it.each(SERVER_OWNED_KEYS)("rejects the server-owned key %s", (rejectedKey) => {
    expect(UpdateSupplierSchema.safeParse({ [rejectedKey]: "anything" }).success).toBe(false);
  });
});

describe("ListSuppliersQuerySchema", () => {
  it("normalizes a single capability to a list", () => {
    const parsed = ListSuppliersQuerySchema.safeParse({ capability: "cnc-machining" });

    expect(parsed.success && parsed.data.capability).toEqual(["cnc-machining"]);
  });

  it("keeps a repeated capability key as a list — several means AND", () => {
    const parsed = ListSuppliersQuerySchema.safeParse({
      capability: ["cnc-machining", "tool-and-die"],
    });

    expect(parsed.success && parsed.data.capability).toEqual(["cnc-machining", "tool-and-die"]);
  });

  it("defaults page and limit rather than leaving them undefined", () => {
    const parsed = ListSuppliersQuerySchema.safeParse({});

    expect(parsed.success && parsed.data.page).toBe(1);
    expect(parsed.success && parsed.data.limit).toBe(20);
  });

  it("caps limit, so one query cannot ask for the whole directory", () => {
    expect(ListSuppliersQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });

  it("rejects an unknown verificationState rather than yielding an empty page", () => {
    expect(ListSuppliersQuerySchema.safeParse({ verificationState: "trusted" }).success).toBe(false);
  });

  it("rejects more than ten capability chips", () => {
    const parsed = ListSuppliersQuerySchema.safeParse({
      capability: Array.from({ length: 11 }, (_unused, index) => `capability-${String(index)}`),
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown filter key rather than ignoring it", () => {
    expect(ListSuppliersQuerySchema.safeParse({ isActive: "false" }).success).toBe(false);
  });
});

describe("LaunchReadyProjectsQuerySchema", () => {
  it("defaults page and limit", () => {
    const parsed = LaunchReadyProjectsQuerySchema.safeParse({});

    expect(parsed.success && parsed.data.page).toBe(1);
    expect(parsed.success && parsed.data.limit).toBe(20);
  });

  it("rejects a stage filter — the rail is go_to_market by definition", () => {
    expect(LaunchReadyProjectsQuerySchema.safeParse({ stage: "building_mvp" }).success).toBe(false);
  });
});

/**
 * §11j.5's hard rule: NOTHING on a project-scoped route may feed a supplier's
 * `verificationState`.
 *
 * WHY THIS BLOCK EXISTS SEPARATELY. `contracted` means *this team says it signed
 * something* — a self-report whose only attesting party is the one that benefits. If that
 * could move the public directory's trust level, the directory becomes forgeable one
 * self-report at a time, and every buyer downstream is reading a number the seller wrote.
 *
 * The rule is enforced three ways and this is the third: `.strict()` refuses the key,
 * `supplier-engagements.service.ts` writes exactly one table and it is not `supplier`, and
 * this test proves the first of those rather than asserting it in a comment.
 */
describe("supplier engagement bodies", () => {
  const ENGAGEMENT_REJECTED_KEYS = [
    "verificationState",
    "supplierSlug",
    "isActive",
    "createdByMemberId",
    "projectId",
    "id",
    "createdAt",
    "updatedAt",
  ] as const;

  it.each(ENGAGEMENT_REJECTED_KEYS)("CREATE rejects a client-supplied %s", (key) => {
    const parsed = CreateSupplierEngagementSchema.safeParse({
      supplierId: "sup_1",
      status: "contracted",
      [key]: key === "isActive" ? true : "verified",
    });
    expect(parsed.success).toBe(false);
  });

  it.each(ENGAGEMENT_REJECTED_KEYS)("UPDATE rejects a client-supplied %s", (key) => {
    const parsed = UpdateSupplierEngagementSchema.safeParse({
      status: "contracted",
      [key]: key === "isActive" ? true : "verified",
    });
    expect(parsed.success).toBe(false);
  });

  /**
   * The (projectId, supplierId) pair is the row's identity — a unique index enforces it —
   * so re-pointing an engagement is a delete plus a create, never an edit.
   */
  it("UPDATE rejects supplierId, because the pair is the row's identity", () => {
    const parsed = UpdateSupplierEngagementSchema.safeParse({ supplierId: "sup_2" });
    expect(parsed.success).toBe(false);
  });

  it("CREATE defaults status to considering, the weakest claim", () => {
    const parsed = CreateSupplierEngagementSchema.safeParse({ supplierId: "sup_1" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.status).toBe("considering");
  });

  it("refuses a note past the 2000-char CHECK, as a 422 rather than a 500", () => {
    const parsed = CreateSupplierEngagementSchema.safeParse({
      supplierId: "sup_1",
      note: "x".repeat(2001),
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts every shipped engagement status and nothing else", () => {
    for (const status of ["considering", "contacted", "contracted", "ended"]) {
      expect(UpdateSupplierEngagementSchema.safeParse({ status }).success).toBe(true);
    }
    expect(UpdateSupplierEngagementSchema.safeParse({ status: "verified" }).success).toBe(false);
  });
});
