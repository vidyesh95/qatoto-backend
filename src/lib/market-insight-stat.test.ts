import { describe, expect, it } from "vitest";

import {
  findStatViolations,
  MARKET_INSIGHT_PERCENT_LEVEL_MAX_MILLI,
  MARKET_INSIGHT_STAT_MAX_MILLI,
  type MarketInsightStat,
} from "#src/lib/market-insight-stat.js";

/**
 * The predicate that has to agree with three CHECK constraints it cannot see.
 *
 * WHY THESE ASSERTIONS ARE WORTH THE LINES. This module is the ONLY thing standing between
 * a hostile stat quad and an unhandled 23514 — `pg-errors.ts` deliberately provides no
 * `isCheckViolation`, so a constraint reached at runtime is a 500 with no domain answer. If
 * this predicate is laxer than Postgres, the 500 comes back; if it is stricter, valid
 * editorial figures are rejected with no way to publish them. Each case below is written
 * against the SQL in `schema.ts`, not against the implementation.
 */

const validPercentChange: MarketInsightStat = {
  statKind: "percent_change",
  statValueMilli: 34_000,
  statUnitKey: "percent",
  trendDirection: "up",
};

describe("market_insight_stat_unit_pairing_ck", () => {
  it("pairs each percent kind with the percent unit", () => {
    expect(findStatViolations(validPercentChange)).toEqual([]);
    expect(
      findStatViolations({
        statKind: "percent_level",
        statValueMilli: 62_000,
        statUnitKey: "percent",
        trendDirection: "flat",
      }),
    ).toEqual([]);
  });

  it("refuses a multiplier carrying a count unit, so 3x never renders as 3 people", () => {
    expect(
      findStatViolations({
        statKind: "multiplier",
        statValueMilli: 3_000,
        statUnitKey: "people",
        trendDirection: "up",
      }),
    ).toContain("unit_pairing");
  });

  it("refuses an absolute_count carrying percent or multiple", () => {
    for (const statUnitKey of ["percent", "multiple"] as const) {
      expect(
        findStatViolations({
          statKind: "absolute_count",
          statValueMilli: 4_000_000,
          statUnitKey,
          trendDirection: "up",
        }),
      ).toContain("unit_pairing");
    }
  });

  it("accepts every legitimate absolute_count unit", () => {
    for (const statUnitKey of [
      "people",
      "households",
      "tonnes",
      "litres",
      "hectares",
      "usd_dollars",
      "count",
    ] as const) {
      expect(
        findStatViolations({
          statKind: "absolute_count",
          statValueMilli: 4_000_000,
          statUnitKey,
          trendDirection: "up",
        }),
      ).toEqual([]);
    }
  });
});

describe("market_insight_stat_range_ck", () => {
  it("lets ONLY percent_change go negative", () => {
    expect(
      findStatViolations({
        ...validPercentChange,
        statValueMilli: -22_000,
        trendDirection: "down",
      }),
    ).toEqual([]);

    expect(
      findStatViolations({
        statKind: "absolute_count",
        statValueMilli: -1,
        statUnitKey: "people",
        trendDirection: "down",
      }),
    ).toContain("value_range");
  });

  it("requires a multiplier to be strictly positive — 0x is not a figure", () => {
    expect(
      findStatViolations({
        statKind: "multiplier",
        statValueMilli: 0,
        statUnitKey: "multiple",
        trendDirection: "flat",
      }),
    ).toContain("value_range");
  });

  it("bounds percent_level to 0..100%, inclusive at both ends", () => {
    const atBound: MarketInsightStat = {
      statKind: "percent_level",
      statValueMilli: MARKET_INSIGHT_PERCENT_LEVEL_MAX_MILLI,
      statUnitKey: "percent",
      trendDirection: "flat",
    };
    expect(findStatViolations(atBound)).toEqual([]);
    expect(findStatViolations({ ...atBound, statValueMilli: 0 })).toEqual([]);
    expect(
      findStatViolations({
        ...atBound,
        statValueMilli: MARKET_INSIGHT_PERCENT_LEVEL_MAX_MILLI + 1,
      }),
    ).toContain("value_range");
  });

  it("enforces the absolute magnitude ceiling at the boundary", () => {
    expect(
      findStatViolations({
        statKind: "absolute_count",
        statValueMilli: MARKET_INSIGHT_STAT_MAX_MILLI,
        statUnitKey: "count",
        trendDirection: "up",
      }),
    ).toEqual([]);
    expect(
      findStatViolations({
        statKind: "absolute_count",
        statValueMilli: MARKET_INSIGHT_STAT_MAX_MILLI + 1,
        statUnitKey: "count",
        trendDirection: "up",
      }),
    ).toContain("value_range");
  });

  /** The column is `bigint`; a fractional milli-unit is a unit error upstream. */
  it("refuses a non-integer, which the column type would reject anyway", () => {
    expect(findStatViolations({ ...validPercentChange, statValueMilli: 34_000.5 })).toContain("value_range");
  });
});

describe("market_insight_trend_agreement_ck", () => {
  it("refuses an arrow that contradicts the sign — the mock's actual bug", () => {
    expect(findStatViolations({ ...validPercentChange, statValueMilli: -22_000, trendDirection: "up" })).toContain(
      "trend_agreement",
    );
    expect(findStatViolations({ ...validPercentChange, statValueMilli: 34_000, trendDirection: "down" })).toContain(
      "trend_agreement",
    );
    expect(findStatViolations({ ...validPercentChange, statValueMilli: 34_000, trendDirection: "flat" })).toContain(
      "trend_agreement",
    );
  });

  it("requires exactly zero for flat", () => {
    expect(findStatViolations({ ...validPercentChange, statValueMilli: 0, trendDirection: "flat" })).toEqual([]);
  });

  /**
   * Direction on a COUNT is editorial — is 4,000 wells "up"? — and the constraint scopes
   * itself to percent_change precisely so the database does not adjudicate that.
   */
  it("does not constrain direction on any other kind", () => {
    for (const trendDirection of ["up", "down", "flat"] as const) {
      expect(
        findStatViolations({
          statKind: "absolute_count",
          statValueMilli: 4_000_000,
          statUnitKey: "people",
          trendDirection,
        }),
      ).toEqual([]);
    }
  });
});

describe("findStatViolations", () => {
  it("reports EVERY broken rule at once, not just the first", () => {
    // A multiplier with a count unit (pairing), at zero (range), is two violations.
    expect(
      findStatViolations({
        statKind: "multiplier",
        statValueMilli: 0,
        statUnitKey: "people",
        trendDirection: "flat",
      }),
    ).toEqual(["unit_pairing", "value_range"]);
  });
});
