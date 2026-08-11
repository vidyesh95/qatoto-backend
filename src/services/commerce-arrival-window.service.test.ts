import { describe, expect, it, vi } from "vitest";

vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));

const { composeArrivalWindow, projectFreight, projectManufacturing } =
  await import("#src/services/commerce-arrival-window.service.js");

const ORDER_PLACED_AT = new Date("2026-01-01T00:00:00.000Z");
const PROMISED_DELIVERY_AT = new Date("2026-01-26T00:00:00.000Z"); // 25 days later
const CONFIRMED_AT = new Date("2026-01-03T00:00:00.000Z");

const KNOWN_MANUFACTURING = {
  status: "known",
  daysMin: 15,
  daysMax: 25,
  endsAt: PROMISED_DELIVERY_AT,
  basis: "declared_range",
} as const;

const KNOWN_FREIGHT = {
  status: "known",
  daysMin: 24,
  daysMax: 34,
  mode: "sea",
  priceInCents: 210_000,
  currency: "USD",
  validUntil: null,
  legSelections: [],
} as const;

const KNOWN_CUSTOMS = {
  status: "known",
  estimateId: "dwell_1",
  clearanceDaysMin: 3,
  clearanceDaysMax: 10,
  source: "Broker circular",
  validUntil: null,
  scope: "any",
} as const;

describe("composeArrivalWindow", () => {
  it("closes the window when every component resolves", () => {
    const composed = composeArrivalWindow({
      clockStartAt: CONFIRMED_AT,
      manufacturing: KNOWN_MANUFACTURING,
      freight: KNOWN_FREIGHT,
      customs: KNOWN_CUSTOMS,
    });

    expect(composed.missingComponents).toEqual([]);
    // Anchored on promisedDeliveryAt: +27 days min, +44 days max.
    expect(composed.arrivalWindow?.fromDate).toEqual(new Date("2026-02-22T00:00:00.000Z"));
    expect(composed.arrivalWindow?.toDate).toEqual(new Date("2026-03-11T00:00:00.000Z"));
  });

  it("closes the window on a DOMESTIC lane, with customs absent and nothing missing", () => {
    const composed = composeArrivalWindow({
      clockStartAt: CONFIRMED_AT,
      manufacturing: KNOWN_MANUFACTURING,
      freight: KNOWN_FREIGHT,
      customs: { status: "not_applicable", reason: "domestic_lane" },
    });

    // "Not applicable" is a RESOLVED component. The window closes and nothing is named.
    expect(composed.missingComponents).toEqual([]);
    expect(composed.arrivalWindow).not.toBeNull();
    expect(composed.arrivalWindow?.fromDate).toEqual(new Date("2026-02-19T00:00:00.000Z"));
  });

  it("leaves the window open and NAMES customs when the dwell figure is unknown", () => {
    const composed = composeArrivalWindow({
      clockStartAt: CONFIRMED_AT,
      manufacturing: KNOWN_MANUFACTURING,
      freight: KNOWN_FREIGHT,
      customs: { status: "unknown", reason: "no_dwell_estimate_for_lane" },
    });

    // The §19.4 two-facts case: this must be distinguishable from the domestic case above.
    expect(composed.arrivalWindow).toBeNull();
    expect(composed.missingComponents).toEqual(["customs"]);
  });

  it("leaves the window open when no mode has been selected", () => {
    const composed = composeArrivalWindow({
      clockStartAt: CONFIRMED_AT,
      manufacturing: KNOWN_MANUFACTURING,
      freight: { status: "unknown", reason: "mode_not_selected", availableModes: ["air", "sea"] },
      customs: KNOWN_CUSTOMS,
    });

    expect(composed.arrivalWindow).toBeNull();
    expect(composed.missingComponents).toEqual(["freight"]);
  });

  it("names manufacturing rather than returning an unnamed absence", () => {
    const composed = composeArrivalWindow({
      clockStartAt: CONFIRMED_AT,
      manufacturing: { status: "unknown", reason: "no_seller_declared_lead_time" },
      freight: KNOWN_FREIGHT,
      customs: KNOWN_CUSTOMS,
    });

    expect(composed.arrivalWindow).toBeNull();
    expect(composed.missingComponents).toEqual(["manufacturing"]);
  });

  it("emits no window before the order is confirmed", () => {
    const composed = composeArrivalWindow({
      clockStartAt: null,
      manufacturing: KNOWN_MANUFACTURING,
      freight: KNOWN_FREIGHT,
      customs: KNOWN_CUSTOMS,
    });

    // No clock start, no calendar — and nothing is MISSING, so nothing is named.
    expect(composed.arrivalWindow).toBeNull();
    expect(composed.missingComponents).toEqual([]);
  });

  it("does not move when confirmedAt moves — the anchor is promisedDeliveryAt", () => {
    const early = composeArrivalWindow({
      clockStartAt: CONFIRMED_AT,
      manufacturing: KNOWN_MANUFACTURING,
      freight: KNOWN_FREIGHT,
      customs: KNOWN_CUSTOMS,
    });
    const late = composeArrivalWindow({
      // Payment took three weeks longer. The manufacturing clock started at order creation and
      // did not wait for it, so the arrival window must be identical.
      clockStartAt: new Date("2026-01-24T00:00:00.000Z"),
      manufacturing: KNOWN_MANUFACTURING,
      freight: KNOWN_FREIGHT,
      customs: KNOWN_CUSTOMS,
    });

    expect(late.arrivalWindow).toEqual(early.arrivalWindow);
  });

  it("emits no window for an order carrying no physical goods", () => {
    const composed = composeArrivalWindow({
      clockStartAt: CONFIRMED_AT,
      manufacturing: { status: "not_applicable", reason: "no_physical_goods_on_order" },
      freight: { status: "not_applicable", reason: "no_physical_goods_on_order" },
      customs: { status: "not_applicable", reason: "no_physical_goods_on_order" },
    });

    expect(composed.arrivalWindow).toBeNull();
    expect(composed.missingComponents).toEqual([]);
  });
});

describe("projectManufacturing", () => {
  it("recovers daysMax from promisedDeliveryAt minus createdAt, losslessly", () => {
    const manufacturing = projectManufacturing({
      hasPhysicalGoods: true,
      orderPlacedAt: ORDER_PLACED_AT,
      promisedDeliveryAt: PROMISED_DELIVERY_AT,
      leadTimeMinDaysSnapshots: [15],
    });

    expect(manufacturing).toEqual(
      expect.objectContaining({ status: "known", daysMax: 25, daysMin: 15, basis: "declared_range" }),
    );
  });

  it("reports daysMin null on a pre-Phase-20 order rather than inventing one", () => {
    const manufacturing = projectManufacturing({
      hasPhysicalGoods: true,
      orderPlacedAt: ORDER_PLACED_AT,
      promisedDeliveryAt: PROMISED_DELIVERY_AT,
      leadTimeMinDaysSnapshots: [null],
    });

    expect(manufacturing).toEqual(
      expect.objectContaining({ daysMin: null, daysMax: 25, basis: "declared_maximum_only" }),
    );
  });

  it("takes the MAXIMUM of the line minimums — an order waits on its slowest line", () => {
    const manufacturing = projectManufacturing({
      hasPhysicalGoods: true,
      orderPlacedAt: ORDER_PLACED_AT,
      promisedDeliveryAt: PROMISED_DELIVERY_AT,
      leadTimeMinDaysSnapshots: [5, 15, 9],
    });

    expect(manufacturing).toEqual(expect.objectContaining({ daysMin: 15 }));
  });

  it("makes the whole order's minimum unknown when ONE line declared none", () => {
    const manufacturing = projectManufacturing({
      hasPhysicalGoods: true,
      orderPlacedAt: ORDER_PLACED_AT,
      promisedDeliveryAt: PROMISED_DELIVERY_AT,
      leadTimeMinDaysSnapshots: [15, null],
    });

    // Taking the max of what happens to be present would publish a floor that ignores the very
    // line most likely to be late.
    expect(manufacturing).toEqual(expect.objectContaining({ daysMin: null }));
  });

  it("reports unknown when no lead time was ever declared", () => {
    expect(
      projectManufacturing({
        hasPhysicalGoods: true,
        orderPlacedAt: ORDER_PLACED_AT,
        promisedDeliveryAt: null,
        leadTimeMinDaysSnapshots: [],
      }),
    ).toEqual({ status: "unknown", reason: "no_seller_declared_lead_time" });
  });

  it("reports not_applicable for a service-only order", () => {
    expect(
      projectManufacturing({
        hasPhysicalGoods: false,
        orderPlacedAt: ORDER_PLACED_AT,
        promisedDeliveryAt: null,
        leadTimeMinDaysSnapshots: [],
      }),
    ).toEqual({ status: "not_applicable", reason: "no_physical_goods_on_order" });
  });
});

type LanePlan = NonNullable<Parameters<typeof projectFreight>[0]["lanePlan"]>;
type Journey = LanePlan["journeys"][number];

function lanePlan(journeys: readonly Journey[], unpriceableReasons: LanePlan["unpriceableReasons"] = []): LanePlan {
  return {
    contracting: { party: "provider" },
    origin: { countryCode: "IN", locality: null },
    destination: { countryCode: "DE", locality: null },
    consignment: {
      billableWeightGrams: 50_000,
      volumeCubicCm: 200_000,
      packageCount: 4,
      hasIncompletePackageData: false,
    },
    legs: [],
    journeys,
    unpriceableReasons,
    quotableProviders: [],
  };
}

describe("projectFreight", () => {
  const seaJourney: Journey = {
    currency: "USD",
    primaryMode: "sea",
    totalInCents: 210_000,
    transitDaysMin: 26,
    transitDaysMax: 38,
    validUntil: null,
    legSelections: [],
  };
  const airJourney: Journey = {
    ...seaJourney,
    primaryMode: "air",
    totalInCents: 960_000,
    transitDaysMin: 6,
    transitDaysMax: 12,
  };

  it("lists the covered modes and selects none when no mode was requested", () => {
    const freight = projectFreight({
      hasPhysicalGoods: true,
      lanePlan: lanePlan([seaJourney, airJourney]),
      requestedMode: undefined,
    });

    expect(freight).toEqual({
      status: "unknown",
      reason: "mode_not_selected",
      availableModes: ["air", "sea"],
    });
  });

  it("never auto-selects the cheapest mode", () => {
    const freight = projectFreight({
      hasPhysicalGoods: true,
      // Sea is far cheaper and far slower; a cheapest-wins rule would publish its window.
      lanePlan: lanePlan([seaJourney, airJourney]),
      requestedMode: undefined,
    });

    expect(freight.status).toBe("unknown");
  });

  it("rates the requested mode", () => {
    const freight = projectFreight({
      hasPhysicalGoods: true,
      lanePlan: lanePlan([seaJourney, airJourney]),
      requestedMode: "air",
    });

    expect(freight).toEqual(expect.objectContaining({ status: "known", mode: "air", daysMin: 6, daysMax: 12 }));
  });

  it("reports an uncovered mode with the covered ones listed, not a 404", () => {
    const freight = projectFreight({
      hasPhysicalGoods: true,
      lanePlan: lanePlan([seaJourney]),
      requestedMode: "rail",
    });

    expect(freight).toEqual({
      status: "unknown",
      reason: "mode_not_covered",
      availableModes: ["sea"],
    });
  });

  it("surfaces an uncovered leg as the reason, never as a cheaper journey", () => {
    const freight = projectFreight({
      hasPhysicalGoods: true,
      lanePlan: lanePlan([], [{ kind: "leg_uncovered", legSequence: 1, reasons: ["no_active_rate_card"] }]),
      requestedMode: "sea",
    });

    expect(freight).toEqual({
      status: "unknown",
      reason: "leg_uncovered",
      availableModes: [],
    });
  });

  it("reports an unresolved origin rather than an uncovered lane", () => {
    const freight = projectFreight({
      hasPhysicalGoods: true,
      lanePlan: null,
      requestedMode: "sea",
    });

    expect(freight).toEqual({
      status: "unknown",
      reason: "origin_country_unresolved",
      availableModes: [],
    });
  });
});
