import { z } from "zod";

/**
 * The query and path parses for the public teardown reads.
 *
 * SEPARATE FROM `teardown-import.schemas.ts` BECAUSE THEY GUARD OPPOSITE DIRECTIONS. That file is
 * the write gate — the whole contract, `.strict()`, so a fixture field the backend does not model
 * fails loudly. These are read parameters arriving from a browser address bar, and the difference
 * decides the two rules below.
 */

/** 12 fixtures at 8 per page is two pages, so the paging control renders. */
export const TEARDOWN_INDEX_DEFAULT_LIMIT = 8;

/** Matches the frontend's `BlueprintDifficulty`, which is why these are the wire values. */
export const TEARDOWN_DIFFICULTIES = ["beginner", "intermediate", "advanced"] as const;

/**
 * `?media=` — what the teardown published, which is its own filter rather than a tag.
 *
 * Mirrors the frontend's `TEARDOWN_MEDIA_FILTERS`. Each value becomes a predicate over a column or
 * a child table in the read service; none is a stored boolean.
 */
export const TEARDOWN_MEDIA_FILTERS = ["assembly", "video", "documents"] as const;
export type TeardownMediaFilter = (typeof TEARDOWN_MEDIA_FILTERS)[number];

/**
 * ⚠️ `.strip()`, NOT `.strict()`. A teardown link is shared, and it comes back carrying
 * `utm_source`, `fbclid` and whatever else an intermediary appended. Refusing the request over a
 * tracking parameter nobody in this system added would break a link that works everywhere else.
 *
 * The parse is still total for every parameter this surface DOES read — an out-of-range `limit` is
 * a 422, not a clamp, and an unknown `?sort=top` is dropped rather than honoured, because this
 * surface offers no sort control and pretending otherwise would return a page in an order the
 * caller did not get.
 */
export const PublicTeardownIndexQuerySchema = z
  .object({
    difficulty: z.enum(TEARDOWN_DIFFICULTIES).optional(),
    media: z.enum(TEARDOWN_MEDIA_FILTERS).optional(),
    tag: z.string().trim().min(1).max(40).optional(),
    limit: z.coerce.number().int().min(1).max(24).default(TEARDOWN_INDEX_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strip();

export type PublicTeardownIndexQuery = z.infer<typeof PublicTeardownIndexQuerySchema>;

/**
 * A teardown address, shaped exactly as `teardown_slug_ck` stores one.
 *
 * ⚠️ A FAILURE HERE ANSWERS 404, NOT 422 — the same departure `PublicShowcaseSlugSchema` documents.
 * A 422 for a malformed slug beside a 404 for a well-formed one that does not exist tells a stranger
 * which shapes are real, one request at a time. The parse still runs at the boundary; only the
 * status differs, and both answers say the same thing: there is nothing here.
 */
export const PublicTeardownSlugSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
