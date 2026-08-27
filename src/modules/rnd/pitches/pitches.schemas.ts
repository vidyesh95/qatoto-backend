/**
 * Request schemas for §12 pitches.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER, the same reason `research-programs.schemas.ts`
 * gives: they have a second consumer a controller cannot serve — `src/docs/
 * openapi-rnd-bodies.ts` generates request bodies from these. Types come from `z.infer`
 * here, so a service takes its input type from the schema rather than importing it back
 * out of a controller.
 *
 * EVERY WRITE BODY IS `.strict()`, and on this surface that is a security control rather
 * than tidiness. Three fields are absent from every one of them and each absence is a rule
 * the client cannot argue with:
 *
 *   - `status` — a pitch a user mints is always `draft`, and submitting moves it to
 *     `pending`. `.strict()` turns an attempt to send `status: "published"` into a 422
 *     rather than a moderation bypass.
 *   - `slug` — server-derived from the title, and immutable once minted because a
 *     published pitch has been linked to from somewhere Qatoto does not control.
 *   - Any amount or equity percentage — see the §12 header in `src/db/schema/rnd.ts`. The
 *     ask lives on the third party's page.
 */

import { z } from "zod";

/**
 * Shared offset-pagination query, matching `PageQuerySchema` in the programs module.
 * Declared again rather than imported so the two domains can diverge without one silently
 * changing the other's limits.
 */
export const PitchPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Client-minted, once per attempt. 8–128 matches the DB CHECK, and the length floor is
 * what stops a caller sending `"1"` and colliding with everyone else's `"1"`.
 */
export const IdempotencyKeySchema = z.string().trim().min(8).max(128);

/**
 * A URL as it arrives. NOT `z.url()` — the parser in `src/lib/external-url.ts` is the check
 * that matters, and a Zod `url()` would accept `http:` and `javascript:` shapes this
 * surface must refuse. All this does is bound the length before the parser sees it.
 *
 * The same argument `suppliers.schemas.ts` and `videos.schemas.ts` make for their links.
 */
const ExternalUrlInputSchema = z.string().trim().min(1).max(2048);

export const CreatePitchSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    summary: z.string().trim().min(20).max(2000),
    /** Optional at creation: a founder may line the video up after writing the pitch. */
    pitchVideoId: z.string().trim().min(1).max(64).optional(),
    externalFundingUrl: ExternalUrlInputSchema.optional(),
    externalContactUrl: ExternalUrlInputSchema.optional(),
  })
  .strict();
export type CreatePitchInput = z.infer<typeof CreatePitchSchema>;

/**
 * Every field optional, and `null` is a distinct, meaningful value on the three nullable
 * ones: absent means "leave it alone", `null` means "clear it". Without that a founder
 * could add a funding link and never remove it.
 */
export const UpdatePitchSchema = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    summary: z.string().trim().min(20).max(2000).optional(),
    pitchVideoId: z.string().trim().min(1).max(64).nullable().optional(),
    externalFundingUrl: ExternalUrlInputSchema.nullable().optional(),
    externalContactUrl: ExternalUrlInputSchema.nullable().optional(),
  })
  .strict();
export type UpdatePitchInput = z.infer<typeof UpdatePitchSchema>;

/**
 * The moderator's verdict.
 *
 * `reason` is REQUIRED to reject and refused on a publish, expressed as a discriminated
 * union so the illegal pair is unrepresentable rather than checked. A rejection with no
 * reason is a wall rather than a decision — the submitter cannot fix what they were not
 * told — and `pitch_rejection_reason_ck` refuses it at the storage layer too.
 */
export const ModeratePitchSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("published") }).strict(),
  z
    .object({
      decision: z.literal("rejected"),
      reason: z.string().trim().min(10).max(1000),
    })
    .strict(),
]);
export type ModeratePitchInput = z.infer<typeof ModeratePitchSchema>;

/**
 * One self-reported funding outcome.
 *
 * `amountInCents` ARRIVES AS A STRING because the column is `bigint`: a value past 2^53
 * loses precision the moment `JSON.parse` makes it a `number`, and a funding figure is
 * exactly the kind of number that gets large. Parsed to `bigint` here so a malformed one
 * is a 422 at the boundary rather than a `NaN` three layers in.
 *
 * `funderUserId` is optional and `funderNameText` is not, because the design assumes the
 * funder is usually a stranger to this platform.
 */
export const RecordPitchOutcomeSchema = z
  .object({
    amountInCents: z
      .string()
      .trim()
      // FIFTEEN DIGITS, not eighteen. The column is `bigint` but drizzle reads it in
      // `{ mode: "number" }`, so anything past 2^53 (~9.0e15) would come back rounded — and
      // a funding figure that silently changes on the way out is worse than a refusal. Ten
      // trillion in cents is a ceiling no honest outcome reaches.
      .regex(/^[1-9]\d{0,14}$/, "Must be a whole number of cents greater than zero."),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Must be a three-letter ISO-4217 code."),
    /** Date only — nobody remembers the minute money landed, and precision here is a lie. */
    fundedOnDate: z.iso.date(),
    funderUserId: z.string().trim().min(1).max(64).optional(),
    funderNameText: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(1000).optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export type RecordPitchOutcomeInput = z.infer<typeof RecordPitchOutcomeSchema>;

/**
 * The public discovery list.
 *
 * NO `status` FACET. This read serves published pitches and nothing else, and a status
 * parameter on a public list is an invitation to ask for `pending` — which would expose
 * the review queue to anyone who could type a query string.
 */
export const ListPublicPitchesQuerySchema = PitchPageQuerySchema.extend({
  projectSlug: z.string().trim().min(1).max(120).optional(),
}).strict();

export const ListMyPitchesQuerySchema = PitchPageQuerySchema.extend({
  status: z.enum(["draft", "pending", "published", "rejected", "closed"]).optional(),
}).strict();
