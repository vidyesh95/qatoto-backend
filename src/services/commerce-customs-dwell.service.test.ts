import { describe, expect, it, vi } from "vitest";

// A domestic lane must resolve with NO query at all, so `db` is a bare object: any attempt to
// touch it in that path would throw and fail the test, which is the assertion.
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));

const { resolveCustomsDwell, selectMostSpecificDwellEstimate } = await import(
  "#src/services/commerce-customs-dwell.service.js"
);

type DwellRow = Parameters<typeof selectMostSpecificDwellEstimate>[0][number];

function row(overrides: Partial<DwellRow> & Pick<DwellRow, "id">): DwellRow {
  return {
    originCountryCode: null,
    commodityScopeCategoryId: null,
    clearanceDaysMin: 3,
    clearanceDaysMax: 10,
    source: "Broker circular",
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validUntil: null,
    ...overrides,
  };
}

describe("resolveCustomsDwell", () => {
  const asOf = new Date("2026-08-10T00:00:00.000Z");

  it("short-circuits a domestic lane to not_applicable without querying", async () => {
    const resolution = await resolveCustomsDwell({
      originCountryCode: "IN",
      destinationCountryCode: "IN",
      commodityCategoryIds: [],
      asOf,
    });

    expect(resolution).toEqual({ status: "not_applicable", reason: "domestic_lane" });
  });

  it("reports unknown rather than not_applicable when the origin is unresolved", async () => {
    const resolution = await resolveCustomsDwell({
      originCountryCode: null,
      destinationCountryCode: "DE",
      commodityCategoryIds: [],
      asOf,
    });

    // Without an origin the lane cannot be classified, and "not applicable" would erase a real
    // clearance while "0 days" would invent one.
    expect(resolution).toEqual({ status: "unknown", reason: "no_dwell_estimate_for_lane" });
  });
});

describe("selectMostSpecificDwellEstimate", () => {
  const lane = { originCountryCode: "IN", commodityCategoryIds: ["cat_electronics"] };

  it("prefers an origin-scoped row over the any-origin catch-all", () => {
    const matched = selectMostSpecificDwellEstimate(
      [row({ id: "any" }), row({ id: "origin", originCountryCode: "IN" })],
      lane,
    );

    expect(matched?.id).toBe("origin");
  });

  it("prefers origin-and-commodity over origin alone", () => {
    const matched = selectMostSpecificDwellEstimate(
      [
        row({ id: "origin", originCountryCode: "IN" }),
        row({
          id: "both",
          originCountryCode: "IN",
          commodityScopeCategoryId: "cat_electronics",
        }),
      ],
      lane,
    );

    expect(matched?.id).toBe("both");
  });

  it("prefers a commodity-scoped row over the catch-all", () => {
    const matched = selectMostSpecificDwellEstimate(
      [row({ id: "any" }), row({ id: "commodity", commodityScopeCategoryId: "cat_electronics" })],
      lane,
    );

    expect(matched?.id).toBe("commodity");
  });

  it("does not match a row scoped to a DIFFERENT commodity", () => {
    const matched = selectMostSpecificDwellEstimate(
      [row({ id: "textiles", commodityScopeCategoryId: "cat_textiles" })],
      lane,
    );

    expect(matched).toBeNull();
  });

  it("does not walk category ancestors", () => {
    // `cat_electronics` is a child of `cat_industrial` in the taxonomy; the parent-scoped row
    // must NOT be applied to the child's consignment.
    const matched = selectMostSpecificDwellEstimate(
      [row({ id: "parent", commodityScopeCategoryId: "cat_industrial" })],
      lane,
    );

    expect(matched).toBeNull();
  });

  it("falls back to the any-commodity row when an order spans categories", () => {
    const matched = selectMostSpecificDwellEstimate(
      [
        row({ id: "any" }),
        row({ id: "electronics", commodityScopeCategoryId: "cat_electronics" }),
      ],
      { originCountryCode: "IN", commodityCategoryIds: ["cat_electronics", "cat_textiles"] },
    );

    // One line of electronics must not pull its dwell figure onto a mixed consignment.
    expect(matched?.id).toBe("any");
  });

  it("breaks a tie by latest validFrom, then id, so the answer never flaps", () => {
    const matched = selectMostSpecificDwellEstimate(
      [
        row({ id: "older", originCountryCode: "IN", validFrom: new Date("2026-01-01T00:00:00.000Z") }),
        row({ id: "newer", originCountryCode: "IN", validFrom: new Date("2026-06-01T00:00:00.000Z") }),
      ],
      lane,
    );

    expect(matched?.id).toBe("newer");
  });

  it("returns null when nothing covers the lane", () => {
    expect(selectMostSpecificDwellEstimate([], lane)).toBeNull();
  });
});
