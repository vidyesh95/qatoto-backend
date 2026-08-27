import { z } from "zod";

/**
 * Request schemas for the channel page, kept beside its controller for the reason
 * `engagement.schemas.ts` states: `src/docs/openapi-rnd-bodies.ts` generates from these, and
 * importing a controller to reach one drags in its whole service and db graph.
 */

/**
 * The handle in the path.
 *
 * NOT `z.uuid()`, and not a loose string either. Handles are minted by this platform's own
 * handle service, not by Better Auth, and the format is what the availability check enforces —
 * so a malformed one can be refused at the boundary without any query running. That leaks
 * nothing: handle-shape is client-checkable, so a 422 says only "that is not a handle", never
 * "that handle does not exist". A well-formed handle nobody has claimed still gets the 404.
 */
export const ChannelHandleParamSchema = z
  .object({ handle: z.string().trim().min(1).max(64) })
  .strict();

/** `?limit=` (1..50, default 24) and `?cursor=`. Byte-identical to the other keyset reads. */
export const ListChannelVideosQuerySchema = z
  .object({
    // 24, not 20, and it is not arbitrary: the channel grid is 2/3/4 columns depending on
    // viewport, and 24 is the smallest page that fills a whole number of rows in all three.
    limit: z.coerce.number().int().min(1).max(50).default(24),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * Query for `GET /channels` — the public directory the sitemap crawls.
 *
 * A HIGHER CEILING THAN THE VIDEO GRID ABOVE, and a higher default, because this list has no
 * viewport: its only consumer walks every page to build a sitemap, so a small page size means more
 * round trips for the same answer. 200 matches the store's own directory reads.
 */
export const ListPublicChannelsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
