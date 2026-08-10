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
  /** §19.9. cm³ per kilogram, this forwarder's own convention. */
  readonly volumetricDivisorCm3PerKg: number;
  readonly breaks: readonly FreightRateBreak[];
}

/** Why a card produced no option. Every one of these is REPORTED, never defaulted (§19.6). */
export type FreightRatingUnavailableReason =
  | "no_active_rate_card"
  | "consignment_not_measurable"
  | "volume_not_declared"
  | "below_smallest_break"
  | "card_has_no_breaks";

/**
 * §19.9. What this consignment BILLS AT under one card's convention.
 *
 * PER CARD, NOT PER CONSIGNMENT, and that is the structural point: the divisor belongs to the
 * forwarder, so the same boxes legitimately bill as two different weights under two different
 * cards. It therefore cannot live on `ConsignmentMeasurement`.
 */
export type ChargeableWeight =
  | {
      readonly status: "chargeable";
      readonly grams: number;
      readonly basis: "actual" | "volumetric";
      /**
       * The volume this was computed from, carried out because proving it non-null happened
       * HERE. Returning it saves every caller a redundant null check that could only ever be
       * satisfied by a fallback constant — and a fallback of `0` would read as "no volume",
       * which is the exact conflation this phase spends its constraints refusing.
       */
      readonly volumeCubicCm: number;
    }
  | {
      readonly status: "not_measurable";
      readonly reason: "weight_not_declared" | "volume_not_declared";
    };

export type RateBreakSelection =
  | { readonly status: "selected"; readonly selected: FreightRateBreak }
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
/**
 * The price, AND WHOSE PRICE IT IS, in one object that cannot be taken apart.
 *
 * QATOTO IS A FREIGHT MARKETPLACE, NOT A CARRIER. It sells no freight, holds no funds and carries
 * no consignment; the buyer's counterparty is the provider organization named here. So the price
 * is not the platform's to state, and nesting it means a client physically CANNOT render the
 * number without holding the provider's identity — attribution stops being a convention that a
 * future surface can quietly drop.
 *
 * This is A13's move, which this codebase already defends: a seller's declared stats and Qatoto's
 * measured stats sit in two objects precisely so a renderer cannot flatten one into the other.
 */
export interface ProviderFreightQuote {
  readonly providerOrganizationId: string;
  readonly sourceForwarderName: string;
  readonly priceInCents: number;
  readonly currency: string;
  readonly validUntil: Date | null;
  /**
   * Always true, and on the wire so a client cannot claim it was not told. Forwarders re-weigh and
   * re-measure at pickup and bill the result; a rate computed from a seller's declared geometry is
   * the provider's estimate against that declaration, not a fixed charge.
   */
  readonly subjectToRemeasurement: true;
}

export interface FreightOption {
  readonly mode: FreightMode;
  readonly providerQuote: ProviderFreightQuote;
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
  readonly rateCardId: string;
  readonly rateBreakId: string;
  /**
   * §19.9. The weight this option was actually priced on, and which basis won.
   *
   * ON THE WIRE because §19.6 makes the basis of a number travel with the number. Without it a
   * buyer whose 20 kg of cushions billed as 3,000 kg has no way to see why, and would read a
   * correct volumetric charge as an error.
   */
  readonly chargeableWeightGrams: number;
  readonly chargeableWeightBasis: "actual" | "volumetric";
}

/** A forwarder who sells this lane and could be asked for a real quote. */
export interface QuotableFreightProvider {
  readonly providerOrganizationId: string;
  readonly sourceForwarderName: string;
  readonly mode: FreightMode;
}

export interface RatedLane {
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly options: readonly FreightOption[];
  /** Sorted and de-duplicated. Empty options WITH an empty reason list is not representable. */
  readonly unavailableReasons: readonly FreightRatingUnavailableReason[];
  /**
   * THE MARKETPLACE FALLBACK. Who sells this lane, whether or not anything could be priced.
   *
   * A lane that cannot be rated — most often because the seller never measured a box — used to end
   * in a named absence and nothing else, which is a dead end: the buyer is told no price exists and
   * offered no way forward. Naming the forwarders lets the client open an RFQ against the machinery
   * that already exists, which is both §15.6's honest degradation and what Alibaba actually does.
   *
   * Derived from the cards already loaded for this lane, so it costs no extra query.
   */
  readonly quotableProviders: readonly QuotableFreightProvider[];
}

/**
 * §19.9. What this consignment bills at under this card — `max(actual, volumetric)`.
 *
 * THE DEFECT THIS CLOSES: rating on actual weight alone underprices a light bulky consignment,
 * and a container of cushions costs a forwarder the same as a container of bolts. It was the one
 * place in Phase 20 that published a WRONG number rather than a missing one.
 *
 * `* 1000` converts kilograms to grams, so a divisor of 6000 makes one cubic metre ≈ 166.7 kg
 * (air) and a divisor of 1000 makes it 1000 kg (the ocean W/M revenue ton). Both are correct
 * under one formula, which is why no per-mode branching is needed here.
 *
 * ROUNDED UP, matching `priceRatedBreak`: rounding a chargeable weight down publishes a number
 * the forwarder will not honour.
 *
 * AN UNDECLARED VOLUME REFUSES rather than falling back to actual weight. Falling back would
 * silently reintroduce exactly the underpricing this function exists to remove, and would do it
 * on the consignments most likely to be bulky — the ones whose seller never measured a box.
 */
export function computeChargeableWeight(
  card: FreightRateCard,
  consignment: ConsignmentMeasurement,
): ChargeableWeight {
  if (consignment.billableWeightGrams === null) {
    return { status: "not_measurable", reason: "weight_not_declared" };
  }
  if (consignment.volumeCubicCm === null) {
    return { status: "not_measurable", reason: "volume_not_declared" };
  }

  const volumetricWeightGrams = Math.ceil(
    (consignment.volumeCubicCm * 1000) / card.volumetricDivisorCm3PerKg,
  );

  // Ties resolve to `actual`: when the two agree there is nothing to explain, and naming the
  // volumetric basis would invite a buyer to look for a bulk surcharge that did not apply.
  return volumetricWeightGrams > consignment.billableWeightGrams
    ? {
        status: "chargeable",
        grams: volumetricWeightGrams,
        basis: "volumetric",
        volumeCubicCm: consignment.volumeCubicCm,
      }
    : {
        status: "chargeable",
        grams: consignment.billableWeightGrams,
        basis: "actual",
        volumeCubicCm: consignment.volumeCubicCm,
      };
}

/**
 * Does this consignment clear the band's volume floor?
 *
 * A `minVolumeCubicCm` of 0 marks a WEIGHT-ONLY band and always qualifies.
 *
 * NOT A DUPLICATE OF THE VOLUMETRIC DIVISOR, though both read volume. The divisor converts volume
 * into a billable weight for the WHOLE card; this floor restricts one BAND to consignments above
 * a given bulk — "this rate applies from 2 CBM up". A card can use either, both, or neither.
 */
function volumeQualifies(band: FreightRateBreak, volumeCubicCm: number): boolean {
  if (band.minVolumeCubicCm === 0) {
    return true;
  }
  return volumeCubicCm >= band.minVolumeCubicCm;
}

/**
 * The ladder: pick the HIGHEST band this consignment clears.
 *
 * MEASURED IN CHARGEABLE WEIGHT, not gross (§19.9). A tariff's "45 kg+" band means 45 kg
 * CHARGEABLE, which is what makes a bulky consignment climb the ladder the way the forwarder
 * intended. Selecting on gross would put a 3 CBM shipment of cushions in the base band and then
 * price it there.
 *
 * THE CONSIGNMENT IS ALREADY MEASURED by the time this runs — `computeChargeableWeight` decides
 * measurability first, so there is no `not_measurable` branch here.
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
  consignment: {
    readonly chargeableWeightGrams: number;
    readonly volumeCubicCm: number;
  },
): RateBreakSelection {
  if (breaks.length === 0) {
    return { status: "card_has_no_breaks" };
  }

  const byFloor = breaks.toSorted(
    (left, right) =>
      left.minBillableWeightGrams - right.minBillableWeightGrams ||
      left.minVolumeCubicCm - right.minVolumeCubicCm ||
      left.position - right.position,
  );

  const qualifying = byFloor.filter(
    (band) =>
      consignment.chargeableWeightGrams >= band.minBillableWeightGrams &&
      volumeQualifies(band, consignment.volumeCubicCm),
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
  chargeableWeightGrams: number,
): number {
  const weightedInCents = Math.ceil(
    (chargeableWeightGrams * selected.unitPriceInCents) / BILLABLE_WEIGHT_UNIT_GRAMS,
  );

  if (!Number.isSafeInteger(weightedInCents)) {
    // Unrecoverable, per CLAUDE §3.3: a lossy cent is worse than a refusal, and no input this
    // service accepts should be able to reach here.
    throw new Error(
      `priceRatedBreak: ${chargeableWeightGrams}g at ${selected.unitPriceInCents} cents/kg exceeds safe integer range`,
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
  /**
   * CHARGEABLE WEIGHT FIRST (§19.9). It decides measurability and it is what both the ladder and
   * the price are measured in, so nothing downstream ever sees gross weight again.
   */
  const chargeable = computeChargeableWeight(card, consignment);
  if (chargeable.status === "not_measurable") {
    return {
      status: "unpriceable",
      reason:
        chargeable.reason === "volume_not_declared"
          ? "volume_not_declared"
          : "consignment_not_measurable",
    };
  }

  const selection = selectRateBreak(card.breaks, {
    chargeableWeightGrams: chargeable.grams,
    volumeCubicCm: chargeable.volumeCubicCm,
  });

  switch (selection.status) {
    case "card_has_no_breaks":
      return { status: "unpriceable", reason: "card_has_no_breaks" };
    case "below_smallest_break":
      return { status: "unpriceable", reason: "below_smallest_break" };
    case "selected":
      return {
        status: "priced",
        option: {
          mode: card.mode,
          providerQuote: {
            providerOrganizationId: card.providerOrganizationId,
            sourceForwarderName: card.sourceForwarderName,
            priceInCents: priceRatedBreak(selection.selected, chargeable.grams),
            currency: card.currency,
            validUntil: card.validUntil,
            subjectToRemeasurement: true,
          },
          transitDaysMin: selection.selected.transitDaysMin,
          transitDaysMax: selection.selected.transitDaysMax,
          rateCardId: card.id,
          rateBreakId: selection.selected.id,
          chargeableWeightGrams: chargeable.grams,
          chargeableWeightBasis: chargeable.basis,
        },
      };
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
      left.providerQuote.priceInCents - right.providerQuote.priceInCents ||
      left.rateCardId.localeCompare(right.rateCardId),
  );

  /**
   * Every forwarder selling this lane, priced or not — the RFQ affordance. Deduplicated on
   * (provider, mode) because one forwarder may sell the lane by sea and by air, and those are two
   * distinct things to ask about.
   */
  const quotableByKey = new Map<string, QuotableFreightProvider>();
  for (const card of input.cards) {
    quotableByKey.set(`${card.providerOrganizationId}:${card.mode}`, {
      providerOrganizationId: card.providerOrganizationId,
      sourceForwarderName: card.sourceForwarderName,
      mode: card.mode,
    });
  }
  const quotableProviders = [...quotableByKey.values()].toSorted(
    (left, right) =>
      FREIGHT_MODE_ORDER.indexOf(left.mode) - FREIGHT_MODE_ORDER.indexOf(right.mode) ||
      left.sourceForwarderName.localeCompare(right.sourceForwarderName),
  );

  return {
    originCountryCode: input.originCountryCode,
    destinationCountryCode: input.destinationCountryCode,
    options: sortedOptions,
    // Reasons are only meaningful when they explain an absence. A lane with options and one
    // unpriceable card is a covered lane.
    unavailableReasons: sortedOptions.length > 0 ? [] : [...reasons].toSorted(),
    quotableProviders,
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
      volumetricDivisorCm3PerKg: card.volumetricDivisorCm3PerKg,
      breaks: breaksByCardId.get(card.id) ?? [],
    })),
    consignment: input.consignment,
  });
}
