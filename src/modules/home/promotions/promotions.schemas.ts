/**
 * Request schemas for promotions, extracted from promotions.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

import { MAX_PROMOTIONAL_SLIDES } from "#src/modules/home/promotions/promotions.service.js";

export const DestinationKindSchema = z.enum(["internal_path", "external_url"]);

/**
 * The destination value's SHAPE only — length and emptiness.
 *
 * The real rules (no protocol-relative path, https only, no credentials) live in
 * `parsePromotionalDestination`, deliberately NOT here. Zod proves the request parses;
 * that module produces the canonical string to store and is the single place the
 * open-redirect logic exists. Duplicating it in a `.refine()` would create a second
 * copy to keep in sync, and the copy that drifted would be the security-relevant one.
 */
export const DestinationValueSchema = z.string().trim().min(1).max(2048);

export const AltTextSchema = z.string().trim().min(1).max(200);

/**
 * A schedule bound on the wire: an ISO 8601 string, parsed into a `Date` by the handler.
 *
 * `z.iso.datetime()` and NOT `z.coerce.date()`, matching every other datetime body field
 * here (funding, compensation, proof-of-effort). Two reasons, and the second is the one
 * that bites: a `z.date()` is an UNREPRESENTABLE TYPE for the OpenAPI emitter, so
 * `convertBodySchema` throws on it and the route silently loses its published body —
 * `openapi-rnd-bodies.test.ts` fails the build for exactly that.
 */
export const ScheduleBoundSchema = z.iso.datetime();

/**
 * Multipart text parts arrive as STRINGS — multer does not type them, so `isActive` is the
 * literal "true" or "false" and the handler compares it.
 *
 * NOT `z.coerce.boolean()`, which follows JS truthiness: the string "false" coerces to
 * `true`, so an admin who unchecked the box would publish the slide anyway. And not a
 * `.transform()` either — a transform is unrepresentable to the OpenAPI emitter for the
 * same reason a date is.
 */
export const MultipartBooleanSchema = z.enum(["true", "false"]);

export const CreatePromotionalSlideSchema = z
  .object({
    altText: AltTextSchema,
    destinationKind: DestinationKindSchema,
    destinationValue: DestinationValueSchema,
    isActive: MultipartBooleanSchema.optional(),
    startsAt: ScheduleBoundSchema.optional(),
    endsAt: ScheduleBoundSchema.optional(),
  })
  .strict();

/**
 * The metadata patch.
 *
 * `.strict()` is what refuses every server-owned field — `position`, `imageUrl`,
 * `imageWidthPx`, `createdAt`, `createdByUserId`. They are refused LOUDLY as
 * unrecognized keys rather than silently ignored, which is how an admin (or an attacker)
 * learns the field is not theirs to set.
 *
 * `startsAt` and `endsAt` are NULLABLE here but not optional-nullable-collapsed: `null`
 * means "clear this bound" and absent means "leave it alone". Those are different edits
 * and the service treats them differently.
 */
export const UpdatePromotionalSlideSchema = z
  .object({
    altText: AltTextSchema.optional(),
    destinationKind: DestinationKindSchema.optional(),
    destinationValue: DestinationValueSchema.optional(),
    isActive: z.boolean().optional(),
    startsAt: ScheduleBoundSchema.nullable().optional(),
    endsAt: ScheduleBoundSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (patch) => (patch.destinationKind === undefined) === (patch.destinationValue === undefined),
    {
      // A kind with no value cannot be validated, and a value with no kind cannot be
      // interpreted — "/store" is a fine path and a broken URL. Both or neither.
      message: "Send destinationKind and destinationValue together, or neither.",
    },
  )
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Send at least one field to change.",
  });

/**
 * The whole order, as a permutation. Not a per-slide position write — see
 * `reorderPromotionalSlides` for why a partial order is a mismatch rather than a partial
 * apply.
 */
export const ReorderPromotionalSlidesSchema = z
  .object({
    // BOTH bounds are load-bearing, not decoration. Without them the largest body this
    // schema can produce is unbounded, and `json-body-budget.test.ts` fails the route for
    // being capped below what its own schema allows. The array bound is the service's own
    // ceiling rather than a second number, so the two cannot drift; 64 is the per-id cap
    // because a uuid is 36 characters.
    slideIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_PROMOTIONAL_SLIDES),
  })
  .strict();
