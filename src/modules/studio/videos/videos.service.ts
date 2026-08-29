import { createHash } from "node:crypto";

import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  animeEpisode,
  animeSeason,
  animeSeries,
  contentCategory,
  creatorStats,
  playlist,
  playlistItem,
  product,
  projectOpenRole,
  researchProject,
  video,
  videoAttachedProduct,
  videoCategory,
  videoChapter,
  user,
  videoCollaborator,
  videoContentReport,
  videoModerationAction,
  videoDocument,
  videoMilestone,
  videoOpenRole,
  videoTeamMember,
} from "#src/db/schema.js";
import {
  deleteVideoThumbnail as deleteThumbnailAsset,
  uploadVideoThumbnail as uploadThumbnailAsset,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import {
  deleteVideoDocument as deleteDocumentObject,
  presignVideoDocumentDownload,
  uploadVideoDocument as uploadDocumentObject,
  type ObjectStorageError,
} from "#src/lib/object-storage.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { mintSeriesSlug } from "#src/modules/studio/series/series.service.js";
import {
  buildYoutubeEmbedUrl,
  extractYoutubeVideoId,
  verifyYoutubeVideo,
  type FetchImplementation,
  type YoutubeSourceError,
  type YoutubeVideoFacts,
} from "#src/lib/youtube.js";
import { ensureVideoStatsRows } from "#src/modules/home/engagement/video-engagement.service.js";
import {
  isPdfValidationError,
  validatePdfBytes,
  type PdfValidationError,
} from "#src/modules/rnd/pdf.js";
// The venture gate's membership half. `isActiveProjectMember` is the only exported R&D
// membership helper keyed on a projectId rather than a slug, which is what studio holds.
import { isActiveProjectMember } from "#src/modules/rnd/projects/project-membership.service.js";
import {
  DEFAULT_CONTENT_CATEGORY_SLUG,
  findUnavailableCategoryIds,
  resolveDefaultCategoryId,
} from "#src/modules/studio/content-categories.service.js";
import { findPublicVideo } from "#src/modules/studio/public-video-gate.js";
import {
  MAX_VIDEO_DOCUMENTS,
  videoDocumentDownloadPath,
} from "#src/modules/studio/videos/video-document-paths.js";
import type {
  CreateVideoInput,
  UpdateVideoInput,
} from "#src/modules/studio/videos/videos.schemas.js";

/**
 * HOME_BACKEND_STRUCTURE.md §2: at most three categories per video.
 *
 * A cardinality bound ACROSS ROWS is not expressible as a table CHECK, and §2 says so —
 * which leaves the service as the only place it can hold. The matching `.max(3)` in the
 * controller is the request contract; this is the invariant.
 */
const MAXIMUM_CATEGORIES_PER_VIDEO = 3;
import type { Result } from "#src/types/index.js";

/**
 * The categories to actually write, given what the creator chose.
 *
 * AN EMPTY SET BECOMES THE DEFAULT BUCKET, and this is the whole reason the default exists:
 * the feed's category predicate never relaxes, so a video in no category is unreachable by
 * every category filter for as long as it lives. Choosing a category stays optional for the
 * creator; the consequence of not choosing is absorbed here.
 *
 * IT DEGRADES TO `[]` RATHER THAN FAILING when the default row is missing or retired. That
 * is the behaviour that existed before this function did, and the alternative — refusing an
 * upload because an environment was never seeded — hands a creator a wall they cannot climb
 * over a problem only an operator can fix. The warning is the signal that the seed is due.
 *
 * The returned ids are NOT re-validated by `findUnavailableCategoryIds`: the default is
 * looked up by slug WITH `isActive` already in the predicate, so it is available by
 * construction, and the caller's own list was validated before it got here.
 */
async function withDefaultCategoryFallback(
  categoryIds: readonly string[],
): Promise<readonly string[]> {
  if (categoryIds.length > 0) return categoryIds;

  const defaultCategoryId = await resolveDefaultCategoryId();
  if (defaultCategoryId === null) {
    logger.warn("videos: default content category missing, video will be left untagged", {
      slug: DEFAULT_CONTENT_CATEGORY_SLUG,
    });
    return [];
  }

  return [defaultCategoryId];
}

/**
 * Creator-owned video operations (docs/STUDIO_BACKEND_STRUCTURE.md §6, §8, §9).
 *
 * OWNERSHIP IS ENFORCED IN THE WHERE CLAUSE, never as a post-check, and "missing" and
 * "belongs to someone else" collapse to the SAME error so a stranger cannot probe which
 * video ids exist (§0). Every `/:videoId` operation therefore starts from a query that
 * already carries `creatorId = caller`.
 *
 * NO TRANSACTION IS EVER OPEN ACROSS A NETWORK CALL. The oEmbed verify and every
 * Cloudinary round-trip happen first, and only then does a transaction open. A
 * transaction held across a third party's timeout is a lock held across a third party's
 * timeout.
 *
 * APPENDIX A IS DEFERRED. Nothing here writes `storageProvider`, `videoAssetId`,
 * `playbackId` or `playbackUrl`, and `videoSource` is always "youtube".
 */

// --------------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------------

/**
 * Declared once and imported by the playlist and review services, because TypeScript
 * only collapses two union arms sharing a `type` literal when their payloads are
 * identical — and the studio mapper must render this as exactly one 404 arm.
 */
export type VideoNotFoundError = { type: "VIDEO_NOT_FOUND"; videoId: string };

/** Which chapter rule was broken. The mapper renders one message per reason. */
export type InvalidChaptersError = {
  type: "INVALID_CHAPTERS";
  reason: "TOO_FEW" | "FIRST_NOT_ZERO" | "NOT_ASCENDING" | "TOO_CLOSE" | "PAST_END";
  /** The offending chapter's index, where the rule is about a specific one. */
  index: number | null;
};

/**
 * `visibility: investor_only` / `isNdaRequired: true` on a YouTube row. The payload is
 * the literal union sourced from the column, not `string`, so the two cannot drift.
 */
export type GatingUnsupportedError = {
  type: "GATING_UNSUPPORTED_FOR_SOURCE";
  videoSource: VideoSource;
};

export type VideoError =
  | VideoNotFoundError
  | InvalidChaptersError
  | GatingUnsupportedError
  | { type: "INCOMPLETE_FOR_PUBLISH"; missing: readonly string[] }
  // Reachable the moment anything sets uploadStatus to "failed" — today only the §5.1
  // re-check job would, and that is deferred. Kept as the publish safety gate rather
  // than deleted, because publishing a row whose media is broken is the thing it stops.
  | { type: "NOT_READY"; uploadStatus: VideoUploadStatus }
  // HOME_BACKEND_STRUCTURE.md §8.3's publish gate. DISTINCT FROM NOT_READY, and the
  // distinction is what the creator needs: nothing about the upload is wrong, the row is
  // complete, and there is nothing to edit. YouTube simply has not confirmed the source
  // yet and `verify-youtube-video` is already retrying. NOT_READY says "fix this";
  // this says "wait".
  | { type: "SOURCE_NOT_VERIFIED"; youtubeVideoId: string | null }
  // Carries the WHOLE offending list, not the first one: a client sends up to 50 ids and
  // must be able to strike every bad chip at once rather than one round-trip each.
  | { type: "PRODUCT_NOT_OWNED"; productIds: readonly string[] }
  // The venture link (§11i). NOT a 403, and the naming says why: three different facts —
  // no such project, a project you are not an active member of, and a project that is not
  // `active` — collapse into one literal on purpose, exactly as PRODUCT_NOT_OWNED collapses
  // "no such product" into "not yours". Splitting them would make the status an oracle for
  // which project ids exist. See studio-error-response.ts's status policy.
  | { type: "RESEARCH_PROJECT_NOT_JOINABLE"; researchProjectSlug: string }
  // Same collapse-into-one rule as the arms around it: "no such role", "a role at another
  // venture" and "this video has no venture" are one answer. Carries the WHOLE offending list.
  | { type: "OPEN_ROLE_NOT_IN_PROJECT"; openRoleIds: readonly string[] }
  // Same rule, for categories. Named NOT_AVAILABLE rather than NOT_FOUND because unknown
  // and retired collapse into it deliberately (see findUnavailableCategoryIds), and
  // because a distinct literal cannot collide with another union's arm inside the studio
  // mapper's exhaustive switch.
  | { type: "VIDEO_CATEGORY_NOT_AVAILABLE"; categoryIds: readonly string[] }
  | { type: "TOO_MANY_VIDEO_CATEGORIES"; limit: number; received: number }
  | { type: "PLAYLIST_NOT_OWNED"; playlistIds: readonly string[] }
  | { type: "ANIME_SERIES_NOT_FOUND"; seriesId: string }
  | { type: "ANIME_SEASON_NOT_FOUND"; seasonId: string }
  | { type: "NOT_AN_ANIME_EPISODE" }
  | { type: "EPISODE_NUMBER_TAKEN"; episodeNumber: number }
  | { type: "NO_TOKEN_REQUIRED" }
  // --- Attached documents (§11j) ---------------------------------------------------
  // The same collapse-into-one rule every id-bearing arm above follows: "no such document" and
  // "a document on another video" are one answer, so the status cannot enumerate document ids.
  | { type: "VIDEO_DOCUMENT_NOT_FOUND"; documentId: string }
  | { type: "TOO_MANY_VIDEO_DOCUMENTS"; limit: number }
  | { type: "INVALID_PDF"; reason: PdfValidationError["type"] }
  // ⚠️ `ObjectStorageError` IS TRANSLATED, NOT MERGED, and the reason is a genuine collision:
  // its three literals are byte-identical to `CloudinaryError`'s — `NOT_CONFIGURED`,
  // `UPLOAD_FAILED`, `DELETE_FAILED` — so a merged union would be indistinguishable to the
  // exhaustive switch in `studio-error-response.ts`, and a PDF that failed to store would answer
  // "Could not store the image". Distinct arms keep the copy honest and the switch total.
  | { type: "DOCUMENT_STORAGE_NOT_CONFIGURED" }
  | { type: "DOCUMENT_STORAGE_UPLOAD_FAILED" }
  | { type: "DOCUMENT_STORAGE_DELETE_FAILED" }
  | YoutubeSourceError
  | ImageValidationError
  | CloudinaryError;
// NOTE: §8's `NOT_PERMITTED` is deliberately absent. Gated playback is refused at the
// boundary in a YouTube-only build, so no code path can produce it, and an unreachable
// arm is dead code the `never` exhaustiveness check cannot catch.

// --------------------------------------------------------------------------------
// Column-sourced literal unions, so a projection can never drift from the schema
// --------------------------------------------------------------------------------

type VideoRow = typeof video.$inferSelect;
export type VideoSource = VideoRow["videoSource"];
export type VideoType = VideoRow["videoType"];
export type VideoUploadStatus = VideoRow["uploadStatus"];
export type VideoVisibility = VideoRow["visibility"];
export type VideoPublishStatus = VideoRow["publishStatus"];
export type ContentReviewStatus = VideoRow["reviewStatus"];

// --------------------------------------------------------------------------------
// Pure validators — no db, no req, unit-testable on their own
// --------------------------------------------------------------------------------

/** Chapters must be at least this far apart for a player to render them usefully. */
const MINIMUM_CHAPTER_GAP_SECONDS = 10;

/** Below this a player shows no chapter UI at all, so storing them is storing nothing. */
const MINIMUM_CHAPTERS_TO_DISPLAY = 3;

export interface ChapterInput {
  readonly startSeconds: number;
  readonly title: string;
}

/**
 * Validates a whole chapter set, or returns null when it is legal (§6).
 *
 * THE `<= durationSeconds` BOUND IS A NULL-GUARD, NOT A SOURCE CHECK. oEmbed returns no
 * duration, so `durationSeconds` is null on every row today and the rule simply does not
 * apply. Written this way rather than as `if (videoSource !== "youtube")` so it becomes
 * correct on its own the moment hosted rows start carrying a duration.
 *
 * An EMPTY set is valid and means "clear the chapters". A set of one or two is NOT: a
 * player renders nothing below three, so those are stored state that can never display.
 */
export function validateChapterSet(
  chapters: readonly ChapterInput[],
  durationSeconds: number | null,
): InvalidChaptersError | null {
  if (chapters.length === 0) return null;

  if (chapters.length < MINIMUM_CHAPTERS_TO_DISPLAY) {
    return { type: "INVALID_CHAPTERS", reason: "TOO_FEW", index: null };
  }

  if (chapters[0]?.startSeconds !== 0) {
    return { type: "INVALID_CHAPTERS", reason: "FIRST_NOT_ZERO", index: 0 };
  }

  for (let chapterIndex = 1; chapterIndex < chapters.length; chapterIndex += 1) {
    const previousStart = chapters[chapterIndex - 1]?.startSeconds ?? 0;
    const currentStart = chapters[chapterIndex]?.startSeconds ?? 0;

    if (currentStart <= previousStart) {
      return { type: "INVALID_CHAPTERS", reason: "NOT_ASCENDING", index: chapterIndex };
    }
    if (currentStart - previousStart < MINIMUM_CHAPTER_GAP_SECONDS) {
      return { type: "INVALID_CHAPTERS", reason: "TOO_CLOSE", index: chapterIndex };
    }
  }

  if (durationSeconds !== null) {
    const pastEndIndex = chapters.findIndex((chapter) => chapter.startSeconds > durationSeconds);
    if (pastEndIndex !== -1) {
      return { type: "INVALID_CHAPTERS", reason: "PAST_END", index: pastEndIndex };
    }
  }

  return null;
}

/**
 * The gating rule (§0, §5.1), or null when the combination is legal.
 *
 * The bytes live on youtube.com, so anyone with the link watches them signed in or not.
 * `investor_only` and NDA-gated playback are therefore IMPOSSIBLE for a YouTube row, and
 * the backend refuses them rather than implying protection it cannot deliver. This lives
 * in the service and not the schema because each field is individually legal — only the
 * combination with a PERSISTED videoSource is not, and a request schema cannot see that
 * column. Called on create, on PATCH against the MERGED state, and again on publish.
 */
export function assertGatingSupported(
  videoSource: VideoSource,
  visibility: VideoVisibility,
  isNdaRequired: boolean,
): GatingUnsupportedError | null {
  if (videoSource !== "youtube") return null;
  if (visibility === "investor_only" || isNdaRequired) {
    return { type: "GATING_UNSUPPORTED_FOR_SOURCE", videoSource };
  }
  return null;
}

/**
 * The single badge the frontend renders, derived from the three orthogonal columns on
 * read (§8). The client never stores it — mixing them on the wire is what would allow
 * "published while still processing".
 */
export type StudioVideoStatusKind =
  | "failed"
  | "processing"
  | "pending-review"
  | "rejected"
  | "approved"
  | "scheduled"
  | "published"
  /**
   * ⚠️ A MODERATOR HID THIS VIDEO. Added because its absence made this function LIE.
   *
   * `video.moderationVisibilityState` is set by the content-report queue and appeared nowhere in
   * this file — not in the projection, not in this union, not in the input type below. So a video a
   * moderator had hidden still derived as `"published"` for its own creator: the Studio told them
   * it was live while the public gate served nobody. That is worse than saying nothing, because it
   * is the one screen the person who could fix it would look at.
   *
   * It is checked BEFORE `publishStatus` for the same reason `rejected` is: the row really is
   * `publishStatus: "published"`, and the moderation state is what overrides that reading.
   */
  | "hidden-by-moderator"
  | "draft";

export interface StudioVideoStatusInput {
  readonly uploadStatus: VideoUploadStatus;
  readonly publishStatus: VideoPublishStatus;
  readonly reviewStatus: ContentReviewStatus;
  readonly scheduledPublishAt: Date | null;
  /** Set on approval, when an anime episode actually goes live in /anime. */
  readonly episodeReleasedAt: Date | null;
  /**
   * Whether the content-report queue has hidden this video.
   *
   * OPTIONAL SO THE PURE HELPER STAYS CALLABLE from anywhere that has not loaded it, but every
   * caller in this file passes it — an omitted value reads as `visible`, which is the safe default
   * only because the alternative (defaulting to hidden) would blank a creator's Studio on a bug.
   */
  readonly moderationVisibilityState?: "visible" | "hidden_by_moderator";
}

export function deriveStudioVideoStatus(
  input: StudioVideoStatusInput,
  nowEpochMs: number,
): StudioVideoStatusKind {
  if (input.uploadStatus === "failed") return "failed";
  // Unreachable for a YouTube row, which is born "ready". Kept because it is reachable
  // again the moment hosted rows exist — deleting it would make Appendix A a code change
  // rather than a config change.
  if (input.uploadStatus === "uploading" || input.uploadStatus === "processing") {
    return "processing";
  }

  // BEFORE THE PUBLISH BRANCHES. A hidden video is still `publishStatus: "published"` in the row —
  // moderation does not unpublish it, it withdraws it from the public gate — so reading publish
  // state first is exactly how this came to report "published" for a video nobody can see.
  if (input.moderationVisibilityState === "hidden_by_moderator") return "hidden-by-moderator";

  if (input.reviewStatus === "pending") return "pending-review";
  if (input.reviewStatus === "rejected") return "rejected";
  if (input.reviewStatus === "approved" && input.episodeReleasedAt === null) return "approved";

  if (input.publishStatus === "scheduled") {
    // Nothing in this build flips scheduled -> published (the job is a separate phase),
    // so the badge is derived rather than trusted. Without this the UI would show
    // "scheduled for last Tuesday" indefinitely.
    const scheduledFor = input.scheduledPublishAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return scheduledFor <= nowEpochMs ? "published" : "scheduled";
  }
  if (input.publishStatus === "published") return "published";

  return "draft";
}

// --------------------------------------------------------------------------------
// Projections
// --------------------------------------------------------------------------------

export interface VideoChapterView {
  readonly id: string;
  readonly startSeconds: number;
  readonly title: string;
}

export interface VideoAttachedProductView {
  readonly id: string;
  readonly productId: string;
  readonly position: number;
  readonly pinnedAtSeconds: number | null;
}

export interface VideoLabelView {
  readonly id: string;
  readonly label: string;
  readonly position: number;
}

export interface VideoOpenRoleView {
  readonly id: string;
  readonly roleTitle: string;
  readonly roleDescription: string | null;
  /** The real `projectOpenRole` this blurb advertises, or null for free text. */
  readonly openRoleId: string | null;
  readonly position: number;
}

export interface VideoTeamMemberView {
  readonly id: string;
  readonly memberName: string;
  readonly roleLabel: string | null;
  readonly position: number;
}

export interface VideoCollaboratorView {
  readonly id: string;
  readonly invitedEmail: string;
  readonly status: "invited" | "accepted" | "declined";
}

/**
 * One attached deck or whitepaper, as it reaches a client.
 *
 * ⚠️ THERE IS NO `url`, AND THAT IS THE DESIGN RATHER THAN AN OMISSION. `downloadPath` is a path on
 * THIS api, not a link to the bytes: every fetch of it re-checks the video's public gate, so the
 * document stops being reachable the moment the video does. A presigned storage URL sent here would
 * outlive an unpublish, and `object_storage_key` never leaves the server at all.
 */
export interface VideoDocumentView {
  readonly id: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly position: number;
  /** `/videos/:videoId/documents/:documentId/file` — 302s to a short-lived presigned URL. */
  readonly downloadPath: string;
}

/**
 * One taxonomy row as it appears on a video (HOME_BACKEND_STRUCTURE.md §2).
 *
 * Narrower than `ContentCategoryView`: a tag on a video does not need the tile art or the
 * global sort order, and returning them would imply the video controls them.
 */
export interface ContentCategoryRefView {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
}

export interface AnimeEpisodeView {
  readonly id: string;
  readonly seriesId: string;
  readonly seriesTitle: string;
  readonly seasonId: string;
  readonly seasonLabel: string;
  readonly episodeNumber: number;
  readonly episodeTitle: string;
  readonly isPremium: boolean;
  readonly releaseScheduleDay: string | null;
  readonly releaseScheduleTime: string | null;
  readonly premiereDate: Date | null;
  readonly audioMode: "subbed" | "dubbed" | null;
  readonly audioLanguage: string | null;
  readonly ageRating: string | null;
  readonly releasedAt: Date | null;
}

/** The full read-back shape. One canonical projection so it cannot drift per endpoint. */
export interface PublicVideo {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly videoType: VideoRow["videoType"];
  readonly stageBadge: VideoRow["stageBadge"];

  readonly videoSource: VideoSource;
  readonly youtubeVideoId: string | null;
  /** Rebuilt server-side from the stored id. The client renders THIS, never its own. */
  readonly youtubeEmbedUrl: string | null;
  /**
   * Has YouTube confirmed the source exists and embeds (§8.3)?
   *
   * IN THE PROJECTION DELIBERATELY. Without it the studio would have to INFER "still
   * verifying" from a missing thumbnail — a client deriving a server fact from a proxy,
   * which is the thin-client violation CLAUDE.md §1.1 exists to prevent. It is also the
   * only way a creator can be shown why publish is refused.
   */
  readonly isSourceVerified: boolean;

  // Provider-neutral media identity — null while videoSource is "youtube" (Appendix A).
  readonly storageProvider: VideoRow["storageProvider"];
  readonly playbackId: string | null;
  readonly playbackUrl: string | null;

  readonly uploadStatus: VideoUploadStatus;
  readonly durationSeconds: number | null;
  readonly thumbnailUrl: string | null;
  readonly hasCustomThumbnail: boolean;

  readonly sectorTags: readonly string[];
  readonly tags: readonly string[];
  readonly websiteUrl: string | null;
  readonly ctaLabel: string | null;
  readonly ctaUrl: string | null;
  readonly linkedinUrl: string | null;
  readonly xProfileUrl: string | null;
  readonly contactEmail: string | null;
  readonly isMadeForKids: boolean | null;
  readonly hasAgeRestriction: boolean;
  readonly relatedVideoUrl: string | null;
  readonly hasFundingCallToAction: boolean;
  /**
   * The venture link (§11i), as a SLUG — the id never leaves the server, matching every
   * other R&D read. Null is unaffiliated content, not missing data.
   */
  readonly researchProjectSlug: string | null;

  readonly visibility: VideoVisibility;
  readonly isNdaRequired: boolean;
  readonly scheduledPublishAt: Date | null;
  readonly publishStatus: VideoPublishStatus;
  readonly publishedAt: Date | null;
  readonly reviewStatus: ContentReviewStatus;
  readonly rejectionReason: string | null;

  readonly license: VideoRow["license"];
  readonly videoLanguage: string | null;
  readonly isEmbeddingAllowed: boolean;
  readonly areCommentsEnabled: boolean;
  readonly shouldShowLikesCount: boolean;
  readonly hasPaidPromotion: boolean;
  readonly usesAlteredContent: boolean | null;
  readonly captionCertification: string | null;
  readonly commentModeration: string | null;
  readonly commentSortOrder: string | null;
  readonly shortsRemixing: VideoRow["shortsRemixing"];
  readonly recordingDate: string | null;
  readonly recordingLocation: string | null;
  /**
   * LEGACY, READ-ONLY, and removed next release. No write path sets it any more — see the
   * `video.category` schema comment. `categories` below is the real answer.
   */
  readonly category: string | null;

  readonly chapters: readonly VideoChapterView[];
  /**
   * The taxonomy rows this video is tagged into, at most three.
   *
   * LABELS, NOT BARE IDS. The studio renders these as chips; returning only ids would make
   * every video card cross-reference `/feed/categories` to draw itself.
   */
  readonly categories: readonly ContentCategoryRefView[];
  readonly attachedProducts: readonly VideoAttachedProductView[];
  readonly milestones: readonly VideoLabelView[];
  readonly openRoles: readonly VideoOpenRoleView[];
  readonly teamMembers: readonly VideoTeamMemberView[];
  readonly collaborators: readonly VideoCollaboratorView[];
  readonly documents: readonly VideoDocumentView[];
  readonly playlistIds: readonly string[];
  readonly animeEpisode: AnimeEpisodeView | null;

  /** Derived on read from the three status columns (§8). */
  readonly derivedStatus: StudioVideoStatusKind;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Compact row for My Videos. Carries `scheduledPublishAt` and `rejectionReason` because
 * the frontend's status union is a discriminated union whose `scheduled` variant needs a
 * date and whose `rejected` variant needs a reason — a list row without them cannot
 * render its own badge. The INSTANT is emitted, never a formatted label: server-side
 * English prose in a data field is a localization bug waiting to happen.
 */
export interface VideoListRow {
  readonly id: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  /**
   * What KIND of video this is.
   *
   * The studio list needs it to tell an anime episode from a pitch at a glance — they take
   * different routes to publication (one is reviewed, one is not) and looked identical without
   * it. One column on a table already in the FROM clause.
   */
  readonly videoType: VideoType;
  readonly videoSource: VideoSource;
  readonly visibility: VideoVisibility;
  readonly uploadStatus: VideoUploadStatus;
  readonly publishStatus: VideoPublishStatus;
  readonly reviewStatus: ContentReviewStatus;
  readonly rejectionReason: string | null;
  readonly scheduledPublishAt: Date | null;
  readonly derivedStatus: StudioVideoStatusKind;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface VideoPage {
  readonly rows: readonly VideoListRow[];
  readonly total: number;
}

// --------------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------------

/** Where the caller-visible ownership predicate is written, once. */
function ownedVideoPredicate(creatorId: string, videoId: string) {
  return and(eq(video.id, videoId), eq(video.creatorId, creatorId));
}

async function loadOwnedVideoRow(creatorId: string, videoId: string): Promise<VideoRow | null> {
  const [row] = await db
    .select()
    .from(video)
    .where(ownedVideoPredicate(creatorId, videoId))
    .limit(1);
  return row ?? null;
}

/**
 * Re-reads this video's publish state INSIDE a transaction, holding the row.
 *
 * WHY THE PRE-TRANSACTION READ IS NOT ENOUGH. `loadOwnedVideoRow` above is a plain SELECT taken
 * before `db.transaction` opens, and every counter decision used to be made from it. Two requests
 * racing on one video therefore both saw the same "before" state and both moved the counter: a
 * double-clicked Delete on a published video read `published` twice, deleted once, and decremented
 * TWICE. `GREATEST(… - 1, 0)` kept that non-negative, which is not the same as correct.
 *
 * Taking the row `FOR UPDATE` serialises them — the second request blocks until the first commits,
 * then re-reads the state the first left behind and decides again from that. Returns null when the
 * row is gone, which is the honest answer for the loser of a delete race.
 */
async function lockOwnedVideoPublishState(
  tx: TransactionClient,
  creatorId: string,
  videoId: string,
): Promise<VideoPublishStatus | null> {
  const [locked] = await tx
    .select({ publishStatus: video.publishStatus })
    .from(video)
    .where(ownedVideoPredicate(creatorId, videoId))
    .for("update")
    .limit(1);
  return locked?.publishStatus ?? null;
}

/** Assembles the full projection from an already-ownership-checked row. */
async function toPublicVideo(row: VideoRow, nowEpochMs: number): Promise<PublicVideo> {
  const [
    chapters,
    attachedProducts,
    milestones,
    openRoles,
    teamMembers,
    collaborators,
    documents,
    playlistRows,
    categories,
    episodeRows,
    researchProjectRows,
  ] = await Promise.all([
    db
      .select({
        id: videoChapter.id,
        startSeconds: videoChapter.startSeconds,
        title: videoChapter.title,
      })
      .from(videoChapter)
      .where(eq(videoChapter.videoId, row.id))
      .orderBy(asc(videoChapter.position)),
    db
      .select({
        id: videoAttachedProduct.id,
        productId: videoAttachedProduct.productId,
        position: videoAttachedProduct.position,
        pinnedAtSeconds: videoAttachedProduct.pinnedAtSeconds,
      })
      .from(videoAttachedProduct)
      .where(eq(videoAttachedProduct.videoId, row.id))
      .orderBy(asc(videoAttachedProduct.position)),
    db
      .select({
        id: videoMilestone.id,
        label: videoMilestone.label,
        position: videoMilestone.position,
      })
      .from(videoMilestone)
      .where(eq(videoMilestone.videoId, row.id))
      .orderBy(asc(videoMilestone.position)),
    db
      .select({
        id: videoOpenRole.id,
        roleTitle: videoOpenRole.roleTitle,
        roleDescription: videoOpenRole.roleDescription,
        openRoleId: videoOpenRole.openRoleId,
        position: videoOpenRole.position,
      })
      .from(videoOpenRole)
      .where(eq(videoOpenRole.videoId, row.id))
      .orderBy(asc(videoOpenRole.position)),
    db
      .select({
        id: videoTeamMember.id,
        memberName: videoTeamMember.memberName,
        roleLabel: videoTeamMember.roleLabel,
        position: videoTeamMember.position,
      })
      .from(videoTeamMember)
      .where(eq(videoTeamMember.videoId, row.id))
      .orderBy(asc(videoTeamMember.position)),
    db
      .select({
        id: videoCollaborator.id,
        invitedEmail: videoCollaborator.invitedEmail,
        status: videoCollaborator.status,
      })
      .from(videoCollaborator)
      .where(eq(videoCollaborator.videoId, row.id))
      .orderBy(asc(videoCollaborator.createdAt)),
    db
      .select({
        id: videoDocument.id,
        fileName: videoDocument.fileName,
        byteSize: videoDocument.byteSize,
        position: videoDocument.position,
      })
      .from(videoDocument)
      .where(eq(videoDocument.videoId, row.id))
      .orderBy(asc(videoDocument.position)),
    // SCOPED TO THE VIDEO'S OWNER, who is the only person this projection is ever built
    // for. Unscoped — as it was — this hands a creator the ids of every STRANGER'S playlist
    // that holds their video, which is neither theirs to know nor anything the picker can
    // do something with: `setVideoPlaylists` writes only within their own playlists.
    db
      .select({ playlistId: playlistItem.playlistId })
      .from(playlistItem)
      .innerJoin(playlist, eq(playlist.id, playlistItem.playlistId))
      .where(and(eq(playlistItem.videoId, row.id), eq(playlist.creatorId, row.creatorId))),
    // Ordered by the taxonomy's own sortOrder rather than by insertion: video_category has
    // no position column on purpose, so the only ordering available is the global one, and
    // an arbitrary order would render two chips differently on two page loads.
    db
      .select({
        id: contentCategory.id,
        slug: contentCategory.slug,
        label: contentCategory.label,
      })
      .from(videoCategory)
      .innerJoin(contentCategory, eq(contentCategory.id, videoCategory.categoryId))
      .where(eq(videoCategory.videoId, row.id))
      .orderBy(asc(contentCategory.sortOrder), asc(contentCategory.slug)),
    db
      .select({
        id: animeEpisode.id,
        seasonId: animeEpisode.seasonId,
        seasonLabel: animeSeason.seasonLabel,
        seriesId: animeSeries.id,
        seriesTitle: animeSeries.title,
        episodeNumber: animeEpisode.episodeNumber,
        episodeTitle: animeEpisode.episodeTitle,
        isPremium: animeEpisode.isPremium,
        releaseScheduleDay: animeEpisode.releaseScheduleDay,
        releaseScheduleTime: animeEpisode.releaseScheduleTime,
        premiereDate: animeEpisode.premiereDate,
        audioMode: animeEpisode.audioMode,
        audioLanguage: animeEpisode.audioLanguage,
        ageRating: animeEpisode.ageRating,
        releasedAt: animeEpisode.releasedAt,
      })
      .from(animeEpisode)
      .innerJoin(animeSeason, eq(animeSeason.id, animeEpisode.seasonId))
      .innerJoin(animeSeries, eq(animeSeries.id, animeSeason.seriesId))
      .where(eq(animeEpisode.videoId, row.id))
      .limit(1),
    // The venture link resolved back to its SLUG. `row` holds the id, and the id is exactly
    // what must not reach a client — every R&D read is slug-addressed. One extra select
    // rather than a join on the parent read, because it is null for the large majority of
    // videos and this Promise.all is already the place child facts are gathered.
    row.researchProjectId === null
      ? Promise.resolve([])
      : db
          .select({ slug: researchProject.slug })
          .from(researchProject)
          .where(eq(researchProject.id, row.researchProjectId))
          .limit(1),
  ]);

  const episode = episodeRows[0] ?? null;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    videoType: row.videoType,
    stageBadge: row.stageBadge,

    videoSource: row.videoSource,
    youtubeVideoId: row.youtubeVideoId,
    youtubeEmbedUrl: row.youtubeVideoId ? buildYoutubeEmbedUrl(row.youtubeVideoId) : null,
    isSourceVerified: row.isSourceVerified,

    storageProvider: row.storageProvider,
    playbackId: row.playbackId,
    playbackUrl: row.playbackUrl,

    uploadStatus: row.uploadStatus,
    durationSeconds: row.durationSeconds,
    thumbnailUrl: row.thumbnailUrl,
    hasCustomThumbnail: row.hasCustomThumbnail,

    sectorTags: row.sectorTags,
    tags: row.tags,
    websiteUrl: row.websiteUrl,
    ctaLabel: row.ctaLabel,
    ctaUrl: row.ctaUrl,
    linkedinUrl: row.linkedinUrl,
    xProfileUrl: row.xProfileUrl,
    contactEmail: row.contactEmail,
    isMadeForKids: row.isMadeForKids,
    hasAgeRestriction: row.hasAgeRestriction,
    relatedVideoUrl: row.relatedVideoUrl,
    hasFundingCallToAction: row.hasFundingCallToAction,
    researchProjectSlug: researchProjectRows[0]?.slug ?? null,

    visibility: row.visibility,
    isNdaRequired: row.isNdaRequired,
    scheduledPublishAt: row.scheduledPublishAt,
    publishStatus: row.publishStatus,
    publishedAt: row.publishedAt,
    reviewStatus: row.reviewStatus,
    rejectionReason: row.rejectionReason,

    license: row.license,
    videoLanguage: row.videoLanguage,
    isEmbeddingAllowed: row.isEmbeddingAllowed,
    areCommentsEnabled: row.areCommentsEnabled,
    shouldShowLikesCount: row.shouldShowLikesCount,
    hasPaidPromotion: row.hasPaidPromotion,
    usesAlteredContent: row.usesAlteredContent,
    captionCertification: row.captionCertification,
    commentModeration: row.commentModeration,
    commentSortOrder: row.commentSortOrder,
    shortsRemixing: row.shortsRemixing,
    recordingDate: row.recordingDate,
    recordingLocation: row.recordingLocation,
    // LEGACY. Read for one more release so that dropping the column and dropping its last
    // reader are two separate deploys (§2.2).
    category: row.category,

    chapters,
    categories,
    attachedProducts,
    milestones,
    openRoles,
    teamMembers,
    collaborators,
    // The download path is COMPOSED, not selected: it is derived from two ids the row already
    // carries, and storing it would be a second copy of the route's own shape.
    documents: documents.map((documentRow) => ({
      ...documentRow,
      downloadPath: videoDocumentDownloadPath(row.id, documentRow.id),
    })),
    playlistIds: playlistRows.map((playlistRow) => playlistRow.playlistId),
    animeEpisode: episode,

    derivedStatus: deriveStudioVideoStatus(
      {
        uploadStatus: row.uploadStatus,
        publishStatus: row.publishStatus,
        reviewStatus: row.reviewStatus,
        scheduledPublishAt: row.scheduledPublishAt,
        episodeReleasedAt: episode?.releasedAt ?? null,
        // WITHOUT THIS THE BRANCH NEVER FIRES. The status union grew a `hidden-by-moderator` arm;
        // it is inert unless the state actually reaches the helper.
        moderationVisibilityState: row.moderationVisibilityState,
      },
      nowEpochMs,
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Options threaded down to the oEmbed call so tests can run it with no network. */
export interface YoutubeVerificationOptions {
  readonly fetchImplementation?: FetchImplementation;
}

async function parseAndVerifyYoutubeUrl(
  rawYoutubeUrl: string,
  options: YoutubeVerificationOptions,
): Promise<
  Result<
    { youtubeVideoId: string; suggestedTitle: string | null; thumbnailUrl: string | null },
    VideoError
  >
> {
  const youtubeVideoId = extractYoutubeVideoId(rawYoutubeUrl);
  if (!youtubeVideoId) {
    return { success: false, error: { type: "INVALID_YOUTUBE_URL" } };
  }

  const verified = await verifyYoutubeVideo(youtubeVideoId, {
    timeoutMs: config.YOUTUBE_OEMBED_TIMEOUT_MS,
    fetchImplementation: options.fetchImplementation,
  });
  if (!verified.success) {
    return { success: false, error: verified.error };
  }

  return {
    success: true,
    value: {
      youtubeVideoId,
      suggestedTitle: verified.value.suggestedTitle,
      thumbnailUrl: verified.value.thumbnailUrl,
    },
  };
}

/**
 * The CREATE-path variant, which tolerates a YouTube outage (HOME_BACKEND_STRUCTURE.md §8.3).
 *
 * Same parse, same verify, one difference in what it does with the failure:
 *
 *   INVALID_YOUTUBE_URL       → still a hard error. Parsing is the SSRF boundary and it
 *                               never degrades; a string that is not a YouTube URL has no id
 *                               to store in the first place.
 *   YOUTUBE_VIDEO_UNAVAILABLE → still a hard error. The video is deleted, private, or not
 *                               embeddable. That is a link the creator must FIX, and
 *                               deferring it would store a known-bad id while telling them
 *                               nothing.
 *   YOUTUBE_VERIFY_FAILED     → DEFERRED. YouTube did not answer. Nothing about the
 *                               creator's submission is wrong, so returning `facts: null`
 *                               lets the row land as an unverified draft and hands the
 *                               question to `verify-youtube-video`.
 *
 * `parseAndVerifyYoutubeUrl` above keeps the hard failure on ALL THREE and stays the
 * update-path function. The asymmetry is deliberate: on create, the work at risk is the
 * whole upload; on PATCH the row already exists and the only loss is one form submission.
 * More to the point, deferring on PATCH would let an outage silently un-verify a published
 * row's source and swap in an id nothing has ever proven.
 */
async function parseAndVerifyYoutubeUrlForCreate(
  rawYoutubeUrl: string,
  options: YoutubeVerificationOptions,
): Promise<Result<{ youtubeVideoId: string; facts: YoutubeVideoFacts | null }, VideoError>> {
  const youtubeVideoId = extractYoutubeVideoId(rawYoutubeUrl);
  if (!youtubeVideoId) {
    return { success: false, error: { type: "INVALID_YOUTUBE_URL" } };
  }

  const verified = await verifyYoutubeVideo(youtubeVideoId, {
    timeoutMs: config.YOUTUBE_OEMBED_TIMEOUT_MS,
    fetchImplementation: options.fetchImplementation,
  });

  if (verified.success) {
    return { success: true, value: { youtubeVideoId, facts: verified.value } };
  }

  if (verified.error.type === "YOUTUBE_VERIFY_FAILED") {
    return { success: true, value: { youtubeVideoId, facts: null } };
  }

  return { success: false, error: verified.error };
}

/**
 * Product ids the caller does NOT own, deduplicated and order-preserved.
 *
 * Keyed on `createdByUserId` since migration 0088 dropped the legacy `sellerId` column.
 * BEHAVIOUR IS UNCHANGED for every existing row: Phase 0 backfilled `createdByUserId` from
 * `sellerId`, and `createProduct` has always written the session user to both.
 *
 * Worth knowing for later: the strictly correct check for "may this creator attach this
 * product" is organization membership, not creator identity, and the two diverge the moment
 * one member of a selling organization lists a product another member wants to feature.
 * Left as-is deliberately — widening authorization is a behaviour change and belongs in a
 * commit that is about authorization, not in a column removal.
 */
async function findUnownedProductIds(
  sellerId: string,
  productIds: readonly string[],
): Promise<readonly string[]> {
  if (productIds.length === 0) return [];
  const ownedRows = await db
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.createdByUserId, sellerId), inArray(product.id, [...productIds])));
  const ownedIds = new Set(ownedRows.map((row) => row.id));
  return productIds.filter((productId) => !ownedIds.has(productId));
}

/**
 * Resolves a venture SLUG to its id, but only if this creator may attach a video to it —
 * the write-side gate on `video.researchProjectId` (§11i).
 *
 * Returns the id on success and `null` on refusal, so the one call answers both "may I" and
 * "what do I store". The slug/id asymmetry is the point: the slug is what a client can name,
 * the id is what the column holds, and the translation happens here and nowhere else.
 *
 * TWO CONDITIONS, AND THE SECOND IS NOT REDUNDANT. `isActiveProjectMember` answers only
 * "is this user an active member", and it returns TRUE for a member of a `draft` project —
 * it never looks at `researchProject.status`. A draft project 404s for non-members
 * everywhere else in R&D, so letting a member attach a PUBLIC video to one would make the
 * watch page name an unpublished venture to anyone: the same disclosure the store's venture
 * block closes with its own `status = 'active'` predicate. Founders publish, then link.
 *
 * THE THREE FAILURES ARE ONE ANSWER. No such project, not a member, and not active are
 * indistinguishable to the caller by design — all three return `null` — see
 * `RESEARCH_PROJECT_NOT_JOINABLE`.
 */
async function resolveAttachableResearchProjectId(
  creatorId: string,
  researchProjectSlug: string,
): Promise<string | null> {
  const [activeProjectRow] = await db
    .select({ id: researchProject.id })
    .from(researchProject)
    .where(and(eq(researchProject.slug, researchProjectSlug), eq(researchProject.status, "active")))
    .limit(1);
  if (!activeProjectRow) return null;

  const isMember = await isActiveProjectMember(activeProjectRow.id, creatorId);
  return isMember ? activeProjectRow.id : null;
}

async function findUnownedPlaylistIds(
  creatorId: string,
  playlistIds: readonly string[],
): Promise<readonly string[]> {
  if (playlistIds.length === 0) return [];
  const ownedRows = await db
    .select({ id: playlist.id })
    .from(playlist)
    .where(and(eq(playlist.creatorId, creatorId), inArray(playlist.id, [...playlistIds])));
  const ownedIds = new Set(ownedRows.map((row) => row.id));
  return playlistIds.filter((playlistId) => !ownedIds.has(playlistId));
}

/** Order-preserving dedupe. Without it a repeated id hits a unique index as a raw 23505. */
function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One recruiting blurb as the wire sends it. `openRoleId` is optional and verified. */
export interface VideoOpenRoleInput {
  readonly roleTitle: string;
  readonly roleDescription?: string;
  readonly openRoleId?: string;
}

/**
 * Open-role ids in this set that this video may NOT advertise.
 *
 * SCOPED ON BOTH COLUMNS, exactly as the R&D apply gate scopes its own lookup: a role id
 * belonging to another venture must be indistinguishable from one that does not exist, or
 * the studio becomes an oracle for enumerating other projects' vacancies.
 *
 * A video with NO venture may not link any role at all — `researchProjectId === null` makes
 * every supplied id unlinkable, which is the honest answer: there is no project whose roles
 * it could be advertising.
 */
async function findUnlinkableOpenRoleIds(
  researchProjectId: string | null,
  openRoleIds: readonly string[],
): Promise<readonly string[]> {
  if (openRoleIds.length === 0) return [];
  if (researchProjectId === null) return openRoleIds;

  const linkableRows = await db
    .select({ id: projectOpenRole.id })
    .from(projectOpenRole)
    .where(
      and(
        eq(projectOpenRole.projectId, researchProjectId),
        inArray(projectOpenRole.id, [...openRoleIds]),
      ),
    );
  const linkableIds = new Set(linkableRows.map((row) => row.id));
  return openRoleIds.filter((openRoleId) => !linkableIds.has(openRoleId));
}

/**
 * Replaces the recruiting blurbs. Split from `replaceSimpleChildSets` because these rows
 * carry a foreign key and that helper deliberately validates none.
 *
 * Ids are re-verified BEFORE the transaction opens, by the caller — this function only
 * writes, matching every other replace-set in this file.
 */
async function replaceVideoOpenRoles(
  tx: TransactionClient,
  videoId: string,
  openRoles: readonly VideoOpenRoleInput[],
): Promise<void> {
  await tx.delete(videoOpenRole).where(eq(videoOpenRole.videoId, videoId));
  if (openRoles.length === 0) return;

  await tx.insert(videoOpenRole).values(
    openRoles.map((openRole, index) => ({
      videoId,
      roleTitle: openRole.roleTitle,
      roleDescription: openRole.roleDescription ?? null,
      openRoleId: openRole.openRoleId ?? null,
      position: index,
    })),
  );
}

/**
 * Replaces the simple label-style child sets that create and PATCH both rewrite.
 *
 * `openRoles` IS NO LONGER ONE OF THEM. This helper writes label rows from plain strings and
 * has no foreign key to validate — the same property that has always kept `videoCategory` out
 * of it. Now that a blurb may carry an `openRoleId`, it needs a cross-table check against the
 * video's own venture, so it moved to `replaceVideoOpenRoles` below.
 */
async function replaceSimpleChildSets(
  tx: TransactionClient,
  videoId: string,
  input: {
    readonly milestones?: readonly string[];
    readonly teamMemberNames?: readonly string[];
    readonly collaboratorEmails?: readonly string[];
  },
): Promise<void> {
  if (input.milestones !== undefined) {
    await tx.delete(videoMilestone).where(eq(videoMilestone.videoId, videoId));
    if (input.milestones.length > 0) {
      await tx
        .insert(videoMilestone)
        .values(input.milestones.map((label, index) => ({ videoId, label, position: index })));
    }
  }

  if (input.teamMemberNames !== undefined) {
    await tx.delete(videoTeamMember).where(eq(videoTeamMember.videoId, videoId));
    if (input.teamMemberNames.length > 0) {
      await tx.insert(videoTeamMember).values(
        input.teamMemberNames.map((memberName, index) => ({
          videoId,
          memberName,
          position: index,
        })),
      );
    }
  }

  if (input.collaboratorEmails !== undefined) {
    const uniqueEmails = dedupe(input.collaboratorEmails);

    /**
     * ⚠️ NOT A DELETE-ALL-AND-REINSERT, UNLIKE ITS SIBLINGS ABOVE, AND THE DIFFERENCE IS THE WHOLE
     * REASON A COLLABORATOR INVITE MEANS ANYTHING.
     *
     * The other child sets here are LABELS the creator owns — milestones, team-member names. Wiping
     * and rewriting them is free because nothing outside this row ever touched them.
     *
     * A collaborator row is not a label. It carries a `status` the INVITEE sets by accepting or
     * declining, so a blind delete-and-reinsert would erase somebody else's answer every time the
     * creator pressed Save — an invite accepted on Monday would silently read `invited` again after
     * an unrelated title edit on Tuesday. That is the bug this shape prevents, and it only became
     * reachable when the accept/decline routes shipped; before that every row was `invited` forever
     * and the delete was harmless.
     *
     * So: remove only the emails that left the list, and leave the survivors untouched — including
     * their status, their `userId` link and their `createdAt`. Re-adding an email that is already
     * there is a no-op rather than a reset, which is what `onConflictDoNothing` buys against
     * `video_collaborator_unq (video_id, invited_email)`.
     */
    if (uniqueEmails.length === 0) {
      await tx.delete(videoCollaborator).where(eq(videoCollaborator.videoId, videoId));
    } else {
      // THE REMOVALS ARE COMPUTED HERE RATHER THAN WITH `notInArray`, because `invitedEmail` is
      // `citext` — a custom column type drizzle's array helpers do not narrow — and because the
      // comparison must be CASE-INSENSITIVE to match that column's own semantics. Reading the
      // existing rows first makes both explicit instead of relying on a helper to get them right.
      const existingRows = await tx
        .select({ invitedEmail: videoCollaborator.invitedEmail })
        .from(videoCollaborator)
        .where(eq(videoCollaborator.videoId, videoId));
      const keptEmails = new Set(uniqueEmails.map((email) => email.toLowerCase()));
      const removedEmails = existingRows
        .map((row) => row.invitedEmail)
        .filter((email) => !keptEmails.has(email.toLowerCase()));

      for (const removedEmail of removedEmails) {
        await tx
          .delete(videoCollaborator)
          .where(
            and(
              eq(videoCollaborator.videoId, videoId),
              eq(videoCollaborator.invitedEmail, removedEmail),
            ),
          );
      }

      await tx
        .insert(videoCollaborator)
        .values(uniqueEmails.map((invitedEmail) => ({ videoId, invitedEmail })))
        .onConflictDoNothing({
          target: [videoCollaborator.videoId, videoCollaborator.invitedEmail],
        });
    }
  }
}

// --------------------------------------------------------------------------------
// Operations
// --------------------------------------------------------------------------------

export interface CreatedVideo {
  readonly video: PublicVideo;
  /**
   * oEmbed's title, offered so the modal can prefill an EMPTY title field. It is a
   * suggestion, never the stored value — whatever the creator typed wins (§6).
   */
  readonly suggestedTitle: string | null;
}

/**
 * Creates a video from a YouTube link.
 *
 * ORDER OF CHECKS IS LOAD-BEARING (§9). Every cheap local rejection runs BEFORE the
 * outbound oEmbed call: a malformed URL and a gated visibility tier must not cost a
 * network request, and a creator who picked `investor_only` should be told so without
 * waiting on YouTube. The insert is last, which is what makes "oEmbed unreachable → 502
 * and NO row is written" true by construction rather than by a cleanup path.
 */
export async function createVideo(
  creatorId: string,
  input: CreateVideoInput,
  options: YoutubeVerificationOptions = {},
): Promise<Result<CreatedVideo, VideoError>> {
  // 1. Gating — pure, no I/O.
  const gatingError = assertGatingSupported("youtube", input.visibility, input.isNdaRequired);
  if (gatingError) return { success: false, error: gatingError };

  // 2. Anime series/season ownership — a local index lookup, still cheaper than a fetch.
  let resolvedSeriesId: string | null = null;
  if (input.anime?.seriesId) {
    const [ownedSeries] = await db
      .select({ id: animeSeries.id })
      .from(animeSeries)
      .where(and(eq(animeSeries.id, input.anime.seriesId), eq(animeSeries.ownerId, creatorId)))
      .limit(1);
    if (!ownedSeries) {
      return {
        success: false,
        error: { type: "ANIME_SERIES_NOT_FOUND", seriesId: input.anime.seriesId },
      };
    }
    resolvedSeriesId = ownedSeries.id;
  }

  // 3. Attached products — ownership re-verified before anything is written (§0).
  const attachedProductIds = dedupe(input.attachedProductIds ?? []);
  const unownedProductIds = await findUnownedProductIds(creatorId, attachedProductIds);
  if (unownedProductIds.length > 0) {
    return { success: false, error: { type: "PRODUCT_NOT_OWNED", productIds: unownedProductIds } };
  }

  // 3a. The venture link — membership re-verified, same rule and same slot as products.
  //     A client sends a project id; the server decides whether it may be used.
  let resolvedResearchProjectId: string | null = null;
  if (input.researchProjectSlug !== undefined && input.researchProjectSlug !== null) {
    resolvedResearchProjectId = await resolveAttachableResearchProjectId(
      creatorId,
      input.researchProjectSlug,
    );
    if (resolvedResearchProjectId === null) {
      return {
        success: false,
        error: {
          type: "RESEARCH_PROJECT_NOT_JOINABLE",
          researchProjectSlug: input.researchProjectSlug,
        },
      };
    }
  }

  // 3a-ii. Linked open roles — every id must belong to the venture resolved just above.
  //     Runs after 3a because it depends on its answer, and before the network call like
  //     everything else cheap.
  const suppliedOpenRoleIds = (input.openRoles ?? [])
    .map((openRole) => openRole.openRoleId)
    .filter((openRoleId): openRoleId is string => openRoleId !== undefined);
  const unlinkableOpenRoleIds = await findUnlinkableOpenRoleIds(
    resolvedResearchProjectId,
    suppliedOpenRoleIds,
  );
  if (unlinkableOpenRoleIds.length > 0) {
    return {
      success: false,
      error: { type: "OPEN_ROLE_NOT_IN_PROJECT", openRoleIds: unlinkableOpenRoleIds },
    };
  }

  // 3b. Categories — existence and activeness checked before the network call, like
  //     products above. Cross-table, so it cannot live in the Zod schema.
  const categoryIds = dedupe(input.categoryIds ?? []);
  // §2's cardinality bound, enforced HERE and not only in Zod. A cross-row count is not
  // expressible as a table CHECK, so the service is the last place it can be true — and
  // the Zod bound only guards the HTTP boundary, which a script, a job or a future
  // internal caller does not cross. Checked after dedupe, so four copies of one id is
  // one category and not an error.
  if (categoryIds.length > MAXIMUM_CATEGORIES_PER_VIDEO) {
    return {
      success: false,
      error: {
        type: "TOO_MANY_VIDEO_CATEGORIES",
        limit: MAXIMUM_CATEGORIES_PER_VIDEO,
        received: categoryIds.length,
      },
    };
  }
  const unavailableCategoryIds = await findUnavailableCategoryIds(categoryIds);
  if (unavailableCategoryIds.length > 0) {
    return {
      success: false,
      error: { type: "VIDEO_CATEGORY_NOT_AVAILABLE", categoryIds: unavailableCategoryIds },
    };
  }

  // Resolved AFTER validation and BEFORE the transaction: the creator's own list is checked
  // on its own terms, and the fallback lookup is a plain read that has no business holding a
  // write transaction open.
  const categoryIdsToWrite = await withDefaultCategoryFallback(categoryIds);

  // 4. THE ONE OUTBOUND REQUEST — and the only failure here that is now survivable is
  //    "YouTube did not answer" (§8.3). See parseAndVerifyYoutubeUrlForCreate.
  const verified = await parseAndVerifyYoutubeUrlForCreate(input.youtubeUrl, options);
  if (!verified.success) return { success: false, error: verified.error };
  const verifiedFacts = verified.value.facts;

  // 5. Now, and only now, write.
  let createdVideoId: string;
  try {
    createdVideoId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(video)
        .values({
          creatorId,
          videoSource: "youtube",
          youtubeVideoId: verified.value.youtubeVideoId,
          // The id is stored either way — the charset CHECK still closes SSRF. This flag
          // records only whether YouTube confirmed the video exists and embeds (§8.3).
          isSourceVerified: verifiedFacts !== null,
          uploadStatus: "ready",
          thumbnailUrl: verifiedFacts?.thumbnailUrl ?? null,
          title: input.title,
          description: input.description,
          videoType: input.videoType,
          stageBadge: input.stageBadge,
          sectorTags: [...input.sectorTags],
          tags: [...input.tags],
          websiteUrl: input.websiteUrl,
          ctaLabel: input.ctaLabel,
          ctaUrl: input.ctaUrl,
          linkedinUrl: input.linkedinUrl,
          xProfileUrl: input.xProfileUrl,
          contactEmail: input.contactEmail,
          isMadeForKids: input.isMadeForKids,
          hasAgeRestriction: input.hasAgeRestriction,
          relatedVideoUrl: input.relatedVideoUrl,
          hasFundingCallToAction: input.hasFundingCallToAction,
          // Resolved from the slug and membership-verified in step 3a. Null when the field
          // was omitted or explicitly null — both mean "unaffiliated", the column's default.
          researchProjectId: resolvedResearchProjectId,
          visibility: input.visibility,
          isNdaRequired: input.isNdaRequired,
          scheduledPublishAt: input.scheduledPublishAt,
          license: input.license,
          videoLanguage: input.videoLanguage,
          isEmbeddingAllowed: input.isEmbeddingAllowed,
          areCommentsEnabled: input.areCommentsEnabled,
          shouldShowLikesCount: input.shouldShowLikesCount,
          hasPaidPromotion: input.hasPaidPromotion,
          usesAlteredContent: input.usesAlteredContent,
          captionCertification: input.captionCertification,
          commentModeration: input.commentModeration,
          commentSortOrder: input.commentSortOrder,
          shortsRemixing: input.shortsRemixing,
          recordingDate: input.recordingDate,
          recordingLocation: input.recordingLocation,
          // `category` is deliberately absent: the column is dead (§2.2) and the schema no
          // longer has a field to carry it. `videoCategory` rows below are the taxonomy.
        })
        .returning({ id: video.id });

      if (!created) throw new Error("Insert returned no video row");
      const videoId = created.id;

      if (attachedProductIds.length > 0) {
        await tx
          .insert(videoAttachedProduct)
          .values(
            attachedProductIds.map((productId, index) => ({ videoId, productId, position: index })),
          );
      }

      // `categoryIdsToWrite`, not `categoryIds` — this is the creator's set OR the default
      // bucket. Still guarded on length: the fallback returns `[]` when the default row is
      // missing, and an INSERT with no values is an error rather than a no-op.
      if (categoryIdsToWrite.length > 0) {
        await tx
          .insert(videoCategory)
          .values(categoryIdsToWrite.map((categoryId) => ({ videoId, categoryId })));
      }

      // The engagement counter caches, minted here rather than lazily (HOME §3.4).
      // Every engagement write is an UPDATE, and an UPDATE against a missing row does
      // not error — it affects zero rows and the count is silently lost.
      await ensureVideoStatsRows(tx, { videoId, creatorId });

      // ENQUEUED INSIDE THE TRANSACTION, on the transaction's own connection (§8.3).
      // pg-boss's send is an INSERT, so it can join this transaction — and it must. An
      // enqueue after the commit can be lost with no error surface anywhere, leaving a row
      // that is permanently unverifiable and therefore permanently unpublishable; an
      // enqueue before it can announce a row that rolled back. Same contract as
      // `enqueueNotifications`.
      //
      // A failed enqueue THROWS, taking the video row with it. A create the creator can
      // retry is strictly better than a row nothing will ever verify.
      if (!verifiedFacts) {
        const enqueueResult = await sendJob(
          JOB_NAMES.verifyYoutubeVideo,
          { videoId },
          {
            idempotencyKey: idempotencyKeyFor.verifyYoutubeVideo(
              videoId,
              verified.value.youtubeVideoId,
            ),
            db: fromDrizzle(tx, sql),
          },
        );
        if (!enqueueResult.success) {
          throw new Error(
            `createVideo: could not queue source verification for ${videoId} ` +
              `(${enqueueResult.error.type})`,
          );
        }
      }

      await replaceSimpleChildSets(tx, videoId, input);
      if (input.openRoles !== undefined) {
        await replaceVideoOpenRoles(tx, videoId, input.openRoles);
      }

      if (input.anime) {
        // Create the series when the creator did not pick one. Zod's superRefine has
        // already proven exactly one of seriesId / newSeriesTitle is present.
        let seriesId = resolvedSeriesId;
        if (!seriesId) {
          // The slug is the public URL identity at /anime/series/<slug> and is minted from
          // the title, never supplied. Minting reads before it writes, so a concurrent
          // upload of a same-titled series can lose the race on `anime_series_slug_uidx`;
          // the retry re-mints, which is now guaranteed to see the winner's row.
          const seriesTitle = input.anime.newSeriesTitle ?? input.title;
          let createdSeries: { id: string } | undefined;
          for (let attempt = 0; attempt < 3 && createdSeries === undefined; attempt += 1) {
            try {
              [createdSeries] = await tx
                .insert(animeSeries)
                .values({
                  ownerId: creatorId,
                  title: seriesTitle,
                  slug: await mintSeriesSlug(tx, seriesTitle),
                  genreTags: [...input.anime.genreTags],
                })
                .returning({ id: animeSeries.id });
            } catch (insertError) {
              if (!isUniqueViolation(insertError) || attempt === 2) throw insertError;
            }
          }
          if (!createdSeries) throw new Error("Insert returned no anime series row");
          seriesId = createdSeries.id;
        }

        // "Pick or create Season 1" is idempotent thanks to anime_season_label_unq —
        // insert-on-conflict rather than a read-then-write race between two tabs.
        const [insertedSeason] = await tx
          .insert(animeSeason)
          .values({ seriesId, seasonLabel: input.anime.seasonLabel, position: 0 })
          .onConflictDoNothing({ target: [animeSeason.seriesId, animeSeason.seasonLabel] })
          .returning({ id: animeSeason.id });

        const seasonId =
          insertedSeason?.id ??
          (
            await tx
              .select({ id: animeSeason.id })
              .from(animeSeason)
              .where(
                and(
                  eq(animeSeason.seriesId, seriesId),
                  eq(animeSeason.seasonLabel, input.anime.seasonLabel),
                ),
              )
              .limit(1)
          )[0]?.id;

        if (!seasonId) throw new Error("Could not resolve the anime season");

        await tx.insert(animeEpisode).values({
          seasonId,
          videoId,
          episodeNumber: input.anime.episodeNumber,
          episodeTitle: input.anime.episodeTitle,
          releaseScheduleDay: input.anime.releaseScheduleDay,
          releaseScheduleTime: input.anime.releaseScheduleTime,
          premiereDate: input.anime.premiereDate,
          audioMode: input.anime.audioMode,
          audioLanguage: input.anime.audioLanguage,
          ageRating: input.anime.ageRating,
        });
      }

      return videoId;
    });
  } catch (error) {
    // A duplicate (seasonId, episodeNumber). Because it happens INSIDE the transaction,
    // the video row rolls back with it — no orphan is left behind.
    if (isUniqueViolation(error) && input.anime) {
      return {
        success: false,
        error: { type: "EPISODE_NUMBER_TAKEN", episodeNumber: input.anime.episodeNumber },
      };
    }
    throw error;
  }

  const createdRow = await loadOwnedVideoRow(creatorId, createdVideoId);
  if (!createdRow)
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: createdVideoId } };

  return {
    success: true,
    value: {
      video: await toPublicVideo(createdRow, Date.now()),
      // Null when verification was deferred: an unverified row has no oEmbed title to
      // suggest, and inventing one would be a fabricated value dressed as a server fact.
      suggestedTitle: verifiedFacts?.suggestedTitle ?? null,
    },
  };
}

/** The caller's own videos, newest-touched first. Pure read — always succeeds. */
export async function listMyVideos(
  creatorId: string,
  filters: {
    readonly page: number;
    readonly limit: number;
    readonly publishStatus?: VideoPublishStatus;
    readonly reviewStatus?: ContentReviewStatus;
  },
): Promise<VideoPage> {
  const offset = (filters.page - 1) * filters.limit;
  const predicate = and(
    eq(video.creatorId, creatorId),
    filters.publishStatus ? eq(video.publishStatus, filters.publishStatus) : undefined,
    filters.reviewStatus ? eq(video.reviewStatus, filters.reviewStatus) : undefined,
  );

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: video.id,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        videoType: video.videoType,
        videoSource: video.videoSource,
        visibility: video.visibility,
        uploadStatus: video.uploadStatus,
        publishStatus: video.publishStatus,
        reviewStatus: video.reviewStatus,
        // Selected for `deriveStudioVideoStatus`, so the LIST badge and the DETAIL badge cannot
        // disagree about whether a video is hidden. It is the row's real state, not a projection
        // of the report that caused it — the reports themselves stay out of this read.
        moderationVisibilityState: video.moderationVisibilityState,
        rejectionReason: video.rejectionReason,
        scheduledPublishAt: video.scheduledPublishAt,
        createdAt: video.createdAt,
        updatedAt: video.updatedAt,
        episodeReleasedAt: animeEpisode.releasedAt,
      })
      .from(video)
      .leftJoin(animeEpisode, eq(animeEpisode.videoId, video.id))
      .where(predicate)
      .orderBy(desc(video.updatedAt))
      .limit(filters.limit)
      .offset(offset),
    db.select({ value: count() }).from(video).where(predicate),
  ]);

  const nowEpochMs = Date.now();
  return {
    rows: rows.map(({ episodeReleasedAt, ...row }) => ({
      ...row,
      derivedStatus: deriveStudioVideoStatus({ ...row, episodeReleasedAt }, nowEpochMs),
    })),
    total: totals[0]?.value ?? 0,
  };
}

/** Full video for the edit/detail flow. Owner only → VIDEO_NOT_FOUND otherwise. */
export async function getVideo(
  creatorId: string,
  videoId: string,
): Promise<Result<PublicVideo, VideoError>> {
  const row = await loadOwnedVideoRow(creatorId, videoId);
  if (!row) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: await toPublicVideo(row, Date.now()) };
}

/**
 * Partial update of mutable metadata.
 *
 * A CHANGED `youtubeUrl` IS RE-PARSED AND RE-VERIFIED, an unchanged one is not. Verifying
 * a URL that did not change spends an outbound request and lets a transient YouTube blip
 * turn an unrelated title edit into a 502.
 *
 * THE ANIME RE-EDIT RESET (§10) lives here. Editing content on an already-decided episode
 * sends it back for review — and takes it OFF the air at the same time. The spec names
 * only `reviewStatus`; resetting that alone would leave an edited episode live in /anime
 * while its review is pending, which is the exact state the rule exists to prevent.
 */
export async function updateVideo(
  creatorId: string,
  videoId: string,
  patch: UpdateVideoInput,
  options: YoutubeVerificationOptions = {},
): Promise<Result<PublicVideo, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  // Gating is checked against the MERGED state. Checking only the patch would miss
  // `{ isNdaRequired: true }` landing on a row that is already investor_only, and
  // `{ visibility: "investor_only" }` landing on a row that already requires an NDA.
  const gatingError = assertGatingSupported(
    existing.videoSource,
    patch.visibility ?? existing.visibility,
    patch.isNdaRequired ?? existing.isNdaRequired,
  );
  if (gatingError) return { success: false, error: gatingError };

  let verifiedYoutube: { youtubeVideoId: string; thumbnailUrl: string | null } | null = null;
  if (patch.youtubeUrl !== undefined) {
    const parsedId = extractYoutubeVideoId(patch.youtubeUrl);
    if (!parsedId) return { success: false, error: { type: "INVALID_YOUTUBE_URL" } };
    if (parsedId !== existing.youtubeVideoId) {
      const verified = await parseAndVerifyYoutubeUrl(patch.youtubeUrl, options);
      if (!verified.success) return { success: false, error: verified.error };
      verifiedYoutube = {
        youtubeVideoId: verified.value.youtubeVideoId,
        thumbnailUrl: verified.value.thumbnailUrl,
      };
    }
  }

  const attachedProductIds =
    patch.attachedProductIds === undefined ? undefined : dedupe(patch.attachedProductIds);
  if (attachedProductIds !== undefined) {
    const unownedProductIds = await findUnownedProductIds(creatorId, attachedProductIds);
    if (unownedProductIds.length > 0) {
      return {
        success: false,
        error: { type: "PRODUCT_NOT_OWNED", productIds: unownedProductIds },
      };
    }
  }

  // The venture link, re-verified on PATCH exactly as on create. A creator who left a
  // project must not keep re-pointing videos at it, and `null` (detach) needs no check —
  // dropping a link asks nothing of the venture.
  let patchedResearchProjectId: string | null | undefined;
  if (patch.researchProjectSlug === null) {
    patchedResearchProjectId = null;
  } else if (patch.researchProjectSlug !== undefined) {
    patchedResearchProjectId = await resolveAttachableResearchProjectId(
      creatorId,
      patch.researchProjectSlug,
    );
    if (patchedResearchProjectId === null) {
      return {
        success: false,
        error: {
          type: "RESEARCH_PROJECT_NOT_JOINABLE",
          researchProjectSlug: patch.researchProjectSlug,
        },
      };
    }
  }

  // Linked open roles, checked against the venture this video will have AFTER the patch —
  // `patchedResearchProjectId` when the patch moves it, the existing column otherwise.
  // Checking against the old venture would let one PATCH detach a project and keep its roles.
  const effectiveResearchProjectId =
    patchedResearchProjectId === undefined ? existing.researchProjectId : patchedResearchProjectId;
  if (patch.openRoles !== undefined) {
    const suppliedOpenRoleIds = patch.openRoles
      .map((openRole) => openRole.openRoleId)
      .filter((openRoleId): openRoleId is string => openRoleId !== undefined);
    const unlinkableOpenRoleIds = await findUnlinkableOpenRoleIds(
      effectiveResearchProjectId,
      suppliedOpenRoleIds,
    );
    if (unlinkableOpenRoleIds.length > 0) {
      return {
        success: false,
        error: { type: "OPEN_ROLE_NOT_IN_PROJECT", openRoleIds: unlinkableOpenRoleIds },
      };
    }
  }

  // REPLACE semantics, like every other array on this patch: `undefined` means untouched,
  // any array means "this is now the whole set", and `[]` means remove all. Merge
  // semantics would leave a creator no way to remove a category.
  const categoryIds = patch.categoryIds === undefined ? undefined : dedupe(patch.categoryIds);
  if (categoryIds !== undefined) {
    if (categoryIds.length > MAXIMUM_CATEGORIES_PER_VIDEO) {
      return {
        success: false,
        error: {
          type: "TOO_MANY_VIDEO_CATEGORIES",
          limit: MAXIMUM_CATEGORIES_PER_VIDEO,
          received: categoryIds.length,
        },
      };
    }
    const unavailableCategoryIds = await findUnavailableCategoryIds(categoryIds);
    if (unavailableCategoryIds.length > 0) {
      return {
        success: false,
        error: { type: "VIDEO_CATEGORY_NOT_AVAILABLE", categoryIds: unavailableCategoryIds },
      };
    }
  }

  /*
   * `[]` ON A PATCH MEANS "THE DEFAULT BUCKET", NOT "NO CATEGORIES" — the same rule create
   * follows, applied to the same wire shape. A creator who strips every category off a
   * published video would otherwise walk it out of every category filter permanently, and
   * the edit form gives them no warning that this is what the empty state costs.
   *
   * `undefined` still means UNTOUCHED and is not defaulted: a patch that never mentions
   * categories must not rewrite them, or every unrelated edit would silently overwrite a
   * three-category video with the fallback.
   */
  const categoryIdsToWrite =
    categoryIds === undefined ? undefined : await withDefaultCategoryFallback(categoryIds);

  // Content-bearing, in the sense §10 means: a change a moderator would want to see
  // again. A visibility toggle or a comment preference is deliberately NOT in this list,
  // because un-publishing an approved episode over a settings change is its own bug.
  const touchesReviewableContent =
    patch.title !== undefined ||
    patch.description !== undefined ||
    verifiedYoutube !== null ||
    patch.anime !== undefined;

  const shouldResetReview =
    existing.videoType === "anime_episode" &&
    (existing.reviewStatus === "approved" || existing.reviewStatus === "rejected") &&
    touchesReviewableContent;

  await db.transaction(async (tx) => {
    const scalarUpdates: Partial<typeof video.$inferInsert> = {};
    // Only keys the client actually sent land here — UpdateVideoSchema carries no
    // defaults, so `undefined` genuinely means "not sent" (see videos.controller.ts).
    if (patch.title !== undefined) scalarUpdates.title = patch.title;
    if (patch.description !== undefined) scalarUpdates.description = patch.description;
    if (patch.videoType !== undefined) scalarUpdates.videoType = patch.videoType;
    if (patch.stageBadge !== undefined) scalarUpdates.stageBadge = patch.stageBadge;
    if (patch.sectorTags !== undefined) scalarUpdates.sectorTags = [...patch.sectorTags];
    if (patch.tags !== undefined) scalarUpdates.tags = [...patch.tags];
    if (patch.websiteUrl !== undefined) scalarUpdates.websiteUrl = patch.websiteUrl;
    if (patch.ctaLabel !== undefined) scalarUpdates.ctaLabel = patch.ctaLabel;
    if (patch.ctaUrl !== undefined) scalarUpdates.ctaUrl = patch.ctaUrl;
    if (patch.linkedinUrl !== undefined) scalarUpdates.linkedinUrl = patch.linkedinUrl;
    if (patch.xProfileUrl !== undefined) scalarUpdates.xProfileUrl = patch.xProfileUrl;
    if (patch.contactEmail !== undefined) scalarUpdates.contactEmail = patch.contactEmail;
    if (patch.isMadeForKids !== undefined) scalarUpdates.isMadeForKids = patch.isMadeForKids;
    if (patch.hasAgeRestriction !== undefined) {
      scalarUpdates.hasAgeRestriction = patch.hasAgeRestriction;
    }
    if (patch.relatedVideoUrl !== undefined) scalarUpdates.relatedVideoUrl = patch.relatedVideoUrl;
    if (patch.hasFundingCallToAction !== undefined) {
      scalarUpdates.hasFundingCallToAction = patch.hasFundingCallToAction;
    }
    // Tri-state, like attachedProductIds: undefined leaves the link alone, null DETACHES.
    // Membership for a non-null value was re-verified before the transaction opened.
    if (patchedResearchProjectId !== undefined) {
      scalarUpdates.researchProjectId = patchedResearchProjectId;
    }
    if (patch.visibility !== undefined) scalarUpdates.visibility = patch.visibility;
    if (patch.isNdaRequired !== undefined) scalarUpdates.isNdaRequired = patch.isNdaRequired;
    if (patch.scheduledPublishAt !== undefined) {
      scalarUpdates.scheduledPublishAt = patch.scheduledPublishAt;
    }
    if (patch.license !== undefined) scalarUpdates.license = patch.license;
    if (patch.videoLanguage !== undefined) scalarUpdates.videoLanguage = patch.videoLanguage;
    if (patch.isEmbeddingAllowed !== undefined) {
      scalarUpdates.isEmbeddingAllowed = patch.isEmbeddingAllowed;
    }
    if (patch.areCommentsEnabled !== undefined) {
      scalarUpdates.areCommentsEnabled = patch.areCommentsEnabled;
    }
    if (patch.shouldShowLikesCount !== undefined) {
      scalarUpdates.shouldShowLikesCount = patch.shouldShowLikesCount;
    }
    if (patch.hasPaidPromotion !== undefined)
      scalarUpdates.hasPaidPromotion = patch.hasPaidPromotion;
    if (patch.usesAlteredContent !== undefined) {
      scalarUpdates.usesAlteredContent = patch.usesAlteredContent;
    }
    if (patch.captionCertification !== undefined) {
      scalarUpdates.captionCertification = patch.captionCertification;
    }
    if (patch.commentModeration !== undefined) {
      scalarUpdates.commentModeration = patch.commentModeration;
    }
    if (patch.commentSortOrder !== undefined) {
      scalarUpdates.commentSortOrder = patch.commentSortOrder;
    }
    if (patch.shortsRemixing !== undefined) scalarUpdates.shortsRemixing = patch.shortsRemixing;
    if (patch.recordingDate !== undefined) scalarUpdates.recordingDate = patch.recordingDate;
    if (patch.recordingLocation !== undefined) {
      scalarUpdates.recordingLocation = patch.recordingLocation;
    }
    // No `category` write. The column is dead (§2.2) and UpdateVideoSchema has no field
    // for it; `categoryIds` is handled below, against video_category.

    if (verifiedYoutube) {
      scalarUpdates.youtubeVideoId = verifiedYoutube.youtubeVideoId;
      // A new source invalidates the OLD auto thumbnail, but never a custom one the
      // creator deliberately uploaded.
      if (!existing.hasCustomThumbnail) scalarUpdates.thumbnailUrl = verifiedYoutube.thumbnailUrl;
    }

    // THE FOURTH DOOR OUT OF PUBLISHED, and it had no counter write at all — `updateVideo`
    // contained none. An approved anime episode is `published`; editing its title sends it back to
    // `draft`/`pending` here, and the count stayed where it was. An anime creator hits this on
    // every edit after approval, so it drifted upward faster than any other path.
    // From the LOCKED row, not the pre-transaction read — same race as publish/unpublish/delete.
    const lockedStatus = await lockOwnedVideoPublishState(tx, creatorId, videoId);
    const leavesPublishedByReviewReset = shouldResetReview && lockedStatus === "published";

    if (shouldResetReview) {
      scalarUpdates.reviewStatus = "pending";
      scalarUpdates.rejectionReason = null;
      scalarUpdates.publishStatus = "draft";
      scalarUpdates.publishedAt = null;
      scalarUpdates.scheduledPublishAt = null;
    }

    if (Object.keys(scalarUpdates).length > 0) {
      await tx.update(video).set(scalarUpdates).where(ownedVideoPredicate(creatorId, videoId));
    }

    if (leavesPublishedByReviewReset) {
      await tx
        .update(creatorStats)
        .set({
          publishedVideoCount: sql`GREATEST(${creatorStats.publishedVideoCount} - 1, 0)`,
        })
        .where(eq(creatorStats.userId, creatorId));
    }

    if (attachedProductIds !== undefined) {
      await tx.delete(videoAttachedProduct).where(eq(videoAttachedProduct.videoId, videoId));
      if (attachedProductIds.length > 0) {
        await tx
          .insert(videoAttachedProduct)
          .values(
            attachedProductIds.map((productId, index) => ({ videoId, productId, position: index })),
          );
      }
    }

    // Delete-then-reinsert rather than a diff. The set is at most three rows and the whole
    // thing is inside one transaction, so computing a minimal delta would buy nothing and
    // cost a correctness argument. Not folded into replaceSimpleChildSets: that helper
    // writes label rows from plain strings and has no foreign key to validate.
    if (categoryIdsToWrite !== undefined) {
      await tx.delete(videoCategory).where(eq(videoCategory.videoId, videoId));
      if (categoryIdsToWrite.length > 0) {
        await tx
          .insert(videoCategory)
          .values(categoryIdsToWrite.map((categoryId) => ({ videoId, categoryId })));
      }
    }

    await replaceSimpleChildSets(tx, videoId, patch);
    if (patch.openRoles !== undefined) {
      await replaceVideoOpenRoles(tx, videoId, patch.openRoles);
    } else if (
      patchedResearchProjectId !== undefined &&
      patchedResearchProjectId !== existing.researchProjectId
    ) {
      // THE VENTURE MOVED AND THE BLURBS DID NOT. Every surviving `openRoleId` was validated
      // against the OLD venture, so each one now points at a role this video has no
      // relationship to — and the watch page would advertise another project's vacancy, or a
      // detached video would keep advertising one at all. Null the links and keep the text:
      // that is exactly the fallback state `roleTitle` stays NOT NULL for.
      //
      // Nulling ALL of them is correct rather than blunt: they were all checked against the
      // old id, so after a real change none of them can still be valid.
      await tx
        .update(videoOpenRole)
        .set({ openRoleId: null })
        .where(eq(videoOpenRole.videoId, videoId));
    }

    // The episode's OWN metadata is patchable; re-linking it to another series or season
    // is deliberately not (that is the /series router's job), so UpdateVideoAnimeSchema
    // has no seriesId field for a client to send.
    if (patch.anime) {
      const episodeUpdates: Partial<typeof animeEpisode.$inferInsert> = {};
      if (patch.anime.episodeNumber !== undefined) {
        episodeUpdates.episodeNumber = patch.anime.episodeNumber;
      }
      if (patch.anime.episodeTitle !== undefined) {
        episodeUpdates.episodeTitle = patch.anime.episodeTitle;
      }
      if (patch.anime.releaseScheduleDay !== undefined) {
        episodeUpdates.releaseScheduleDay = patch.anime.releaseScheduleDay;
      }
      if (patch.anime.releaseScheduleTime !== undefined) {
        episodeUpdates.releaseScheduleTime = patch.anime.releaseScheduleTime;
      }
      if (patch.anime.premiereDate !== undefined) {
        episodeUpdates.premiereDate = patch.anime.premiereDate;
      }
      if (patch.anime.audioMode !== undefined) episodeUpdates.audioMode = patch.anime.audioMode;
      if (patch.anime.audioLanguage !== undefined) {
        episodeUpdates.audioLanguage = patch.anime.audioLanguage;
      }
      if (patch.anime.ageRating !== undefined) episodeUpdates.ageRating = patch.anime.ageRating;
      if (shouldResetReview) episodeUpdates.releasedAt = null;

      if (Object.keys(episodeUpdates).length > 0) {
        await tx.update(animeEpisode).set(episodeUpdates).where(eq(animeEpisode.videoId, videoId));
      }
    } else if (shouldResetReview) {
      await tx
        .update(animeEpisode)
        .set({ releasedAt: null })
        .where(eq(animeEpisode.videoId, videoId));
    }
  });

  const updated = await loadOwnedVideoRow(creatorId, videoId);
  if (!updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: await toPublicVideo(updated, Date.now()) };
}

/** Custom thumbnails are re-encoded to AVIF and downscaled into this box. */
const VIDEO_THUMBNAIL_OUTPUT_MAX_DIMENSION_PX = 1280;

/**
 * Replaces the oEmbed thumbnail with a creator-uploaded one. The Cloudinary round-trip
 * happens outside any transaction; the single UPDATE afterwards is atomic on its own.
 */
export async function replaceVideoThumbnail(
  creatorId: string,
  videoId: string,
  rawImageBytes: Buffer,
): Promise<Result<PublicVideo, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  const normalized = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: VIDEO_THUMBNAIL_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) return { success: false, error: normalized.error };

  const uploaded = await uploadThumbnailAsset(videoId, normalized.value.buffer);
  if (!uploaded.success) return { success: false, error: uploaded.error };

  await db
    .update(video)
    .set({ thumbnailUrl: uploaded.value.secureUrl, hasCustomThumbnail: true })
    .where(ownedVideoPredicate(creatorId, videoId));

  const updated = await loadOwnedVideoRow(creatorId, videoId);
  if (!updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: await toPublicVideo(updated, Date.now()) };
}

/** Replaces the whole chapter set. Position is the array index — the client's order. */
export async function replaceChapters(
  creatorId: string,
  videoId: string,
  chapters: readonly ChapterInput[],
): Promise<Result<PublicVideo, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  const chapterError = validateChapterSet(chapters, existing.durationSeconds);
  if (chapterError) return { success: false, error: chapterError };

  await db.transaction(async (tx) => {
    await tx.delete(videoChapter).where(eq(videoChapter.videoId, videoId));
    if (chapters.length > 0) {
      await tx.insert(videoChapter).values(
        // No server-side sort: rule NOT_ASCENDING already guarantees index order equals
        // time order, and silently reordering a creator's list is a change they did not
        // ask for.
        chapters.map((chapter, index) => ({
          videoId,
          startSeconds: chapter.startSeconds,
          title: chapter.title,
          position: index,
        })),
      );
    }
  });

  const updated = await loadOwnedVideoRow(creatorId, videoId);
  if (!updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: await toPublicVideo(updated, Date.now()) };
}

/** Replaces the attached-product set. Every product's ownership is re-verified (§0). */
export async function replaceAttachedProducts(
  creatorId: string,
  videoId: string,
  productIds: readonly string[],
): Promise<Result<PublicVideo, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  const uniqueProductIds = dedupe(productIds);
  const unownedProductIds = await findUnownedProductIds(creatorId, uniqueProductIds);
  if (unownedProductIds.length > 0) {
    return { success: false, error: { type: "PRODUCT_NOT_OWNED", productIds: unownedProductIds } };
  }

  await db.transaction(async (tx) => {
    await tx.delete(videoAttachedProduct).where(eq(videoAttachedProduct.videoId, videoId));
    if (uniqueProductIds.length > 0) {
      await tx
        .insert(videoAttachedProduct)
        .values(
          uniqueProductIds.map((productId, index) => ({ videoId, productId, position: index })),
        );
    }
  });

  const updated = await loadOwnedVideoRow(creatorId, videoId);
  if (!updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: await toPublicVideo(updated, Date.now()) };
}

/**
 * Sets which of the caller's playlists contain this video.
 *
 * APPENDS at `max(position) + 1` per playlist rather than setting `position = index`:
 * this endpoint knows the video's membership, not the other videos' intended order, so
 * it must not rewrite an ordering it cannot see. `PUT /playlists/:id/videos` is the
 * endpoint that owns ordering within a playlist.
 */
export async function setVideoPlaylists(
  creatorId: string,
  videoId: string,
  playlistIds: readonly string[],
): Promise<Result<PublicVideo, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  const uniquePlaylistIds = dedupe(playlistIds);
  const unownedPlaylistIds = await findUnownedPlaylistIds(creatorId, uniquePlaylistIds);
  if (unownedPlaylistIds.length > 0) {
    return {
      success: false,
      error: { type: "PLAYLIST_NOT_OWNED", playlistIds: unownedPlaylistIds },
    };
  }

  await db.transaction(async (tx) => {
    // THE `creatorId` TERM IS LOAD-BEARING AND MUST NOT BE DROPPED.
    //
    // This used to be `where(eq(playlistItem.videoId, videoId))` — scoped by video and
    // nothing else. That was safe only while a video could sit in no playlist but its own
    // uploader's. Now that any viewer may add a public video to their own playlist, the
    // unscoped form means: a creator opens their own upload's playlist picker, presses
    // Save, and SILENTLY EVICTS THAT VIDEO FROM EVERY STRANGER'S PLAYLIST — transactionally,
    // with no error and nothing to undo it from.
    //
    // The subquery is the caller's own playlists, so this endpoint keeps meaning "set which
    // of MY playlists hold this video" and stops meaning "set which playlists anywhere do".
    await tx
      .delete(playlistItem)
      .where(
        and(
          eq(playlistItem.videoId, videoId),
          inArray(
            playlistItem.playlistId,
            tx.select({ id: playlist.id }).from(playlist).where(eq(playlist.creatorId, creatorId)),
          ),
        ),
      );
    for (const playlistId of uniquePlaylistIds) {
      const [tail] = await tx
        .select({ nextPosition: sql<number>`coalesce(max(${playlistItem.position}), -1) + 1` })
        .from(playlistItem)
        .where(eq(playlistItem.playlistId, playlistId));
      await tx
        .insert(playlistItem)
        .values({ playlistId, videoId, position: tail?.nextPosition ?? 0 });
    }
  });

  const updated = await loadOwnedVideoRow(creatorId, videoId);
  if (!updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: await toPublicVideo(updated, Date.now()) };
}

/**
 * Publishes a video, or routes an anime episode into the review queue.
 *
 * "Save draft" vs "Publish" is UX; THIS decides whether a video is complete enough to go
 * live. Note what is deliberately NOT in the completeness list: `title` is NOT NULL with
 * a `.min(1)` schema and `visibility` is NOT NULL DEFAULT — checking either would be
 * theatre. `isMadeForKids` is the one that genuinely can be unanswered at publish time,
 * and for a COPPA-shaped attestation "unanswered" is the failure that matters.
 *
 * AN ANIME EPISODE NEVER SELF-PUBLISHES (§10). It moves to reviewStatus "pending" and
 * publishStatus STAYS "draft" — approval is what publishes it.
 */
export async function publishVideo(
  creatorId: string,
  videoId: string,
): Promise<Result<PublicVideo, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  if (existing.uploadStatus !== "ready") {
    return { success: false, error: { type: "NOT_READY", uploadStatus: existing.uploadStatus } };
  }

  // §8.3's gate, and it sits HERE — beside NOT_READY, before the completeness list —
  // because it is a fact about the media rather than about the form. This is what keeps
  // "no unverified id in a published row" true now that createVideo can store one.
  if (!existing.isSourceVerified) {
    return {
      success: false,
      error: { type: "SOURCE_NOT_VERIFIED", youtubeVideoId: existing.youtubeVideoId },
    };
  }

  // The backstop re-check: this re-runs even if some future write path sets the columns
  // without going through create or PATCH.
  const gatingError = assertGatingSupported(
    existing.videoSource,
    existing.visibility,
    existing.isNdaRequired,
  );
  if (gatingError) return { success: false, error: gatingError };

  const missing: string[] = [];
  if (existing.title.trim() === "") missing.push("title");
  if (existing.videoSource === "youtube" && !existing.youtubeVideoId) missing.push("youtubeUrl");
  if (existing.isMadeForKids === null) missing.push("isMadeForKids");

  const isAnimeEpisode = existing.videoType === "anime_episode";
  if (isAnimeEpisode) {
    const [linkedEpisode] = await db
      .select({ id: animeEpisode.id })
      .from(animeEpisode)
      .where(eq(animeEpisode.videoId, videoId))
      .limit(1);
    if (!linkedEpisode) missing.push("anime");
  }

  if (missing.length > 0) {
    return { success: false, error: { type: "INCOMPLETE_FOR_PUBLISH", missing } };
  }

  const now = new Date();
  const shouldSchedule =
    existing.scheduledPublishAt !== null && existing.scheduledPublishAt.getTime() > now.getTime();

  // The counter moves in the SAME transaction as the status change (HOME §3.4). It
  // moves ONLY on a real transition to `published`: an anime episode goes to `pending`
  // review and a future-dated one goes to `scheduled`, and neither is a published video.
  // BOTH DIRECTIONS ARE DECIDED INSIDE THE TRANSACTION, from the locked row — see below. The
  // second of them had no branch at all until now: re-publishing an already-published video with a
  // future `scheduledPublishAt` sends it BACK to `scheduled`, the video goes dark, and the counter
  // did not follow it. Reachable entirely through public routes — publish, PATCH a future date,
  // publish again — and the sweep then increments when it fires, so the count ended one high per
  // round trip.

  await db.transaction(async (tx) => {
    // Re-read under the lock: two concurrent publishes on one draft both saw `draft` before the
    // transaction and both incremented. The second now waits, sees `published`, and does not.
    const lockedStatus = await lockOwnedVideoPublishState(tx, creatorId, videoId);
    if (lockedStatus === null) return;
    const becomesPublished = !isAnimeEpisode && !shouldSchedule && lockedStatus !== "published";
    const leavesPublished = !isAnimeEpisode && shouldSchedule && lockedStatus === "published";

    await tx
      .update(video)
      .set(
        isAnimeEpisode
          ? { reviewStatus: "pending", rejectionReason: null }
          : shouldSchedule
            ? { publishStatus: "scheduled" }
            : { publishStatus: "published", publishedAt: now },
      )
      .where(ownedVideoPredicate(creatorId, videoId));

    if (becomesPublished) {
      await tx.insert(creatorStats).values({ userId: creatorId }).onConflictDoNothing();
      await tx
        .update(creatorStats)
        .set({ publishedVideoCount: sql`${creatorStats.publishedVideoCount} + 1` })
        .where(eq(creatorStats.userId, creatorId));
    }

    if (leavesPublished) {
      await tx
        .update(creatorStats)
        .set({
          publishedVideoCount: sql`GREATEST(${creatorStats.publishedVideoCount} - 1, 0)`,
        })
        .where(eq(creatorStats.userId, creatorId));
    }
  });

  const updated = await loadOwnedVideoRow(creatorId, videoId);
  if (!updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: await toPublicVideo(updated, Date.now()) };
}

/** published/scheduled → draft. `publishedAt` is cleared to satisfy video_published_at_ck. */
export async function unpublishVideo(
  creatorId: string,
  videoId: string,
): Promise<Result<PublicVideo, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  // Mirrors publishVideo: the counter comes back down only if it went up, so a
  // repeated unpublish on a draft cannot drive it toward zero.
  await db.transaction(async (tx) => {
    // Locked, so two concurrent unpublishes decrement once between them rather than once each.
    const lockedStatus = await lockOwnedVideoPublishState(tx, creatorId, videoId);
    if (lockedStatus === null) return;
    const wasPublished = lockedStatus === "published";

    await tx
      .update(video)
      .set({ publishStatus: "draft", publishedAt: null, scheduledPublishAt: null })
      .where(ownedVideoPredicate(creatorId, videoId));

    if (wasPublished) {
      await tx
        .update(creatorStats)
        .set({
          publishedVideoCount: sql`GREATEST(${creatorStats.publishedVideoCount} - 1, 0)`,
        })
        .where(eq(creatorStats.userId, creatorId));
    }
  });

  const updated = await loadOwnedVideoRow(creatorId, videoId);
  if (!updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: await toPublicVideo(updated, Date.now()) };
}

/**
 * DEFERRED (Appendix A). A YouTube video cannot be gated, so there is nothing to sign
 * and this always refuses.
 *
 * OWNERSHIP IS CHECKED FIRST, deliberately. §6 says "always returns 409" and §0 says
 * every `/:videoId*` route re-verifies ownership — those give a stranger different
 * answers, so one had to win. Ownership-first keeps §0 literally true, is what the route
 * will do anyway once real tokens exist, and leaks nothing either way.
 */
export async function issuePlaybackToken(
  creatorId: string,
  videoId: string,
): Promise<Result<never, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: false, error: { type: "NO_TOKEN_REQUIRED" } };
}

/**
 * Deletes a video and, via FK cascade, its children.
 *
 * There is NO provider asset to delete — the YouTube video is not ours and stays exactly
 * where it was. The only asset we might own is a custom thumbnail, and `hasCustomThumbnail`
 * is what makes that decidable: calling Cloudinary unconditionally would return
 * NOT_CONFIGURED on a box with no credentials, so no video could ever be deleted in
 * development.
 */
export async function deleteVideo(
  creatorId: string,
  videoId: string,
): Promise<Result<{ deleted: true }, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  if (existing.hasCustomThumbnail) {
    const deletedAsset = await deleteThumbnailAsset(videoId);
    if (!deletedAsset.success) return { success: false, error: deletedAsset.error };
  }

  // ⚠️ BEFORE THE ROW GOES, because `video_document` CASCADES from `video`: once the delete below
  // commits there is nothing left to enumerate the object keys from, and the bytes stay in the
  // bucket forever with no row pointing at them. SQL cannot reach object storage, so there is no
  // database-level backstop for forgetting this — the same reason `deleteThumbnailAsset` sits
  // immediately above.
  //
  // BEST-EFFORT, UNLIKE THE THUMBNAIL ABOVE, and the asymmetry is deliberate. A creator pressing
  // Delete on their own video must not be blocked by a storage outage; `deleteObject` is
  // idempotent, so a failure here leaks bytes rather than corrupting anything, and refusing the
  // delete would leave them with a video they cannot remove. The failure is logged, loudly, with
  // the key — which is what makes a later sweep possible.
  await deleteStoredDocumentsForVideo(videoId);

  // THE COUNTER COMES DOWN HERE TOO, and its absence was a real bug rather than a deliberate
  // omission. `publishVideo` increments `publishedVideoCount` and `unpublishVideo` decrements it,
  // but deleting a PUBLISHED video removed the row and left the count where it was — so the number
  // drifted upward by one for every published video its creator ever deleted, permanently.
  //
  // It went unnoticed for as long as it did because nothing read the column: `/users/me/creator-
  // summary` is its first consumer anywhere in the codebase, and a counter with no reader is a
  // counter nobody can see breaking.
  //
  // `GREATEST(… - 1, 0)` and the `wasPublished` guard both mirror `unpublishVideo` exactly: the
  // count only comes down if it went up, so deleting a draft cannot drive it negative and a
  // double-delete cannot either.
  await db.transaction(async (tx) => {
    // Locked, so a double-clicked Delete decrements once rather than twice.
    const lockedStatus = await lockOwnedVideoPublishState(tx, creatorId, videoId);
    if (lockedStatus === null) return;
    const wasPublished = lockedStatus === "published";

    await tx.delete(video).where(ownedVideoPredicate(creatorId, videoId));

    if (wasPublished) {
      await tx
        .update(creatorStats)
        .set({
          publishedVideoCount: sql`GREATEST(${creatorStats.publishedVideoCount} - 1, 0)`,
        })
        .where(eq(creatorStats.userId, creatorId));
    }
  });

  return { success: true, value: { deleted: true } };
}

// --------------------------------------------------------------------------------
// Attached documents — the deck or whitepaper shown under a video (§11j)
// --------------------------------------------------------------------------------
//
// WHY THIS SECTION EXISTS AT ALL. `video_document` has been in the schema since the studio was,
// has been read by `buildStudioVideoView` above the whole time, and had NO WRITER — 0 rows. The
// studio's "Attach documents" control collected a `File`, kept `file.name`, threw the bytes away
// and dropped even the name at save. The copy under it promised "Deck or whitepaper shown as a
// download under the video". A creator who used it lost their file silently. These four functions
// and the three routes above them are that promise being kept.
//
// THE BYTES NEVER BECOME A URL. `object_storage_key` does not leave the server; a client receives
// `downloadPath`, a path on this api, and every fetch of it re-runs the video's public gate. See
// the schema comment on `videoDocument` for why a stored URL would be a regression rather than a
// shortcut.

/**
 * The name a creator sees on the chip, and the name the file downloads as.
 *
 * ONE FUNCTION FOR BOTH, so the studio list and the browser's Save dialog cannot disagree — the
 * same string is written to `file_name` and handed to storage for the `Content-Disposition`.
 * `object-storage.ts` sanitizes again on its own side, which is not redundant: that layer must be
 * safe against any caller, and a header-injection guard that trusts its caller is not a guard.
 */
function sanitizeStoredFileName(rawFileName: string): string {
  const cleaned = rawFileName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ._-]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "document.pdf";
}

/** Translates a storage failure into the studio's own arms. See `VideoError`'s note on the collision. */
function asVideoDocumentStorageError(error: ObjectStorageError): VideoError {
  switch (error.type) {
    case "NOT_CONFIGURED":
      return { type: "DOCUMENT_STORAGE_NOT_CONFIGURED" };
    case "UPLOAD_FAILED":
      return { type: "DOCUMENT_STORAGE_UPLOAD_FAILED" };
    case "DELETE_FAILED":
      return { type: "DOCUMENT_STORAGE_DELETE_FAILED" };
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled object storage error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Deletes every stored object for a video, best-effort, and reports what it could not remove.
 *
 * CALLED BEFORE THE ROWS GO, from `deleteVideo` and from the account scrub. Both are cascade sites
 * where the rows vanish on their own and the bytes do not.
 *
 * IT RETURNS NOTHING AND THROWS NOTHING. A caller who could act on a partial failure does not
 * exist: the video is being deleted either way, and `DeleteObject` is idempotent so a retry is
 * always safe. What a failure produces is a log line carrying the key, which is the only thing a
 * later sweep could work from.
 */
async function deleteStoredDocumentsForVideo(videoId: string): Promise<void> {
  const storedDocuments = await db
    .select({ objectStorageKey: videoDocument.objectStorageKey })
    .from(videoDocument)
    .where(eq(videoDocument.videoId, videoId));

  for (const storedDocument of storedDocuments) {
    const deleted = await deleteDocumentObject(storedDocument.objectStorageKey);
    if (!deleted.success) {
      logger.error("videos: document object left in storage after video delete", {
        videoId,
        objectStorageKey: storedDocument.objectStorageKey,
        reason: deleted.error.type,
      });
    }
  }
}

/**
 * The account-scrub half of the same obligation.
 *
 * `video.creatorId` cascades from `user`, so anonymizing an account deletes every video it owns and
 * every document row under them — leaving the bytes. This enumerates them by creator, which is a
 * join the per-video helper above cannot do, and it MUST run before the scrub touches `user`.
 *
 * Exported for `anonymize-account.service.ts` alone. It is not a general-purpose helper: it deletes
 * objects for videos it does not delete, which is only correct because the caller is about to.
 */
export async function deleteStoredVideoDocumentsForCreator(creatorId: string): Promise<void> {
  const storedDocuments = await db
    .select({
      videoId: videoDocument.videoId,
      objectStorageKey: videoDocument.objectStorageKey,
    })
    .from(videoDocument)
    .innerJoin(video, eq(video.id, videoDocument.videoId))
    .where(eq(video.creatorId, creatorId));

  for (const storedDocument of storedDocuments) {
    const deleted = await deleteDocumentObject(storedDocument.objectStorageKey);
    if (!deleted.success) {
      logger.error("videos: document object left in storage after account anonymization", {
        creatorId,
        videoId: storedDocument.videoId,
        objectStorageKey: storedDocument.objectStorageKey,
        reason: deleted.error.type,
      });
    }
  }
}

/**
 * Attaches one PDF to a video the caller owns.
 *
 * ORDER IS THE WHOLE DESIGN, and each step is placed where it is for a reason:
 *
 * 1. **Ownership first**, and a miss is `VIDEO_NOT_FOUND` — never a 403. A 403 here would confirm
 *    that a video id exists while refusing it, which is the oracle §0 forbids.
 * 2. **Validate the bytes before hashing or storing them.** `file.mimetype` was already gated by
 *    the multipart middleware, but that is a header the client chose; `validatePdfBytes` reads the
 *    actual header, version and trailer, and it is the check that decides.
 * 3. **Count under the cap**, taken inside the transaction rather than before it. Two uploads
 *    racing on a video with four documents would both read four and both insert.
 * 4. **Store, then insert.** An object with no row is a leak a sweep can find; a row with no object
 *    is a download link that 502s. If the insert then fails, the object is deleted on the way out.
 *
 * ⚠️ A RE-UPLOAD OF THE SAME BYTES CONVERGES RATHER THAN DUPLICATING. `video_document_content_uidx`
 * is unique on `(video_id, content_sha256)` and the object key is content-addressed, so a retried
 * request rewrites the same object and hits the same row. That is why this route takes no
 * idempotency key: the storage layer is idempotent by construction, which is stronger than a
 * replayed response. The conflict is therefore answered as SUCCESS with the existing row, not as a
 * 409 — a creator who double-clicked Attach has the outcome they asked for.
 */
export async function attachVideoDocument(
  creatorId: string,
  videoId: string,
  input: { readonly fileName: string; readonly bytes: Buffer },
): Promise<Result<{ document: VideoDocumentView }, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  const validated = validatePdfBytes(input.bytes);
  if (isPdfValidationError(validated)) {
    return { success: false, error: { type: "INVALID_PDF", reason: validated.type } };
  }

  const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");

  // THE CAP IS CHECKED BEFORE THE UPLOAD as well as inside the transaction below. This one saves a
  // 25 MB round trip to storage that the insert would only reject; the one below is the one that
  // is actually correct under concurrency. Both, not either.
  const [preflightCount] = await db
    .select({ documentCount: sql<number>`count(*)::int` })
    .from(videoDocument)
    .where(and(eq(videoDocument.videoId, videoId), ne(videoDocument.contentSha256, contentSha256)));
  if ((preflightCount?.documentCount ?? 0) >= MAX_VIDEO_DOCUMENTS) {
    return {
      success: false,
      error: { type: "TOO_MANY_VIDEO_DOCUMENTS", limit: MAX_VIDEO_DOCUMENTS },
    };
  }

  const stored = await uploadDocumentObject({
    videoId,
    contentSha256,
    pdfBytes: input.bytes,
    downloadFileName: input.fileName,
  });
  if (!stored.success) {
    return { success: false, error: asVideoDocumentStorageError(stored.error) };
  }

  try {
    const inserted = await db.transaction(async (tx) => {
      // Re-counted under the transaction, EXCLUDING these bytes: a re-upload of a document the
      // video already holds must not be refused for being the sixth when it is really the same
      // one as before.
      const [rowCount] = await tx
        .select({ documentCount: sql<number>`count(*)::int` })
        .from(videoDocument)
        .where(
          and(eq(videoDocument.videoId, videoId), ne(videoDocument.contentSha256, contentSha256)),
        );
      if ((rowCount?.documentCount ?? 0) >= MAX_VIDEO_DOCUMENTS) return null;

      // `position` is the count, so documents render in attach order. It is not re-packed on
      // delete: a gap in the sequence orders identically, and re-packing would rewrite rows a
      // creator did not touch.
      const [row] = await tx
        .insert(videoDocument)
        .values({
          videoId,
          objectStorageKey: stored.value.objectKey,
          contentSha256,
          byteSize: validated.byteSize,
          fileName: sanitizeStoredFileName(input.fileName),
          position: rowCount?.documentCount ?? 0,
        })
        .onConflictDoUpdate({
          target: [videoDocument.videoId, videoDocument.contentSha256],
          // The name is refreshed, nothing else: same bytes under a new file name is a rename, and
          // the position must not jump because a creator re-attached what was already there.
          set: { fileName: sanitizeStoredFileName(input.fileName) },
        })
        .returning({
          id: videoDocument.id,
          fileName: videoDocument.fileName,
          byteSize: videoDocument.byteSize,
          position: videoDocument.position,
        });
      return row ?? null;
    });

    if (inserted === null) {
      // The cap won the race. The object is orphaned by this path alone, so it is removed here
      // rather than left for a sweep that does not exist.
      await deleteDocumentObject(stored.value.objectKey);
      return {
        success: false,
        error: { type: "TOO_MANY_VIDEO_DOCUMENTS", limit: MAX_VIDEO_DOCUMENTS },
      };
    }

    return {
      success: true,
      value: {
        document: {
          ...inserted,
          downloadPath: videoDocumentDownloadPath(videoId, inserted.id),
        },
      },
    };
  } catch (insertError: unknown) {
    // A row with no object is a broken download; an object with no row is a leak. Neither is good,
    // but only the first is visible to a creator, so the object goes when the row could not land.
    await deleteDocumentObject(stored.value.objectKey);
    throw insertError;
  }
}

/**
 * Removes one attached document.
 *
 * THE OBJECT GOES FIRST, and the order is the opposite of the attach path's for the same reason it
 * follows there: whichever operation can leave the more visible wreckage goes last. Deleting the
 * object first can leave a row whose download 502s, which the very next statement removes; deleting
 * the row first can leave bytes nothing points at, which nothing ever removes.
 *
 * A storage failure REFUSES the delete rather than dropping the row anyway. Unlike `deleteVideo`'s
 * best-effort sweep, this caller is asking to remove one document and can retry — silently keeping
 * the bytes while telling them it is gone is the one outcome to avoid.
 */
export async function detachVideoDocument(
  creatorId: string,
  videoId: string,
  documentId: string,
): Promise<Result<{ deleted: true }, VideoError>> {
  const existing = await loadOwnedVideoRow(creatorId, videoId);
  if (!existing) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  // Scoped to the video as well as the id: a document id belonging to somebody else's video must
  // be indistinguishable from one that does not exist.
  const [row] = await db
    .select({ objectStorageKey: videoDocument.objectStorageKey })
    .from(videoDocument)
    .where(and(eq(videoDocument.id, documentId), eq(videoDocument.videoId, videoId)))
    .limit(1);
  if (!row) return { success: false, error: { type: "VIDEO_DOCUMENT_NOT_FOUND", documentId } };

  const deletedObject = await deleteDocumentObject(row.objectStorageKey);
  if (!deletedObject.success) {
    return { success: false, error: asVideoDocumentStorageError(deletedObject.error) };
  }

  await db
    .delete(videoDocument)
    .where(and(eq(videoDocument.id, documentId), eq(videoDocument.videoId, videoId)));

  return { success: true, value: { deleted: true } };
}

/**
 * Resolves one document to a short-lived download URL, for anyone allowed to have it.
 *
 * ⚠️ THIS IS THE ONLY GATE ON THESE BYTES, and unlike every other read in this file it serves
 * ANONYMOUS callers. The bucket is private and the key never leaves the server, so the presigned
 * URL this returns is the single window in which the gate is bypassed — which is why it lives 300
 * seconds and why the check below is re-run on every request rather than cached anywhere.
 *
 * TWO WAYS IN, AND THEY ARE NOT THE SAME CHECK. `findPublicVideo` is the six-term public gate every
 * public engagement route runs; the owner branch exists so a creator can verify their own upload
 * before publishing. A viewer who is neither gets `VIDEO_NOT_FOUND` — the same answer an unpublished
 * video, a private one and a nonexistent one all give.
 */
export async function resolveVideoDocumentDownload(
  videoId: string,
  documentId: string,
  viewerId: string | null,
): Promise<Result<{ downloadUrl: string; expiresInSeconds: number }, VideoError>> {
  const publicVideo = await findPublicVideo(db, videoId);
  const isViewerTheOwner =
    viewerId !== null && (await loadOwnedVideoRow(viewerId, videoId)) !== null;
  if (publicVideo === null && !isViewerTheOwner) {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  }

  const [row] = await db
    .select({ objectStorageKey: videoDocument.objectStorageKey })
    .from(videoDocument)
    .where(and(eq(videoDocument.id, documentId), eq(videoDocument.videoId, videoId)))
    .limit(1);
  if (!row) return { success: false, error: { type: "VIDEO_DOCUMENT_NOT_FOUND", documentId } };

  const presigned = await presignVideoDocumentDownload(row.objectStorageKey);
  if (!presigned.success) {
    return { success: false, error: asVideoDocumentStorageError(presigned.error) };
  }
  return { success: true, value: presigned.value };
}

// --------------------------------------------------------------------------------
// Collaborator credits — the invite, and the answer to it
// --------------------------------------------------------------------------------
//
// WHAT THIS IS, AND WHAT IT IS NOT. A collaborator row is a CREDIT: "this person worked on this
// video", confirmed by that person. It grants NOTHING — no access to the video, the account or the
// studio. Nothing in this codebase authorizes off `video_collaborator`, and nothing should start
// without a deliberate design pass; `/studio/team`'s roadmap line promised "who else can act on
// this account", and that is ACCOUNT-LEVEL DELEGATION, which remains unbuilt. Do not let this table
// quietly become it.
//
// WHY IT NEEDED BUILDING. `video_collaborator.status` has had `invited | accepted | declined` since
// the table existed, and **no route could ever write anything but `invited`** — there was no
// accept, no decline, and no read by which an invitee could even learn they had been named. So the
// two other enum values were unreachable and a "collaborator" was an email address a creator typed
// into a box. The handshake is what makes the credit worth more than the typing.
//
// KEYED ON EMAIL, RESOLVED TO A USER ON ANSWER. The creator invites an address, because they may not
// know whether that person has an account. `userId` is filled in when the invite is answered, which
// is the first moment a real identity is attached to it.

export interface CollaborationInviteView {
  readonly videoId: string;
  readonly videoTitle: string;
  readonly creatorName: string;
  readonly status: (typeof videoCollaborator.$inferSelect)["status"];
  readonly invitedAt: Date;
}

export interface VideoCollaboratorRosterEntry {
  readonly videoId: string;
  readonly videoTitle: string;
  readonly invitedEmail: string;
  readonly status: (typeof videoCollaborator.$inferSelect)["status"];
  readonly invitedAt: Date;
  /** Non-null once the invite has been answered — before that nobody is attached to the address. */
  readonly userId: string | null;
}

/**
 * `GET /users/me/collaborations` — the invitations addressed to ME.
 *
 * MATCHED ON THE CALLER'S EMAIL, NOT ON `userId`, and that is the whole reason this read exists.
 * `userId` is null until an invite is answered, so matching on it would return nothing to exactly
 * the people who have not answered yet — the only ones with anything to do.
 *
 * `citext` DOES THE CASE-FOLDING. `invitedEmail` and `user.email` are both `citext`, so
 * `Alice@x.com` finds an invite typed as `alice@x.com` without either side lowercasing anything.
 *
 * DECLINED INVITES STAY IN THE LIST. Declining is an answer, not a delete — hiding it would let a
 * creator re-invite into what looks to the invitee like the same unanswered row, and the person
 * would have no record of having said no.
 */
export async function listMyCollaborationInvites(
  userId: string,
): Promise<readonly CollaborationInviteView[]> {
  const [caller] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!caller) return [];

  const rows = await db
    .select({
      videoId: videoCollaborator.videoId,
      videoTitle: video.title,
      creatorName: user.name,
      status: videoCollaborator.status,
      invitedAt: videoCollaborator.createdAt,
    })
    .from(videoCollaborator)
    .innerJoin(video, eq(video.id, videoCollaborator.videoId))
    .innerJoin(user, eq(user.id, video.creatorId))
    .where(eq(videoCollaborator.invitedEmail, caller.email))
    .orderBy(desc(videoCollaborator.createdAt), desc(videoCollaborator.videoId));

  return rows;
}

/**
 * `GET /users/me/collaborators` — everyone I have invited, across every video I own.
 *
 * THE ACCOUNT-LEVEL VIEW THAT DID NOT EXIST. `video_collaborator` was written by the per-video save
 * and read only into that one video's projection, so a creator with twelve videos had to open
 * twelve pages to see who they had named. Same gap `/studio/funding` had over funding rounds, and
 * the same shape of fix: one read across the owner's own rows.
 */
export async function listMyVideoCollaborators(
  creatorId: string,
): Promise<readonly VideoCollaboratorRosterEntry[]> {
  const rows = await db
    .select({
      videoId: videoCollaborator.videoId,
      videoTitle: video.title,
      invitedEmail: videoCollaborator.invitedEmail,
      status: videoCollaborator.status,
      invitedAt: videoCollaborator.createdAt,
      userId: videoCollaborator.userId,
    })
    .from(videoCollaborator)
    .innerJoin(video, eq(video.id, videoCollaborator.videoId))
    .where(eq(video.creatorId, creatorId))
    .orderBy(desc(videoCollaborator.createdAt), desc(videoCollaborator.videoId));

  return rows;
}

/**
 * `POST /videos/:videoId/collaborators/respond` — the invitee accepts or declines.
 *
 * THE FIRST WRITER OF `accepted` AND `declined` ANYWHERE. Both enum values shipped with the table
 * and had no route that could produce them.
 *
 * ⚠️ THE PREDICATE IS THE AUTHORIZATION. There is no ownership check and there should not be — the
 * caller is not the video's owner, they are the person whose ADDRESS was invited. Matching on
 * `(videoId, invitedEmail = caller's email)` is what proves they are answering their own invite,
 * and a caller who was never invited matches nothing and gets the same `VIDEO_NOT_FOUND` an absent
 * video gives. Splitting those two would make this route an oracle for who is invited to what.
 *
 * `userId` IS STAMPED ON THE ANSWER, not at invite time: it is the first moment an account is
 * provably behind the address. It is `set null` on user delete, so the credit survives the account
 * as a typed email — which is the honest degradation for a record about who did work.
 */
export async function respondToCollaborationInvite(
  userId: string,
  videoId: string,
  response: "accepted" | "declined",
): Promise<Result<{ status: "accepted" | "declined" }, VideoError>> {
  const [caller] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!caller) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };

  const [updated] = await db
    .update(videoCollaborator)
    .set({ status: response, userId })
    .where(
      and(eq(videoCollaborator.videoId, videoId), eq(videoCollaborator.invitedEmail, caller.email)),
    )
    .returning({ status: videoCollaborator.status });

  if (!updated) return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId } };
  return { success: true, value: { status: response } };
}

// --------------------------------------------------------------------------------
// Moderation actions on YOUR videos — what `/studio/copyright` reads
// --------------------------------------------------------------------------------
//
// WHY IT EXISTS. A moderator could hide a creator's video and the creator was told NOTHING.
// `moderationVisibilityState` reached no read they could see, and `deriveStudioVideoStatus` had no
// branch for it, so the Studio positively reported "published" for a video the public gate served
// to nobody. The badge fix above stops the lie; this read is how they find out WHAT happened and
// WHEN, which is what makes it actionable rather than merely honest.
//
// It is the video half of the lever `user.profileModerationState` already had on the profile side,
// where the owner's read carries the state for exactly this reason — "otherwise nobody ever tells
// them".

export interface VideoModerationNoticeView {
  readonly videoId: string;
  readonly videoTitle: string;
  readonly actionKind: (typeof videoModerationAction.$inferSelect)["actionKind"];
  /** The report's CATEGORY, or null for an action taken without one. Never free text. */
  readonly reason: (typeof videoContentReport.$inferSelect)["reason"] | null;
  readonly decidedAt: Date;
}

/**
 * `GET /users/me/video-moderation` — decisions taken on this creator's own videos.
 *
 * ## ⚠️ THREE THINGS THIS DELIBERATELY DOES NOT RETURN
 *
 * **The reporter.** Not their id, name, count, or anything from which one could be inferred.
 * `video_content_report` carries `reporterUserId` and the moderator queue itself does not show it —
 * "a moderator who can see who reported whom is a moderator who can be lobbied", and a CREATOR who
 * can see it is a creator who can retaliate. With ten videos on the platform, a count alone would
 * often be an identity.
 *
 * **Pending reports.** Only DECIDED actions appear. YouTube works this way too: community flags are
 * invisible to the creator until action is taken, and only Content ID matches — an automated
 * process, not a person — are surfaced while open. Showing a live report would tip somebody off
 * mid-review and invite exactly the retaliation the paragraph above guards against.
 *
 * **`reasonNote`.** It is the moderator's own free-text justification, hash-chained into
 * `platform_audit_entry` as an accountability record for STAFF. A moderator writing "reported by
 * three people, one of them the seller in #4821" is writing an internal note, not creator-facing
 * copy. The report's `reason` ENUM is projected instead: categorical, safe, and enough to act on —
 * it is what a YouTube strike notice actually tells you.
 *
 * `report_dismissed` IS INCLUDED, and that is not noise: a creator who was told their video was
 * hidden should also be told when a claim against it was thrown out. Reporting only the punishments
 * would make this a record of accusations rather than of outcomes.
 */
export async function listMyVideoModerationNotices(
  creatorId: string,
): Promise<readonly VideoModerationNoticeView[]> {
  const rows = await db
    .select({
      videoId: video.id,
      videoTitle: video.title,
      actionKind: videoModerationAction.actionKind,
      reason: videoContentReport.reason,
      decidedAt: videoModerationAction.createdAt,
    })
    .from(videoModerationAction)
    // INNER on the video: `videoModerationAction.videoId` is `set null` on delete, and an action
    // whose video is gone has nothing to show a creator about.
    .innerJoin(video, eq(video.id, videoModerationAction.videoId))
    // LEFT on the report: `reportId` is nullable and `set null`, so a staff-initiated action with
    // no report behind it still reaches the creator — with `reason: null` rather than vanishing.
    .leftJoin(videoContentReport, eq(videoContentReport.id, videoModerationAction.reportId))
    .where(eq(video.creatorId, creatorId))
    .orderBy(desc(videoModerationAction.createdAt), desc(videoModerationAction.id));

  return rows;
}
