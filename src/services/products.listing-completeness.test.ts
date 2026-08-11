import { describe, expect, it, vi } from "vitest";

// Pure projection — no database, no Cloudinary. The stubs exist only so importing the service
// module does not open a pool.
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("#src/lib/cloudinary.js", () => ({
  deleteAllProductImages: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  deleteProductImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  uploadProductImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));
vi.mock("#src/lib/image.js", () => ({
  validateAndNormalizeImage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));
vi.mock("#src/services/store-search.service.js", () => ({
  enqueueProductSearchDocumentRefresh: vi.fn<(...arguments_: readonly unknown[]) => Promise<void>>(),
  refreshProductSearchDocument: vi.fn<(...arguments_: readonly unknown[]) => Promise<void>>(),
}));

const { collectMissingListingFields, missingShippingFacts, projectListingCompleteness } =
  await import("#src/services/products.service.js");

type Facts = Parameters<typeof projectListingCompleteness>[0];

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    title: "Solar chest freezer",
    priceInCents: 120_000,
    imageCount: 3,
    samplePolicy: "unavailable",
    samplePriceInCents: null,
    packageLengthMm: 400,
    packageWidthMm: 300,
    packageHeightMm: 200,
    packageGrossWeightGrams: 12_000,
    unitsPerPackage: 5,
    ...overrides,
  };
}

function requirement(completeness: ReturnType<typeof projectListingCompleteness>, key: string) {
  return completeness.requirements.find((entry) => entry.key === key);
}

describe("projectListingCompleteness", () => {
  it("reports a fully described listing as complete", () => {
    const completeness = projectListingCompleteness(facts());

    expect(completeness.isComplete).toBe(true);
    expect(completeness.satisfiedRequirementCount).toBe(completeness.applicableRequirementCount);
    expect(collectMissingListingFields(completeness)).toEqual([]);
  });

  /**
   * §19.9. THE WHOLE POINT OF FIVE RATHER THAN THREE: a listing with dimensions but no
   * `unitsPerPackage` contributes zero volume to the rater, so it must not read as complete.
   */
  it("names all five shipping facts, not just the three dimensions", () => {
    const completeness = projectListingCompleteness(
      facts({
        packageLengthMm: null,
        packageWidthMm: null,
        packageHeightMm: null,
        packageGrossWeightGrams: null,
        unitsPerPackage: null,
      }),
    );

    expect(completeness.isComplete).toBe(false);
    expect(requirement(completeness, "shippingFacts")).toEqual({
      key: "shippingFacts",
      state: "missing",
      missingFields: [
        "packageLengthMm",
        "packageWidthMm",
        "packageHeightMm",
        "packageGrossWeightGrams",
        "unitsPerPackage",
      ],
    });
  });

  it("refuses a listing whose boxes are measured but whose units per package are not", () => {
    const completeness = projectListingCompleteness(facts({ unitsPerPackage: null }));

    // Dimensions alone would have passed a three-column gate, and the rater would still have
    // computed nothing from this listing.
    expect(completeness.isComplete).toBe(false);
    expect(requirement(completeness, "shippingFacts")?.missingFields).toEqual(["unitsPerPackage"]);
  });

  it("excludes a not-applicable requirement from the denominator", () => {
    const completeness = projectListingCompleteness(facts({ samplePolicy: "unavailable" }));

    expect(requirement(completeness, "samplePrice")).toEqual({
      key: "samplePrice",
      state: "not_applicable",
      missingFields: [],
    });
    expect(completeness.requirementCount).toBe(5);
    expect(completeness.applicableRequirementCount).toBe(4);
    expect(completeness.isComplete).toBe(true);
  });

  it("requires a sample price once the policy charges for samples", () => {
    const completeness = projectListingCompleteness(facts({ samplePolicy: "paid", samplePriceInCents: null }));

    expect(completeness.isComplete).toBe(false);
    expect(collectMissingListingFields(completeness)).toEqual(["samplePriceInCents"]);
  });

  /**
   * Other clients already render `INCOMPLETE_FOR_PUBLISH.missing`, so the token vocabulary and its
   * order are a wire contract this refactor must not have changed.
   */
  it("preserves the legacy token order", () => {
    const completeness = projectListingCompleteness(
      facts({
        title: "   ",
        priceInCents: 0,
        imageCount: 0,
        samplePolicy: "refundable",
        samplePriceInCents: null,
        unitsPerPackage: null,
      }),
    );

    expect(collectMissingListingFields(completeness)).toEqual([
      "title",
      "price",
      "images",
      "samplePriceInCents",
      "unitsPerPackage",
    ]);
  });
});

describe("missingShippingFacts", () => {
  it("returns nothing when every fact is declared", () => {
    expect(
      missingShippingFacts({
        packageLengthMm: 400,
        packageWidthMm: 300,
        packageHeightMm: 200,
        packageGrossWeightGrams: 12_000,
        unitsPerPackage: 5,
      }),
    ).toEqual([]);
  });

  it("treats a zero as declared — a flat box is a measurement, an absent one is not", () => {
    // 0 is falsy; the check must be `=== null`, not a truthiness test.
    expect(
      missingShippingFacts({
        packageLengthMm: 0,
        packageWidthMm: 0,
        packageHeightMm: 0,
        packageGrossWeightGrams: 0,
        unitsPerPackage: 0,
      }),
    ).toEqual([]);
  });
});
