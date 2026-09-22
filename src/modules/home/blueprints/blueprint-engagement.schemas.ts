import { z } from "zod";

/**
 * The request boundary for the blueprint engagement routes.
 *
 * Every schema here is `.strict()`, so an unknown key is a loud 422 rather than a silent strip —
 * the deliberate choice CLAUDE.md §3.1 asks callers to make.
 *
 * ⚠️ NO SCHEMA HERE CARRIES A TARGET ID OR A USER ID. The blueprint comes from the path and the
 * caller comes from the session, which is CLAUDE.md §1.1 applied: a body-carried `userId` would
 * let anyone like on somebody else's behalf, and a body-carried blueprint id would bypass the slug
 * gate the route resolves. `.strict()` is what turns "we ignore it" into "we refuse it".
 */

/** The comment body's bounds MIRROR `*_comment_body_ck`, so the parse and the CHECK agree. */
const BLUEPRINT_COMMENT_BODY_MAXIMUM_CHARACTERS = 2000;

export const CreateBlueprintCommentSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Write something first.")
      .max(
        BLUEPRINT_COMMENT_BODY_MAXIMUM_CHARACTERS,
        `Keep a comment under ${String(BLUEPRINT_COMMENT_BODY_MAXIMUM_CHARACTERS)} characters.`,
      ),
    /**
     * ⚠️ `.max(64)` IS NOT DECORATION. `json-body-budget.test.ts` refuses a route whose cap could
     * 413 a body its own schema accepts, and it computes that worst case from the schema — so an
     * unbounded string makes the route's maximum body size UNCOMPUTABLE and fails the build. A
     * comment id is a uuid, so 64 is generous.
     *
     * ⚠️ ONE LEVEL ONLY, AND THE SCHEMA CANNOT SAY SO. A reply names a TOP-LEVEL comment; a reply
     * naming another reply is refused by the service with a 409, because nothing in the body is
     * wrong — the thread shape is. A `.refine()` here could not tell the difference without a
     * database read.
     */
    parentCommentId: z.string().min(1).max(64).nullable(),
  })
  .strict();
export const UpdateBlueprintCommentSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Write something first.")
      .max(
        BLUEPRINT_COMMENT_BODY_MAXIMUM_CHARACTERS,
        `Keep a comment under ${String(BLUEPRINT_COMMENT_BODY_MAXIMUM_CHARACTERS)} characters.`,
      ),
  })
  .strict();
/**
 * The comment thread's paging controls.
 *
 * ⚠️ `.strip()` RATHER THAN `.strict()`, matching `ShowcaseReviewQueueQuerySchema`, which states
 * the reason at length: `.strict()` earns its keep on a BODY, where an unknown key is a client
 * trying to set something it should not; on a QUERY it turns a stray `utm_source` or a browser
 * extension's appended parameter into a 422 on a read.
 *
 * ⚠️ AND NO `sort`. A like-count sort breaks the keyset cursor's stable key, which is why
 * `ListVideoCommentsQuerySchema` refuses one too.
 */
export const ListBlueprintCommentsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).optional(),
    parentCommentId: z.string().min(1).optional(),
  })
  .strip();
/**
 * The batched viewer-state read.
 *
 * ⚠️ CAPPED AT 50 SLUGS PER ARM, AND THE CAP IS NOT COSMETIC. This route runs one left-joined
 * query per non-empty list; an unbounded array makes its worst case uncomputable, which is exactly
 * what `json-body-budget.test.ts` refuses for a body. It arrives as a query rather than a body
 * because it is a READ, so the bound has to live here instead.
 *
 * Comma-separated rather than repeated keys, so one long URL carries three arms without Express's
 * array-parsing ambiguity deciding whether `?showcases=a` is a string or a one-element array.
 */
const SlugListSchema = z
  .string()
  .optional()
  .transform((raw) =>
    raw === undefined || raw.trim() === ""
      ? []
      : raw
          .split(",")
          .map((slug) => slug.trim())
          .filter((slug) => slug.length > 0),
  )
  .pipe(z.array(z.string().min(1).max(120)).max(50, "At most 50 blueprints per arm."));

export const BlueprintViewerStateQuerySchema = z
  .object({
    showcases: SlugListSchema,
    teardowns: SlugListSchema,
    caseStudies: SlugListSchema,
  })
  .strip();
