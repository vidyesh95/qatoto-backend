import { z } from "zod";

import {
  FreightModeSchema,
  FreightRateBreakListSchema,
  FreightRateCardStateSchema,
} from "#src/modules/store/fulfillment/commerce-freight-rates.schemas.js";

/**
 * Boundary contracts for §19.12 — the lanes an APPROVED FREIGHT PROVIDER authors for itself.
 *
 * THE DIFFERENCES FROM THE STAFF SCHEMAS ARE THE WHOLE FILE, and each one is a refusal
 * rather than a convenience:
 *
 *   - `providerOrganizationId` is ABSENT and `.strict()` REFUSES it. It is derived from the
 *     session. A body carrying one is a forwarder authoring a competitor's tariff, so it must
 *     be a 422 naming the field and never a silently ignored key (§0).
 *   - `sourceForwarderName` is ABSENT for the same reason. It is the provenance §19.6 puts on
 *     the wire beside the price; a free-text one would let a forwarder publish a rate under
 *     somebody else's name. The service writes the caller's own organization display name.
 *   - `validFrom` is REQUIRED and must be FUTURE, where the staff schema makes it optional and
 *     the controller defaults it to now. §19.11 step 1: a card in force the instant it exists
 *     can never have its bands edited, and no PATCH can correct it because `validFrom` is
 *     absent from every update schema. An operator reads that in a runbook; a provider will
 *     not, so it becomes a 422.
 *   - `breaks` must contain a band whose `minBillableWeightGrams` is `0`. §19.11 step 4:
 *     without a floor band every lighter consignment rates `below_smallest_break` and the lane
 *     publishes NO OPTION, which reaches the buyer as an empty delivery sheet —
 *     indistinguishable from having loaded nothing at all.
 *
 * EVERYTHING ELSE IS IMPORTED, NOT RESTATED. The band shape, the mode tuple, the state tuple
 * and the 1..20 bound are the staff schemas' — one vocabulary, in both directions of the
 * exchange and across both surfaces (§19.10).
 *
 * ⚠️ THE TWO REFINES BELOW ARE UX, NOT THE AUTHORITY. §1.1: the backend is the sole source of
 * truth for anything gating a state transition, and a clock read at parse time is not the
 * clock the transaction runs against. The service re-checks both, and its refusals are the
 * ones that count.
 */

const IdentifierSchema = z.string().trim().min(1).max(200);

const CountryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, "Use an uppercase ISO 3166-1 alpha-2 country code.");

const CurrencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, "Use an uppercase ISO 4217 currency code.");

const PageLimitSchema = z.coerce.number().int().min(1).max(50).optional();
const PageCursorSchema = z.string().trim().min(1).max(500).optional();

export const ProviderRateCardIdParamsSchema = z.object({ rateCardId: IdentifierSchema }).strict();

/**
 * `GET /commerce/provider/freight-rate-cards`.
 *
 * NO `providerOrganizationId` FILTER, and its absence is the access rule rather than a
 * shortened list: the caller may only ever see its own cards, so a filter for whose cards to
 * show would be a field with exactly one legal value. `.strict()` turns a sent one into a 422
 * naming it.
 *
 * `state` IS STILL A FILTER, and still not a display rule. The rating read's predicate is the
 * validity WINDOW plus `state <> 'withdrawn'`, so a `superseded` card may legitimately still be
 * pricing a lane — a composer that dropped those rows itself would hide live prices from the
 * forwarder that set them.
 */
export const ListProviderFreightRateCardsQuerySchema = z
  .object({
    originCountryCode: CountryCodeSchema.optional(),
    destinationCountryCode: CountryCodeSchema.optional(),
    mode: FreightModeSchema.optional(),
    state: FreightRateCardStateSchema.optional(),
    limit: PageLimitSchema,
    cursor: PageCursorSchema,
  })
  .strict();
/** §19.11 step 4, as a parse-time refusal rather than prose. */
function hasZeroWeightFloorBand(
  breaks: readonly { readonly minBillableWeightGrams: number }[],
): boolean {
  return breaks.some((band) => band.minBillableWeightGrams === 0);
}

export const ProviderCreateFreightRateCardSchema = z
  .object({
    originCountryCode: CountryCodeSchema,
    destinationCountryCode: CountryCodeSchema,
    mode: FreightModeSchema,
    currency: CurrencyCodeSchema,
    /**
     * REQUIRED AND FUTURE, unlike the staff schema's optional-defaults-to-now. See the file
     * header: a defaulted card is in force immediately and its ladder can never be corrected.
     */
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().optional(),
    /**
     * §19.9. The forwarder's OWN volumetric divisor, cm³ per kilogram — required, never
     * defaulted. Ocean LCL is 1000 (the W/M revenue ton), road around 3000, air 5000 or 6000
     * depending on who is quoting.
     *
     * ⚠️ THE BOUND CATCHES A DECIMAL SLIP AND NOTHING SUBTLER. A road divisor typed onto an air
     * card is inside 100–20000 and will underbill every bulky consignment on that lane, quietly.
     * Defaulting it would be the platform choosing a tariff convention on the forwarder's
     * behalf, which is the error §19.4 refuses everywhere else.
     */
    volumetricDivisorCm3PerKg: z.number().int().min(100).max(20_000),
    /**
     * REQUIRED, 1..20, in the SAME call. A card with no bands prices nothing and reads to a
     * buyer as an uncovered lane; and because this create supersedes, a two-call create would
     * leave a window in which the incumbent is already closed and the successor prices nothing.
     */
    breaks: FreightRateBreakListSchema,
  })
  .strict()
  .refine((input) => new Date(input.validFrom).getTime() > Date.now(), {
    message:
      "validFrom must be in the future — a card that is already in force can never have its bands edited.",
    path: ["validFrom"],
  })
  .refine((input) => hasZeroWeightFloorBand(input.breaks), {
    message:
      "One band must start at 0 g, or every consignment lighter than the smallest band prices nothing and the lane publishes no option at all.",
    path: ["breaks"],
  });
/**
 * `PATCH /commerce/provider/freight-rate-cards/:rateCardId` — §19.12's "withdraw / retire only".
 *
 * A DISCRIMINATED UNION, not an optional-field bag (CLAUDE.md §3.2), and the SAME TWO ARMS the
 * staff surface carries. Both narrow: nothing here can restate a price or push a window
 * outward, because extending validity is re-selling an expired list under its old provenance.
 * Declared here rather than imported so `.strict()`'s refusal list is this file's, and so a
 * later divergence between the two surfaces is an edit rather than a fork.
 */
export const ProviderUpdateFreightRateCardSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("shorten_window"), validUntil: z.iso.datetime() }).strict(),
  z
    .object({
      intent: z.literal("withdraw"),
      /**
       * Required. Withdrawing removes a price buyers were being shown, and a lifecycle change
       * with no stated basis is fiat with extra steps. Lands in the audit entry's payload.
       */
      reasonNote: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
/**
 * `PATCH .../breaks` — a WHOLE-SET replace, never a per-band edit, because breaks form a ladder
 * and changing one band's floor silently reprices the weights its neighbours covered.
 *
 * ⚠️ IT CARRIES THE ZERO-FLOOR REFINE TOO, and that is not symmetry for its own sake. Replace
 * is the one verb that can DELETE the floor band off a card that had one, which blanks the lane
 * just as thoroughly as never authoring it.
 */
export const ProviderReplaceFreightRateBreaksSchema = z
  .object({ breaks: FreightRateBreakListSchema })
  .strict()
  .refine((input) => hasZeroWeightFloorBand(input.breaks), {
    message:
      "One band must start at 0 g, or every consignment lighter than the smallest band prices nothing and the lane publishes no option at all.",
    path: ["breaks"],
  });
