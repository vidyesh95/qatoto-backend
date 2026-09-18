import { and, asc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceFreightRateBreak, commerceFreightRateCard } from "#src/db/schema.js";
import type { FreightMode } from "#src/modules/store/fulfillment/commerce-freight-rates.schemas.js";

/**
 * The lane rate card's SHARED half — the projection, the band-write gate, and the
 * supersession transaction — sitting under both write surfaces that own cards:
 * `commerce-freight-rates.*` (staff, §19.10) and `commerce-provider-freight-rates.*`
 * (the forwarder authoring its own lanes, §19.12).
 *
 * WHY A FILE RATHER THAN AN IMPORT BETWEEN THE TWO SERVICES. §19.10 settled that both
 * directions of the exchange keep ONE projection, and that `bandsEditable` must be
 * "the same function the 409 comes from, not a second opinion about it". A provider
 * service importing the admin service would satisfy that, but upside down: the narrower,
 * newer surface would pin the older one in place, and the staff module would look like the
 * owner of a rule that belongs to the table. Nothing here is staff-specific and nothing
 * here is provider-specific.
 *
 * NO CAPABILITY, OWNERSHIP OR AUDIT CONCERN LIVES HERE, deliberately. Those are exactly
 * what differs between the two callers — `moderate_commerce` against a platform hash chain
 * on one side, an approved provider profile against the organization's own audit on the
 * other. A helper that tried to carry either would have to take a flag saying which caller
 * it was serving, and a flag like that is how one surface ends up running the other's
 * checks.
 */

export type FreightRateCardRow = typeof commerceFreightRateCard.$inferSelect;
export type FreightRateBreakRow = typeof commerceFreightRateBreak.$inferSelect;

export interface AdminFreightRateBreak {
  readonly id: string;
  readonly position: number;
  readonly minBillableWeightGrams: number;
  readonly minVolumeCubicCm: number;
  readonly unitPriceInCents: number;
  readonly minimumChargeInCents: number;
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
}

export interface AdminFreightRateCard {
  readonly id: string;
  readonly providerOrganizationId: string;
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly mode: FreightMode;
  readonly currency: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly sourceForwarderName: string;
  readonly volumetricDivisorCm3PerKg: number;
  readonly state: "active" | "superseded" | "withdrawn";
  readonly supersededByRateCardId: string | null;
  /**
   * §19.10. Whether the two `/breaks` routes would succeed against this card RIGHT NOW —
   * `assertCardAcceptsBreakWrites` evaluated at projection time, not a second opinion about it.
   *
   * IT IS ON THE SHARED PROJECTION, so every write answers with it too. On the staff surface
   * `validFrom` is optional on create and the controller defaults it to now, so a card keyed in
   * without an explicit future `validFrom` is in force the instant it exists and can NEVER
   * accept a band write; §19.12's provider surface refuses that body outright rather than
   * minting the same trap. A console deriving this itself would own a copy of the deciding
   * predicate and drift from the server's across clock skew — enabling a control the very next
   * request refuses.
   */
  readonly bandsEditable: boolean;
  readonly breaks: readonly AdminFreightRateBreak[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Dates, never ISO strings. Each controller converts at its own boundary. */
export interface FreightRateBreakInput {
  readonly minBillableWeightGrams: number;
  readonly minVolumeCubicCm: number;
  readonly unitPriceInCents: number;
  readonly minimumChargeInCents: number;
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
}

/**
 * The two refusals the band-write gate can produce.
 *
 * NARROWER THAN EITHER SERVICE'S ERROR UNION, and that is what makes the gate shareable:
 * both unions include these two members verbatim, so each service can return this value
 * unwrapped and still switch exhaustively over its own union.
 */
export type FreightRateCardBandWriteRefusal =
  | {
      readonly type: "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE";
      readonly rateCardId: string;
      readonly state: "superseded" | "withdrawn";
    }
  | {
      readonly type: "COMMERCE_FREIGHT_RATE_CARD_IN_FORCE";
      readonly rateCardId: string;
      readonly validFrom: Date;
    };

/**
 * Both break verbs on both surfaces share this gate, and `projectRateCard` reports its verdict
 * as `bandsEditable` — ONE function, so a list can never advertise a control the write refuses.
 *
 * A LIVE CARD'S BANDS ARE FROZEN. Breaks form a ladder, so no insertion is monotone — adding a
 * band below the top reprices weights its neighbours covered, and adding one above the top
 * reprices the weights that band used to catch. There is no safe append to a card that has
 * already quoted somebody. A live card is corrected by POSTing a new one, which supersedes;
 * this path exists so a card STAGED for next Monday can be fixed on Thursday.
 */
export function assertCardAcceptsBreakWrites(
  row: FreightRateCardRow,
  now: Date,
): FreightRateCardBandWriteRefusal | null {
  if (row.state !== "active") {
    return {
      type: "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE",
      rateCardId: row.id,
      state: row.state,
    };
  }
  if (row.validFrom <= now) {
    return {
      type: "COMMERCE_FREIGHT_RATE_CARD_IN_FORCE",
      rateCardId: row.id,
      validFrom: row.validFrom,
    };
  }
  return null;
}

export function projectBreak(row: FreightRateBreakRow): AdminFreightRateBreak {
  return {
    id: row.id,
    position: row.position,
    minBillableWeightGrams: row.minBillableWeightGrams,
    minVolumeCubicCm: row.minVolumeCubicCm,
    unitPriceInCents: row.unitPriceInCents,
    minimumChargeInCents: row.minimumChargeInCents,
    transitDaysMin: row.transitDaysMin,
    transitDaysMax: row.transitDaysMax,
  };
}

/**
 * `now` IS A PARAMETER, not a `new Date()` taken here. Every caller already minted the
 * instant it made its decision against, and a projection that read the clock a second time
 * could report `bandsEditable: true` on the very card the gate had just refused a millisecond
 * earlier — the exact disagreement this field exists to prevent. A list page mints ONE
 * instant for every row it projects, for the same reason.
 */
export function projectRateCard(
  row: FreightRateCardRow,
  breakRows: readonly FreightRateBreakRow[],
  now: Date,
): AdminFreightRateCard {
  return {
    id: row.id,
    providerOrganizationId: row.providerOrganizationId,
    originCountryCode: row.originCountryCode,
    destinationCountryCode: row.destinationCountryCode,
    mode: row.mode,
    currency: row.currency,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    sourceForwarderName: row.sourceForwarderName,
    volumetricDivisorCm3PerKg: row.volumetricDivisorCm3PerKg,
    state: row.state,
    supersededByRateCardId: row.supersededByRateCardId,
    bandsEditable: assertCardAcceptsBreakWrites(row, now) === null,
    breaks: breakRows.map(projectBreak).toSorted((left, right) => left.position - right.position),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Two bands sharing a floor make "the highest band this consignment clears" an arbitrary
 * pick, and the database refuses it. Caught HERE so the caller gets a 422 naming the
 * offending floor rather than a caught 23505 with no field.
 */
export function findDuplicatedFloor(
  breaks: readonly FreightRateBreakInput[],
): FreightRateBreakInput | null {
  const seenFloors = new Set<string>();
  for (const band of breaks) {
    const floorKey = `${band.minBillableWeightGrams}:${band.minVolumeCubicCm}`;
    if (seenFloors.has(floorKey)) {
      return band;
    }
    seenFloors.add(floorKey);
  }
  return null;
}

export async function loadBreaksForCard(
  rateCardId: string,
): Promise<readonly FreightRateBreakRow[]> {
  return db
    .select()
    .from(commerceFreightRateBreak)
    .where(eq(commerceFreightRateBreak.rateCardId, rateCardId))
    .orderBy(asc(commerceFreightRateBreak.position));
}

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface InsertFreightRateCardInput {
  readonly providerOrganizationId: string;
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly mode: FreightMode;
  readonly currency: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly sourceForwarderName: string;
  readonly volumetricDivisorCm3PerKg: number;
  readonly breaks: readonly FreightRateBreakInput[];
}

/**
 * The transactional outcome, named rather than inferred.
 *
 * `recordPlatformAction<T>` infers `T` from its `work` callback, and a callback returning a
 * discriminated union defeats that inference — the `describe` argument is checked against a
 * half-formed `T` and the whole call collapses to `unknown`. Declaring the union here and
 * passing it explicitly keeps both halves typed, for both callers.
 */
export type CreateRateCardOutcome =
  | { readonly kind: "predates"; readonly incumbent: FreightRateCardRow }
  | {
      readonly kind: "created";
      readonly insertedCard: FreightRateCardRow | undefined;
      readonly insertedBreaks: readonly FreightRateBreakRow[];
      readonly incumbent: FreightRateCardRow | undefined;
    };

/**
 * Mint a card on a lane, closing whatever card that provider already had in force there.
 *
 * TAKES `rateCardId` RATHER THAN MINTING ONE, because the caller must mint it BEFORE opening
 * the transaction: the incumbent's `supersededByRateCardId` has to point at a row that does
 * not exist yet.
 *
 * TAKES A `tx` AND APPENDS NO AUDIT. The two callers audit to different tables — the platform
 * hash chain for a moderator, the organization's own trail for a provider — and each wraps
 * this call in the transaction helper that does its own. What is shared is the concurrency
 * argument below, which is the part neither surface may get subtly different.
 */
export async function insertFreightRateCardSupersedingIncumbent(
  tx: DatabaseExecutor,
  rateCardId: string,
  input: InsertFreightRateCardInput,
): Promise<CreateRateCardOutcome> {
  /**
   * Lock and read the incumbent. `FOR UPDATE` so two concurrent creates on one lane
   * serialize instead of racing the partial unique index into a 500. The predicate is
   * exactly `commerce_freight_rate_card_active_uidx`'s columns — provider included, so a
   * second forwarder's card on the same lane is untouched (§19.5's `options[]` is plural).
   */
  const [incumbent] = await tx
    .select()
    .from(commerceFreightRateCard)
    .where(
      and(
        eq(commerceFreightRateCard.providerOrganizationId, input.providerOrganizationId),
        eq(commerceFreightRateCard.originCountryCode, input.originCountryCode),
        eq(commerceFreightRateCard.destinationCountryCode, input.destinationCountryCode),
        eq(commerceFreightRateCard.mode, input.mode),
        eq(commerceFreightRateCard.currency, input.currency),
        eq(commerceFreightRateCard.state, "active"),
      ),
    )
    .for("update")
    .limit(1);

  // A successor may not start before its predecessor did — the predecessor's own
  // `..._window_ck` would reject the close, as a 500 rather than a 422.
  if (incumbent && incumbent.validFrom >= input.validFrom) {
    return { kind: "predates", incumbent };
  }

  /**
   * CLOSE THE OUTGOING INTERVAL FIRST. `validUntil` is exclusive, so setting it to the
   * incoming card's `validFrom` leaves no gap and no overlap — the rating read sees one
   * continuous coverage. `compensation-agreements.service.ts` is the precedent, and its
   * note applies verbatim: the partial unique index would otherwise reject this insert,
   * and the correct resolution is to close the old interval rather than refuse the new
   * card.
   *
   * The incumbent flips to `superseded` IMMEDIATELY even when the successor is
   * future-dated, which is why the rating read must select on the window plus
   * `state <> 'withdrawn'` and never on `state = 'active'`.
   */
  if (incumbent) {
    await tx
      .update(commerceFreightRateCard)
      .set({
        state: "superseded",
        validUntil: input.validFrom,
        supersededByRateCardId: rateCardId,
      })
      .where(
        and(
          eq(commerceFreightRateCard.id, incumbent.id),
          // Re-asserted inside the transaction, for the reason the accept path states:
          // a concurrent write may have landed between the read and this update.
          eq(commerceFreightRateCard.state, "active"),
        ),
      );
  }

  const [insertedCard] = await tx
    .insert(commerceFreightRateCard)
    .values({
      id: rateCardId,
      providerOrganizationId: input.providerOrganizationId,
      originCountryCode: input.originCountryCode,
      destinationCountryCode: input.destinationCountryCode,
      mode: input.mode,
      currency: input.currency,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      sourceForwarderName: input.sourceForwarderName,
      volumetricDivisorCm3PerKg: input.volumetricDivisorCm3PerKg,
    })
    .returning();

  const insertedBreaks = await tx
    .insert(commerceFreightRateBreak)
    .values(
      input.breaks.map((band, index) => ({
        rateCardId,
        position: index,
        minBillableWeightGrams: band.minBillableWeightGrams,
        minVolumeCubicCm: band.minVolumeCubicCm,
        unitPriceInCents: band.unitPriceInCents,
        minimumChargeInCents: band.minimumChargeInCents,
        transitDaysMin: band.transitDaysMin,
        transitDaysMax: band.transitDaysMax,
      })),
    )
    .returning();

  return { kind: "created", insertedCard, insertedBreaks, incumbent };
}
