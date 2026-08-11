import { describe, expect, it, vi } from "vitest";

// The pure half touches no database; the singleton is stubbed so importing the module does
// not open a pool. `commerce-trust.service.test.ts` takes the same shape.
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));

const {
  BILLABLE_WEIGHT_UNIT_GRAMS,
  computeChargeableWeight,
  priceRatedBreak,
  rateCard,
  rateLaneFromCards,
  selectRateBreak,
} = await import("#src/services/commerce-freight-rating.service.js");

type Band = Parameters<typeof selectRateBreak>[0][number];
type Card = Parameters<typeof rateCard>[0];
type Consignment = Parameters<typeof rateCard>[1];

/** Ocean LCL: the W/M revenue ton — one cubic metre bills as 1000 kg. */
const OCEAN_DIVISOR = 1000;
/** IATA air: one cubic metre bills as ~166.7 kg. */
const AIR_DIVISOR = 6000;

const AS_OF = new Date("2026-08-10T00:00:00.000Z");
const ONE_CUBIC_METRE_CM3 = 1_000_000;

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

function card(overrides: Partial<Card> & Pick<Card, "id">): Card {
  return {
    providerOrganizationId: "org_forwarder",
    originCountryCode: "IN",
    destinationCountryCode: "DE",
    mode: "sea",
    currency: "USD",
    validFrom: AS_OF,
    validUntil: null,
    sourceForwarderName: "Blue Anchor Logistics",
    volumetricDivisorCm3PerKg: OCEAN_DIVISOR,
    breaks: [band({ id: `${overrides.id}_b0`, minBillableWeightGrams: 0 })],
    ...overrides,
  };
}

describe("computeChargeableWeight", () => {
  /**
   * THE REGRESSION GUARD FOR THE DEFECT §19.9 RECORDS. Twenty kilograms of cushions filling three
   * cubic metres bills as three TONNES under ocean W/M. Phase 20 shipped rating this at 20 kg.
   */
  it("bills a light bulky consignment on volume, not on its actual weight", () => {
    const chargeable = computeChargeableWeight(
      card({ id: "rc_sea", volumetricDivisorCm3PerKg: OCEAN_DIVISOR }),
      consignment({ billableWeightGrams: 20_000, volumeCubicCm: 3 * ONE_CUBIC_METRE_CM3 }),
    );

    expect(chargeable).toEqual({
      status: "chargeable",
      grams: 3_000_000,
      basis: "volumetric",
      volumeCubicCm: 3_000_000,
    });
  });

  it("bills a dense consignment on its actual weight", () => {
    const chargeable = computeChargeableWeight(
      card({ id: "rc_sea" }),
      // A pallet of bolts: heavy, barely any volume.
      consignment({ billableWeightGrams: 900_000, volumeCubicCm: 200_000 }),
    );

    expect(chargeable).toEqual(expect.objectContaining({ grams: 900_000, basis: "actual" }));
  });

  it("resolves a tie to the actual basis", () => {
    const chargeable = computeChargeableWeight(
      card({ id: "rc_sea", volumetricDivisorCm3PerKg: OCEAN_DIVISOR }),
      // 1 m³ under divisor 1000 is exactly 1000 kg.
      consignment({ billableWeightGrams: 1_000_000, volumeCubicCm: ONE_CUBIC_METRE_CM3 }),
    );

    expect(chargeable).toEqual(expect.objectContaining({ grams: 1_000_000, basis: "actual" }));
  });

  it("applies the AIR divisor when the card declares one", () => {
    const chargeable = computeChargeableWeight(
      card({ id: "rc_air", mode: "air", volumetricDivisorCm3PerKg: AIR_DIVISOR }),
      consignment({ billableWeightGrams: 20_000, volumeCubicCm: ONE_CUBIC_METRE_CM3 }),
    );

    // 1_000_000 cm³ / 6000 = 166.67 kg → 166_667 g, rounded UP.
    expect(chargeable).toEqual(expect.objectContaining({ grams: 166_667, basis: "volumetric" }));
  });

  it("gives two different chargeable weights for one consignment under two divisors", () => {
    const boxes = consignment({
      billableWeightGrams: 20_000,
      volumeCubicCm: ONE_CUBIC_METRE_CM3,
    });

    const bySea = computeChargeableWeight(card({ id: "rc_sea", volumetricDivisorCm3PerKg: OCEAN_DIVISOR }), boxes);
    const byAir = computeChargeableWeight(card({ id: "rc_air", volumetricDivisorCm3PerKg: AIR_DIVISOR }), boxes);

    // The divisor belongs to the forwarder, not to the boxes — this is why chargeable weight
    // cannot live on `ConsignmentMeasurement`.
    expect(bySea).toEqual(expect.objectContaining({ grams: 1_000_000 }));
    expect(byAir).toEqual(expect.objectContaining({ grams: 166_667 }));
  });

  it("rounds volumetric weight UP", () => {
    const chargeable = computeChargeableWeight(
      card({ id: "rc_air", volumetricDivisorCm3PerKg: AIR_DIVISOR }),
      consignment({ billableWeightGrams: 1, volumeCubicCm: 6_001 }),
    );

    // 6001 / 6000 = 1.0002 kg → 1001 g, never 1000.
    expect(chargeable).toEqual(expect.objectContaining({ grams: 1_001 }));
  });

  it("refuses an undeclared volume rather than falling back to actual weight", () => {
    const chargeable = computeChargeableWeight(
      card({ id: "rc_sea" }),
      consignment({ volumeCubicCm: null, hasIncompletePackageData: true }),
    );

    // Falling back to gross is exactly the underpricing this function exists to remove.
    expect(chargeable).toEqual({ status: "not_measurable", reason: "volume_not_declared" });
  });

  it("keeps an undeclared weight distinct from an undeclared volume", () => {
    const chargeable = computeChargeableWeight(
      card({ id: "rc_sea" }),
      consignment({ billableWeightGrams: null, hasIncompletePackageData: true }),
    );

    expect(chargeable).toEqual({ status: "not_measurable", reason: "weight_not_declared" });
  });
});

describe("selectRateBreak", () => {
  it("selects the highest band the consignment clears, not the first", () => {
    const selection = selectRateBreak(
      [
        band({ id: "b0", minBillableWeightGrams: 0, position: 0 }),
        band({ id: "b45", minBillableWeightGrams: 45_000, position: 1 }),
        band({ id: "b100", minBillableWeightGrams: 100_000, position: 2 }),
      ],
      { chargeableWeightGrams: 50_000, volumeCubicCm: 200_000 },
    );

    expect(selection).toEqual({ status: "selected", selected: expect.objectContaining({ id: "b45" }) });
  });

  /**
   * §19.9. A tariff's "500 kg+" band means 500 kg CHARGEABLE. A bulky consignment must climb the
   * ladder the way the forwarder intended rather than sitting in the base band on its gross weight.
   */
  it("climbs the ladder on CHARGEABLE weight, so a bulky consignment reaches a heavy band", () => {
    const bands = [
      band({ id: "b0", minBillableWeightGrams: 0, position: 0, unitPriceInCents: 400 }),
      band({ id: "b500", minBillableWeightGrams: 500_000, position: 1, unitPriceInCents: 120 }),
    ];

    // 20 kg gross would sit in `b0`; 3 tonnes chargeable reaches `b500`.
    expect(selectRateBreak(bands, { chargeableWeightGrams: 3_000_000, volumeCubicCm: 3_000_000 })).toEqual({
      status: "selected",
      selected: expect.objectContaining({ id: "b500" }),
    });
    expect(selectRateBreak(bands, { chargeableWeightGrams: 20_000, volumeCubicCm: 3_000_000 })).toEqual({
      status: "selected",
      selected: expect.objectContaining({ id: "b0" }),
    });
  });

  it("treats a band's floor as inclusive", () => {
    const selection = selectRateBreak(
      [
        band({ id: "b0", minBillableWeightGrams: 0, position: 0 }),
        band({ id: "b45", minBillableWeightGrams: 45_000, position: 1 }),
      ],
      { chargeableWeightGrams: 45_000, volumeCubicCm: 200_000 },
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
      { chargeableWeightGrams: 50_000, volumeCubicCm: 200_000 },
    );

    expect(selection).toEqual({ status: "selected", selected: expect.objectContaining({ id: "b45" }) });
  });

  it("reports below_smallest_break rather than falling back to a minimum charge", () => {
    const selection = selectRateBreak(
      [band({ id: "b45", minBillableWeightGrams: 45_000, minimumChargeInCents: 15_000 })],
      { chargeableWeightGrams: 5_000, volumeCubicCm: 10_000 },
    );

    expect(selection).toEqual({
      status: "below_smallest_break",
      smallestMinBillableWeightGrams: 45_000,
      smallestMinVolumeCubicCm: 0,
    });
  });

  it("reports a card with no bands", () => {
    expect(selectRateBreak([], { chargeableWeightGrams: 50_000, volumeCubicCm: 200_000 })).toEqual({
      status: "card_has_no_breaks",
    });
  });

  /**
   * The band's volume floor is NOT the volumetric divisor. The divisor turns volume into weight
   * for the whole card; this floor restricts one band to bulky consignments.
   */
  it("requires BOTH floors to be cleared", () => {
    const selection = selectRateBreak(
      [
        band({ id: "b0", minBillableWeightGrams: 0, minVolumeCubicCm: 0, position: 0 }),
        band({
          id: "bbulky",
          minBillableWeightGrams: 10_000,
          minVolumeCubicCm: 5_000_000,
          position: 1,
        }),
      ],
      // Heavy enough for the second band, nowhere near bulky enough.
      { chargeableWeightGrams: 50_000, volumeCubicCm: 200_000 },
    );

    expect(selection).toEqual({ status: "selected", selected: expect.objectContaining({ id: "b0" }) });
  });
});

describe("priceRatedBreak", () => {
  it("charges per kilogram of chargeable weight", () => {
    expect(BILLABLE_WEIGHT_UNIT_GRAMS).toBe(1000);
    expect(priceRatedBreak(band({ id: "b", minBillableWeightGrams: 0, unitPriceInCents: 400 }), 50_000)).toBe(20_000);
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

describe("rateCard", () => {
  /**
   * End to end, and the number that moved: 20 kg of cushions in 3 m³ at 400 cents/kg was
   * 8,000 cents before this change and is 1,200,000 cents after it. That difference IS the bug.
   */
  it("prices a bulky consignment on its volumetric weight", () => {
    const rated = rateCard(
      card({ id: "rc_sea", volumetricDivisorCm3PerKg: OCEAN_DIVISOR }),
      consignment({ billableWeightGrams: 20_000, volumeCubicCm: 3 * ONE_CUBIC_METRE_CM3 }),
    );

    expect(rated).toEqual({
      status: "priced",
      option: expect.objectContaining({
        chargeableWeightGrams: 3_000_000,
        chargeableWeightBasis: "volumetric",
        providerQuote: expect.objectContaining({ priceInCents: 1_200_000 }),
      }),
    });
  });

  it("refuses to price a consignment whose volume was never declared", () => {
    const rated = rateCard(
      card({ id: "rc_sea" }),
      consignment({ volumeCubicCm: null, hasIncompletePackageData: true }),
    );

    expect(rated).toEqual({ status: "unpriceable", reason: "volume_not_declared" });
  });

  it("keeps an undeclared weight reported as its own reason", () => {
    const rated = rateCard(
      card({ id: "rc_sea" }),
      consignment({ billableWeightGrams: null, hasIncompletePackageData: true }),
    );

    expect(rated).toEqual({ status: "unpriceable", reason: "consignment_not_measurable" });
  });
});

describe("rateLaneFromCards", () => {
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
    expect(lane.options.map((option) => option.providerQuote.sourceForwarderName).toSorted()).toEqual([
      "Blue Anchor Logistics",
      "Harbour Line",
    ]);
  });

  it("prices two forwarders differently when their divisors differ", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [
        card({ id: "rc_generous", volumetricDivisorCm3PerKg: 6000 }),
        card({ id: "rc_strict", volumetricDivisorCm3PerKg: 1000 }),
      ],
      consignment: consignment({
        billableWeightGrams: 20_000,
        volumeCubicCm: ONE_CUBIC_METRE_CM3,
      }),
    });

    const prices = lane.options
      .map((option) => option.providerQuote.priceInCents)
      .toSorted((left, right) => left - right);
    // 166_667 g and 1_000_000 g at 400 cents/kg.
    expect(prices).toEqual([66_667, 400_000]);
  });

  it("orders options by mode, then price, then card id", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [card({ id: "rc_sea", mode: "sea" }), card({ id: "rc_air", mode: "air" })],
      consignment: consignment(),
    });

    expect(lane.options.map((option) => option.mode)).toEqual(["air", "sea"]);
  });

  it("carries provenance, expiry and the chargeable basis on every option, per §19.6", () => {
    const validUntil = new Date("2026-12-31T00:00:00.000Z");
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [card({ id: "rc_a", validUntil })],
      consignment: consignment(),
    });

    expect(lane.options[0]).toEqual(
      expect.objectContaining({
        rateCardId: "rc_a",
        chargeableWeightBasis: expect.any(String),
        chargeableWeightGrams: expect.any(Number),
        providerQuote: expect.objectContaining({
          sourceForwarderName: "Blue Anchor Logistics",
          providerOrganizationId: "org_forwarder",
          validUntil,
          currency: "USD",
          subjectToRemeasurement: true,
        }),
      }),
    );

    // The price is NOT readable without the provider — that is the whole mechanism.
    expect(lane.options[0]).not.toHaveProperty("priceInCents");
  });

  it("reports reasons only when they explain an absence", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [card({ id: "rc_ok" }), card({ id: "rc_empty", breaks: [] })],
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
        card({ id: "rc_heavy", breaks: [band({ id: "bh", minBillableWeightGrams: 999_000_000 })] }),
      ],
      consignment: consignment({ billableWeightGrams: 5_000, volumeCubicCm: 10_000 }),
    });

    expect(lane.options).toEqual([]);
    expect(lane.unavailableReasons).toEqual(["below_smallest_break", "card_has_no_breaks"]);
  });

  it("names volume_not_declared when the whole lane is unrateable for want of dimensions", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [card({ id: "rc_a" })],
      consignment: consignment({ volumeCubicCm: null, hasIncompletePackageData: true }),
    });

    expect(lane.options).toEqual([]);
    expect(lane.unavailableReasons).toEqual(["volume_not_declared"]);
  });

  /**
   * THE MARKETPLACE FALLBACK. An unrateable lane must not be a dead end — the buyer is owed
   * somewhere to go, and Qatoto's answer is the forwarders who sell that lane.
   */
  it("names the quotable forwarders even when nothing could be priced", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [
        card({ id: "rc_sea", sourceForwarderName: "Blue Anchor Logistics" }),
        card({ id: "rc_air", mode: "air", sourceForwarderName: "Harbour Line" }),
      ],
      consignment: consignment({ volumeCubicCm: null, hasIncompletePackageData: true }),
    });

    expect(lane.options).toEqual([]);
    expect(lane.quotableProviders).toEqual([
      { providerOrganizationId: "org_forwarder", sourceForwarderName: "Harbour Line", mode: "air" },
      {
        providerOrganizationId: "org_forwarder",
        sourceForwarderName: "Blue Anchor Logistics",
        mode: "sea",
      },
    ]);
  });

  it("reports no quotable forwarder for a lane nobody sells", () => {
    const lane = rateLaneFromCards({
      originCountryCode: "IN",
      destinationCountryCode: "DE",
      cards: [],
      consignment: consignment(),
    });

    expect(lane.quotableProviders).toEqual([]);
    expect(lane.unavailableReasons).toEqual(["no_active_rate_card"]);
  });
});
