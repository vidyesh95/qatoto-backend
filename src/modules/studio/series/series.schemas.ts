/**
 * Request schemas for series, extracted from series.controller.ts.
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

export const HttpUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .transform((rawUrl) => new URL(rawUrl).toString());

export const seriesFieldShapes = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000),
  posterUrl: HttpUrlSchema,
  genreTags: z.array(z.string().trim().min(1).max(40)).max(20),
  status: z.enum(["ongoing", "completed", "hiatus"]),
};

export const CreateSeriesSchema = z
  .object(seriesFieldShapes)
  .partial()
  .extend({
    title: seriesFieldShapes.title,
    genreTags: seriesFieldShapes.genreTags.default([]),
    status: seriesFieldShapes.status.default("ongoing"),
  })
  .strict();

export const UpdateSeriesSchema = z.object(seriesFieldShapes).partial().strict();

export const seasonFieldShapes = {
  seasonLabel: z.string().trim().min(1).max(60),
  position: z.number().int().min(0).max(500),
};

export const CreateSeasonSchema = z
  .object(seasonFieldShapes)
  .partial()
  .extend({ seasonLabel: seasonFieldShapes.seasonLabel })
  .strict();

export const UpdateSeasonSchema = z.object(seasonFieldShapes).partial().strict();

/**
 * `videoId` is deliberately absent. Linking an episode to an upload happens in the upload
 * flow, where the caller's ownership of the VIDEO is proven; accepting it here would let
 * a series owner attach a stranger's video to their catalog.
 */
export const episodeFieldShapes = {
  episodeNumber: z.number().int().min(0),
  episodeTitle: z.string().trim().min(1).max(200),
  isPremium: z.boolean(),
  releaseScheduleDay: z.string().trim().max(20),
  releaseScheduleTime: z.string().trim().max(10),
  premiereDate: z.coerce.date(),
  audioMode: z.enum(["subbed", "dubbed"]),
  audioLanguage: z.string().trim().max(60),
  ageRating: z.string().trim().max(20),
};

export const CreateEpisodeSchema = z
  .object(episodeFieldShapes)
  .partial()
  .extend({
    episodeNumber: episodeFieldShapes.episodeNumber,
    episodeTitle: episodeFieldShapes.episodeTitle,
    isPremium: episodeFieldShapes.isPremium.default(false),
  })
  .strict();

export const UpdateEpisodeSchema = z.object(episodeFieldShapes).partial().strict();

export const ListMySeriesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreateSeriesInput = z.infer<typeof CreateSeriesSchema>;

export type UpdateSeriesInput = z.infer<typeof UpdateSeriesSchema>;

export type CreateSeasonInput = z.infer<typeof CreateSeasonSchema>;

export type UpdateSeasonInput = z.infer<typeof UpdateSeasonSchema>;

export type CreateEpisodeInput = z.infer<typeof CreateEpisodeSchema>;

export type UpdateEpisodeInput = z.infer<typeof UpdateEpisodeSchema>;
