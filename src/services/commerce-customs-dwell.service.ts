import { and, eq, gt, isNull, lte, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceCustomsDwellEstimate } from "#src/db/schema.js";

/**
 * How long a border holds a consignment (STORE_BACKEND_STRUCTURE.md §19.3).
 *
 * NOTHING MODELLED THIS BEFORE Phase 20. `customs_broker` exists as a provider kind and its
 * offerings carry lead times, but an offering's lead time is the BROKER's own turnaround, not
 * the PORT's, and reading one as the other would put a number on the wire that answers a
 * different question.
 *
 * THE THREE OUTCOMES ARE NOT INTERCHANGEABLE, and keeping them apart is the whole point:
 *   - `not_applicable` — a DOMESTIC lane has no customs leg. The component is ABSENT, the
 *     arrival window still closes, and nothing is missing.
 *   - `known` — a published figure covers this lane.
 *   - `unknown` — a cross-border lane with no figure. The window CANNOT close, and the
 *     component is named in `missingComponents`.
 *
 * Collapsing the first and the third into a bare `null` is the A11 mistake in a new place,
 * which is exactly what §19.4 warns against.
 */

/** Which narrowings the matched row actually used. On the wire so a client can see the fit. */
export type CustomsDwellScope =
  | "origin_and_commodity"
  | "origin_only"
  | "commodity_only"
  | "any";

export type CustomsDwellResolution =
  | { readonly status: "not_applicable"; readonly reason: "domestic_lane" }
  | {
      readonly status: "known";
      readonly estimateId: string;
      readonly clearanceDaysMin: number;
      readonly clearanceDaysMax: number;
      readonly source: string;
      readonly validUntil: Date | null;
      readonly scope: CustomsDwellScope;
    }
  | { readonly status: "unknown"; readonly reason: "no_dwell_estimate_for_lane" };

export interface CustomsDwellRow {
  readonly id: string;
  readonly originCountryCode: string | null;
  readonly commodityScopeCategoryId: string | null;
  readonly clearanceDaysMin: number;
  readonly clearanceDaysMax: number;
  readonly source: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
}

function scopeOf(row: CustomsDwellRow): CustomsDwellScope {
  if (row.originCountryCode !== null && row.commodityScopeCategoryId !== null) {
    return "origin_and_commodity";
  }
  if (row.originCountryCode !== null) {
    return "origin_only";
  }
  if (row.commodityScopeCategoryId !== null) {
    return "commodity_only";
  }
  return "any";
}

/**
 * PURE. Specificity precedence over the rows already filtered to the destination and window.
 *
 * THE SCORE: origin-scoped is worth more than commodity-scoped, and any narrowing beats the
 * catch-all. §19 states no precedence; this one is chosen so the more specific published
 * figure always wins, and the tie-break is TOTAL (latest `validFrom`, then `id`) so two
 * admins cannot make the endpoint flap between two equally specific rows.
 *
 * COMMODITY MATCHING IS EXACT-OR-NULL — CATEGORY ANCESTORS ARE DELIBERATELY NOT WALKED.
 * Walking them would silently apply a broad figure to a narrow commodity, which is the same
 * flattening §19.2 rejected when it put transit days on the band rather than the card. If
 * ancestor matching is wanted later the recursive CTE already exists in
 * `store-catalog.service.ts`, and it should rank by DEPTH rather than merge.
 *
 * A MULTI-CATEGORY ORDER uses a commodity-scoped row only if that row covers EVERY category
 * on the order; otherwise it falls through to the any-commodity row. One line of electronics
 * must not pull a textile dwell figure onto the whole consignment.
 */
export function selectMostSpecificDwellEstimate(
  rows: readonly CustomsDwellRow[],
  lane: {
    readonly originCountryCode: string;
    readonly commodityCategoryIds: readonly string[];
  },
): CustomsDwellRow | null {
  const distinctCategoryIds = [...new Set(lane.commodityCategoryIds)];

  const applicable = rows.filter((row) => {
    if (row.originCountryCode !== null && row.originCountryCode !== lane.originCountryCode) {
      return false;
    }
    if (row.commodityScopeCategoryId === null) {
      return true;
    }
    // A scoped row must cover the WHOLE consignment, which for a single-category order is the
    // ordinary case and for a mixed one is deliberately hard to satisfy.
    return (
      distinctCategoryIds.length > 0 &&
      distinctCategoryIds.every((categoryId) => categoryId === row.commodityScopeCategoryId)
    );
  });

  const ranked = applicable.toSorted((left, right) => {
    const leftScore =
      (left.originCountryCode === null ? 0 : 2) + (left.commodityScopeCategoryId === null ? 0 : 1);
    const rightScore =
      (right.originCountryCode === null ? 0 : 2) +
      (right.commodityScopeCategoryId === null ? 0 : 1);
    return (
      rightScore - leftScore ||
      right.validFrom.getTime() - left.validFrom.getTime() ||
      left.id.localeCompare(right.id)
    );
  });

  return ranked[0] ?? null;
}

/**
 * IMPURE. Resolves the customs component for one lane.
 *
 * A DOMESTIC LANE SHORT-CIRCUITS BEFORE ANY QUERY. There is no border to wait at, so there is
 * nothing to look up, and a stored IN→IN row is refused by the table's own CHECK.
 */
export async function resolveCustomsDwell(input: {
  readonly originCountryCode: string | null;
  readonly destinationCountryCode: string;
  readonly commodityCategoryIds: readonly string[];
  readonly asOf: Date;
}): Promise<CustomsDwellResolution> {
  if (input.originCountryCode === null) {
    // Without an origin the lane cannot be classified as domestic or not, and guessing either
    // way would either invent a clearance or erase a real one.
    return { status: "unknown", reason: "no_dwell_estimate_for_lane" };
  }

  if (input.originCountryCode === input.destinationCountryCode) {
    return { status: "not_applicable", reason: "domestic_lane" };
  }

  const rows = await db
    .select({
      id: commerceCustomsDwellEstimate.id,
      originCountryCode: commerceCustomsDwellEstimate.originCountryCode,
      commodityScopeCategoryId: commerceCustomsDwellEstimate.commodityScopeCategoryId,
      clearanceDaysMin: commerceCustomsDwellEstimate.clearanceDaysMin,
      clearanceDaysMax: commerceCustomsDwellEstimate.clearanceDaysMax,
      source: commerceCustomsDwellEstimate.source,
      validFrom: commerceCustomsDwellEstimate.validFrom,
      validUntil: commerceCustomsDwellEstimate.validUntil,
    })
    .from(commerceCustomsDwellEstimate)
    .where(
      and(
        eq(commerceCustomsDwellEstimate.destinationCountryCode, input.destinationCountryCode),
        lte(commerceCustomsDwellEstimate.validFrom, input.asOf),
        or(
          isNull(commerceCustomsDwellEstimate.validUntil),
          gt(commerceCustomsDwellEstimate.validUntil, input.asOf),
        ),
        // Origin narrowings that name a DIFFERENT origin cannot apply; the any-origin rows
        // and this lane's own rows both survive.
        or(
          isNull(commerceCustomsDwellEstimate.originCountryCode),
          eq(commerceCustomsDwellEstimate.originCountryCode, input.originCountryCode),
        ),
      ),
    );

  const matched = selectMostSpecificDwellEstimate(rows, {
    originCountryCode: input.originCountryCode,
    commodityCategoryIds: input.commodityCategoryIds,
  });

  if (!matched) {
    return { status: "unknown", reason: "no_dwell_estimate_for_lane" };
  }

  return {
    status: "known",
    estimateId: matched.id,
    clearanceDaysMin: matched.clearanceDaysMin,
    clearanceDaysMax: matched.clearanceDaysMax,
    source: matched.source,
    validUntil: matched.validUntil,
    scope: scopeOf(matched),
  };
}
