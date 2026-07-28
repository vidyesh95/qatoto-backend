import type { marketInsight } from "#src/db/schema.js";

/**
 * The three `market_insight` stat CHECKs, stated once in TypeScript
 * (R_AND_D_BACKEND_STRUCTURE.md §6, §11j.4).
 *
 * WHY THIS MODULE EXISTS. `src/lib/pg-errors.ts` deliberately refuses to expose an
 * `isCheckViolation` helper, so a 23514 reaching Postgres surfaces as an unhandled 500 with
 * no domain answer — the caller is told nothing about which rule they broke. The stat quad
 * is governed by three cross-field constraints, so the invariant has to be proven BEFORE
 * the insert. Stating it here once, and having both the Zod schema and the service consume
 * it, is what stops the schema and the database drifting into disagreement.
 *
 * The three clauses map 1:1 onto the named constraints in `schema.ts`, and the mapping is
 * the point — a reviewer can diff them:
 *
 *   `market_insight_stat_unit_pairing_ck`   → "unit_pairing"
 *   `market_insight_stat_range_ck`          → "value_range"
 *   `market_insight_trend_agreement_ck`     → "trend_agreement"
 *
 * WHY MILLI-UNITS. `statValueMilli` is thousandths, so 34.5% is `34_500` and no float ever
 * touches a stored figure (§4b). The frontend's `"+34%"` string is a RENDERING of
 * (kind, value, unit, direction), never a stored value — which is why the arrow and the
 * sign cannot disagree here but could in the mock.
 */

export type MarketInsightStatKind = (typeof marketInsight.$inferSelect)["statKind"];
export type MarketInsightStatUnitKey = (typeof marketInsight.$inferSelect)["statUnitKey"];
export type MarketInsightTrendDirection = (typeof marketInsight.$inferSelect)["trendDirection"];

export interface MarketInsightStat {
  readonly statKind: MarketInsightStatKind;
  readonly statValueMilli: number;
  readonly statUnitKey: MarketInsightStatUnitKey;
  readonly trendDirection: MarketInsightTrendDirection;
}

/** `abs(stat_value_milli) <= 9000000000000000`, from `market_insight_stat_range_ck`. */
export const MARKET_INSIGHT_STAT_MAX_MILLI = 9_000_000_000_000_000;

/** `percent_level` is bounded to 0–100% inclusive, i.e. 0–100000 milli-percent. */
export const MARKET_INSIGHT_PERCENT_LEVEL_MAX_MILLI = 100_000;

/** The unit keys an `absolute_count` may carry — everything except the two reserved ones. */
export const ABSOLUTE_COUNT_UNIT_KEYS = [
  "people",
  "households",
  "tonnes",
  "litres",
  "hectares",
  "usd_dollars",
  "count",
] as const;

export type StatViolation = "unit_pairing" | "value_range" | "trend_agreement";

/**
 * Every CHECK the stat quad would violate. An empty array means the row would insert.
 *
 * Returns ALL violations rather than the first, so a 422 can name every problem at once
 * instead of making a client fix them one round trip at a time.
 */
export function findStatViolations(stat: MarketInsightStat): readonly StatViolation[] {
  const violations: StatViolation[] = [];

  // market_insight_stat_unit_pairing_ck — without it a `multiplier` insight can carry
  // unit `people` and render "3 people" where "3× coverage" was meant.
  const unitPairs =
    (stat.statKind === "percent_change" || stat.statKind === "percent_level"
      ? stat.statUnitKey === "percent"
      : false) ||
    (stat.statKind === "multiplier" ? stat.statUnitKey === "multiple" : false) ||
    (stat.statKind === "absolute_count"
      ? stat.statUnitKey !== "percent" && stat.statUnitKey !== "multiple"
      : false);

  if (!unitPairs) {
    violations.push("unit_pairing");
  }

  // market_insight_stat_range_ck. Only `percent_change` may be negative — a count of
  // households or a multiplier below zero is not a figure, it is a bug upstream.
  const withinRange =
    (stat.statKind === "percent_change" || stat.statValueMilli >= 0) &&
    (stat.statKind !== "multiplier" || stat.statValueMilli > 0) &&
    (stat.statKind !== "percent_level" ||
      (stat.statValueMilli >= 0 &&
        stat.statValueMilli <= MARKET_INSIGHT_PERCENT_LEVEL_MAX_MILLI)) &&
    Math.abs(stat.statValueMilli) <= MARKET_INSIGHT_STAT_MAX_MILLI &&
    Number.isInteger(stat.statValueMilli);

  if (!withinRange) {
    violations.push("value_range");
  }

  // market_insight_trend_agreement_ck — the arrow cannot contradict the sign, so "+34%"
  // can never render with a down chevron. Applies to `percent_change` alone: a count's
  // direction is editorial (is 4,000 wells "up"?) and the database does not adjudicate it.
  const trendAgrees =
    stat.statKind !== "percent_change" ||
    (stat.trendDirection === "up" && stat.statValueMilli > 0) ||
    (stat.trendDirection === "down" && stat.statValueMilli < 0) ||
    (stat.trendDirection === "flat" && stat.statValueMilli === 0);

  if (!trendAgrees) {
    violations.push("trend_agreement");
  }

  return violations;
}
