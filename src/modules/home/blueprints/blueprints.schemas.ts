/**
 * Request schemas for the `/blueprints` module, kept out of the controllers.
 *
 * WHY NOT IN THE CONTROLLERS. They have a second consumer a controller cannot serve:
 * `src/docs/openapi-rnd-bodies.ts` generates request bodies from these schemas, and
 * importing a controller to reach one drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. Every handler still runs `safeParse` before any
 * service call and returns 422 on failure.
 */
import { z } from "zod";

import { MAX_BLUEPRINT_HERO_SLIDES } from "#src/modules/home/blueprints/blueprint-hero.service.js";

/**
 * The slide's caption AND its alt text — one field, two uses. 160 rather than the
 * promotional carousel's 200 because this one is `line-clamp-2` in a 328px card, and a
 * title that cannot fit is a title nobody reads.
 */
export const BlueprintHeroTitleSchema = z.string().trim().min(1).max(160);

/**
 * The link's SHAPE only — length and emptiness.
 *
 * The real rule (no protocol-relative path, no control characters, round-trip identity)
 * lives in `parsePromotionalDestination`'s internal arm, deliberately NOT here. Zod proves
 * the request parses; that module produces the canonical string to store and is the single
 * place the open-redirect logic exists. Duplicating it in a `.refine()` would create a
 * second copy to keep in sync, and the copy that drifted would be the security-relevant one.
 */
export const BlueprintHeroDestinationPathSchema = z.string().trim().min(1).max(512);

/**
 * A schedule bound on the wire: an ISO 8601 string, parsed into a `Date` by the handler.
 *
 * `z.iso.datetime()` and NOT `z.coerce.date()`: a `z.date()` is unrepresentable to the
 * OpenAPI emitter, so `convertBodySchema` throws on it and the route silently loses its
 * published body — `openapi-rnd-bodies.test.ts` fails the build for exactly that.
 */
export const BlueprintHeroScheduleBoundSchema = z.iso.datetime();

/**
 * Multipart text parts arrive as STRINGS — multer does not type them.
 *
 * NOT `z.coerce.boolean()`, which follows JS truthiness: the string "false" coerces to
 * `true`, so an admin who unchecked the box would publish the slide anyway. And not a
 * `.transform()` either — unrepresentable to the OpenAPI emitter for the same reason a
 * date is.
 */
export const BlueprintHeroMultipartBooleanSchema = z.enum(["true", "false"]);

export const CreateBlueprintHeroSlideSchema = z
  .object({
    title: BlueprintHeroTitleSchema,
    // Optional because a decorative slide has no link at all — see the column's comment.
    destinationPath: BlueprintHeroDestinationPathSchema.optional(),
    isActive: BlueprintHeroMultipartBooleanSchema.optional(),
    startsAt: BlueprintHeroScheduleBoundSchema.optional(),
    endsAt: BlueprintHeroScheduleBoundSchema.optional(),
  })
  .strict();

/**
 * The metadata patch.
 *
 * `.strict()` is what refuses every server-owned field — `position`, `imageUrl`,
 * `createdAt`, `createdByUserId`. They are refused LOUDLY as unrecognized keys rather than
 * silently ignored, which is how an admin (or an attacker) learns the field is not theirs.
 *
 * `destinationPath`, `startsAt` and `endsAt` are NULLABLE but not collapsed with optional:
 * `null` means "clear it" and absent means "leave it alone". Those are different edits and
 * the service treats them differently.
 */
export const UpdateBlueprintHeroSlideSchema = z
  .object({
    title: BlueprintHeroTitleSchema.optional(),
    destinationPath: BlueprintHeroDestinationPathSchema.nullable().optional(),
    isActive: z.boolean().optional(),
    startsAt: BlueprintHeroScheduleBoundSchema.nullable().optional(),
    endsAt: BlueprintHeroScheduleBoundSchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Send at least one field to change.",
  });

/**
 * The whole order, as a permutation. Not a per-slide position write — see
 * `reorderBlueprintHeroSlides` for why a partial order is a mismatch rather than a partial
 * apply.
 */
export const ReorderBlueprintHeroSlidesSchema = z
  .object({
    // BOTH bounds are load-bearing, not decoration. Without them the largest body this
    // schema can produce is unbounded, and `json-body-budget.test.ts` fails the route for
    // being capped below what its own schema allows. The array bound is the service's own
    // ceiling rather than a second number, so the two cannot drift; 64 is the per-id cap
    // because a uuid is 36 characters.
    slideIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_BLUEPRINT_HERO_SLIDES),
  })
  .strict();
