import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceFreightRateBreak, commerceFreightRateCard } from "#src/db/schema.js";
import type { FreightMode } from "#src/schemas/commerce-freight-rates.schemas.js";

/**
 * Rating a lane from a purchased forwarder tariff (STORE_BACKEND_STRUCTURE.md §19.2, §19.6).
 *
 * THE POSTURE IS A16's, DELIBERATELY. No `Result<T, E>`: an unrateable lane is an EMPTY
 * `options[]` plus a NAMED reason, never a zero and never a thrown error. "We do not know"
 * and "it is free" are different answers, and only one of them is ever true here.
 *
 * NOTHING IN THIS MODULE WRITES. Rating from a card is not a booking, confers no capacity,
 * and never touches `shippingInCents` — that stays literal `0` until something is booked
 * (§19.6, A16's decision).
 *
 * The pure half (`selectRateBreak`, `priceRatedBreak`, `rateCard`, `rateLaneFromCards`) is
 * split from the loading half so the whole selection algorithm is testable with no database.
 */

/** Display order, and the only ordering the wire ever promises. */
export const FREIGHT_MODE_ORDER: readonly FreightMode[] = ["air", "sea", "land", "rail"];

/** Bounded like A16's `MAXIMUM_OFFERINGS_PER_ESTIMATE`: one PDP must not scan a tariff library. */
const MAXIMUM_RATE_CARDS_PER_LANE = 25;

/**
 * `unitPriceInCents` is CENTS PER KILOGRAM of chargeable weight.
 *
 * §19 never declares the denominator. It is named here as a constant rather than left as a
 * literal `1000` because it is the one assumption that, if the write half disagreed, would
 * make the published number WRONG rather than absent — and a wrong freight price is the
 * failure §0 exists to prevent. The migration banner and the schema comment carry the same
 * sentence.
 */
export const BILLABLE_WEIGHT_UNIT_GRAMS = 1000;

export interface ConsignmentMeasurement {
  readonly billableWeightGrams: number | null;
  readonly volumeCubicCm: number | null;
  readonly packageCount: number | null;
  readonly hasIncompletePackageData: boolean;
}

export interface FreightRateBreak {
  readonly id: string;
  readonly minBillableWeightGrams: number;
  readonly minVolumeCubicCm: number;
  readonly unitPriceInCents: number;
  readonly minimumChargeInCents: number;
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
  readonly position: number;
}

export interface FreightRateCard {
  readonly id: string;
  readonly providerOrganizationId: string;
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly mode: FreightMode;
  readonly currency: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly sourceForwarderName: string;
  readonly breaks: readonly FreightRateBreak[];
}

/** Why a card produced no option. Every one of these is REPORTED, never defaulted (§19.6). */
export type FreightRatingUnavailableReason =
  | "no_active_rate_card"
  | "consignment_not_measurable"
  | "below_smallest_break"
  | "card_has_no_breaks";

export type RateBreakSelection =
  | { readonly status: "selected"; readonly selected: FreightRateBreak }
  | { readonly status: "consignment_not_measurable" }
  | { readonly status: "card_has_no_breaks" }
  | {
      readonly status: "below_smallest_break";
      readonly smallestMinBillableWeightGrams: number;
      readonly smallestMinVolumeCubicCm: number;
    };

/**
 * §19.5's option shape, plus `currency`.
 *
 * THE SPEC OMITS THE CURRENCY AND CANNOT: a `priceInCents` with no currency is unrenderable,
 * and a list mixing USD and EUR is exactly the collapse A16 refused when it grouped estimates
 * per currency and never converted.
 */
export interface FreightOption {
  readonly mode: FreightMode;
  readonly priceInCents: number;
  readonly currency: string;
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
  readonly rateCardId: string;
  readonly rateBreakId: string;
  readonly sourceForwarderName: string;
  readonly validUntil: Date | null;
}

export interface RatedLane {
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly options: readonly FreightOption[];
  /** Sorted and de-duplicated. Empty options WITH an empty reason list is not representable. */
  readonly unavailableReasons: readonly FreightRatingUnavailableReason[];
}

/**
 * Does this consignment clear the band's volume floor?
 *
 * A `minVolumeCubicCm` of 0 marks a WEIGHT-ONLY band and always qualifies. A positive floor
 * cannot be cleared by an unknown volume: `null` means the seller declared no dimensions, and
 * treating that as "small enough" would select a band on a measurement nobody made.
 */
function volumeQualifies(band: FreightRateBreak, consignment: ConsignmentMeasurement): boolean {
  if (band.minVolumeCubicCm === 0) {
    return true;
  }
  if (consignment.volumeCubicCm === null) {
    return false;
  }
  return consignment.volumeCubicCm >= band.minVolumeCubicCm;
}

/**
 * The ladder: pick the HIGHEST band this consignment clears.
 *
 * SORTED BY THE FLOORS, NOT BY `position`. `position` is authoring order and the unique index
 * on it does not make it monotone in weight, so a badly ordered card would otherwise select
 * arbitrarily. `position` survives only as the final tie-break.
 *
 * BOTH FLOORS ARE CONJUNCTIVE. §19 does not say; AND is chosen because it is monotone, which
 * is what makes "the highest qualifying band" well defined, and because OR would let a bulky
 * but light consignment fall into a heavy band's cheap per-kilogram rate.
 *
 * BELOW THE SMALLEST BAND YIELDS NO OPTION, not the minimum charge. A card whose smallest
 * band starts at 45 kg is a tariff that says it starts at 45 kg; applying its
 * `minimumChargeInCents` to a 5 kg parcel extrapolates a price out of a band the forwarder
 * explicitly excluded. An admin who wants floor coverage authors a band at
 * `minBillableWeightGrams: 0`, which is one reviewable row.
 *
 * THERE IS NO "ABOVE THE LARGEST BAND" CASE. Bands carry floors and no ceilings, so the top
 * band is open-ended by construction. Capping a forwarder's own tariff would be the platform
 * authoring a price.
 */
export function selectRateBreak(
  breaks: readonly FreightRateBreak[],
  consignment: ConsignmentMeasurement,
): RateBreakSelection {
  if (breaks.length === 0) {
    return { status: "card_has_no_breaks" };
  }

  const billableWeightGrams = consignment.billableWeightGrams;
  if (billableWeightGrams === null) {
    return { status: "consignment_not_measurable" };
  }

  const byFloor = breaks.toSorted(
    (left, right) =>
      left.minBillableWeightGrams - right.minBillableWeightGrams ||
      left.minVolumeCubicCm - right.minVolumeCubicCm ||
      left.position - right.position,
  );

  const qualifying = byFloor.filter(
    (band) =>
      billableWeightGrams >= band.minBillableWeightGrams && volumeQualifies(band, consignment),
  );

  const selected = qualifying.at(-1);
  if (!selected) {
    const smallest = byFloor[0];
    if (!smallest) {
      // Unreachable: `breaks.length === 0` returned above. Kept as an assertion rather than a
      // non-null assertion, per CLAUDE §2.2's ban on unchecked narrowing.
      throw new Error("selectRateBreak: a non-empty band list sorted to nothing");
    }
    return {
      status: "below_smallest_break",
      smallestMinBillableWeightGrams: smallest.minBillableWeightGrams,
      smallestMinVolumeCubicCm: smallest.minVolumeCubicCm,
    };
  }

  return { status: "selected", selected };
}

/**
 * `max(minimumCharge, ceil(kilograms * unitPrice))`, in integer cents.
 *
 * ROUNDED UP. Rounding a freight charge down publishes a number the forwarder will not
 * honour, and the platform would then own the difference.
 */
export function priceRatedBreak(
  selected: FreightRateBreak,
  billableWeightGrams: number,
): number {
  const weightedInCents = Math.ceil(
    (billableWeightGrams * selected.unitPriceInCents) / BILLABLE_WEIGHT_UNIT_GRAMS,
  );

  if (!Number.isSafeInteger(weightedInCents)) {
    // Unrecoverable, per CLAUDE §3.3: a lossy cent is worse than a refusal, and no input this
    // service accepts should be able to reach here.
    throw new Error(
      `priceRatedBreak: ${billableWeightGrams}g at ${selected.unitPriceInCents} cents/kg exceeds safe integer range`,
    );
  }

  return Math.max(selected.minimumChargeInCents, weightedInCents);
}

/** PURE. One card in, at most one option out. */
export function rateCard(
  card: FreightRateCard,
  consignment: ConsignmentMeasurement,
):
  | { readonly status: "priced"; readonly option: FreightOption }
  | { readonly status: "unpriceable"; readonly reason: FreightRatingUnavailableReason } {
  const selection = selectRateBreak(card.breaks, consignment);

  switch (selection.status) {
    case "card_has_no_breaks":
      return { status: "unpriceable", reason: "card_has_no_breaks" };
    case "consignment_not_measurable":
      return { status: "unpriceable", reason: "consignment_not_measurable" };
    case "below_smallest_break":
      return { status: "unpriceable", reason: "below_smallest_break" };
    case "selected": {
      const billableWeightGrams = consignment.billableWeightGrams;
      if (billableWeightGrams === null) {
        // Unreachable: `selectRateBreak` returns `consignment_not_measurable` first.
        return { status: "unpriceable", reason: "consignment_not_measurable" };
      }
      return {
        status: "priced",
        option: {
          mode: card.mode,
          priceInCents: priceRatedBreak(selection.selected, billableWeightGrams),
          currency: card.currency,
          transitDaysMin: selection.selected.transitDaysMin,
          transitDaysMax: selection.selected.transitDaysMax,
          rateCardId: card.id,
          rateBreakId: selection.selected.id,
          sourceForwarderName: card.sourceForwarderName,
          validUntil: card.validUntil,
        },
      };
    }
    default: {
      const exhaustiveCheck: never = selection;
      throw new Error(`Unhandled rate break selection: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * PURE. Every card on a lane, collapsed into a deterministic option list.
 *
 * ONE OPTION PER CARD, not per mode. The option carries `rateCardId` and
 * `sourceForwarderName`, which only mean anything per card, and two forwarders selling sea on
 * one lane are two real choices a buyer is entitled to see.
 */
export function rateLaneFromCards(input: {
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly cards: readonly FreightRateCard[];
  readonly consignment: ConsignmentMeasurement;
}): RatedLane {
  const options: FreightOption[] = [];
  const reasons = new Set<FreightRatingUnavailableReason>();

  if (input.cards.length === 0) {
    reasons.add("no_active_rate_card");
  }

  for (const card of input.cards) {
    const rated = rateCard(card, input.consignment);
    if (rated.status === "priced") {
      options.push(rated.option);
    } else {
      reasons.add(rated.reason);
    }
  }

  // Deterministic and total: mode order, then cheapest, then id. No tie is left to insertion
  // order, so two identical requests cannot disagree about which option leads.
  const sortedOptions = options.toSorted(
    (left, right) =>
      FREIGHT_MODE_ORDER.indexOf(left.mode) - FREIGHT_MODE_ORDER.indexOf(right.mode) ||
      left.priceInCents - right.priceInCents ||
      left.rateCardId.localeCompare(right.rateCardId),
  );

  return {
    originCountryCode: input.originCountryCode,
    destinationCountryCode: input.destinationCountryCode,
    options: sortedOptions,
    // Reasons are only meaningful when they explain an absence. A lane with options and one
    // unpriceable card is a covered lane.
    unavailableReasons: sortedOptions.length > 0 ? [] : [...reasons].toSorted(),
  };
}

/**
 * IMPURE. Loads the cards live on this lane at `asOf`, then delegates to the pure half.
 *
 * THE PREDICATE IS THE WINDOW, NOT THE STATE, and that is load-bearing. A future-dated
 * successor flips its incumbent to `superseded` the moment it is written, while the
 * incumbent's window is still open — selecting on `state = 'active'` would black out the lane
 * from the instant an admin scheduled next month's tariff. `withdrawn` is the only state that
 * removes a card from the read, because withdrawing is the act of saying "this was never a
 * price".
 *
 * An expired card is likewise not a price (§19.6), which is the other half of the window test.
 */
export async function rateLane(input: {
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly consignment: ConsignmentMeasurement;
  readonly asOf: Date;
  readonly modes?: readonly FreightMode[];
}): Promise<RatedLane> {
  const cardRows = await db
    .select()
    .from(commerceFreightRateCard)
    .where(
      and(
        eq(commerceFreightRateCard.originCountryCode, input.originCountryCode),
        eq(commerceFreightRateCard.destinationCountryCode, input.destinationCountryCode),
        ne(commerceFreightRateCard.state, "withdrawn"),
        lte(commerceFreightRateCard.validFrom, input.asOf),
        or(
          isNull(commerceFreightRateCard.validUntil),
          gt(commerceFreightRateCard.validUntil, input.asOf),
        ),
      ),
    )
    .orderBy(asc(commerceFreightRateCard.id))
    .limit(MAXIMUM_RATE_CARDS_PER_LANE);

  const requestedModes = input.modes;
  const applicableCards =
    requestedModes === undefined
      ? cardRows
      : cardRows.filter((card) => requestedModes.includes(card.mode));

  if (applicableCards.length === 0) {
    return rateLaneFromCards({
      originCountryCode: input.originCountryCode,
      destinationCountryCode: input.destinationCountryCode,
      cards: [],
      consignment: input.consignment,
    });
  }

  const breakRows = await db
    .select()
    .from(commerceFreightRateBreak)
    .where(
      inArray(
        commerceFreightRateBreak.rateCardId,
        applicableCards.map((card) => card.id),
      ),
    )
    .orderBy(asc(commerceFreightRateBreak.rateCardId), asc(commerceFreightRateBreak.position));

  const breaksByCardId = new Map<string, FreightRateBreak[]>();
  for (const band of breakRows) {
    const existing = breaksByCardId.get(band.rateCardId);
    const projected: FreightRateBreak = {
      id: band.id,
      minBillableWeightGrams: band.minBillableWeightGrams,
      minVolumeCubicCm: band.minVolumeCubicCm,
      unitPriceInCents: band.unitPriceInCents,
      minimumChargeInCents: band.minimumChargeInCents,
      transitDaysMin: band.transitDaysMin,
      transitDaysMax: band.transitDaysMax,
      position: band.position,
    };
    if (existing) {
      existing.push(projected);
    } else {
      breaksByCardId.set(band.rateCardId, [projected]);
    }
  }

  return rateLaneFromCards({
    originCountryCode: input.originCountryCode,
    destinationCountryCode: input.destinationCountryCode,
    cards: applicableCards.map((card) => ({
      id: card.id,
      providerOrganizationId: card.providerOrganizationId,
      originCountryCode: card.originCountryCode,
      destinationCountryCode: card.destinationCountryCode,
      mode: card.mode,
      currency: card.currency,
      validFrom: card.validFrom,
      validUntil: card.validUntil,
      sourceForwarderName: card.sourceForwarderName,
      breaks: breaksByCardId.get(card.id) ?? [],
    })),
    consignment: input.consignment,
  });
}
