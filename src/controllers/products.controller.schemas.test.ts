import { describe, expect, it, vi } from "vitest";

// The controller imports the service, which pulls in the db pool, Cloudinary and sharp at
// module scope. Stub the whole module so the schemas can be parsed without a configured
// environment — nothing here calls a handler.
vi.mock("#src/services/products.service.js", () => ({}));

const { CreateProductSchema, UpdateProductSchema } = await import("#src/controllers/products.controller.js");

/**
 * REGRESSION SUITE for a data-loss bug, not a style preference.
 *
 * `UpdateProductSchema` used to be `ProductFieldsSchema.partial()`. Zod's `.partial()`
 * does NOT strip `.default()`, so `PATCH { title }` parsed into a payload that also
 * asserted `condition`, `keyFeatures`, `stockQuantity` and `pricingTiers`. Every
 * `if (patch.X !== undefined)` guard in products.service.ts therefore fired, and
 * `updateProduct` deleted the listing's entire pricing-tier set on a title-only edit.
 *
 * The first test below is the one that matters: a PATCH must carry ONLY what the client
 * sent. The studio video schemas are built the same way for the same reason.
 */
describe("UpdateProductSchema — a PATCH carries only what the client sent", () => {
  it("parses a title-only patch into exactly one key", () => {
    const parsed = UpdateProductSchema.safeParse({ title: "New title" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data).toSorted()).toEqual(["title"]);
  });

  it("leaves every defaulted field undefined when it is omitted", () => {
    const parsed = UpdateProductSchema.parse({ title: "New title" });

    // Each of these was silently defined before the fix. `pricingTiers` is the dangerous
    // one: defined-and-empty means "replace the tier set with nothing".
    expect(parsed.condition).toBeUndefined();
    expect(parsed.keyFeatures).toBeUndefined();
    expect(parsed.stockQuantity).toBeUndefined();
    expect(parsed.pricingTiers).toBeUndefined();
  });

  it("still round-trips the fields a patch does send", () => {
    const parsed = UpdateProductSchema.parse({
      stockQuantity: 0,
      pricingTiers: [{ unitPriceInCents: 100, minimumOrderQuantity: 10 }],
    });

    // An explicitly-sent 0 and an explicitly-sent empty set must stay distinguishable
    // from "omitted" — that is the whole point of dropping the defaults.
    expect(parsed.stockQuantity).toBe(0);
    expect(parsed.pricingTiers).toEqual([{ unitPriceInCents: 100, minimumOrderQuantity: 10 }]);
  });

  it("still rejects unknown keys", () => {
    expect(UpdateProductSchema.safeParse({ title: "x", sellerId: "usr_evil" }).success).toBe(false);
  });

  it("still enforces the compare-at rule when both prices are present", () => {
    expect(UpdateProductSchema.safeParse({ priceInCents: 500, compareAtPriceInCents: 100 }).success).toBe(false);
    expect(UpdateProductSchema.safeParse({ priceInCents: 100, compareAtPriceInCents: 500 }).success).toBe(true);
  });
});

describe("CreateProductSchema — defaults still apply on create", () => {
  it("fills the defaulted fields a wizard may omit", () => {
    const parsed = CreateProductSchema.parse({
      title: "A listing",
      category: "electronics",
      priceInCents: 1_000,
    });

    expect(parsed.condition).toBe("new");
    expect(parsed.keyFeatures).toEqual([]);
    expect(parsed.stockQuantity).toBe(0);
    expect(parsed.pricingTiers).toEqual([]);
  });

  it("still requires the fields that have no default", () => {
    expect(CreateProductSchema.safeParse({ title: "A listing" }).success).toBe(false);
  });

  it("accepts canonical categoryId without the legacy category enum", () => {
    const parsed = CreateProductSchema.parse({
      title: "A listing",
      categoryId: "commerce_category_electronics",
      priceInCents: 1_000,
    });

    expect(parsed.categoryId).toBe("commerce_category_electronics");
    expect(parsed.category).toBeUndefined();
  });

  it("requires at least one category representation", () => {
    expect(CreateProductSchema.safeParse({ title: "A listing", priceInCents: 1_000 }).success).toBe(false);
  });

  it("rejects client-supplied organization ownership fields", () => {
    expect(
      CreateProductSchema.safeParse({
        title: "A listing",
        category: "electronics",
        priceInCents: 1_000,
        sellerOrganizationId: "commerce_org_attacker",
      }).success,
    ).toBe(false);
  });
});

describe("legacy product schema compatibility", () => {
  it("accepts all eight legacy category values", () => {
    const legacyCategories = [
      "electronics",
      "fashion",
      "home_kitchen",
      "anime_collectibles",
      "digital_goods",
      "books_media",
      "sports_outdoors",
      "beauty_personal_care",
    ];

    for (const category of legacyCategories) {
      expect(CreateProductSchema.safeParse({ title: "Legacy listing", category, priceInCents: 100 }).success).toBe(
        true,
      );
    }
  });
});
