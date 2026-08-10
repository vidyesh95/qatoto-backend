import { describe, expect, it, vi } from "vitest";

// The pure half touches no database; the singleton is stubbed so importing the module does
// not open a pool. `commerce-trust.service.test.ts` takes the same shape.
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));

const {
  BILLABLE_WEIGHT_UNIT_GRAMS,
  priceRatedBreak,
  rateCard,
  rateLaneFromCards,
  selectRateBreak,
} = await import("#src/services/commerce-freight-rating.service.js");

type Band = Parameters<typeof selectRateBreak>[0][number];
type Consignment = Parameters<typeof selectRateBreak>[1];

function band(overrides: Partial<Band> & Pick<Band, "id" | "minBillableWeightGrams">): Band {
  return {
    minVolumeCubicCm: 0,
    unitPriceInCents: 400,
    minimumChargeInCents: 0,
    transitDaysMin: 24,
    transitDaysMax: 34,
    position: 0,
    ...overrides,
  };
}

function consignment(overrides: Partial<Consignment> = {}): Consignment {
  return {
    billableWeightGrams: 50_000,
    volumeCubicCm: 200_000,
    packageCount: 4,
    hasIncompletePackageData: false,
    ...overrides,
  };
}

describe("selectRateBreak", () => {
  it("selects the highest band the consignment clears, not the first", () => {
    const selection = selectRateBreak(
      [
        band({ id: "b0", minBillableWeightGrams: 0, position: 0 }),
        band({ id: "b45", minBillableWeightGrams: 45_000, position: 1 }),
        band({ id: "b100", minBillableWeightGrams: 100_000, position: 2 }),
      ],
      consignment({ billableWeightGrams: 50_000 }),
    );

    expect(selection).toEqual({ status: "selected", selected: expect.objectContaining({ id: "b45" }) });
  });

  it("treats a band's floor as inclusive", () => {
    const selection = selectRateBreak(
      [
        band({ id: "b0", minBillableWeightGrams: 0, position: 0 }),
        band({ id: "b45", minBillableWeightGrams: 45_000, position: 1 }),
      ],
      consignment({ billableWeightGrams: 45_000 }),
    );

    expect(selection).toEqual({ status: "selected", selected: expect.objectContaining({ id: "b45" }) });
  });

  it("selects correctly even when bands are authored out of position order", () => {
    const selection = selectRateBreak(
      [
        band({ id: "b100", minBillableWeightGrams: 100_000, position: 0 }),
        band({ id: "b0", minBillableWeightGrams: 0, position: 1 }),
        band({ id: "b45", minBillableWeightGrams: 45_000, position: 2 }),
      ],
      consignment({ billableWeightGrams: 50_000 }),
    );

    expect(selection).toEqual({ status: "selected", selected: expect.objectContaining({ id: "b45" }) });
  });

  it("reports below_smallest_break rather than falling back to a minimum charge", () => {
    const selection = selectRateBreak(
      [band({ id: "b45", minBillableWeightGrams: 45_000, minimumChargeInCents: 15_000 })],
      consignment({ billableWeightGrams: 5_000 }),
    );

    expect(selection).toEqual({
      status: "below_smallest_break",
      smallestMinBillableWeightGrams: 45_000,
      smallestMinVolumeCubicCm: 0,
    });
  });

  it("refuses to rate an unmeasurable consignment", () => {
    const selection = selectRateBreak(
      [band({ id: "b0", minBillableWeightGrams: 0 })],
      consignment({ billableWeightGrams: null, hasIncompletePackageData: true }),
    );

    expect(selection).toEqual({ status: "consignment_not_measurable" });
  });

  it("reports a card with no bands", () => {
    expect(selectRateBreak([], consignment())).toEqual({ status: "card_has_no_breaks" });
  });

  it("disqualifies a volume-floored band when the volume is unknown, but not a weight-only one", () => {
    const unknownVolume = consignment({ volumeCubicCm: null, hasIncompletePackageData: true });

    expect(
      selectRateBreak(
        [band({ id: "bvol", minBillableWeightGrams: 0, minVolumeCubicCm: 100_000 })],
        unknownVolume,
      ),
    ).toEqual(expect.objectContaining({ status: "below_smallest_break" }));

    expect(
      selectRateBreak(
        [band({ id: "bweight", minBillableWeightGrams: 0, minVolumeCubicCm: 0 })],
        unknownVolume,
      ),
    ).toEqual({ status: "selected", selected: expect.objectContaining({ id: "bweight" }) });
  });

  it("requires BOTH floors to be cleared", () => {
    const selection = selectRateBreak(
      [
        band({ id: "b0", minBillableWeightGrams: 0, minVolumeCubicCm: 0, position: 0 }),
        band({
          id: "bheavy",
          minBillableWeightGrams: 10_000,
          minVolumeCubicCm: 5_000_000,
          position: 1,
        }),
      ],
      // Heavy enough for the second band, nowhere near bulky enough.
      consignment({ billableWeightGrams: 50_000, volumeCubicCm: 200_000 }),
    );

    expect(selection).toEqual({ status: "selected", selected: expect.objectContaining({ id: "b0" }) });
  });
});

describe("priceRatedBreak", () => {
  it("charges per kilogram of chargeable weight", () => {
    expect(BILLABLE_WEIGHT_UNIT_GRAMS).toBe(1000);
    expect(priceRatedBreak(band({ id: "b", minBillableWeightGrams: 0, unitPriceInCents: 400 }), 50_000)).toBe(
      20_000,
    );
  });

  it("rounds up, never down — a rounded-down freight charge is one the forwarder will not honour", () => {
    expect(priceRatedBreak(band({ id: "b", minBillableWeightGrams: 0, unitPriceInCents: 333 }), 1_001)).toBe(334);
  });

  it("lets the minimum charge dominate a light consignment", () => {
    expect(
      priceRatedBreak(
        band({ id: "b", minBillableWeightGrams: 0, unitPriceInCents: 400, minimumChargeInCents: 15_000 }),
        1_000,
      ),
    ).toBe(15_000);
  });
});

describe("rateLaneFromCards", () => {
  const asOf = new Date("2026-08-10T00:00:00.000Z");

  function card(overrides: Partial<Parameters<typeof rateCard>[0]> & { readonly id: string }) {
    return {
      providerOrganizationId: "org_forwarder",
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      mode: "sea" as const,
      currency: "USD",
      validFrom: asOf,
      validUntil: null,
      sourceForwarderName: "Blue Anchor Logistics",
      breaks: [band({ id: `${overrides.id}_b0`, minBillableWeightGrams: 0 })],
      ...overrides,
    };
  }

  it("reports no_active_rate_card for an uncovered lane, with no options and no zero", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [],
      consignment: consignment(),
    });

    expect(lane.options).toEqual([]);
    expect(lane.unavailableReasons).toEqual(["no_active_rate_card"]);
  });

  it("emits one option per card, so two forwarders on one mode are two choices", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [
        card({ id: "rc_a", sourceForwarderName: "Blue Anchor Logistics" }),
        card({ id: "rc_b", sourceForwarderName: "Harbour Line" }),
      ],
      consignment: consignment(),
    });

    expect(lane.options).toHaveLength(2);
    expect(lane.options.map((option) => option.sourceForwarderName).toSorted()).toEqual([
      "Blue Anchor Logistics",
      "Harbour Line",
    ]);
  });

  it("orders options by mode, then price, then card id", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [
        card({ id: "rc_sea", mode: "sea" }),
        card({ id: "rc_air", mode: "air" }),
      ],
      consignment: consignment(),
    });

    expect(lane.options.map((option) => option.mode)).toEqual(["air", "sea"]);
  });

  it("carries provenance and expiry on every option, per §19.6", () => {
    const validUntil = new Date("2026-12-31T00:00:00.000Z");
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [card({ id: "rc_a", validUntil })],
      consignment: consignment(),
    });

    expect(lane.options[0]).toEqual(
      expect.objectContaining({
        sourceForwarderName: "Blue Anchor Logistics",
        validUntil,
        rateCardId: "rc_a",
        currency: "USD",
      }),
    );
  });

  it("reports reasons only when they explain an absence", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [
        card({ id: "rc_ok" }),
        card({ id: "rc_empty", breaks: [] }),
      ],
      consignment: consignment(),
    });

    expect(lane.options).toHaveLength(1);
    // One card could not price, but the lane IS covered — a covered lane names no reason.
    expect(lane.unavailableReasons).toEqual([]);
  });

  it("names every reason when nothing on the lane could price", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [
        card({ id: "rc_empty", breaks: [] }),
        card({ id: "rc_heavy", breaks: [band({ id: "bh", minBillableWeightGrams: 999_000 })] }),
      ],
      consignment: consignment({ billableWeightGrams: 5_000 }),
    });

    expect(lane.options).toEqual([]);
    expect(lane.unavailableReasons).toEqual(["below_smallest_break", "card_has_no_breaks"]);
  });
});
