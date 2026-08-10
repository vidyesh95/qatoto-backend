import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondFieldRefusal,
  respondStudioError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/studio-error-response.js";
import { isYoutubeVideoUrl } from "#src/lib/youtube.js";
import * as videosService from "#src/services/videos.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * Creator video endpoints (docs/STUDIO_BACKEND_STRUCTURE.md §6, §7).
 *
 * MEDIA FIELDS ARE NEVER IN A SCHEMA (§0). `youtubeVideoId`, `videoSource`,
 * `uploadStatus`, `thumbnailUrl`, `durationSeconds`, `sizeBytes`, `originalFileName`,
 * `playbackId` and `videoAssetId` are all server-derived, so `.strict()` rejects a
 * client that sends one. The client sends a URL; the SERVER decides the id.
 */

/**
 * An http(s) URL, normalized.
 *
 * `z.url()` ALONE IS NOT ENOUGH HERE. It validates by constructing a `URL`, which
 * happily accepts `javascript:alert(1)` — and every one of these columns is rendered by
 * the client as an `href`. The protocol allowlist is what makes that safe. Normalizing
 * through `URL` afterwards means one stored spelling per link rather than three.
 */
const HttpUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .transform((rawUrl) => new URL(rawUrl).toString());

/**
 * The video source, as the client sends it.
 *
 * DELIBERATELY NOT WRAPPED IN `z.url()`. The frontend's parser accepts a bare 11-char id
 * and a schemeless `youtu.be/<id>`, and green-ticks both live; `.url()` requires a
 * scheme and would 422 them after that checkmark — the precise divergence §3 exists to
 * prevent. `isYoutubeVideoUrl` IS the shape check, and it is the same function the
 * browser runs. Proof that the video EXISTS is a separate layer (the oEmbed call in the
 * service); do not collapse the two.
 */
const YoutubeUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isYoutubeVideoUrl, "Not a YouTube video link");

const ChapterSchema = z
  .object({
    startSeconds: z.number().int().min(0),
    title: z.string().trim().min(1).max(120),
  })
  .strict();

/**
 * The anime branch, on CREATE. Exactly one of `seriesId` (pick an existing series) or
 * `newSeriesTitle` (mint one) — enforced by the superRefine below, because "neither" and
 * "both" are each a different kind of ambiguity the service cannot resolve.
 */
const CreateAnimeSchema = z
  .object({
    seriesId: z.string().min(1).max(64).optional(),
    newSeriesTitle: z.string().trim().min(1).max(200).optional(),
    seasonLabel: z.string().trim().min(1).max(60),
    episodeNumber: z.number().int().min(0),
    episodeTitle: z.string().trim().min(1).max(200),
    releaseScheduleDay: z.string().trim().max(20).optional(),
    releaseScheduleTime: z.string().trim().max(10).optional(),
    premiereDate: z.coerce.date().optional(),
    audioMode: z.enum(["subbed", "dubbed"]).optional(),
    audioLanguage: z.string().trim().max(60).optional(),
    ageRating: z.string().trim().max(20).optional(),
    genreTags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  })
  .strict()
  .superRefine((anime, ctx) => {
    const hasExistingSeries = anime.seriesId !== undefined;
    const hasNewSeries = anime.newSeriesTitle !== undefined;
    if (hasExistingSeries === hasNewSeries) {
      ctx.addIssue({
        code: "custom",
        path: ["seriesId"],
        message: "Send exactly one of seriesId or newSeriesTitle.",
      });
    }
  });

/**
 * The anime branch, on PATCH — the episode's OWN metadata only.
 *
 * There is deliberately no `seriesId`, `newSeriesTitle` or `seasonLabel` here. Deriving
 * this from CreateAnimeSchema would let a PATCH silently move an episode between series,
 * which is a catalog operation and belongs to the /series router where the ownership
 * chain is visible.
 */
const UpdateAnimeSchema = z
  .object({
    episodeNumber: z.number().int().min(0),
    episodeTitle: z.string().trim().min(1).max(200),
    releaseScheduleDay: z.string().trim().max(20),
    releaseScheduleTime: z.string().trim().max(10),
    premiereDate: z.coerce.date(),
    audioMode: z.enum(["subbed", "dubbed"]),
    audioLanguage: z.string().trim().max(60),
    ageRating: z.string().trim().max(20),
  })
  .partial()
  .strict();

/**
 * The video field shapes, declared ONCE and deliberately WITHOUT defaults.
 *
 * WHY THE DEFAULTS LIVE ON THE CREATE SCHEMA AND NOT HERE. `.partial()` does NOT strip
 * `.default()`, so a PATCH schema derived from a defaulted one parses `{ title }` into a
 * payload that ALSO asserts `videoType: "demo"`, `visibility: "private"`, `sectorTags:
 * []` and `isNdaRequired: false`. On this domain that is not merely lossy — it is a
 * moderation bypass: `videoType` reverting to "demo" takes the row out of the anime
 * branch, and the next publish goes live with no review at all. The same mistake was
 * live in products.controller.ts and is fixed there in this change.
 *
 * Never derive a PATCH schema from a schema carrying `.default()`.
 */
const videoFieldShapes = {
  youtubeUrl: YoutubeUrlSchema,
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(5000),
  videoType: z.enum(["pitch", "demo", "update", "ama", "anime_episode"]),
  stageBadge: z.enum(["idea", "mvp", "scaling", "shipped"]),
  sectorTags: z.array(z.string().trim().min(1).max(40)).max(20),
  tags: z.array(z.string().trim().min(1).max(40)).max(30),
  websiteUrl: HttpUrlSchema,
  ctaLabel: z.string().trim().max(60),
  ctaUrl: HttpUrlSchema,
  linkedinUrl: HttpUrlSchema,
  xProfileUrl: HttpUrlSchema,
  contactEmail: z.email().max(320),
  isMadeForKids: z.boolean(),
  hasAgeRestriction: z.boolean(),
  relatedVideoUrl: HttpUrlSchema,
  hasFundingCallToAction: z.boolean(),
  visibility: z.enum(["private", "unlisted", "public", "investor_only"]),
  isNdaRequired: z.boolean(),
  scheduledPublishAt: z.coerce.date(),
  license: z.enum(["standard", "creative_commons"]),
  videoLanguage: z.string().trim().max(60),
  isEmbeddingAllowed: z.boolean(),
  areCommentsEnabled: z.boolean(),
  shouldShowLikesCount: z.boolean(),
  hasPaidPromotion: z.boolean(),
  usesAlteredContent: z.boolean(),
  captionCertification: z.string().trim().max(120),
  commentModeration: z.string().trim().max(60),
  commentSortOrder: z.string().trim().max(60),
  shortsRemixing: z.enum(["video_and_audio", "audio_only"]),
  recordingDate: z.iso.date(),
  recordingLocation: z.string().trim().max(200),
  // `category` USED TO BE HERE and is gone (HOME_BACKEND_STRUCTURE.md §2.2). It was free
  // text nobody validated and nothing could filter on; `categoryIds` below replaces it.
  // Removing it from this map removes it from CREATE and PATCH at once, so `.strict()` now
  // answers 422 to a client that still sends it — which is louder, and therefore better,
  // than accepting a value we would silently discard.
  //
  // The COLUMN survives one more release, read-only, so that dropping it and dropping its
  // last reader are two separate deploys.
  /**
   * At most three, and the bound is asserted in BOTH layers on purpose. Here it is the
   * request contract: a client sending four gets a field-level 422 with a path it can put
   * next to an input. In `videos.service.ts` it is the invariant, checked AFTER dedupe
   * against `MAXIMUM_CATEGORIES_PER_VIDEO` — so `["a","a","a","a"]` is refused here
   * (four items on the wire) and accepted there (one category), which is the strict
   * reading at the boundary and the honest one inside.
   *
   * No `.default([])`, here or in CreateVideoSchema below. See the note on this map: a
   * default on an array field would make an omitted key mean "remove all categories" on a
   * PATCH. The service reads `?? []` instead.
   *
   * NO `.min(1)`, AND AN EMPTY SET IS NOT AN UNTAGGED VIDEO. Choosing a category is optional
   * for the creator; `withDefaultCategoryFallback` in `videos.service.ts` turns an empty set
   * — omitted on create, or `[]` on either verb — into the single default bucket
   * (`DEFAULT_CONTENT_CATEGORY_SLUG`). The feed's category predicate never relaxes, so a
   * genuinely untagged video is invisible to every category filter; requiring a choice at
   * this boundary would have pushed that cost onto the creator instead.
   */
  categoryIds: z.array(z.string().min(1).max(64)).max(3),
  attachedProductIds: z.array(z.string().min(1).max(64)).max(50),
  milestones: z.array(z.string().trim().min(1).max(200)).max(20),
  openRoles: z.array(z.string().trim().min(1).max(120)).max(20),
  teamMemberNames: z.array(z.string().trim().min(1).max(120)).max(50),
  collaboratorEmails: z.array(z.email().max(320)).max(50),
};

/**
 * `videoType: "anime_episode"` and the `anime` block must arrive together: an episode
 * with no catalog entry can never be reviewed, and a catalog entry on a `demo` would be
 * an orphan nothing reads.
 */
function requireAnimeBlockForEpisodes(
  value: { readonly videoType?: string; readonly anime?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.videoType === undefined) return;
  const isAnimeEpisode = value.videoType === "anime_episode";
  const hasAnimeBlock = value.anime !== undefined;
  if (isAnimeEpisode !== hasAnimeBlock) {
    ctx.addIssue({
      code: "custom",
      path: ["anime"],
      message: 'Send the "anime" block if and only if videoType is "anime_episode".',
    });
  }
}

/**
 * CREATE. Defaults are correct here: an omitted key means "use the platform default",
 * and the wizard legitimately omits most of the advanced step.
 *
 * `originalFileName` is NOT accepted, though §7's sketch lists it. §1 and §4 both say it
 * stays null for a YouTube row, and the upload modal currently builds its draft with
 * `fileName` set to the YouTube URL — so accepting the field would mean silently
 * discarding a value the client believed it saved. `.strict()` rejecting it is louder
 * and therefore better. `attachedPitchId` is omitted for the same class of reason: the
 * pitch domain does not exist yet (§12), so there is nothing to validate it against.
 */
const CreateVideoSchema = z
  .object(videoFieldShapes)
  // Start from "everything optional", then re-require the two fields a video cannot
  // exist without and layer the platform defaults on top. Spreading the shapes directly
  // would make EVERY field mandatory — the wizard sends a handful of them, so a normal
  // create would 422 on `description` and `stageBadge`.
  //
  // `.partial()` is safe HERE and unsafe on the update schema for the same underlying
  // reason: it does not touch defaults. Applied to this defaults-free map it simply
  // relaxes requiredness; applied to a map that already carried `.default()` it would
  // silently keep them, which is the bug documented above.
  .partial()
  .extend({
    youtubeUrl: videoFieldShapes.youtubeUrl,
    title: videoFieldShapes.title,
    videoType: videoFieldShapes.videoType.default("demo"),
    sectorTags: videoFieldShapes.sectorTags.default([]),
    tags: videoFieldShapes.tags.default([]),
    hasAgeRestriction: videoFieldShapes.hasAgeRestriction.default(false),
    hasFundingCallToAction: videoFieldShapes.hasFundingCallToAction.default(false),
    visibility: videoFieldShapes.visibility.default("private"),
    isNdaRequired: videoFieldShapes.isNdaRequired.default(false),
    license: videoFieldShapes.license.default("standard"),
    isEmbeddingAllowed: videoFieldShapes.isEmbeddingAllowed.default(true),
    areCommentsEnabled: videoFieldShapes.areCommentsEnabled.default(true),
    shouldShowLikesCount: videoFieldShapes.shouldShowLikesCount.default(true),
    hasPaidPromotion: videoFieldShapes.hasPaidPromotion.default(false),
    anime: CreateAnimeSchema.optional(),
  })
  .strict()
  .superRefine(requireAnimeBlockForEpisodes);

/** PATCH. Every field optional, NONE defaulted — see the note on videoFieldShapes. */
const UpdateVideoSchema = z
  .object({ ...videoFieldShapes, anime: UpdateAnimeSchema })
  .partial()
  .strict()
  .superRefine(requireAnimeBlockForEpisodes);

const ReplaceChaptersSchema = z.object({ chapters: z.array(ChapterSchema).max(100) }).strict();

const ReplaceProductsSchema = z
  .object({ productIds: z.array(z.string().min(1).max(64)).max(50) })
  .strict();

const ReplacePlaylistsSchema = z
  .object({ playlistIds: z.array(z.string().min(1).max(64)).max(50) })
  .strict();

const ListMyVideosQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    // My Videos wants draft/published/pending tabs. Both are index-backed and much
    // cheaper to add now than to retrofit once the client paginates.
    publishStatus: z.enum(["draft", "scheduled", "published"]).optional(),
    reviewStatus: z.enum(["not_required", "pending", "approved", "rejected"]).optional(),
  })
  .strict();

export type CreateVideoInput = z.infer<typeof CreateVideoSchema>;
export type UpdateVideoInput = z.infer<typeof UpdateVideoSchema>;

/** POST /videos */
export async function createVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateVideoSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const createResult = await videosService.createVideo(req.user.id, parsedBody.data);
  if (!createResult.success) {
    respondStudioError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Video created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/** GET /videos/mine */
export async function getMyVideos(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListMyVideosQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const videosPage = await videosService.listMyVideos(req.user.id, parsedQuery.data);

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Videos retrieved successfully",
    data: [...videosPage.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: videosPage.total,
      totalPages: Math.ceil(videosPage.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/** GET /videos/:videoId */
export async function getVideoById(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const getResult = await videosService.getVideo(req.user.id, firstParam(req.params.videoId ?? ""));
  if (!getResult.success) {
    respondStudioError(res, getResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video retrieved successfully",
    data: getResult.value,
  };
  res.status(200).json(response);
}

/** PATCH /videos/:videoId */
export async function updateVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = UpdateVideoSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updateResult = await videosService.updateVideo(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondStudioError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/** POST /videos/:videoId/thumbnail — multipart, field `image`. */
export async function uploadThumbnail(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  if (!req.file) {
    // Wording matched to the eleven sibling missing-file handlers: naming the multipart field is
    // the difference between a fixable request and a guess.
    respondFieldRefusal(res, "image", "An image file is required (multipart field 'image').");
    return;
  }

  const replaceResult = await videosService.replaceVideoThumbnail(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    req.file.buffer,
  );
  if (!replaceResult.success) {
    respondStudioError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Thumbnail updated successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/** PUT /videos/:videoId/chapters */
export async function replaceChapters(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ReplaceChaptersSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const replaceResult = await videosService.replaceChapters(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data.chapters,
  );
  if (!replaceResult.success) {
    respondStudioError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Chapters updated successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/** PUT /videos/:videoId/products */
export async function replaceAttachedProducts(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ReplaceProductsSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const replaceResult = await videosService.replaceAttachedProducts(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data.productIds,
  );
  if (!replaceResult.success) {
    respondStudioError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Attached products updated successfully",
    data: replaceResult.value,
  };
  res.status(200).json(response);
}

/** PUT /videos/:videoId/playlists */
export async function replaceVideoPlaylists(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ReplacePlaylistsSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const setResult = await videosService.setVideoPlaylists(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
    parsedBody.data.playlistIds,
  );
  if (!setResult.success) {
    respondStudioError(res, setResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Playlists updated successfully",
    data: setResult.value,
  };
  res.status(200).json(response);
}

/** POST /videos/:videoId/publish */
export async function publishVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const publishResult = await videosService.publishVideo(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  if (!publishResult.success) {
    respondStudioError(res, publishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    // An anime episode is SUBMITTED, not published — say so, or the creator will look
    // for it in /anime and find nothing.
    message:
      publishResult.value.reviewStatus === "pending"
        ? "Episode submitted for review"
        : "Video published successfully",
    data: publishResult.value,
  };
  res.status(200).json(response);
}

/** POST /videos/:videoId/unpublish */
export async function unpublishVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const unpublishResult = await videosService.unpublishVideo(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  if (!unpublishResult.success) {
    respondStudioError(res, unpublishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video unpublished successfully",
    data: unpublishResult.value,
  };
  res.status(200).json(response);
}

/**
 * GET /videos/:videoId/playback-token — DEFERRED (Appendix A), always refuses.
 *
 * The route is mounted so the client contract does not move when self-hosting lands.
 * Ownership is checked first, so a stranger gets 404 and only the owner sees the 409.
 */
export async function getPlaybackToken(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const tokenResult = await videosService.issuePlaybackToken(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  // The success branch is `never` today, but it is written out rather than assumed:
  // when Appendix A lands and this starts minting real tokens, the compiler points here
  // instead of the route silently 409-ing a caller who should have got a token.
  if (!tokenResult.success) {
    respondStudioError(res, tokenResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Playback token issued",
    data: tokenResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /videos/:videoId */
export async function deleteVideo(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const deleteResult = await videosService.deleteVideo(
    req.user.id,
    firstParam(req.params.videoId ?? ""),
  );
  if (!deleteResult.success) {
    respondStudioError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Video deleted successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}
