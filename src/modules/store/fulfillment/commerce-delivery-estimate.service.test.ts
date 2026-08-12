import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { computePackagingTotals, groupOfferingsIntoEstimates } =
  await import("#src/modules/store/fulfillment/commerce-delivery-estimate.service.js");

type EstimateBasis = Parameters<typeof groupOfferingsIntoEstimates>[1];
type CoveringOffering = Parameters<typeof groupOfferingsIntoEstimates>[0][number];

const BASIS: EstimateBasis = {
  originCountryCode: "IN",
  destinationCountryCode: "DE",
  billableWeightGrams: 24_000,
  packageCount: 4,
  hasIncompletePackageData: false,
};

function buildOffering(overrides: Partial<CoveringOffering> = {}): CoveringOffering {
  return {
    offeringId: "offering_1",
    offeringSlug: "sea-freight-in-eu",
    providerKind: "freight_forwarder",
    currency: "USD",
    indicativePriceMinInCents: 40_000,
    indicativePriceMaxInCents: 90_000,
    minimumLeadTimeDays: 18,
    maximumLeadTimeDays: 32,
    providerOrganizationSlug: "blue-anchor-logistics",
    providerDisplayName: "Blue Anchor Logistics",
    ...overrides,
  };
}

describe("billable packaging (A16)", () => {
  it("counts whole packages, because half a carton does not ship", () => {
    expect(computePackagingTotals([{ quantity: 50, unitsPerPackage: 12, packageGrossWeightGrams: 6_000 }])).toEqual({
      // 50 units at 12 per package is five packages, not 4.17.
      packageCount: 5,
      billableWeightGrams: 30_000,
      hasIncompletePackageData: false,
    });
  });

  /**
   * `unitsPerPackage` NULL means UNSTATED, not one. Guessing one unit per package would
   * manufacture a weight the seller never declared, and an estimate is only worth
   * anything if it is attributable.
   */
  it("refuses to guess when a seller never declared packaging", () => {
    expect(computePackagingTotals([{ quantity: 10, unitsPerPackage: null, packageGrossWeightGrams: 6_000 }])).toEqual({
      packageCount: null,
      billableWeightGrams: null,
      hasIncompletePackageData: true,
    });
  });

  it("sums the lines it can and flags that some it could not", () => {
    expect(
      computePackagingTotals([
        { quantity: 24, unitsPerPackage: 12, packageGrossWeightGrams: 5_000 },
        { quantity: 10, unitsPerPackage: 5, packageGrossWeightGrams: null },
      ]),
    ).toEqual({
      packageCount: 2,
      billableWeightGrams: 10_000,
      hasIncompletePackageData: true,
    });
  });
});

describe("estimate grouping (A16)", () => {
  it("spans the cheapest floor to the dearest ceiling on the route", () => {
    const estimates = groupOfferingsIntoEstimates(
      [
        buildOffering({ indicativePriceMinInCents: 40_000, indicativePriceMaxInCents: 90_000 }),
        buildOffering({
          offeringId: "offering_2",
          indicativePriceMinInCents: 25_000,
          indicativePriceMaxInCents: 60_000,
          minimumLeadTimeDays: 30,
          maximumLeadTimeDays: 45,
        }),
      ],
      BASIS,
    );

    expect(estimates).toHaveLength(1);
    expect(estimates[0]).toMatchObject({
      currency: "USD",
      estimatedMinInCents: 25_000,
      estimatedMaxInCents: 90_000,
      leadTimeMinDays: 18,
      leadTimeMaxDays: 45,
    });
    // Attribution is the whole point: a buyer can see whose numbers these are.
    expect(estimates[0]?.derivedFrom).toHaveLength(2);
  });

  it("keeps currencies apart rather than converting without an FX quote", () => {
    const estimates = groupOfferingsIntoEstimates(
      [buildOffering({ currency: "USD" }), buildOffering({ offeringId: "offering_2", currency: "EUR" })],
      BASIS,
    );

    expect(estimates.map((estimate) => estimate.currency)).toEqual(["EUR", "USD"]);
  });

  it("reports no lead time rather than inventing one when nobody declared it", () => {
    const estimates = groupOfferingsIntoEstimates(
      [buildOffering({ minimumLeadTimeDays: null, maximumLeadTimeDays: null })],
      BASIS,
    );

    expect(estimates[0]).toMatchObject({ leadTimeMinDays: null, leadTimeMaxDays: null });
  });

  /**
   * "We do not know" and "it is free" are different answers. The mock this replaces
   * rendered the second one over a hardcoded date range.
   */
  it("returns nothing at all when no offering covers the route", () => {
    expect(groupOfferingsIntoEstimates([], BASIS)).toEqual([]);
  });
});
