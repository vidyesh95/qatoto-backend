import { z } from "zod";

/**
 * The `/watch-history` write contract.
 *
 * THERE IS NO BODY SCHEMA HERE, AND THAT IS THE POINT. All three routes carry their
 * entire meaning in the verb and the path: the viewer is `req.user.id` and nothing else,
 * and the only other input is which video. A body would be a place for a caller to put a
 * `viewerId` we would then have to remember never to read.
 */

/** `:videoId`, mirroring `VideoIdParamSchema` in engagement.schemas.ts. */
export const WatchHistoryVideoIdParamSchema = z.object({ videoId: z.uuid() }).strict();
