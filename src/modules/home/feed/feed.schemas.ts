/**
 * Request schemas for feed, extracted from feed.controller.ts.
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

import { RANK_SEED_LENGTH } from "#src/lib/rank-seed.js";
import { FEED_MODES } from "#src/modules/home/feed/feed.service.js";

/** `video.id` is `randomUUID()`, so this is a statement about the column, not a guess. */
export const WatchVideoIdParamSchema = z.object({ videoId: z.uuid() }).strict();

/** The chip and tile slugs are kebab-case, server-generated, and validated at creation. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `GET /feed/videos` — §5.1's query contract.
 *
 * `.strict()`, `z.coerce` with `.default()`, snake_case enum values that byte-match the
 * wire contract (`?mode=new_to_you`, never `new-to-you`).
 *
 * `page` is capped at 200 and `limit` at 50 because offset pagination gets more expensive
 * the deeper it goes, and nothing on the homepage asks for row 10,000.
 */
export const ListFeedVideosQuerySchema = z
  .object({
    mode: z.enum(FEED_MODES).default("all"),
    categorySlug: z.string().regex(SLUG_PATTERN).max(64).optional(),
    page: z.coerce.number().int().min(1).max(200).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(24),
    /**
     * Echoed from a previous response so page 2 ranks against the same seed as page 1.
     * Absent on a first request; minted server-side and returned.
     */
    rankSeed: z.string().length(RANK_SEED_LENGTH).optional(),
  })
  .strict();

/**
 * `GET /feed/search` — the query contract for relevance search.
 *
 * `query` IS REQUIRED AND CANNOT BE EMPTY. A blank search is not a search: it would ask the
 * database to rank the entire catalogue by a tsquery that matches nothing, and the client
 * already knows not to send it — an empty box renders a prompt, not a request. `.trim()`
 * first, so `?query=%20` is a 422 rather than a scan.
 *
 * 120 characters is well past any real query and short enough that `websearch_to_tsquery`
 * cannot be handed a novel to parse.
 *
 * `page` and `limit` share `ListFeedVideosQuerySchema`'s bounds for the same reason it has
 * them: offset pagination gets more expensive the deeper it goes, and nothing on a search
 * results page asks for row 10,000.
 */
export const SearchVideosQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(120),
    page: z.coerce.number().int().min(1).max(200).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(24),
  })
  .strict();
