import { describe, expect, it, vi } from "vitest";

vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));

const { composeJourneys, computeConsignmentMeasurement, planLegs } = await import(
  "#src/services/commerce-freight-journey.service.js"
);

type LegPlan = Parameters<typeof composeJourneys>[0][number];
type Option = LegPlan["options"][number];

function option(overrides: Partial<Option> & Pick<Option, "rateCardId">): Option {
  return {
    mode: "sea",
    priceInCents: 186_000,
    currency: "USD",
    transitDaysMin: 24,
    transitDaysMax: 34,
    rateBreakId: `${overrides.rateCardId}_b0`,
    sourceForwarderName: "Blue Anchor Logistics",
    validUntil: null,
    chargeableWeightGrams: 50_000,
    chargeableWeightBasis: "actual",
    ...overrides,
  };
}

function leg(overrides: Partial<LegPlan> & Pick<LegPlan, "sequence" | "kind">): LegPlan {
  return {
    originCountryCode: "IN",
    originLocality: null,
    destinationCountryCode: "DE",
    destinationLocality: null,
    options: [],
    unavailableReasons: [],
    ...overrides,
  };
}

describe("planLegs", () => {
  it("gives a domestic delivery exactly one leg", () => {
    const legs = planLegs({
      originCountryCode: "IN",
      originLocality: "Surat",
      destinationCountryCode: "IN",
      destinationLocality: "Pune",
    });

    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual(expect.objectContaining({ sequence: 0, kind: "domestic" }));
  });

  it("splits a cross-border delivery into an international then an inland leg", () => {
    const legs = planLegs({
      originCountryCode: "IN",
      originLocality: "Surat",
      destinationCountryCode: "DE",
      destinationLocality: "Hamburg",
    });

    expect(legs.map((entry) => [entry.sequence, entry.kind])).toEqual([
      [0, "international"],
      [1, "inland_destination"],
    ]);
    // The inland leg is a DOMESTIC lane in the destination country — that is what makes it
    // rateable at all, since cards are keyed by country pair.
    expect(legs[1]).toEqual(
      expect.objectContaining({ originCountryCode: "DE", destinationCountryCode: "DE" }),
    );
  });

  it("carries localities as labels only, on the ends where they are known", () => {
    const legs = planLegs({
      originCountryCode: "IN",
      originLocality: "Surat",
      destinationCountryCode: "DE",
      destinationLocality: "Hamburg",
    });

    expect(legs[0]?.originLocality).toBe("Surat");
    expect(legs[1]?.destinationLocality).toBe("Hamburg");
  });
});

describe("computeConsignmentMeasurement", () => {
  it("reports volume as null when no line declared all three dimensions", () => {
    const measurement = computeConsignmentMeasurement([
      {
        quantity: 10,
        unitsPerPackage: 5,
        packageGrossWeightGrams: 12_000,
        packageLengthMm: 400,
        packageWidthMm: 300,
        packageHeightMm: null,
      },
    ]);

    // Never 0: an undeclared box is not a flat one.
    expect(measurement.volumeCubicCm).toBeNull();
    expect(measurement.hasIncompletePackageData).toBe(true);
    expect(measurement.billableWeightGrams).toBe(24_000);
  });

  it("sums volume across packages when the geometry is complete", () => {
    const measurement = computeConsignmentMeasurement([
      {
        quantity: 10,
        unitsPerPackage: 5,
        packageGrossWeightGrams: 12_000,
        packageLengthMm: 400,
        packageWidthMm: 300,
        packageHeightMm: 200,
      },
    ]);

    // 2 packages x ceil(400*300*200 / 1000) cm³
    expect(measurement.volumeCubicCm).toBe(48_000);
    expect(measurement.hasIncompletePackageData).toBe(false);
  });
});

describe("composeJourneys", () => {
  it("empties journeys entirely when the inland leg is uncovered", () => {
    const composed = composeJourneys([
      leg({ sequence: 0, kind: "international", options: [option({ rateCardId: "rc_sea" })] }),
      leg({
        sequence: 1,
        kind: "inland_destination",
        originCountryCode: "DE",
        options: [],
        unavailableReasons: ["no_active_rate_card"],
      }),
    ]);

    // An uncovered leg makes the journey UNPRICEABLE, not cheaper — the international leg is
    // never priced alone.
    expect(composed.journeys).toEqual([]);
    expect(composed.unpriceableReasons).toEqual([
      { kind: "leg_uncovered", legSequence: 1, reasons: ["no_active_rate_card"] },
    ]);
  });

  it("sums the legs server-side and names the card behind each", () => {
    const composed = composeJourneys([
      leg({
        sequence: 0,
        kind: "international",
        options: [option({ rateCardId: "rc_sea", priceInCents: 186_000, transitDaysMin: 24, transitDaysMax: 34 })],
      }),
      leg({
        sequence: 1,
        kind: "inland_destination",
        originCountryCode: "DE",
        options: [
          option({
            rateCardId: "rc_inland",
            mode: "land",
            priceInCents: 24_000,
            transitDaysMin: 2,
            transitDaysMax: 4,
          }),
        ],
      }),
    ]);

    expect(composed.journeys).toHaveLength(1);
    expect(composed.journeys[0]).toEqual(
      expect.objectContaining({
        currency: "USD",
        primaryMode: "sea",
        totalInCents: 210_000,
        transitDaysMin: 26,
        transitDaysMax: 38,
      }),
    );
    expect(composed.journeys[0]?.legSelections.map((entry) => entry.rateCardId)).toEqual([
      "rc_sea",
      "rc_inland",
    ]);
  });

  it("emits one journey per international mode", () => {
    const composed = composeJourneys([
      leg({
        sequence: 0,
        kind: "international",
        options: [
          option({ rateCardId: "rc_sea", mode: "sea", priceInCents: 186_000 }),
          option({ rateCardId: "rc_air", mode: "air", priceInCents: 940_000, transitDaysMin: 4, transitDaysMax: 8 }),
        ],
      }),
      leg({
        sequence: 1,
        kind: "inland_destination",
        originCountryCode: "DE",
        options: [option({ rateCardId: "rc_inland", mode: "land", priceInCents: 24_000 })],
      }),
    ]);

    expect(composed.journeys.map((journey) => journey.primaryMode)).toEqual(["air", "sea"]);
  });

  it("never sums across currencies", () => {
    const composed = composeJourneys([
      leg({
        sequence: 0,
        kind: "international",
        options: [option({ rateCardId: "rc_sea", currency: "USD" })],
      }),
      leg({
        sequence: 1,
        kind: "inland_destination",
        originCountryCode: "DE",
        options: [option({ rateCardId: "rc_inland", mode: "land", currency: "EUR" })],
      }),
    ]);

    // Adding a USD leg to a EUR leg would invent an exchange rate.
    expect(composed.journeys).toEqual([]);
    expect(composed.unpriceableReasons).toEqual([{ kind: "no_common_currency_across_legs" }]);
  });

  it("carries a per-leg chargeable weight, because divisors belong to forwarders", () => {
    const composed = composeJourneys([
      leg({
        sequence: 0,
        kind: "international",
        options: [
          option({
            rateCardId: "rc_sea",
            // Ocean W/M: 1 m³ bills as 1000 kg.
            chargeableWeightGrams: 1_000_000,
            chargeableWeightBasis: "volumetric",
          }),
        ],
      }),
      leg({
        sequence: 1,
        kind: "inland_destination",
        originCountryCode: "DE",
        options: [
          option({
            rateCardId: "rc_inland",
            mode: "land",
            // A road divisor of 3000 turns the same 1 m³ into ~333 kg.
            chargeableWeightGrams: 333_334,
            chargeableWeightBasis: "volumetric",
          }),
        ],
      }),
    ]);

    // The SAME boxes, two legitimate weights. A single journey-level figure would make one of
    // the two leg prices read as an arithmetic error.
    expect(composed.journeys[0]?.legSelections.map((entry) => entry.chargeableWeightGrams)).toEqual([
      1_000_000, 333_334,
    ]);
  });

  it("expires a journey with its earliest card", () => {
    const early = new Date("2026-09-30T00:00:00.000Z");
    const late = new Date("2026-12-31T00:00:00.000Z");

    const composed = composeJourneys([
      leg({
        sequence: 0,
        kind: "international",
        options: [option({ rateCardId: "rc_sea", validUntil: late })],
      }),
      leg({
        sequence: 1,
        kind: "inland_destination",
        originCountryCode: "DE",
        options: [option({ rateCardId: "rc_inland", mode: "land", validUntil: early })],
      }),
    ]);

    expect(composed.journeys[0]?.validUntil).toEqual(early);
  });

  it("prices a domestic delivery as a single leg with no international mode", () => {
    const composed = composeJourneys([
      leg({
        sequence: 0,
        kind: "domestic",
        destinationCountryCode: "IN",
        options: [option({ rateCardId: "rc_land", mode: "land", priceInCents: 12_000 })],
      }),
    ]);

    expect(composed.journeys).toHaveLength(1);
    expect(composed.journeys[0]?.totalInCents).toBe(12_000);
  });
});
