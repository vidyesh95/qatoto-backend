/**
 * Request schemas for videos, extracted from videos.controller.ts.
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

import { isYoutubeVideoUrl } from "#src/lib/youtube.js";

/**
 * An http(s) URL, normalized.
 *
 * `z.url()` ALONE IS NOT ENOUGH HERE. It validates by constructing a `URL`, which
 * happily accepts `javascript:alert(1)` — and every one of these columns is rendered by
 * the client as an `href`. The protocol allowlist is what makes that safe. Normalizing
 * through `URL` afterwards means one stored spelling per link rather than three.
 */
export const HttpUrlSchema = z
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
export const YoutubeUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isYoutubeVideoUrl, "Not a YouTube video link");

export const ChapterSchema = z
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
export const CreateAnimeSchema = z
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
export const UpdateAnimeSchema = z
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
export const videoFieldShapes = {
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
  /**
   * The venture this video belongs to (§11i).
   *
   * A SLUG, NOT AN ID, and that is not a style choice. R&D's public identity is the slug —
   * no route is keyed on a project id, and neither `ResearchProjectListRow` nor
   * `ResearchProjectDetailView` carries one — so a client has no id to send and should
   * never be given one. The service resolves the slug and stores the id in the column.
   *
   * NULLABLE, and the null is load-bearing on PATCH: it is how a creator DETACHES a video
   * from a venture. An omitted key leaves the link alone. No `.default()`, per this map's
   * standing warning.
   *
   * The server re-verifies active membership AND that the project is `active` before
   * accepting a value — a client sending this field is making a request, not a statement.
   * Unlike `attachedPitchId`, which is still absent below, the thing this points at exists.
   */
  researchProjectSlug: z.string().min(1).max(200).nullable(),
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
  /**
   * Recruiting blurbs. OBJECTS, NOT STRINGS, since the venture link landed.
   *
   * `openRoleId` is optional and, when present, must name a `projectOpenRole` belonging to
   * THIS video's own `researchProjectSlug` — the service re-verifies it with the same
   * `and(id, projectId)` predicate the R&D apply gate uses, so a role id from another venture
   * is indistinguishable from a nonexistent one. Without it the blurb stays what it has always
   * been: text that points at nothing, which is correct for anime and unaffiliated videos.
   *
   * `roleDescription` is accepted here for the first time. The column has existed since the
   * table did and no endpoint ever wrote it.
   */
  openRoles: z
    .array(
      z
        .object({
          roleTitle: z.string().trim().min(1).max(120),
          roleDescription: z.string().trim().max(2000).optional(),
          openRoleId: z.string().min(1).max(64).optional(),
        })
        .strict(),
    )
    .max(20),
  teamMemberNames: z.array(z.string().trim().min(1).max(120)).max(50),
  collaboratorEmails: z.array(z.email().max(320)).max(50),
};

/**
 * `videoType: "anime_episode"` and the `anime` block must arrive together: an episode
 * with no catalog entry can never be reviewed, and a catalog entry on a `demo` would be
 * an orphan nothing reads.
 */
export function requireAnimeBlockForEpisodes(
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
export const CreateVideoSchema = z
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
export const UpdateVideoSchema = z
  .object({ ...videoFieldShapes, anime: UpdateAnimeSchema })
  .partial()
  .strict()
  .superRefine(requireAnimeBlockForEpisodes);

export const ReplaceChaptersSchema = z
  .object({ chapters: z.array(ChapterSchema).max(100) })
  .strict();

export const ReplaceProductsSchema = z
  .object({ productIds: z.array(z.string().min(1).max(64)).max(50) })
  .strict();

export const ReplacePlaylistsSchema = z
  .object({ playlistIds: z.array(z.string().min(1).max(64)).max(50) })
  .strict();

/**
 * `GET /users/me/video-analytics`.
 *
 * PAGE AND LIMIT ONLY. There is no `?sort=`, and its absence is the same refusal
 * `ListVideoCommentsQuerySchema` makes about `?sort=top`: `video_stats` carries a primary key and
 * no secondary index, so ordering a creator's videos by view count would sort after the join with
 * nothing behind it. Accepting the parameter would advertise storage that does not exist.
 */
export const ListVideoAnalyticsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const ListMyVideosQuerySchema = z
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

/**
 * Body for `POST /videos/:videoId/collaborators/respond`.
 *
 * TWO VALUES, NO THIRD. There is no "un-answer": a decline is an answer the creator can see, and
 * reverting to `invited` would erase a decision somebody made. Re-inviting is the creator's move.
 */
export const RespondToCollaborationSchema = z
  .object({ response: z.enum(["accepted", "declined"]) })
  .strict();
