import { inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { product } from "#src/db/schema.js";
import { computePackagingTotals } from "#src/services/commerce-delivery-estimate.service.js";
import {
  FREIGHT_MODE_ORDER,
  rateLane,
  type ConsignmentMeasurement,
  type FreightOption,
  type FreightRatingUnavailableReason,
} from "#src/services/commerce-freight-rating.service.js";
import type { FreightMode } from "#src/schemas/commerce-freight-rates.schemas.js";

/**
 * Decomposing a delivery into priced legs, and recomposing those legs into whole journeys
 * (STORE_BACKEND_STRUCTURE.md §19.1, §19.4, §19.6).
 *
 * WHERE DOES THE INLAND LEG START? NOTHING IN THE SCHEMA SAYS. Rate cards are keyed by
 * COUNTRY PAIR — no port, no city, no zone — and the finest geography that exists on either
 * end is `commerce_organization_address.locality`, which no rate table is keyed by. So the
 * only decomposition the data supports is by country pair, and any finer split would produce
 * a leg that is unpriceable by construction.
 *
 * THE INLAND LEG IS ON THE DESTINATION SIDE. §19.1 says "an international leg and an inland
 * leg" without saying which end. Origin-side drayage already lives inside the international
 * card's own country pair, and an origin-side leg would need a card keyed by the SELLER's
 * locality — which does not exist, so that leg would be permanently uncovered, and by the
 * "an uncovered leg makes the whole journey unpriceable" rule it would poison every journey
 * forever.
 *
 * LOCALITIES ARE LABELS. They render; they never select a card. They are named as such on the
 * wire so a client cannot mistake one for a lane key.
 */

export type FreightLegKind = "international" | "inland_destination" | "domestic";

export interface FreightLegPlan {
  readonly sequence: number;
  readonly kind: FreightLegKind;
  readonly originCountryCode: string;
  /** LABEL ONLY — selects no card. */
  readonly originLocality: string | null;
  readonly destinationCountryCode: string;
  /** LABEL ONLY — selects no card. */
  readonly destinationLocality: string | null;
  readonly options: readonly FreightOption[];
  readonly unavailableReasons: readonly FreightRatingUnavailableReason[];
}

export interface FreightJourneyLegSelection {
  readonly legSequence: number;
  readonly rateCardId: string;
  readonly mode: FreightMode;
  readonly priceInCents: number;
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
  readonly sourceForwarderName: string;
  /**
   * §19.9. PER LEG, because the divisor belongs to the forwarder and not to the boxes: an ocean
   * card (divisor 1000) and an inland card (divisor 3000) rating the SAME consignment produce
   * two different chargeable weights on one journey. Reporting a single journey-level weight
   * would make one of the two leg prices look like an arithmetic error.
   */
  readonly chargeableWeightGrams: number;
  readonly chargeableWeightBasis: "actual" | "volumetric";
}

/**
 * A whole journey, priced and timed by the SERVER.
 *
 * §19.5's table asks only for `legs[]`, but §19.6 says "the client never sums legs — the
 * server returns the journey total already computed". Those two cannot both be satisfied by
 * `legs[]` alone, so the totals live here.
 */
export interface FreightJourneyProjection {
  readonly currency: string;
  /**
   * The mode the BUYER is choosing between — the international leg's on a cross-border
   * journey, the single leg's on a domestic one.
   *
   * Not `internationalMode`: a domestic journey still offers land against rail, and calling
   * that field "international" would force it to null and make two real domestic choices
   * indistinguishable on the wire.
   */
  readonly primaryMode: FreightMode;
  readonly totalInCents: number;
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
  /** The earliest expiry across the selections — a journey expires with its first card. */
  readonly validUntil: Date | null;
  readonly legSelections: readonly FreightJourneyLegSelection[];
}

export type JourneyUnpriceableReason =
  | {
      readonly kind: "leg_uncovered";
      readonly legSequence: number;
      readonly reasons: readonly FreightRatingUnavailableReason[];
    }
  | { readonly kind: "no_common_currency_across_legs" }
  | { readonly kind: "origin_country_unresolved" };

export interface FreightLanePlan {
  readonly origin: { readonly countryCode: string; readonly locality: string | null };
  readonly destination: { readonly countryCode: string; readonly locality: string | null };
  readonly consignment: ConsignmentMeasurement;
  readonly legs: readonly FreightLegPlan[];
  readonly journeys: readonly FreightJourneyProjection[];
  readonly unpriceableReasons: readonly JourneyUnpriceableReason[];
}

export interface ConsignmentLineInput {
  readonly productId: string;
  readonly quantity: number;
}

const CUBIC_MM_PER_CUBIC_CM = 1000;

/**
 * Package count, gross weight and volume across the lines being rated.
 *
 * The weight and package halves DELEGATE to A16's `computePackagingTotals` unchanged — it is
 * exported, already unit-tested, and its "`unitsPerPackage` NULL means UNSTATED, not one"
 * rule is the same rule volume needs. Only the volume is new.
 *
 * ALL THREE DIMENSIONS TRAVEL TOGETHER or the line contributes no volume at all. A box with a
 * length and a width and no height is not a smaller box; it is an undeclared one.
 */
export function computeConsignmentMeasurement(
  lines: readonly {
    readonly quantity: number;
    readonly unitsPerPackage: number | null;
    readonly packageGrossWeightGrams: number | null;
    readonly packageLengthMm: number | null;
    readonly packageWidthMm: number | null;
    readonly packageHeightMm: number | null;
  }[],
): ConsignmentMeasurement {
  const packaging = computePackagingTotals(lines);

  let volumeCubicCm = 0;
  let contributedAnyVolume = false;
  let hasIncompleteVolumeData = false;

  for (const line of lines) {
    const { packageLengthMm, packageWidthMm, packageHeightMm, unitsPerPackage } = line;
    if (
      unitsPerPackage === null ||
      packageLengthMm === null ||
      packageWidthMm === null ||
      packageHeightMm === null
    ) {
      hasIncompleteVolumeData = true;
      continue;
    }
    const packagesForLine = Math.ceil(line.quantity / unitsPerPackage);
    volumeCubicCm +=
      packagesForLine *
      Math.ceil((packageLengthMm * packageWidthMm * packageHeightMm) / CUBIC_MM_PER_CUBIC_CM);
    contributedAnyVolume = true;
  }

  return {
    billableWeightGrams: packaging.billableWeightGrams,
    packageCount: packaging.packageCount,
    // Never 0 for "we did not measure it" — that is the distinction the whole phase turns on.
    volumeCubicCm: contributedAnyVolume ? volumeCubicCm : null,
    hasIncompletePackageData: packaging.hasIncompletePackageData || hasIncompleteVolumeData,
  };
}

/** Loads the geometry the seller declared for these products, then measures the consignment. */
export async function measureConsignmentForLines(
  lines: readonly ConsignmentLineInput[],
): Promise<ConsignmentMeasurement> {
  if (lines.length === 0) {
    return {
      billableWeightGrams: null,
      volumeCubicCm: null,
      packageCount: null,
      hasIncompletePackageData: true,
    };
  }

  const productRows = await db
    .select({
      id: product.id,
      unitsPerPackage: product.unitsPerPackage,
      packageGrossWeightGrams: product.packageGrossWeightGrams,
      packageLengthMm: product.packageLengthMm,
      packageWidthMm: product.packageWidthMm,
      packageHeightMm: product.packageHeightMm,
    })
    .from(product)
    .where(inArray(product.id, [...new Set(lines.map((line) => line.productId))]));

  const productById = new Map(productRows.map((row) => [row.id, row]));

  return computeConsignmentMeasurement(
    lines.map((line) => {
      const geometry = productById.get(line.productId);
      return {
        quantity: line.quantity,
        unitsPerPackage: geometry?.unitsPerPackage ?? null,
        packageGrossWeightGrams: geometry?.packageGrossWeightGrams ?? null,
        packageLengthMm: geometry?.packageLengthMm ?? null,
        packageWidthMm: geometry?.packageWidthMm ?? null,
        packageHeightMm: geometry?.packageHeightMm ?? null,
      };
    }),
  );
}

/**
 * PURE. Which legs does this delivery have?
 *
 * Same country → ONE domestic leg. Different countries → an international leg followed by an
 * inland leg in the destination country. See the module header for why the inland leg sits on
 * the destination side.
 */
export function planLegs(input: {
  readonly originCountryCode: string;
  readonly originLocality: string | null;
  readonly destinationCountryCode: string;
  readonly destinationLocality: string | null;
}): readonly {
  readonly sequence: number;
  readonly kind: FreightLegKind;
  readonly originCountryCode: string;
  readonly originLocality: string | null;
  readonly destinationCountryCode: string;
  readonly destinationLocality: string | null;
}[] {
  if (input.originCountryCode === input.destinationCountryCode) {
    return [
      {
        sequence: 0,
        kind: "domestic",
        originCountryCode: input.originCountryCode,
        originLocality: input.originLocality,
        destinationCountryCode: input.destinationCountryCode,
        destinationLocality: input.destinationLocality,
      },
    ];
  }

  return [
    {
      sequence: 0,
      kind: "international",
      originCountryCode: input.originCountryCode,
      originLocality: input.originLocality,
      destinationCountryCode: input.destinationCountryCode,
      destinationLocality: null,
    },
    {
      sequence: 1,
      kind: "inland_destination",
      originCountryCode: input.destinationCountryCode,
      originLocality: null,
      destinationCountryCode: input.destinationCountryCode,
      destinationLocality: input.destinationLocality,
    },
  ];
}

/**
 * PURE. Recomposes priced legs into whole journeys.
 *
 * ONE JOURNEY PER (currency, international mode) FOR WHICH EVERY LEG HAS AN OPTION IN THAT
 * CURRENCY. Within a leg the cheapest qualifying option is selected and named, so the client
 * can see which card produced each number without summing anything itself.
 *
 * AN UNCOVERED LEG MAKES THE WHOLE JOURNEY UNPRICEABLE RATHER THAN CHEAPER (§19.6). No
 * journey is emitted for ANY mode, and the offending leg is named. This is the case that
 * matters in practice: few forwarders sell a domestic card in the destination country, so the
 * inland leg is genuinely uncovered on most lanes, and it must not silently vanish into a
 * cheaper-looking total.
 *
 * NEVER CROSS-CURRENCY. Summing a USD international leg and a EUR inland leg would invent an
 * exchange rate, which is A16's and §15.4's rule.
 */
export function composeJourneys(legs: readonly FreightLegPlan[]): {
  readonly journeys: readonly FreightJourneyProjection[];
  readonly unpriceableReasons: readonly JourneyUnpriceableReason[];
} {
  const uncoveredLeg = legs.find((leg) => leg.options.length === 0);
  if (uncoveredLeg) {
    return {
      journeys: [],
      unpriceableReasons: [
        {
          kind: "leg_uncovered",
          legSequence: uncoveredLeg.sequence,
          reasons: uncoveredLeg.unavailableReasons,
        },
      ],
    };
  }

  // The leg that carries the choice: the international one, or the single domestic one.
  // An inland leg never carries it — nobody chooses how a truck reaches the warehouse.
  const primaryLeg = legs.find((leg) => leg.kind !== "inland_destination");
  const candidateModes =
    primaryLeg === undefined
      ? []
      : [...new Set(primaryLeg.options.map((option) => option.mode))].toSorted(
          (left, right) => FREIGHT_MODE_ORDER.indexOf(left) - FREIGHT_MODE_ORDER.indexOf(right),
        );

  const candidateCurrencies = [
    ...new Set(legs.flatMap((leg) => leg.options.map((option) => option.currency))),
  ].toSorted();

  const journeys: FreightJourneyProjection[] = [];
  let sawCurrencySplit = false;

  for (const currency of candidateCurrencies) {
    for (const mode of candidateModes) {
      const selections: FreightJourneyLegSelection[] = [];
      let complete = true;

      for (const leg of legs) {
        // The international leg is pinned to the mode under consideration; an inland leg takes
        // whatever mode is cheapest, because nobody chooses how a truck reaches the warehouse.
        const eligible = leg.options.filter(
          (option) =>
            option.currency === currency &&
            (leg.kind === "inland_destination" || option.mode === mode),
        );
        const cheapest = eligible.toSorted(
          (left, right) =>
            left.priceInCents - right.priceInCents ||
            left.rateCardId.localeCompare(right.rateCardId),
        )[0];

        if (!cheapest) {
          complete = false;
          sawCurrencySplit = true;
          break;
        }

        selections.push({
          legSequence: leg.sequence,
          rateCardId: cheapest.rateCardId,
          mode: cheapest.mode,
          priceInCents: cheapest.priceInCents,
          transitDaysMin: cheapest.transitDaysMin,
          transitDaysMax: cheapest.transitDaysMax,
          sourceForwarderName: cheapest.sourceForwarderName,
          chargeableWeightGrams: cheapest.chargeableWeightGrams,
          chargeableWeightBasis: cheapest.chargeableWeightBasis,
        });
      }

      if (!complete) {
        continue;
      }

      const expiries = legs
        .flatMap((leg) =>
          leg.options
            .filter((option) =>
              selections.some((selection) => selection.rateCardId === option.rateCardId),
            )
            .map((option) => option.validUntil),
        )
        .filter((validUntil): validUntil is Date => validUntil !== null);

      journeys.push({
        currency,
        primaryMode: mode,
        totalInCents: selections.reduce((sum, selection) => sum + selection.priceInCents, 0),
        transitDaysMin: selections.reduce((sum, selection) => sum + selection.transitDaysMin, 0),
        transitDaysMax: selections.reduce((sum, selection) => sum + selection.transitDaysMax, 0),
        validUntil:
          expiries.length === 0
            ? null
            : expiries.reduce((earliest, current) => (current < earliest ? current : earliest)),
        legSelections: selections,
      });
    }
  }

  return {
    journeys,
    unpriceableReasons:
      journeys.length === 0 && sawCurrencySplit ? [{ kind: "no_common_currency_across_legs" }] : [],
  };
}

/**
 * IMPURE. The whole lane plan: measure, decompose, rate each leg, recompose.
 *
 * NO DATES ANYWHERE IN THE RESULT — durations only. A product page has no order and therefore
 * no clock to start, which is §19.4's "no arrival window before an order exists".
 */
export async function planFreightJourney(input: {
  readonly originCountryCode: string | null;
  readonly originLocality: string | null;
  readonly destinationCountryCode: string;
  readonly destinationLocality: string | null;
  readonly lines: readonly ConsignmentLineInput[];
  readonly asOf: Date;
}): Promise<FreightLanePlan | null> {
  if (input.originCountryCode === null) {
    // A lane with no origin has no legs to plan. `null` rather than an empty plan, so the
    // caller renders "we cannot say" rather than "nothing covers this".
    return null;
  }
  const originCountryCode = input.originCountryCode;

  const consignment = await measureConsignmentForLines(input.lines);

  const legPlans = planLegs({
    originCountryCode,
    originLocality: input.originLocality,
    destinationCountryCode: input.destinationCountryCode,
    destinationLocality: input.destinationLocality,
  });

  const legs: FreightLegPlan[] = [];
  for (const leg of legPlans) {
    const rated = await rateLane({
      originCountryCode: leg.originCountryCode,
      destinationCountryCode: leg.destinationCountryCode,
      consignment,
      asOf: input.asOf,
    });
    legs.push({ ...leg, options: rated.options, unavailableReasons: rated.unavailableReasons });
  }

  const composed = composeJourneys(legs);

  return {
    origin: { countryCode: originCountryCode, locality: input.originLocality },
    destination: {
      countryCode: input.destinationCountryCode,
      locality: input.destinationLocality,
    },
    consignment,
    legs,
    journeys: composed.journeys,
    unpriceableReasons: composed.unpriceableReasons,
  };
}
