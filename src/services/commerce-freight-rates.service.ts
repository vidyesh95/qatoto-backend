import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNull, lt, or, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceCustomsDwellEstimate,
  commerceFreightRateBreak,
  commerceFreightRateCard,
  commerceProviderProfile,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import {
  ANY_SCOPE_FILTER,
  type FreightMode,
  type FreightRateCardState,
} from "#src/schemas/commerce-freight-rates.schemas.js";
import { recordPlatformAction } from "#src/services/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The §19 reference data — lane rate cards, their weight bands, and customs dwell estimates.
 * Every function here is staff-only; every WRITE is additionally audited.
 *
 * THE READS AT THE FOOT OF THIS FILE ARE THE OPERATOR'S, NOT THE BUYER'S (§19.10), and they
 * belong here rather than beside the rating read for the reason the whole file exists: they
 * answer "what reference rows are there", which is a question about this table, while the
 * rating read answers "what does this lane cost", which is a question about a shipment. They
 * are NOT audited — reading reference data decides nothing, and an audit chain that records
 * page views buries the decisions it exists to preserve.
 *
 * THE ONE RULE THAT SHAPES THE WRITES: a number that has been quotable is never rewritten.
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
  | { type: "COMMERCE_CUSTOMS_DWELL_WINDOW_WIDENED"; currentValidUntil: Date }
  /**
   * §19.10's reads. UNPREFIXED, unlike every member above it, and that is the repo's spelling
   * rather than an oversight — a dozen other error unions carry `INVALID_CURSOR` verbatim
   * because a malformed cursor is a transport fault, not a fact about freight. Answered `422`
   * naming `cursor`, never a silent first page: a client that silently restarts a list shows
   * duplicates and reports it as a backend bug.
   */
  | { type: "INVALID_CURSOR" };

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
  /**
   * §19.10. Whether the two `/breaks` routes would succeed against this card RIGHT NOW —
   * `assertCardAcceptsBreakWrites` evaluated at projection time, not a second opinion about it.
   *
   * IT IS ON THE SHARED PROJECTION, so the six writes answer with it too. `validFrom` is
   * optional on create and the controller defaults it to now, so a card keyed in without an
   * explicit future `validFrom` is in force the instant it exists and can NEVER accept a band
   * write. A console deriving this itself would own a copy of the deciding predicate and drift
   * from the server's across clock skew — enabling a control the very next request refuses.
   */
  readonly bandsEditable: boolean;
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

/**
 * §19.10's filters. Every field optional — an absent filter is "do not narrow on this", which
 * is not the same as any value the field could take.
 */
export interface ListFreightRateCardsInput {
  readonly originCountryCode?: string | undefined;
  readonly destinationCountryCode?: string | undefined;
  readonly mode?: FreightMode | undefined;
  readonly providerOrganizationId?: string | undefined;
  readonly state?: FreightRateCardState | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ListCustomsDwellEstimatesInput {
  readonly destinationCountryCode?: string | undefined;
  /** `"any"` selects the rows stored as NULL — "scoped to any origin" (§19.3). */
  readonly originCountryCode?: string | undefined;
  /** `"any"` selects the rows stored as NULL — "scoped to any commodity". */
  readonly commodityScopeCategoryId?: string | undefined;
  readonly openOnly?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/** §7's list envelope, one shape for both reads. */
export interface AdminReferencePage<TItem> {
  readonly items: readonly TItem[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

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

/**
 * Both break verbs share this gate, and `projectRateCard` reports its verdict as
 * `bandsEditable` — ONE function, so a list can never advertise a control the write refuses.
 *
 * A LIVE CARD'S BANDS ARE FROZEN. Breaks form a ladder, so no insertion is monotone —
 * adding a band below the top reprices weights its neighbours covered, and adding one above
 * the top reprices the weights that band used to catch. There is no safe append to a card
 * that has already quoted somebody. A live card is corrected by POSTing a new one, which
 * supersedes; this path exists so a card STAGED for next Monday can be fixed on Thursday.
 *
 * DECLARED HERE, ABOVE THE PROJECTIONS, rather than beside the two verbs that enforce it:
 * the projection is now its second caller and a function must precede the code that reads it
 * in a file this long.
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

/**
 * `now` IS A PARAMETER, not a `new Date()` taken here. Every caller already minted the
 * instant it made its decision against, and a projection that read the clock a second time
 * could report `bandsEditable: true` on the very card the gate had just refused a millisecond
 * earlier — the exact disagreement this field exists to prevent.
 */
function projectRateCard(
  row: RateCardRow,
  breakRows: readonly RateBreakRow[],
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
      // The reply's `bandsEditable` is the caller's answer to "can I still fix this?", and it
      // is `false` for any card created without an explicit future `validFrom` — the default
      // the controller supplies puts the card in force immediately.
      rateCard: projectRateCard(outcome.insertedCard, outcome.insertedBreaks, new Date()),
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

  return {
    success: true,
    value: projectRateCard(updatedRow, await loadBreaksForCard(rateCardId), new Date()),
  };
}

// ---------------------------------------------------------------------------
// Breaks
// ---------------------------------------------------------------------------

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

  // ONE INSTANT for the gate and for the reply's `bandsEditable`. Two `new Date()`s could
  // straddle `validFrom` and answer "your bands are editable" to the request that just edited
  // them for the last time.
  const now = new Date();
  const gateError = assertCardAcceptsBreakWrites(existing, now);
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

  return {
    success: true,
    value: projectRateCard(existing, await loadBreaksForCard(rateCardId), now),
  };
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

  // One instant for the gate and the reply, for `appendFreightRateBreak`'s reason.
  const now = new Date();
  const gateError = assertCardAcceptsBreakWrites(existing, now);
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

  return { success: true, value: projectRateCard(existing, replaced.insertedBreaks, now) };
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
      : eq(commerceCustomsDwellEstimate.commodityScopeCategoryId, input.commodityScopeCategoryId),
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

// ---------------------------------------------------------------------------
// The operator's reads (§19.10)
// ---------------------------------------------------------------------------

/** `commerce-trust.service.ts`'s figure, so one page size means one thing platform-wide. */
const DEFAULT_PAGE_LIMIT = 20;

/**
 * BOTH READS ORDER ON `(validFrom DESC, id ASC)`, and the keyset is written out at each of the
 * two call sites rather than shared through a helper — a helper would have to be generic over
 * two tables' columns to buy four lines, which `commerce-trust`, `commerce-fulfillment` and
 * `commerce-content-reports` each already declined to do.
 *
 * `validFrom` RATHER THAN `createdAt`, which is what most lists in this repo order on. A rate
 * card's subject is the day its prices START APPLYING, and a card keyed in on Friday for next
 * quarter belongs where an operator looks for next quarter — not at the top because it was
 * typed most recently. `createdAt` would sort the console by data-entry order, which is a fact
 * about the admin rather than about the tariff.
 *
 * ID LAST AND ASCENDING while the instant descends. Two rows can share a `validFrom` — the
 * supersession path sets a successor's `validFrom` to the incumbent's `validUntil`, and nothing
 * stops two lanes being staged for one midnight — so the tiebreak must be total, or the page
 * boundary silently drops whichever row loses the tie.
 */

/**
 * `GET /commerce/admin/freight-rate-cards` — what this platform currently prices, and with what.
 *
 * THE READ THAT MAKES THE WRITES REACHABLE. Four of §6.8's six writes take a `rateCardId` or a
 * `dwellEstimateId` that no other route yields, so before this existed the lifecycle half of
 * the admin surface — shorten, withdraw, fix the bands — could not be called at all.
 *
 * IT IS ALSO THE ONLY WAY TO SEE A SUPERSESSION COMING. `createFreightRateCard` closes the
 * incumbent inside its own transaction and reports `supersededRateCardId` solely in the reply
 * to the request that did it; an operator without this list overwrites a live price and learns
 * a price existed only afterwards. §19.6 requires a missing component to be NAMED rather than
 * defaulted, and a console that cannot name the card it is about to replace breaks that rule
 * one level up — at the price list instead of the price.
 */
export async function listFreightRateCards(
  actorUserId: string,
  input: ListFreightRateCardsInput,
): Promise<Result<AdminReferencePage<AdminFreightRateCard>, CommerceFreightRateError>> {
  // CAPABILITY FIRST, before a single filter value is read — the same first statement as all
  // six writes, and for the identical reason: reversed, the 403/404 difference would make this
  // route an oracle for which provider organizations and lanes exist.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;

  let cursorPredicate: SQL | undefined;
  if (input.cursor !== undefined) {
    const decodedCursor = decodeTimestampStoreCursor(input.cursor);
    if (!decodedCursor) {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    cursorPredicate = or(
      lt(commerceFreightRateCard.validFrom, decodedCursor.sortKey),
      and(
        eq(commerceFreightRateCard.validFrom, decodedCursor.sortKey),
        gt(commerceFreightRateCard.id, decodedCursor.id),
      ),
    );
  }

  const cardRows = await db
    .select()
    .from(commerceFreightRateCard)
    .where(
      and(
        input.originCountryCode === undefined
          ? undefined
          : eq(commerceFreightRateCard.originCountryCode, input.originCountryCode),
        input.destinationCountryCode === undefined
          ? undefined
          : eq(commerceFreightRateCard.destinationCountryCode, input.destinationCountryCode),
        input.mode === undefined ? undefined : eq(commerceFreightRateCard.mode, input.mode),
        input.providerOrganizationId === undefined
          ? undefined
          : eq(commerceFreightRateCard.providerOrganizationId, input.providerOrganizationId),
        input.state === undefined ? undefined : eq(commerceFreightRateCard.state, input.state),
        cursorPredicate,
      ),
    )
    .orderBy(desc(commerceFreightRateCard.validFrom), asc(commerceFreightRateCard.id))
    .limit(limit + 1);

  const hasMore = cardRows.length > limit;
  const pageRows = hasMore ? cardRows.slice(0, limit) : cardRows;

  /**
   * ONE QUERY FOR EVERY BAND ON THE PAGE, not `loadBreaksForCard` per row. A card carries up
   * to twenty bands and a page up to fifty cards, so the per-row shape is fifty round trips
   * to save a `Map` — and the write paths that call `loadBreaksForCard` hold exactly one card,
   * which is why it stays.
   */
  const pageCardIds = pageRows.map((row) => row.id);
  const breakRowsByCardId = new Map<string, RateBreakRow[]>();
  if (pageCardIds.length > 0) {
    const allBreakRows = await db
      .select()
      .from(commerceFreightRateBreak)
      .where(inArray(commerceFreightRateBreak.rateCardId, pageCardIds))
      .orderBy(asc(commerceFreightRateBreak.rateCardId), asc(commerceFreightRateBreak.position));

    for (const breakRow of allBreakRows) {
      const existingBands = breakRowsByCardId.get(breakRow.rateCardId);
      if (existingBands) {
        existingBands.push(breakRow);
      } else {
        breakRowsByCardId.set(breakRow.rateCardId, [breakRow]);
      }
    }
  }

  // ONE INSTANT for the whole page, so two cards staged either side of the same second cannot
  // disagree about what "editable now" meant within a single response.
  const now = new Date();
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: pageRows.map((row) => projectRateCard(row, breakRowsByCardId.get(row.id) ?? [], now)),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({ sortKey: lastRow.validFrom.toISOString(), id: lastRow.id })
            : null,
        hasMore,
      },
    },
  };
}

/**
 * `GET /commerce/admin/customs-dwell-estimates` — what this platform believes about borders.
 *
 * `originCountryCode` AND `commodityScopeCategoryId` ARE NULLABLE ON THE ROW AND MEAN "ANY".
 * The create body refuses omission and demands an explicit `null` for that reason, and this
 * filter inherits the distinction: the literal `"any"` selects the NULL rows, a real value
 * selects that value, and an absent key narrows on nothing. Collapsing the first and third
 * would leave the any-origin rows — the broadest claims the platform makes — unfindable.
 */
export async function listCustomsDwellEstimates(
  actorUserId: string,
  input: ListCustomsDwellEstimatesInput,
): Promise<Result<AdminReferencePage<AdminCustomsDwellEstimate>, CommerceFreightRateError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;

  let cursorPredicate: SQL | undefined;
  if (input.cursor !== undefined) {
    const decodedCursor = decodeTimestampStoreCursor(input.cursor);
    if (!decodedCursor) {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    cursorPredicate = or(
      lt(commerceCustomsDwellEstimate.validFrom, decodedCursor.sortKey),
      and(
        eq(commerceCustomsDwellEstimate.validFrom, decodedCursor.sortKey),
        gt(commerceCustomsDwellEstimate.id, decodedCursor.id),
      ),
    );
  }

  const originPredicate =
    input.originCountryCode === undefined
      ? undefined
      : input.originCountryCode === ANY_SCOPE_FILTER
        ? isNull(commerceCustomsDwellEstimate.originCountryCode)
        : eq(commerceCustomsDwellEstimate.originCountryCode, input.originCountryCode);

  const commodityPredicate =
    input.commodityScopeCategoryId === undefined
      ? undefined
      : input.commodityScopeCategoryId === ANY_SCOPE_FILTER
        ? isNull(commerceCustomsDwellEstimate.commodityScopeCategoryId)
        : eq(commerceCustomsDwellEstimate.commodityScopeCategoryId, input.commodityScopeCategoryId);

  const dwellRows = await db
    .select()
    .from(commerceCustomsDwellEstimate)
    .where(
      and(
        input.destinationCountryCode === undefined
          ? undefined
          : eq(commerceCustomsDwellEstimate.destinationCountryCode, input.destinationCountryCode),
        originPredicate,
        commodityPredicate,
        // The table has no `state`, so an open window IS an unretired estimate.
        input.openOnly === true ? isNull(commerceCustomsDwellEstimate.validUntil) : undefined,
        cursorPredicate,
      ),
    )
    .orderBy(desc(commerceCustomsDwellEstimate.validFrom), asc(commerceCustomsDwellEstimate.id))
    .limit(limit + 1);

  const hasMore = dwellRows.length > limit;
  const pageRows = hasMore ? dwellRows.slice(0, limit) : dwellRows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: pageRows.map(projectDwellEstimate),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({ sortKey: lastRow.validFrom.toISOString(), id: lastRow.id })
            : null,
        hasMore,
      },
    },
  };
}
