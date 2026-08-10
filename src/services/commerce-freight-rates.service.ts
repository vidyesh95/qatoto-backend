import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceCustomsDwellEstimate,
  commerceFreightRateBreak,
  commerceFreightRateCard,
  commerceProviderProfile,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { recordPlatformAction } from "#src/services/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/services/platform-role.service.js";
import type { FreightMode } from "#src/schemas/commerce-freight-rates.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * The §19 reference data's WRITE half — lane rate cards, their weight bands, and customs
 * dwell estimates. Every function here is staff-only and audited.
 *
 * THE ONE RULE THAT SHAPES ALL OF IT: a number that has been quotable is never rewritten.
 * A card feeds a buyer-facing range whose provenance §19.6 puts on the wire, so editing
 * `unitPriceInCents` under an unchanged `sourceForwarderName` would be a claim that
 * forwarder never made. The edit path is a NEW card, which supersedes its predecessor in one
 * transaction; the PATCH verbs can only narrow a window or withdraw a card.
 *
 * THE RATING READ DOES NOT LIVE HERE and must not select on `state = 'active'` — see
 * `createFreightRateCard`'s supersession note.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One union for both tables. There is one router, one controller and one mapper, and §19.4
 * puts freight and customs side by side in a single projection; the dwell members are
 * prefixed so the mapper's `switch` still reads by subject.
 */
export type CommerceFreightRateError =
  | PlatformAccessError
  | { type: "COMMERCE_FREIGHT_PROVIDER_NOT_FOUND"; providerOrganizationId: string }
  | { type: "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND"; rateCardId: string }
  | {
      type: "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE";
      rateCardId: string;
      state: "superseded" | "withdrawn";
    }
  | { type: "COMMERCE_FREIGHT_RATE_CARD_IN_FORCE"; rateCardId: string; validFrom: Date }
  | {
      type: "COMMERCE_FREIGHT_RATE_CARD_PREDATES_PREDECESSOR";
      predecessorRateCardId: string;
      predecessorValidFrom: Date;
    }
  | { type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_WIDENED"; currentValidUntil: Date }
  | { type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_EMPTY"; validFrom: Date; validUntil: Date }
  | {
      type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED";
      minBillableWeightGrams: number;
      minVolumeCubicCm: number;
    }
  | { type: "COMMERCE_CUSTOMS_DWELL_ESTIMATE_NOT_FOUND"; dwellEstimateId: string }
  | { type: "COMMERCE_CUSTOMS_DWELL_COMMODITY_NOT_FOUND"; commodityScopeCategoryId: string }
  | {
      type: "COMMERCE_CUSTOMS_DWELL_OVERLAPS";
      dwellEstimateId: string;
      validFrom: Date;
      validUntil: Date | null;
    }
  | { type: "COMMERCE_CUSTOMS_DWELL_ALREADY_CLOSED"; dwellEstimateId: string; validUntil: Date }
  | { type: "COMMERCE_CUSTOMS_DWELL_WINDOW_EMPTY"; validFrom: Date; validUntil: Date }
  | { type: "COMMERCE_CUSTOMS_DWELL_WINDOW_WIDENED"; currentValidUntil: Date };

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

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
  readonly breaks: readonly AdminFreightRateBreak[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminCustomsDwellEstimate {
  readonly id: string;
  readonly destinationCountryCode: string;
  readonly originCountryCode: string | null;
  readonly commodityScopeCategoryId: string | null;
  readonly clearanceDaysMin: number;
  readonly clearanceDaysMax: number;
  readonly source: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Inputs — Dates, never ISO strings. The controller converts at the boundary.
// ---------------------------------------------------------------------------

export interface FreightRateBreakInput {
  readonly minBillableWeightGrams: number;
  readonly minVolumeCubicCm: number;
  readonly unitPriceInCents: number;
  readonly minimumChargeInCents: number;
  readonly transitDaysMin: number;
  readonly transitDaysMax: number;
}

export interface CreateFreightRateCardInput {
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

export type UpdateFreightRateCardInput =
  | { readonly intent: "shorten_window"; readonly validUntil: Date }
  | { readonly intent: "withdraw"; readonly reasonNote: string };

export interface CreateCustomsDwellEstimateInput {
  readonly destinationCountryCode: string;
  readonly originCountryCode: string | null;
  readonly commodityScopeCategoryId: string | null;
  readonly clearanceDaysMin: number;
  readonly clearanceDaysMax: number;
  readonly source: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

type RateCardRow = typeof commerceFreightRateCard.$inferSelect;
type RateBreakRow = typeof commerceFreightRateBreak.$inferSelect;
type DwellEstimateRow = typeof commerceCustomsDwellEstimate.$inferSelect;

/**
 * The transactional outcomes, named rather than inferred.
 *
 * `recordPlatformAction<T>` infers `T` from its `work` callback, and a callback returning a
 * discriminated union defeats that inference — the `describe` argument is checked against a
 * half-formed `T` and the whole call collapses to `unknown`. Declaring the union here and
 * passing it explicitly keeps both halves typed.
 */
type CreateRateCardOutcome =
  | { readonly kind: "predates"; readonly incumbent: RateCardRow }
  | {
      readonly kind: "created";
      readonly insertedCard: RateCardRow | undefined;
      readonly insertedBreaks: readonly RateBreakRow[];
      readonly incumbent: RateCardRow | undefined;
    };

type CreateDwellEstimateOutcome =
  | { readonly kind: "overlaps"; readonly conflicting: DwellEstimateRow }
  | {
      readonly kind: "created";
      readonly inserted: DwellEstimateRow | undefined;
      readonly closed: DwellEstimateRow | null;
    };

interface ReplaceBreaksOutcome {
  readonly previousBreakCount: number;
  readonly insertedBreaks: readonly RateBreakRow[];
}

function projectBreak(row: RateBreakRow): AdminFreightRateBreak {
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

function projectRateCard(
  row: RateCardRow,
  breakRows: readonly RateBreakRow[],
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
    breaks: breakRows.map(projectBreak).toSorted((left, right) => left.position - right.position),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function projectDwellEstimate(row: DwellEstimateRow): AdminCustomsDwellEstimate {
  return {
    id: row.id,
    destinationCountryCode: row.destinationCountryCode,
    originCountryCode: row.originCountryCode,
    commodityScopeCategoryId: row.commodityScopeCategoryId,
    clearanceDaysMin: row.clearanceDaysMin,
    clearanceDaysMax: row.clearanceDaysMax,
    source: row.source,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Two bands sharing a floor make "the highest band this consignment clears" an arbitrary
 * pick, and the database refuses it. Caught HERE so the caller gets a 422 naming the
 * offending floor rather than a caught 23505 with no field.
 */
function findDuplicatedFloor(
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

async function loadBreaksForCard(rateCardId: string): Promise<readonly RateBreakRow[]> {
  return db
    .select()
    .from(commerceFreightRateBreak)
    .where(eq(commerceFreightRateBreak.rateCardId, rateCardId))
    .orderBy(asc(commerceFreightRateBreak.position));
}

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------

export async function createFreightRateCard(
  actorUserId: string,
  input: CreateFreightRateCardInput,
): Promise<
  Result<
    { readonly rateCard: AdminFreightRateCard; readonly supersededRateCardId: string | null },
    CommerceFreightRateError
  >
> {
  // 1. CAPABILITY FIRST — before any id in the body is read. Reversed, the 403/404
  //    difference turns this route into an id oracle for anyone holding a session.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second. The FK would also reject an unknown provider, but as a 500.
  const [providerProfile] = await db
    .select({ organizationId: commerceProviderProfile.organizationId })
    .from(commerceProviderProfile)
    .where(eq(commerceProviderProfile.organizationId, input.providerOrganizationId))
    .limit(1);

  if (!providerProfile) {
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_PROVIDER_NOT_FOUND",
        providerOrganizationId: input.providerOrganizationId,
      },
    };
  }

  if (input.validUntil !== null && input.validUntil <= input.validFrom) {
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_EMPTY",
        validFrom: input.validFrom,
        validUntil: input.validUntil,
      },
    };
  }

  const duplicatedFloor = findDuplicatedFloor(input.breaks);
  if (duplicatedFloor) {
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED",
        minBillableWeightGrams: duplicatedFloor.minBillableWeightGrams,
        minVolumeCubicCm: duplicatedFloor.minVolumeCubicCm,
      },
    };
  }

  // Minted BEFORE the transaction so the incumbent's `supersededByRateCardId` can point at
  // a card that does not exist yet.
  const rateCardId = randomUUID();

  const outcome = await recordPlatformAction<CreateRateCardOutcome>(
    async (tx) => {
      /**
       * Lock and read the incumbent. `FOR UPDATE` so two concurrent creates on one lane
       * serialize instead of racing the partial unique index into a 500.
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
        return { kind: "predates" as const, incumbent };
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

      return { kind: "created" as const, insertedCard, insertedBreaks, incumbent };
    },
    (value) =>
      value.kind !== "created" || value.insertedCard === undefined
        ? // A decision that did not happen must not be recorded as one.
          null
        : {
            eventKind: "commerce_freight_rate_card_created",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Created a freight lane rate card",
            targetLabel: `${input.originCountryCode}→${input.destinationCountryCode} ${input.mode} (${input.currency})`,
            detailNote: input.sourceForwarderName,
            payload: {
              rateCardId,
              providerOrganizationId: input.providerOrganizationId,
              originCountryCode: input.originCountryCode,
              destinationCountryCode: input.destinationCountryCode,
              mode: input.mode,
              currency: input.currency,
              validFrom: input.validFrom.toISOString(),
              validUntil: input.validUntil === null ? null : input.validUntil.toISOString(),
              volumetricDivisorCm3PerKg: String(input.volumetricDivisorCm3PerKg),
              breakCount: String(input.breaks.length),
              // The supersession rides in the create's payload rather than a second entry:
              // it is a consequence of this decision, not a decision of its own.
              supersededRateCardId: value.incumbent?.id ?? null,
            },
            occurredAt: new Date(),
          },
  );

  if (outcome.kind === "predates") {
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_PREDATES_PREDECESSOR",
        predecessorRateCardId: outcome.incumbent.id,
        predecessorValidFrom: outcome.incumbent.validFrom,
      },
    };
  }

  if (!outcome.insertedCard) {
    throw new Error("createFreightRateCard: insert returned no row");
  }

  return {
    success: true,
    value: {
      rateCard: projectRateCard(outcome.insertedCard, outcome.insertedBreaks),
      supersededRateCardId: outcome.incumbent?.id ?? null,
    },
  };
}

export async function updateFreightRateCard(
  actorUserId: string,
  rateCardId: string,
  input: UpdateFreightRateCardInput,
): Promise<Result<AdminFreightRateCard, CommerceFreightRateError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const [existing] = await db
    .select()
    .from(commerceFreightRateCard)
    .where(eq(commerceFreightRateCard.id, rateCardId))
    .limit(1);

  if (!existing) {
    return {
      success: false,
      error: { type: "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND", rateCardId },
    };
  }

  if (existing.state !== "active") {
    return {
      success: false,
      error: { type: "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE", rateCardId, state: existing.state },
    };
  }

  if (input.intent === "shorten_window") {
    if (input.validUntil <= existing.validFrom) {
      return {
        success: false,
        error: {
          type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_EMPTY",
          validFrom: existing.validFrom,
          validUntil: input.validUntil,
        },
      };
    }

    // Narrowing only. Pushing an end date outward re-sells an expired list under its old
    // provenance, and §19.6 says an expired card is not a price.
    if (existing.validUntil !== null && input.validUntil > existing.validUntil) {
      return {
        success: false,
        error: {
          type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_WIDENED",
          currentValidUntil: existing.validUntil,
        },
      };
    }
  }

  const updatedRow = await recordPlatformAction(
    async (tx) => {
      const [row] = await tx
        .update(commerceFreightRateCard)
        .set(
          input.intent === "shorten_window"
            ? { validUntil: input.validUntil }
            : { state: "withdrawn" },
        )
        // The conditional predicate IS the concurrency guard: a card withdrawn by a
        // concurrent request matches nothing here rather than being withdrawn twice.
        .where(
          and(
            eq(commerceFreightRateCard.id, rateCardId),
            eq(commerceFreightRateCard.state, "active"),
          ),
        )
        .returning();

      return row;
    },
    (row) =>
      row === undefined
        ? null
        : {
            eventKind:
              input.intent === "shorten_window"
                ? "commerce_freight_rate_card_window_shortened"
                : "commerce_freight_rate_card_withdrawn",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel:
              input.intent === "shorten_window"
                ? "Shortened a freight lane rate card's validity"
                : "Withdrew a freight lane rate card",
            targetLabel: `${row.originCountryCode}→${row.destinationCountryCode} ${row.mode} (${row.currency})`,
            detailNote:
              input.intent === "shorten_window" ? row.sourceForwarderName : input.reasonNote,
            payload: {
              rateCardId,
              providerOrganizationId: row.providerOrganizationId,
              validFrom: row.validFrom.toISOString(),
              validUntil: row.validUntil === null ? null : row.validUntil.toISOString(),
              state: row.state,
            },
            occurredAt: new Date(),
          },
  );

  if (!updatedRow) {
    // The row was `active` a moment ago and is not now — a concurrent withdraw or
    // supersession landed. That is a state conflict, not a missing card.
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE",
        rateCardId,
        state: "withdrawn",
      },
    };
  }

  return { success: true, value: projectRateCard(updatedRow, await loadBreaksForCard(rateCardId)) };
}

// ---------------------------------------------------------------------------
// Breaks
// ---------------------------------------------------------------------------

/**
 * Both break verbs share this gate.
 *
 * A LIVE CARD'S BANDS ARE FROZEN. Breaks form a ladder, so no insertion is monotone —
 * adding a band below the top reprices weights its neighbours covered, and adding one above
 * the top reprices the weights that band used to catch. There is no safe append to a card
 * that has already quoted somebody. A live card is corrected by POSTing a new one, which
 * supersedes; this path exists so a card STAGED for next Monday can be fixed on Thursday.
 */
function assertCardAcceptsBreakWrites(
  row: RateCardRow,
  now: Date,
): CommerceFreightRateError | null {
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

export async function appendFreightRateBreak(
  actorUserId: string,
  rateCardId: string,
  input: FreightRateBreakInput,
): Promise<Result<AdminFreightRateCard, CommerceFreightRateError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const [existing] = await db
    .select()
    .from(commerceFreightRateCard)
    .where(eq(commerceFreightRateCard.id, rateCardId))
    .limit(1);

  if (!existing) {
    return {
      success: false,
      error: { type: "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND", rateCardId },
    };
  }

  const gateError = assertCardAcceptsBreakWrites(existing, new Date());
  if (gateError) {
    return { success: false, error: gateError };
  }

  try {
    const inserted = await recordPlatformAction(
      async (tx) => {
        const [highest] = await tx
          .select({ position: commerceFreightRateBreak.position })
          .from(commerceFreightRateBreak)
          .where(eq(commerceFreightRateBreak.rateCardId, rateCardId))
          .orderBy(desc(commerceFreightRateBreak.position))
          .for("update")
          .limit(1);

        const [row] = await tx
          .insert(commerceFreightRateBreak)
          .values({
            rateCardId,
            position: highest === undefined ? 0 : highest.position + 1,
            minBillableWeightGrams: input.minBillableWeightGrams,
            minVolumeCubicCm: input.minVolumeCubicCm,
            unitPriceInCents: input.unitPriceInCents,
            minimumChargeInCents: input.minimumChargeInCents,
            transitDaysMin: input.transitDaysMin,
            transitDaysMax: input.transitDaysMax,
          })
          .returning();

        return row;
      },
      (row) =>
        row === undefined
          ? null
          : {
              eventKind: "commerce_freight_rate_break_added",
              actorUserId,
              actorRoleSnapshot: capabilityResult.value.platformRole,
              actionLabel: "Added a freight rate band",
              targetLabel: `${existing.originCountryCode}→${existing.destinationCountryCode} ${existing.mode} (${existing.currency})`,
              detailNote: existing.sourceForwarderName,
              payload: {
                rateCardId,
                rateBreakId: row.id,
                position: String(row.position),
                minBillableWeightGrams: String(row.minBillableWeightGrams),
                minVolumeCubicCm: String(row.minVolumeCubicCm),
                unitPriceInCents: String(row.unitPriceInCents),
              },
              occurredAt: new Date(),
            },
    );

    if (!inserted) {
      throw new Error("appendFreightRateBreak: insert returned no row");
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: {
          type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED",
          minBillableWeightGrams: input.minBillableWeightGrams,
          minVolumeCubicCm: input.minVolumeCubicCm,
        },
      };
    }
    throw error;
  }

  return { success: true, value: projectRateCard(existing, await loadBreaksForCard(rateCardId)) };
}

export async function replaceFreightRateBreaks(
  actorUserId: string,
  rateCardId: string,
  input: { readonly breaks: readonly FreightRateBreakInput[] },
): Promise<Result<AdminFreightRateCard, CommerceFreightRateError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const [existing] = await db
    .select()
    .from(commerceFreightRateCard)
    .where(eq(commerceFreightRateCard.id, rateCardId))
    .limit(1);

  if (!existing) {
    return {
      success: false,
      error: { type: "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND", rateCardId },
    };
  }

  const gateError = assertCardAcceptsBreakWrites(existing, new Date());
  if (gateError) {
    return { success: false, error: gateError };
  }

  const duplicatedFloor = findDuplicatedFloor(input.breaks);
  if (duplicatedFloor) {
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED",
        minBillableWeightGrams: duplicatedFloor.minBillableWeightGrams,
        minVolumeCubicCm: duplicatedFloor.minVolumeCubicCm,
      },
    };
  }

  const replaced = await recordPlatformAction<ReplaceBreaksOutcome>(
    async (tx) => {
      const removed = await tx
        .delete(commerceFreightRateBreak)
        .where(eq(commerceFreightRateBreak.rateCardId, rateCardId))
        .returning({ id: commerceFreightRateBreak.id });

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

      return { previousBreakCount: removed.length, insertedBreaks };
    },
    (value) => ({
      eventKind: "commerce_freight_rate_breaks_replaced",
      actorUserId,
      actorRoleSnapshot: capabilityResult.value.platformRole,
      actionLabel: "Replaced a freight rate card's bands",
      targetLabel: `${existing.originCountryCode}→${existing.destinationCountryCode} ${existing.mode} (${existing.currency})`,
      detailNote: existing.sourceForwarderName,
      payload: {
        rateCardId,
        previousBreakCount: String(value.previousBreakCount),
        breakCount: String(value.insertedBreaks.length),
      },
      occurredAt: new Date(),
    }),
  );

  return { success: true, value: projectRateCard(existing, replaced.insertedBreaks) };
}

// ---------------------------------------------------------------------------
// Customs dwell
// ---------------------------------------------------------------------------

export async function createCustomsDwellEstimate(
  actorUserId: string,
  input: CreateCustomsDwellEstimateInput,
): Promise<
  Result<
    {
      readonly dwellEstimate: AdminCustomsDwellEstimate;
      readonly closedDwellEstimateId: string | null;
    },
    CommerceFreightRateError
  >
> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  if (input.commodityScopeCategoryId !== null) {
    const [category] = await db
      .select({ id: commerceCategory.id })
      .from(commerceCategory)
      .where(eq(commerceCategory.id, input.commodityScopeCategoryId))
      .limit(1);

    if (!category) {
      return {
        success: false,
        error: {
          type: "COMMERCE_CUSTOMS_DWELL_COMMODITY_NOT_FOUND",
          commodityScopeCategoryId: input.commodityScopeCategoryId,
        },
      };
    }
  }

  if (input.validUntil !== null && input.validUntil <= input.validFrom) {
    return {
      success: false,
      error: {
        type: "COMMERCE_CUSTOMS_DWELL_WINDOW_EMPTY",
        validFrom: input.validFrom,
        validUntil: input.validUntil,
      },
    };
  }

  /**
   * The scope key. NULL is a VALUE here — "any origin", "any commodity" — so the predicate
   * matches on `IS NULL` rather than on equality, which would silently match nothing.
   */
  const scopePredicate = and(
    eq(commerceCustomsDwellEstimate.destinationCountryCode, input.destinationCountryCode),
    input.originCountryCode === null
      ? isNull(commerceCustomsDwellEstimate.originCountryCode)
      : eq(commerceCustomsDwellEstimate.originCountryCode, input.originCountryCode),
    input.commodityScopeCategoryId === null
      ? isNull(commerceCustomsDwellEstimate.commodityScopeCategoryId)
      : eq(
          commerceCustomsDwellEstimate.commodityScopeCategoryId,
          input.commodityScopeCategoryId,
        ),
  );

  const outcome = await recordPlatformAction<CreateDwellEstimateOutcome>(
    async (tx) => {
      // Every row on this scope, locked: the open-ended one to close, the closed ones to
      // check for overlap. One lock, one scan.
      const scoped = await tx
        .select()
        .from(commerceCustomsDwellEstimate)
        .where(scopePredicate)
        .for("update");

      const openEnded = scoped.find((row) => row.validUntil === null);

      if (openEnded && openEnded.validFrom >= input.validFrom) {
        return { kind: "overlaps" as const, conflicting: openEnded };
      }

      /**
       * Overlap between two CLOSED windows on one scope. The partial unique index cannot
       * express this — `now()` is not IMMUTABLE and a real exclusion would need
       * `btree_gist` — so it is answered here, as a 409 naming the row in the way.
       */
      const incomingUntil = input.validUntil;
      const conflicting = scoped.find((row) => {
        if (row.id === openEnded?.id) {
          return false;
        }
        const rowEndsAfterIncomingStarts =
          row.validUntil === null || row.validUntil > input.validFrom;
        const incomingEndsAfterRowStarts = incomingUntil === null || incomingUntil > row.validFrom;
        return rowEndsAfterIncomingStarts && incomingEndsAfterRowStarts;
      });

      if (conflicting) {
        return { kind: "overlaps" as const, conflicting };
      }

      // Close the outgoing interval at the incoming start — exclusive, so no gap, no overlap.
      if (openEnded) {
        await tx
          .update(commerceCustomsDwellEstimate)
          .set({ validUntil: input.validFrom })
          .where(
            and(
              eq(commerceCustomsDwellEstimate.id, openEnded.id),
              isNull(commerceCustomsDwellEstimate.validUntil),
            ),
          );
      }

      const [inserted] = await tx
        .insert(commerceCustomsDwellEstimate)
        .values({
          destinationCountryCode: input.destinationCountryCode,
          originCountryCode: input.originCountryCode,
          commodityScopeCategoryId: input.commodityScopeCategoryId,
          clearanceDaysMin: input.clearanceDaysMin,
          clearanceDaysMax: input.clearanceDaysMax,
          source: input.source,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
        })
        .returning();

      return { kind: "created" as const, inserted, closed: openEnded ?? null };
    },
    (value) =>
      value.kind !== "created" || value.inserted === undefined
        ? null
        : {
            eventKind: "commerce_customs_dwell_estimate_created",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Recorded a customs dwell estimate",
            targetLabel: `${input.originCountryCode ?? "any"}→${input.destinationCountryCode}`,
            detailNote: input.source,
            payload: {
              dwellEstimateId: value.inserted.id,
              destinationCountryCode: input.destinationCountryCode,
              originCountryCode: input.originCountryCode,
              commodityScopeCategoryId: input.commodityScopeCategoryId,
              clearanceDaysMin: String(input.clearanceDaysMin),
              clearanceDaysMax: String(input.clearanceDaysMax),
              validFrom: input.validFrom.toISOString(),
              closedDwellEstimateId: value.closed?.id ?? null,
            },
            occurredAt: new Date(),
          },
  );

  if (outcome.kind === "overlaps") {
    return {
      success: false,
      error: {
        type: "COMMERCE_CUSTOMS_DWELL_OVERLAPS",
        dwellEstimateId: outcome.conflicting.id,
        validFrom: outcome.conflicting.validFrom,
        validUntil: outcome.conflicting.validUntil,
      },
    };
  }

  if (!outcome.inserted) {
    throw new Error("createCustomsDwellEstimate: insert returned no row");
  }

  return {
    success: true,
    value: {
      dwellEstimate: projectDwellEstimate(outcome.inserted),
      closedDwellEstimateId: outcome.closed?.id ?? null,
    },
  };
}

export async function retireCustomsDwellEstimate(
  actorUserId: string,
  dwellEstimateId: string,
  input: { readonly validUntil: Date },
): Promise<Result<AdminCustomsDwellEstimate, CommerceFreightRateError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const [existing] = await db
    .select()
    .from(commerceCustomsDwellEstimate)
    .where(eq(commerceCustomsDwellEstimate.id, dwellEstimateId))
    .limit(1);

  if (!existing) {
    return {
      success: false,
      error: { type: "COMMERCE_CUSTOMS_DWELL_ESTIMATE_NOT_FOUND", dwellEstimateId },
    };
  }

  // The table has no `state`, so a closed window IS a retired estimate. Closing one twice is
  // a state conflict, and re-closing it later would push the end date outward.
  if (existing.validUntil !== null) {
    return {
      success: false,
      error: {
        type: "COMMERCE_CUSTOMS_DWELL_ALREADY_CLOSED",
        dwellEstimateId,
        validUntil: existing.validUntil,
      },
    };
  }

  if (input.validUntil <= existing.validFrom) {
    return {
      success: false,
      error: {
        type: "COMMERCE_CUSTOMS_DWELL_WINDOW_EMPTY",
        validFrom: existing.validFrom,
        validUntil: input.validUntil,
      },
    };
  }

  const retiredRow = await recordPlatformAction(
    async (tx) => {
      const [row] = await tx
        .update(commerceCustomsDwellEstimate)
        .set({ validUntil: input.validUntil })
        .where(
          and(
            eq(commerceCustomsDwellEstimate.id, dwellEstimateId),
            isNull(commerceCustomsDwellEstimate.validUntil),
          ),
        )
        .returning();

      return row;
    },
    (row) =>
      row === undefined
        ? null
        : {
            eventKind: "commerce_customs_dwell_estimate_retired",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Retired a customs dwell estimate",
            targetLabel: `${row.originCountryCode ?? "any"}→${row.destinationCountryCode}`,
            detailNote: row.source,
            payload: {
              dwellEstimateId,
              validFrom: row.validFrom.toISOString(),
              validUntil: input.validUntil.toISOString(),
            },
            occurredAt: new Date(),
          },
  );

  if (!retiredRow) {
    return {
      success: false,
      error: {
        type: "COMMERCE_CUSTOMS_DWELL_ALREADY_CLOSED",
        dwellEstimateId,
        validUntil: input.validUntil,
      },
    };
  }

  return { success: true, value: projectDwellEstimate(retiredRow) };
}
