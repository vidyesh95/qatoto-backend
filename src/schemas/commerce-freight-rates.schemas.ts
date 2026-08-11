import { z } from "zod";

/**
 * Boundary contracts for the §19 reference data — lane rate cards and customs dwell.
 *
 * THE FIELDS ABSENT FROM THE PATCH SCHEMAS ARE THE POINT, and `.strict()` makes sending one
 * a 422 rather than a silent drop. A rate card's lane, mode, currency, `validFrom` and
 * `sourceForwarderName` are not editable: the card feeds a buyer-facing quoted range whose
 * provenance §19.6 puts on the wire, and rewriting a number under an unchanged
 * `sourceForwarderName` is a claim that forwarder never made. The edit path is a NEW card,
 * which supersedes.
 */

// Module-private, per file. There is no shared ISO schema in this repo — `commerce-fulfillment`,
// `store-factories` and `community-cofounder` each declare their own — and inventing one here
// would be a refactor smuggled into a feature.
const CountryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, "Use an uppercase ISO 3166-1 alpha-2 country code.");

const CurrencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, "Use an uppercase ISO 4217 currency code.");

const IdentifierSchema = z.string().trim().min(1).max(200);

/**
 * Mirrors `commerce_shipment_leg_mode`. NOT a second enum — §19.2 forbids one, and this
 * tuple is the wire's spelling of the enum the database already owns.
 */
export const FREIGHT_MODES = ["air", "sea", "land", "rail"] as const;
export const FreightModeSchema = z.enum(FREIGHT_MODES);
export type FreightMode = (typeof FREIGHT_MODES)[number];

/**
 * Mirrors `commerce_freight_rate_card_state`, on the `FREIGHT_MODES` precedent directly above:
 * the wire's spelling of an enum the database already owns, not a second enum.
 *
 * ON THE WIRE VERBATIM, snake_case, because that is what the column stores and what the
 * projection's `state` already returns. A camelCase alias would be a third spelling of one
 * concept and would have to be translated in both directions forever.
 */
export const FREIGHT_RATE_CARD_STATES = ["active", "superseded", "withdrawn"] as const;
export const FreightRateCardStateSchema = z.enum(FREIGHT_RATE_CARD_STATES);
export type FreightRateCardState = (typeof FREIGHT_RATE_CARD_STATES)[number];

export const RateCardIdParamsSchema = z.object({ rateCardId: IdentifierSchema }).strict();
export const DwellEstimateIdParamsSchema = z.object({ dwellEstimateId: IdentifierSchema }).strict();

/**
 * Shared page controls. Bounds match every other commerce list schema — `commerce-trust`,
 * `commerce-content-reports`, `commerce-fulfillment` — so one page size behaves the same
 * everywhere. The service supplies the default; absent here means "unspecified", not 20.
 */
const PageLimitSchema = z.coerce.number().int().min(1).max(50).optional();
const PageCursorSchema = z.string().trim().min(1).max(500).optional();

/**
 * `GET /commerce/admin/freight-rate-cards` (§19.10).
 *
 * EVERY FILTER OPTIONAL, and `state` among them. The rating read's predicate is the WINDOW
 * plus `state <> 'withdrawn'`, so a live option may legitimately come from a `superseded`
 * card — narrowing to `active` by default would hide rows that are still pricing lanes. The
 * console filters by asking the server, never by dropping rows it was sent.
 */
export const ListFreightRateCardsQuerySchema = z
  .object({
    originCountryCode: CountryCodeSchema.optional(),
    destinationCountryCode: CountryCodeSchema.optional(),
    /** `FreightModeSchema` — FOUR members. `freight_transport_mode`'s fifth, `multimodal`, is
     * not a leg mode and no rate card can carry it. */
    mode: FreightModeSchema.optional(),
    providerOrganizationId: IdentifierSchema.optional(),
    state: FreightRateCardStateSchema.optional(),
    limit: PageLimitSchema,
    cursor: PageCursorSchema,
  })
  .strict();
export type ListFreightRateCardsQuery = z.infer<typeof ListFreightRateCardsQuerySchema>;

/**
 * The literal that asks for the rows scoped to ANY origin / ANY commodity — the ones stored
 * as NULL (§19.3).
 *
 * A SENTINEL RATHER THAN AN ABSENCE, because absence already means something else here. The
 * create body refuses omission and demands an explicit `null` for exactly this reason; a
 * filter that could not tell "scoped to any origin" from "not filtering by origin" would
 * make the any-origin rows — the broadest and most consequential ones — unfindable.
 *
 * IT CANNOT COLLIDE WITH A REAL VALUE, and the two halves rest on different grounds.
 * `CountryCodeSchema` is `^[A-Z]{2}$` and the column carries the same check constraint, so
 * lowercase `any` is structurally not a country code. `commerceCategory.id` is a `randomUUID()`
 * — the default and every seeded row — so no category is named `any`; that half is a fact about
 * the data rather than a constraint, and a category id assigned by hand as the literal `any`
 * would become unfilterable. Nothing in this repo assigns one.
 */
export const ANY_SCOPE_FILTER = "any";
const AnyOriginFilterSchema = z.union([z.literal(ANY_SCOPE_FILTER), CountryCodeSchema]).optional();
const AnyCommodityFilterSchema = z
  .union([z.literal(ANY_SCOPE_FILTER), IdentifierSchema])
  .optional();

/**
 * `GET /commerce/admin/customs-dwell-estimates` (§19.10).
 *
 * `openOnly` narrows to the rows whose window is still open — `validUntil IS NULL`. The table
 * has no `state`, so that is what "not retired" means here.
 */
export const ListCustomsDwellEstimatesQuerySchema = z
  .object({
    destinationCountryCode: CountryCodeSchema.optional(),
    originCountryCode: AnyOriginFilterSchema,
    commodityScopeCategoryId: AnyCommodityFilterSchema,
    openOnly: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    limit: PageLimitSchema,
    cursor: PageCursorSchema,
  })
  .strict();
export type ListCustomsDwellEstimatesQuery = z.infer<typeof ListCustomsDwellEstimatesQuerySchema>;

/**
 * One weight/volume band.
 *
 * NO `position` KEY. Order is array order — the server assigns positions densely from 0, so
 * two bands cannot claim one slot and the unique index cannot reject the second at random.
 * The call `reorderCommerceCategories` already makes for siblings.
 *
 * `unitPriceInCents` is CENTS PER KILOGRAM of chargeable weight; the two `min*` fields are
 * the band's FLOOR, not its denominator.
 */
export const FreightRateBreakSchema = z
  .object({
    minBillableWeightGrams: z.number().int().min(0).max(100_000_000),
    minVolumeCubicCm: z.number().int().min(0).max(1_000_000_000),
    /** `min(1)` — a zero unit price is §19.6's forbidden zero. */
    unitPriceInCents: z.number().int().min(1).max(100_000_000),
    /** `min(0)` — plenty of tariffs have no floor, and refusing one would invite a typed `1`. */
    minimumChargeInCents: z.number().int().min(0).max(1_000_000_000_000),
    transitDaysMin: z.number().int().min(0).max(365),
    transitDaysMax: z.number().int().min(0).max(365),
  })
  .strict()
  .refine((band) => band.transitDaysMax >= band.transitDaysMin, {
    message: "transitDaysMax must be greater than or equal to transitDaysMin.",
    path: ["transitDaysMax"],
  });
export type FreightRateBreakBody = z.infer<typeof FreightRateBreakSchema>;

/**
 * BOUNDED ON BOTH AXES, and both bounds are load-bearing rather than decoration: an
 * unbounded array is an unbounded body, which is what `json-body-budget.test.ts` exists to
 * refuse. Twenty bands is well past any published tariff.
 */
const FreightRateBreakListSchema = z.array(FreightRateBreakSchema).min(1).max(20);

/**
 * `breaks` IS REQUIRED, not optional, and that is a rule rather than a convenience.
 *
 * A card with no bands prices nothing, so the rating read reports the lane as uncovered —
 * indistinguishable from a lane that genuinely is. Worse, this create SUPERSEDES: a two-call
 * create would leave a window in which the incumbent is already closed and the successor
 * prices nothing, so the lane goes dark because an admin's second request was slow.
 */
export const CreateFreightRateCardSchema = z
  .object({
    providerOrganizationId: IdentifierSchema,
    originCountryCode: CountryCodeSchema,
    destinationCountryCode: CountryCodeSchema,
    mode: FreightModeSchema,
    currency: CurrencyCodeSchema,
    /** Absent = now. A future instant stages a card; its breaks stay editable until then. */
    validFrom: z.iso.datetime().optional(),
    validUntil: z.iso.datetime().optional(),
    sourceForwarderName: z.string().trim().min(1).max(200),
    /**
     * §19.9. The forwarder's own volumetric divisor, cm³ per kilogram — REQUIRED, because
     * freight bills on `max(actual, volumetric)` and the platform must not pick the convention.
     *
     * Ocean LCL is 1000 (the W/M revenue ton), road around 3000, air 5000 or 6000 depending on
     * who is quoting. The bounds catch a transposed figure, not a policy.
     */
    volumetricDivisorCm3PerKg: z.number().int().min(100).max(20_000),
    breaks: FreightRateBreakListSchema,
  })
  .strict();
export type CreateFreightRateCardBody = z.infer<typeof CreateFreightRateCardSchema>;

/**
 * A DISCRIMINATED UNION, not an optional-field bag (CLAUDE.md §3.2). The two intents are
 * different acts with different audit kinds, and `{ validUntil, state }` together has no
 * meaning anyone could defend.
 *
 * BOTH ARMS NARROW. Nothing here can restate a price or push a window outward: extending
 * validity is re-selling an expired list under its old provenance, which §19.6's "an expired
 * card is not a price" forbids.
 */
export const UpdateFreightRateCardSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("shorten_window"), validUntil: z.iso.datetime() }).strict(),
  z
    .object({
      intent: z.literal("withdraw"),
      /**
       * Required. A lifecycle change with no stated basis is fiat with extra steps, and this
       * one removes a price buyers were being shown. Lands in the audit entry's `detailNote`.
       */
      reasonNote: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export type UpdateFreightRateCardBody = z.infer<typeof UpdateFreightRateCardSchema>;

/** POST /:rateCardId/breaks — append ONE band at the next position. */
export const AppendFreightRateBreakSchema = FreightRateBreakSchema;
export type AppendFreightRateBreakBody = z.infer<typeof AppendFreightRateBreakSchema>;

/**
 * PATCH /:rateCardId/breaks — a WHOLE-SET replace, never a per-band edit.
 *
 * A partial edit cannot be expressed safely: breaks form a ladder, so changing one band's
 * floor silently reprices the weights its neighbours covered.
 */
export const ReplaceFreightRateBreaksSchema = z
  .object({ breaks: FreightRateBreakListSchema })
  .strict();
export type ReplaceFreightRateBreaksBody = z.infer<typeof ReplaceFreightRateBreaksSchema>;

/**
 * `originCountryCode: null` = ANY ORIGIN, `commodityScopeCategoryId: null` = ANY COMMODITY
 * (§19.3). Both are EXPLICIT nulls rather than absences, so the console cannot turn a
 * forgotten field into a broader claim than the broker made.
 */
export const CreateCustomsDwellEstimateSchema = z
  .object({
    destinationCountryCode: CountryCodeSchema,
    originCountryCode: CountryCodeSchema.nullable(),
    commodityScopeCategoryId: IdentifierSchema.nullable(),
    clearanceDaysMin: z.number().int().min(0).max(365),
    clearanceDaysMax: z.number().int().min(0).max(365),
    source: z.string().trim().min(1).max(200),
    validFrom: z.iso.datetime().optional(),
    validUntil: z.iso.datetime().optional(),
  })
  .strict()
  .refine((input) => input.clearanceDaysMax >= input.clearanceDaysMin, {
    message: "clearanceDaysMax must be greater than or equal to clearanceDaysMin.",
    path: ["clearanceDaysMax"],
  })
  .refine((input) => input.originCountryCode !== input.destinationCountryCode, {
    message:
      "A domestic lane has no customs leg — that is an absent component, not a zero-day one.",
    path: ["originCountryCode"],
  });
export type CreateCustomsDwellEstimateBody = z.infer<typeof CreateCustomsDwellEstimateSchema>;

/**
 * The dwell table has no `state`, so retiring one IS closing its window. Narrowing only, for
 * the card's reason: these days feed a buyer's arrival window.
 */
export const UpdateCustomsDwellEstimateSchema = z.object({ validUntil: z.iso.datetime() }).strict();
export type UpdateCustomsDwellEstimateBody = z.infer<typeof UpdateCustomsDwellEstimateSchema>;
