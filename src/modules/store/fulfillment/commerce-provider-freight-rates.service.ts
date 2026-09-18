import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, lt, or, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceFreightRateBreak,
  commerceFreightRateCard,
  commerceOrganization,
  commerceProviderKindLink,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  assertCardAcceptsBreakWrites,
  findDuplicatedFloor,
  insertFreightRateCardSupersedingIncumbent,
  loadBreaksForCard,
  projectRateCard,
  type AdminFreightRateCard,
  type CreateRateCardOutcome,
  type FreightRateBreakInput,
  type FreightRateBreakRow,
  type FreightRateCardBandWriteRefusal,
  type FreightRateCardRow,
} from "#src/modules/store/fulfillment/commerce-freight-rate-card-projection.js";
import type {
  FreightMode,
  FreightRateCardState,
} from "#src/modules/store/fulfillment/commerce-freight-rates.schemas.js";
import {
  appendCommerceOrganizationAuditEntry,
  type CommerceOrganizationAuditAppendInput,
} from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import type { Result } from "#src/types/index.js";

/**
 * §19.12 — THE LANES A PROVIDER AUTHORS FOR ITSELF.
 *
 * A36's commercial half was mis-diagnosed: "no forwarder lane list has been purchased" framed
 * an ACCESS problem as a budget one. The six §19.10 write routes are `moderate_commerce`, so
 * the only party who may type a forwarder's tariff is staff — including the tariff of a
 * forwarder already approved and selling on `/store/providers`. That is why a phase passed
 * with the tables still empty. Nothing is being bought; the supply side is being let in.
 *
 * WHAT THIS FILE IS NOT. It is not a second rating service, not a second projection and not a
 * second supersession. Those are shared with the staff surface in
 * `commerce-freight-rate-card-projection.ts` (§19.10's one-vocabulary rule). What lives here is
 * exactly the part that differs: WHO may write, WHICH rows they may touch, and the three §19.11
 * traps turned from runbook prose into refusals.
 *
 * ⚠️ `providerOrganizationId` IS DERIVED FROM THE SESSION AND NEVER READ FROM A BODY. The
 * schema refuses the field outright rather than ignoring it, and every query below is keyed on
 * `actor.organizationId`. A provider authoring a competitor's tariff must be unexpressible, not
 * merely unlikely.
 *
 * ⚠️ `sourceForwarderName` IS DERIVED TOO, from the caller's own organization display name. It
 * is the provenance §19.6 puts on the wire beside the price; a free-text one would let a
 * forwarder publish a rate under a carrier's or a rival's name.
 *
 * TWO ASSERTIONS OPEN EVERY FUNCTION, IN THIS ORDER, BEFORE ANY ID OR FILTER VALUE IS READ —
 * the reason `commerce-freight-rates.routes.ts` gives for putting `moderate_commerce` in the
 * service rather than on the route: a filter-first service is an existence oracle for lanes and
 * providers, and a route-level guard makes the capability probeable from the route table.
 *
 *   1. the caller's active organization holds an APPROVED provider profile of kind
 *      `freight_forwarder` or `logistics_operator`;
 *   2. the card it names is that organization's own.
 *
 * A CARD BELONGING TO ANOTHER ORGANIZATION ANSWERS 404, NOT 403 — byte-identical to a garbage
 * id. A 403 there would confirm the card exists, which makes this surface an id oracle for
 * every rival's lane portfolio.
 *
 * `proposed` IS NOT A STATE AND WILL NOT BECOME ONE. The PROVIDER is the moderated entity, not
 * the price: a profile is approved before it may sell anything, and the rate is the forwarder's
 * own (§19.9b), so Qatoto reviewing a lane price on merit would be an endorsement — the exact
 * liability this platform is built to avoid. Spam is answered by provider approval and
 * withdrawal. ⚠️ If that ever has to change, the enum is the SMALL half: the rating read selects
 * on the validity WINDOW and never on `state`, so adding `proposed` without also filtering that
 * read publishes every unreviewed card the instant its window opens.
 *
 * NOTHING HERE CHARGES ANYTHING. `shippingInCents` stays literal `0` (§19.6) — rating from a
 * card is not a booking and confers no capacity. This work changes who may write, not what is
 * read.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * ITS OWN UNION, not the staff one narrowed. The two surfaces refuse for different reasons —
 * there is no `PLATFORM_CAPABILITY_REQUIRED` here and no `COMMERCE_FREIGHT_PROVIDER_NOT_FOUND`,
 * because the provider is the caller rather than a body field — and a shared union would leave
 * each mapper with arms it can never reach, which is how a `switch` stops being evidence.
 *
 * The two band-write members are spelled to match `FreightRateCardBandWriteRefusal` exactly, so
 * the shared gate's return value is assignable here without a translation step.
 */
export type CommerceProviderFreightRateError =
  | { type: "COMMERCE_PROVIDER_FREIGHT_NOT_APPROVED" }
  | { type: "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND"; rateCardId: string }
  | FreightRateCardBandWriteRefusal
  | { type: "COMMERCE_FREIGHT_RATE_CARD_VALID_FROM_NOT_FUTURE"; validFrom: Date }
  | { type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_MISSING" }
  | {
      type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED";
      minBillableWeightGrams: number;
      minVolumeCubicCm: number;
    }
  | {
      type: "COMMERCE_FREIGHT_RATE_CARD_PREDATES_PREDECESSOR";
      predecessorRateCardId: string;
      predecessorValidFrom: Date;
    }
  | { type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_EMPTY"; validFrom: Date; validUntil: Date }
  | { type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_WIDENED"; currentValidUntil: Date | null }
  | { type: "INVALID_CURSOR" };

// ---------------------------------------------------------------------------
// Inputs — Dates, never ISO strings. The controller converts at the boundary.
// ---------------------------------------------------------------------------

/**
 * WHO IS ACTING, assembled by the controller from `req.user` and `req.commerceOrganization`.
 * There is no `providerOrganizationId` parameter anywhere in this file for the reason the
 * header gives; `actor.organizationId` is the only spelling.
 */
export interface ProviderFreightActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly memberRole:
    | "owner"
    | "administrator"
    | "buyer"
    | "seller"
    | "provider_operator"
    | "finance"
    | "support"
    | "viewer";
}

export interface CreateProviderFreightRateCardInput {
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly mode: FreightMode;
  readonly currency: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly volumetricDivisorCm3PerKg: number;
  readonly breaks: readonly FreightRateBreakInput[];
}

export type UpdateProviderFreightRateCardInput =
  | { readonly intent: "shorten_window"; readonly validUntil: Date }
  | { readonly intent: "withdraw"; readonly reasonNote: string };

export interface ListProviderFreightRateCardsInput {
  readonly originCountryCode?: string | undefined;
  readonly destinationCountryCode?: string | undefined;
  readonly mode?: FreightMode | undefined;
  readonly state?: FreightRateCardState | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/** §7's list envelope, the same shape the staff reads answer with. */
export interface ProviderFreightRateCardPage {
  readonly items: readonly AdminFreightRateCard[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

const DEFAULT_PAGE_LIMIT = 20;

/**
 * The kinds that may price freight.
 *
 * `customs_broker` IS NOT ONE OF THEM, and the omission is §19.12's: a broker clears customs and
 * does not sell lane capacity. `commerce_customs_dwell_estimate` — the table a broker's figures
 * would belong in — has no provider column at all. It is scoped by destination, origin and
 * commodity and is platform-wide, so there is nothing for a per-provider dwell row to key on.
 * Dwell stays `moderate_commerce`.
 */
const FREIGHT_AUTHORING_PROVIDER_KINDS = ["freight_forwarder", "logistics_operator"] as const;

// ---------------------------------------------------------------------------
// The two assertions
// ---------------------------------------------------------------------------

/**
 * Assertion 1 — is this organization allowed to price freight at all?
 *
 * STRICTLY `verified`, which is the same predicate `providerMayQuoteRfq`
 * (`commerce-quotes.service.ts`) uses to decide who may bid on an RFQ. It is deliberately NOT
 * the public directory's rule — that one is the negative `NOT IN ('rejected','suspended')`, so
 * an `unverified` self-registered org still appears in a listing. Appearing in a directory is a
 * weaker claim than publishing a price a buyer will act on, and §19.12 rests the whole design
 * on the provider being the moderated entity: if approval did not mean approval, nothing would
 * be moderating the price either.
 *
 * PER-KIND, not per-profile. `commerce_provider_kind_link` carries its own `verification_state`
 * because verification is recorded per kind (§5) — an organization verified as a warehouse
 * provider has not been verified to sell sea freight.
 */
async function isApprovedFreightProvider(organizationId: string): Promise<boolean> {
  const [verifiedKindLink] = await db
    .select({ id: commerceProviderKindLink.id })
    .from(commerceProviderKindLink)
    .where(
      and(
        eq(commerceProviderKindLink.organizationId, organizationId),
        eq(commerceProviderKindLink.verificationState, "verified"),
        inArray(commerceProviderKindLink.providerKind, [...FREIGHT_AUTHORING_PROVIDER_KINDS]),
      ),
    )
    .limit(1);

  return verifiedKindLink !== undefined;
}

/**
 * Assertion 2 — is this card theirs?
 *
 * ONE QUERY, PREDICATED ON BOTH, rather than a load followed by an ownership comparison. A
 * separate comparison is a branch somebody can forget to write, and the failure mode is silent:
 * the row is already in hand by then.
 */
async function findOwnedRateCard(
  rateCardId: string,
  organizationId: string,
): Promise<FreightRateCardRow | undefined> {
  const [row] = await db
    .select()
    .from(commerceFreightRateCard)
    .where(
      and(
        eq(commerceFreightRateCard.id, rateCardId),
        eq(commerceFreightRateCard.providerOrganizationId, organizationId),
      ),
    )
    .limit(1);

  return row;
}

function notApproved(): Result<never, CommerceProviderFreightRateError> {
  return { success: false, error: { type: "COMMERCE_PROVIDER_FREIGHT_NOT_APPROVED" } };
}

function cardNotFound(rateCardId: string): Result<never, CommerceProviderFreightRateError> {
  return { success: false, error: { type: "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND", rateCardId } };
}

/**
 * The audit append is inside the caller's transaction, so the card and the evidence that it was
 * written commit together or not at all.
 *
 * THROWS RATHER THAN RETURNING, on `commerce-quotes.service.ts`'s `appendAuditOrThrow`
 * precedent. An audit that failed to append is not a domain outcome the caller could sensibly
 * report — it is a broken invariant, and rolling the write back is the only honest answer.
 */
type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function appendAuditOrThrow(
  transaction: DatabaseExecutor,
  input: CommerceOrganizationAuditAppendInput,
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Provider freight rate audit append failed: ${appended.error.type}`);
  }
}

/**
 * ⚠️ EVERY NUMBER IN AN AUDIT PAYLOAD IS A STRING. `CommerceAuditSafeValue` has no number arm —
 * the payload is canonicalized and scanned for secret-bearing key names before any write, and
 * the value type is `string | boolean | null` plus arrays and objects of the same. A numeric
 * value is a compile error here, not a runtime surprise.
 */
function laneTargetLabel(row: {
  readonly originCountryCode: string;
  readonly destinationCountryCode: string;
  readonly mode: string;
  readonly currency: string;
}): string {
  return `${row.originCountryCode}→${row.destinationCountryCode} ${row.mode} (${row.currency})`;
}

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------

export async function createProviderFreightRateCard(
  actor: ProviderFreightActor,
  input: CreateProviderFreightRateCardInput,
): Promise<
  Result<
    { readonly rateCard: AdminFreightRateCard; readonly supersededRateCardId: string | null },
    CommerceProviderFreightRateError
  >
> {
  if (!(await isApprovedFreightProvider(actor.organizationId))) {
    return notApproved();
  }

  /**
   * §19.11 step 1, RE-CHECKED HERE rather than trusted from the schema's refine. The boundary
   * read the clock at parse time; this one reads it against the write. Between them sits
   * network time, and a card that slipped into force in that gap is one whose bands can never
   * be edited and which no PATCH can correct.
   */
  const now = new Date();
  if (input.validFrom <= now) {
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_VALID_FROM_NOT_FUTURE",
        validFrom: input.validFrom,
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

  // §19.11 step 4. The schema refuses this too; this is the copy that counts.
  if (!input.breaks.some((band) => band.minBillableWeightGrams === 0)) {
    return { success: false, error: { type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_MISSING" } };
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

  /**
   * The provenance, derived. The organization row is guaranteed by the FK chain the kind link
   * already proved, so a missing one is an invariant break rather than a 404.
   */
  const [organization] = await db
    .select({ displayName: commerceOrganization.displayName })
    .from(commerceOrganization)
    .where(eq(commerceOrganization.id, actor.organizationId))
    .limit(1);

  if (!organization) {
    throw new Error(
      `createProviderFreightRateCard: approved provider ${actor.organizationId} has no organization row`,
    );
  }

  // Minted BEFORE the transaction so the incumbent's `supersededByRateCardId` can point at a
  // card that does not exist yet.
  const rateCardId = randomUUID();

  const outcome = await db.transaction<CreateRateCardOutcome>(async (tx) => {
    const created = await insertFreightRateCardSupersedingIncumbent(tx, rateCardId, {
      providerOrganizationId: actor.organizationId,
      originCountryCode: input.originCountryCode,
      destinationCountryCode: input.destinationCountryCode,
      mode: input.mode,
      currency: input.currency,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      sourceForwarderName: organization.displayName,
      volumetricDivisorCm3PerKg: input.volumetricDivisorCm3PerKg,
      breaks: input.breaks,
    });

    // A decision that did not happen must not be recorded as one.
    if (created.kind !== "created" || created.insertedCard === undefined) {
      return created;
    }

    await appendAuditOrThrow(tx, {
      organizationId: actor.organizationId,
      eventKind: "freight_rate_card_created",
      actorUserId: actor.userId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_freight_rate_card",
      targetEntityId: rateCardId,
      payload: {
        lane: laneTargetLabel(created.insertedCard),
        originCountryCode: input.originCountryCode,
        destinationCountryCode: input.destinationCountryCode,
        mode: input.mode,
        currency: input.currency,
        validFrom: input.validFrom.toISOString(),
        validUntil: input.validUntil === null ? null : input.validUntil.toISOString(),
        volumetricDivisorCm3PerKg: String(input.volumetricDivisorCm3PerKg),
        breakCount: String(input.breaks.length),
        // The supersession rides in the create's payload rather than a second entry: it is a
        // consequence of this decision, not a decision of its own.
        supersededRateCardId: created.incumbent?.id ?? null,
      },
      occurredAt: new Date(),
    });

    return created;
  });

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
    throw new Error("createProviderFreightRateCard: insert returned no row");
  }

  return {
    success: true,
    value: {
      /**
       * `bandsEditable` is the author's answer to "can I still fix this?", and on this surface
       * it is ALWAYS `true` on a fresh card — the future-`validFrom` refusal above is what
       * guarantees it. That is the whole difference between §19.11's runbook and this route.
       */
      rateCard: projectRateCard(outcome.insertedCard, outcome.insertedBreaks, new Date()),
      supersededRateCardId: outcome.incumbent?.id ?? null,
    },
  };
}

export async function updateProviderFreightRateCard(
  actor: ProviderFreightActor,
  rateCardId: string,
  input: UpdateProviderFreightRateCardInput,
): Promise<Result<AdminFreightRateCard, CommerceProviderFreightRateError>> {
  if (!(await isApprovedFreightProvider(actor.organizationId))) {
    return notApproved();
  }

  const existing = await findOwnedRateCard(rateCardId, actor.organizationId);
  if (!existing) {
    return cardNotFound(rateCardId);
  }

  /**
   * NARROWING ONLY, both arms. Pushing a window outward is re-selling an expired list under its
   * old provenance, which §19.6's "an expired card is not a price" forbids — and unlike a fresh
   * card, nobody would see that it had happened.
   */
  if (input.intent === "shorten_window") {
    if (existing.validUntil !== null && input.validUntil >= existing.validUntil) {
      return {
        success: false,
        error: {
          type: "COMMERCE_FREIGHT_RATE_CARD_WINDOW_WIDENED",
          currentValidUntil: existing.validUntil,
        },
      };
    }
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
  }

  const updatedRow = await db.transaction(async (tx) => {
    /**
     * `state = 'active'` RE-ASSERTED IN THE UPDATE, not merely read above: a concurrent write
     * may have landed between the read and this statement. No matched row therefore means the
     * card is no longer active rather than that it vanished.
     */
    const [updated] = await tx
      .update(commerceFreightRateCard)
      .set(
        input.intent === "shorten_window"
          ? { validUntil: input.validUntil }
          : { state: "withdrawn" },
      )
      .where(
        and(
          eq(commerceFreightRateCard.id, rateCardId),
          eq(commerceFreightRateCard.providerOrganizationId, actor.organizationId),
          eq(commerceFreightRateCard.state, "active"),
        ),
      )
      .returning();

    if (!updated) {
      return undefined;
    }

    await appendAuditOrThrow(tx, {
      organizationId: actor.organizationId,
      eventKind:
        input.intent === "shorten_window"
          ? "freight_rate_card_window_shortened"
          : "freight_rate_card_withdrawn",
      actorUserId: actor.userId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_freight_rate_card",
      targetEntityId: rateCardId,
      payload:
        input.intent === "shorten_window"
          ? { lane: laneTargetLabel(updated), validUntil: input.validUntil.toISOString() }
          : { lane: laneTargetLabel(updated), reasonNote: input.reasonNote },
      occurredAt: new Date(),
    });

    return updated;
  });

  if (!updatedRow) {
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE",
        rateCardId,
        // The read above proved the row is the caller's; only a non-active state can reach here.
        state: existing.state === "active" ? "superseded" : existing.state,
      },
    };
  }

  const breaks = await loadBreaksForCard(rateCardId);
  return { success: true, value: projectRateCard(updatedRow, breaks, new Date()) };
}

// ---------------------------------------------------------------------------
// Bands — staged cards only
// ---------------------------------------------------------------------------

export async function appendProviderFreightRateBreak(
  actor: ProviderFreightActor,
  rateCardId: string,
  input: FreightRateBreakInput,
): Promise<Result<AdminFreightRateCard, CommerceProviderFreightRateError>> {
  if (!(await isApprovedFreightProvider(actor.organizationId))) {
    return notApproved();
  }

  const existing = await findOwnedRateCard(rateCardId, actor.organizationId);
  if (!existing) {
    return cardNotFound(rateCardId);
  }

  // ONE `now` for the gate and the reply, so the projection cannot contradict the refusal.
  const now = new Date();
  const refusal = assertCardAcceptsBreakWrites(existing, now);
  if (refusal) {
    return { success: false, error: refusal };
  }

  const insertedRows = await db
    .transaction(async (tx) => {
      /**
       * The next position, taken under `FOR UPDATE` so two concurrent appends cannot both read
       * the same highest band and race `commerce_freight_rate_break_position_uidx` into a 500.
       */
      const [highest] = await tx
        .select({ position: commerceFreightRateBreak.position })
        .from(commerceFreightRateBreak)
        .where(eq(commerceFreightRateBreak.rateCardId, rateCardId))
        .orderBy(desc(commerceFreightRateBreak.position))
        .for("update")
        .limit(1);

      const nextPosition = highest === undefined ? 0 : highest.position + 1;

      const [insertedBreak] = await tx
        .insert(commerceFreightRateBreak)
        .values({
          rateCardId,
          position: nextPosition,
          minBillableWeightGrams: input.minBillableWeightGrams,
          minVolumeCubicCm: input.minVolumeCubicCm,
          unitPriceInCents: input.unitPriceInCents,
          minimumChargeInCents: input.minimumChargeInCents,
          transitDaysMin: input.transitDaysMin,
          transitDaysMax: input.transitDaysMax,
        })
        .returning();

      if (!insertedBreak) {
        throw new Error("appendProviderFreightRateBreak: insert returned no row");
      }

      await appendAuditOrThrow(tx, {
        organizationId: actor.organizationId,
        eventKind: "freight_rate_break_added",
        actorUserId: actor.userId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_freight_rate_card",
        targetEntityId: rateCardId,
        payload: {
          lane: laneTargetLabel(existing),
          position: String(nextPosition),
          minBillableWeightGrams: String(input.minBillableWeightGrams),
          minVolumeCubicCm: String(input.minVolumeCubicCm),
        },
        occurredAt: new Date(),
      });

      return insertedBreak;
    })
    .catch((error: unknown) => {
      /**
       * ONE appended band can collide with a floor already on the card, which the in-memory
       * pre-check cannot see — the other bands are in the table, not in the body. Caught so the
       * author gets a 422 naming the floor rather than a bare 23505.
       */
      if (isUniqueViolation(error)) {
        return undefined;
      }
      throw error;
    });

  if (!insertedRows) {
    return {
      success: false,
      error: {
        type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED",
        minBillableWeightGrams: input.minBillableWeightGrams,
        minVolumeCubicCm: input.minVolumeCubicCm,
      },
    };
  }

  const breaks = await loadBreaksForCard(rateCardId);
  return { success: true, value: projectRateCard(existing, breaks, now) };
}

export async function replaceProviderFreightRateBreaks(
  actor: ProviderFreightActor,
  rateCardId: string,
  input: { readonly breaks: readonly FreightRateBreakInput[] },
): Promise<Result<AdminFreightRateCard, CommerceProviderFreightRateError>> {
  if (!(await isApprovedFreightProvider(actor.organizationId))) {
    return notApproved();
  }

  const existing = await findOwnedRateCard(rateCardId, actor.organizationId);
  if (!existing) {
    return cardNotFound(rateCardId);
  }

  const now = new Date();
  const refusal = assertCardAcceptsBreakWrites(existing, now);
  if (refusal) {
    return { success: false, error: refusal };
  }

  /**
   * ⚠️ THE FLOOR CHECK BELONGS ON THIS VERB MOST OF ALL. Replace is the only write that can
   * REMOVE the zero-weight band off a card that already had one, and a lane whose floor was
   * deleted publishes no option at all — which reaches the buyer as an empty delivery sheet,
   * indistinguishable from a lane nobody ever priced.
   */
  if (!input.breaks.some((band) => band.minBillableWeightGrams === 0)) {
    return { success: false, error: { type: "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_MISSING" } };
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

  const insertedBreaks = await db.transaction<readonly FreightRateBreakRow[]>(async (tx) => {
    const previous = await tx
      .delete(commerceFreightRateBreak)
      .where(eq(commerceFreightRateBreak.rateCardId, rateCardId))
      .returning({ id: commerceFreightRateBreak.id });

    const inserted = await tx
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

    await appendAuditOrThrow(tx, {
      organizationId: actor.organizationId,
      eventKind: "freight_rate_breaks_replaced",
      actorUserId: actor.userId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_freight_rate_card",
      targetEntityId: rateCardId,
      payload: {
        lane: laneTargetLabel(existing),
        previousBreakCount: String(previous.length),
        breakCount: String(inserted.length),
      },
      occurredAt: new Date(),
    });

    return inserted;
  });

  return { success: true, value: projectRateCard(existing, insertedBreaks, now) };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * `GET /commerce/provider/freight-rate-cards` — §19.10's keyset, scoped to one provider.
 *
 * ORDER IS `(validFrom DESC, id ASC)`, not `createdAt`: a card's subject is the day its prices
 * start applying, so a card keyed in on Friday for next quarter belongs where its author looks
 * for next quarter. `id` last and ascending because two cards genuinely can share an instant —
 * supersession sets a successor's `validFrom` to the incumbent's `validUntil` — and a partial
 * tiebreak drops whichever row loses it.
 */
export async function listProviderFreightRateCards(
  actor: ProviderFreightActor,
  input: ListProviderFreightRateCardsInput,
): Promise<Result<ProviderFreightRateCardPage, CommerceProviderFreightRateError>> {
  if (!(await isApprovedFreightProvider(actor.organizationId))) {
    return notApproved();
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

  const rows = await db
    .select()
    .from(commerceFreightRateCard)
    .where(
      and(
        // The scope, not a filter. There is no spelling for anybody else's cards.
        eq(commerceFreightRateCard.providerOrganizationId, actor.organizationId),
        input.originCountryCode === undefined
          ? undefined
          : eq(commerceFreightRateCard.originCountryCode, input.originCountryCode),
        input.destinationCountryCode === undefined
          ? undefined
          : eq(commerceFreightRateCard.destinationCountryCode, input.destinationCountryCode),
        input.mode === undefined ? undefined : eq(commerceFreightRateCard.mode, input.mode),
        input.state === undefined ? undefined : eq(commerceFreightRateCard.state, input.state),
        cursorPredicate,
      ),
    )
    .orderBy(desc(commerceFreightRateCard.validFrom), asc(commerceFreightRateCard.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  /**
   * EVERY BAND ON THE PAGE IN ONE QUERY, keyed by the page's card ids, rather than
   * `loadBreaksForCard` per row. Fifty cards at twenty bands is fifty round trips to save a
   * `Map`. The per-card helper stays for the write paths, which hold exactly one card.
   */
  const pageCardIds = pageRows.map((row) => row.id);
  const breakRows =
    pageCardIds.length === 0
      ? []
      : await db
          .select()
          .from(commerceFreightRateBreak)
          .where(inArray(commerceFreightRateBreak.rateCardId, pageCardIds))
          .orderBy(
            asc(commerceFreightRateBreak.rateCardId),
            asc(commerceFreightRateBreak.position),
          );

  const breaksByCardId = new Map<string, FreightRateBreakRow[]>();
  for (const breakRow of breakRows) {
    const existing = breaksByCardId.get(breakRow.rateCardId);
    if (existing) {
      existing.push(breakRow);
    } else {
      breaksByCardId.set(breakRow.rateCardId, [breakRow]);
    }
  }

  /**
   * ONE `now` FOR THE WHOLE PAGE. Two reads of the clock could straddle a `validFrom` and
   * answer "editable" to the request that had just been refused.
   */
  const now = new Date();
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: pageRows.map((row) => projectRateCard(row, breaksByCardId.get(row.id) ?? [], now)),
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
