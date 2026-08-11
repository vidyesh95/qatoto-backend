import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

const { buildSpecificationSnapshot, resolveUnitPriceInCents } = await import("#src/lib/commerce-pricing.js");

describe("resolveUnitPriceInCents", () => {
  it("uses the base price when no tiers exist", () => {
    const result = resolveUnitPriceInCents({
      basePriceInCents: 1000,
      quantity: 5,
      tiers: [],
    });

    expect(result).toEqual({
      unitPriceInCents: 1000,
      minimumOrderQuantity: 1,
      leadTimeDays: null,
    });
  });

  it("picks the highest eligible tier by minimum order quantity", () => {
    const result = resolveUnitPriceInCents({
      basePriceInCents: 1000,
      quantity: 500,
      tiers: [
        { unitPriceInCents: 900, minimumOrderQuantity: 100 },
        { unitPriceInCents: 800, minimumOrderQuantity: 250 },
        { unitPriceInCents: 700, minimumOrderQuantity: 500 },
      ],
    });

    expect(result).toEqual({
      unitPriceInCents: 700,
      minimumOrderQuantity: 100,
      leadTimeDays: null,
    });
  });

  it("falls back to the base price at the lowest MOQ when quantity is below every tier", () => {
    const result = resolveUnitPriceInCents({
      basePriceInCents: 1000,
      quantity: 10,
      tiers: [
        { unitPriceInCents: 900, minimumOrderQuantity: 100 },
        { unitPriceInCents: 800, minimumOrderQuantity: 250 },
      ],
    });

    expect(result).toEqual({
      unitPriceInCents: 1000,
      minimumOrderQuantity: 100,
      leadTimeDays: null,
    });
  });

  it("selects the tier whose MOQ exactly matches the requested quantity", () => {
    const result = resolveUnitPriceInCents({
      basePriceInCents: 1000,
      quantity: 250,
      tiers: [
        { unitPriceInCents: 900, minimumOrderQuantity: 100 },
        { unitPriceInCents: 800, minimumOrderQuantity: 250 },
      ],
    });

    expect(result).toEqual({
      unitPriceInCents: 800,
      minimumOrderQuantity: 100,
      leadTimeDays: null,
    });
  });

  /**
   * A27. The lead time comes from the tier the QUANTITY selected, not from an aggregate
   * over the ladder — 500 units ship on the 500-unit band's clock even though a shorter
   * one exists lower down. `min()` across the ladder is how the displayed MOQ is
   * computed elsewhere, and it would give the wrong answer here.
   */
  it("carries the selected tier's lead time, not the ladder's smallest", () => {
    const result = resolveUnitPriceInCents({
      basePriceInCents: 1000,
      quantity: 500,
      tiers: [
        { unitPriceInCents: 900, minimumOrderQuantity: 100, leadTimeDays: 15 },
        { unitPriceInCents: 800, minimumOrderQuantity: 250, leadTimeDays: 30 },
        { unitPriceInCents: 700, minimumOrderQuantity: 500, leadTimeDays: 60 },
      ],
    });

    expect(result).toEqual({
      unitPriceInCents: 700,
      minimumOrderQuantity: 100,
      leadTimeDays: 60,
    });
  });

  /** A band that declared none reports null, so the product's lead time can apply. */
  it("reports null when the selected tier declared no lead time", () => {
    const result = resolveUnitPriceInCents({
      basePriceInCents: 1000,
      quantity: 500,
      tiers: [
        { unitPriceInCents: 900, minimumOrderQuantity: 100, leadTimeDays: 15 },
        { unitPriceInCents: 700, minimumOrderQuantity: 500 },
      ],
    });

    expect(result).toEqual({
      unitPriceInCents: 700,
      minimumOrderQuantity: 100,
      leadTimeDays: null,
    });
  });

  /**
   * Below every tier there is no selected band at all, so there is no band lead time to
   * report — the fallback must not reach down and borrow one.
   */
  it("reports null when the quantity is below every tier", () => {
    const result = resolveUnitPriceInCents({
      basePriceInCents: 1000,
      quantity: 10,
      tiers: [{ unitPriceInCents: 900, minimumOrderQuantity: 100, leadTimeDays: 15 }],
    });

    expect(result).toEqual({
      unitPriceInCents: 1000,
      minimumOrderQuantity: 100,
      leadTimeDays: null,
    });
  });
});

describe("buildSpecificationSnapshot", () => {
  it("combines brand and description when both are present", () => {
    const snapshot = buildSpecificationSnapshot({
      brand: "Acme",
      description: "4-layer FR4 PCB",
    });

    expect(snapshot).toBe("Brand: Acme\n4-layer FR4 PCB");
  });

  it("uses only the description when brand is absent", () => {
    const snapshot = buildSpecificationSnapshot({ brand: null, description: "Steel widget" });

    expect(snapshot).toBe("Steel widget");
  });

  it("uses only the brand when description is absent", () => {
    const snapshot = buildSpecificationSnapshot({ brand: "Acme", description: null });

    expect(snapshot).toBe("Brand: Acme");
  });

  it("falls back to a generic snapshot when both are absent or blank", () => {
    expect(buildSpecificationSnapshot({ brand: null, description: null })).toBe("Product listing snapshot");
    expect(buildSpecificationSnapshot({ brand: "   ", description: "" })).toBe("Product listing snapshot");
  });

  it("truncates the combined snapshot at 10,000 characters", () => {
    const longDescription = "x".repeat(20_000);
    const snapshot = buildSpecificationSnapshot({ brand: null, description: longDescription });

    expect(snapshot.length).toBe(10_000);
  });
});
