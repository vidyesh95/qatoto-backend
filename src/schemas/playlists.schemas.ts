/**
 * Request schemas for playlists, extracted from playlists.controller.ts.
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

/**
 * Declared once and WITHOUT defaults, so the update schema can be `.partial()`d safely —
 * `.partial()` does not strip `.default()`, and a PATCH that silently re-asserts a
 * default is how a rename ends up resetting a playlist's visibility. Same reasoning as
 * videos.controller.ts and products.controller.ts.
 */
export const playlistFieldShapes = {
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().max(5000),
  visibility: z.enum(["public", "unlisted", "private"]),
  defaultVideoOrder: z.enum([
    "date_published_newest",
    "date_published_oldest",
    "date_added_newest",
    "date_added_oldest",
    "manual",
  ]),
  language: z.string().trim().max(60),
};

export const CreatePlaylistSchema = z
  .object(playlistFieldShapes)
  .partial()
  .extend({
    title: playlistFieldShapes.title,
    // Private by default: a playlist created mid-edit should not be publicly listed
    // before the creator has decided it is ready.
    visibility: playlistFieldShapes.visibility.default("private"),
    defaultVideoOrder: playlistFieldShapes.defaultVideoOrder.default("date_published_newest"),
  })
  .strict();

export const UpdatePlaylistSchema = z.object(playlistFieldShapes).partial().strict();

export const ReplacePlaylistVideosSchema = z
  .object({ videoIds: z.array(z.string().min(1).max(64)).max(500) })
  .strict();

export const ListMyPlaylistsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreatePlaylistInput = z.infer<typeof CreatePlaylistSchema>;

export type UpdatePlaylistInput = z.infer<typeof UpdatePlaylistSchema>;
