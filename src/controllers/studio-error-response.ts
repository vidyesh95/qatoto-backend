import type { Response } from "express";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import type { ContentReviewError } from "#src/services/content-review.service.js";
import type { PlaylistError } from "#src/services/playlists.service.js";
import type { AnimeSeriesError } from "#src/services/series.service.js";
import type { VideoError } from "#src/services/videos.service.js";

/**
 * Error mapping for the Creator Studio controllers (docs/STUDIO_BACKEND_STRUCTURE.md §8).
 *
 * WHY A THIRD MAPPER FILE rather than extending one of the two that exist. No controller
 * in this repo imports another, and exporting a mapper FROM a route-owning controller
 * would invert the routes → controllers → services layering. The studio controllers
 * compose one domain error union, so the mapper lives here and they all import it —
 * exactly the arrangement discovery-error-response.ts arrived at.
 *
 * The transport-generic helpers are IMPORTED from project-error-response.ts, never
 * copied. There are now three consumers, which is the threshold that file names for
 * extracting them to src/controllers/http-response.ts — worth doing next time one of
 * these files is opened, and deliberately not bundled into this change.
 *
 * THE STATUS POLICY FOR THE STUDIO, stated once:
 *   404 — every ownership and lookup failure. "No such video" and "not yours" are
 *         indistinguishable, so a stranger cannot probe which video ids exist.
 *   403 — ONLY the platform-capability refusal on /videos/admin/*. That does not break
 *         the 404-never-403 rule, it applies it: the refusal is decided BEFORE any id is
 *         read, so a non-staff caller gets an identical 403 for a valid id and a garbage
 *         one. The single fact disclosed is the caller's own staff status.
 *   422 — parse failures, and cross-table rules a schema cannot express.
 *   409 — lifecycle conflicts, and the deferred playback-token route.
 *   502 — YouTube did not answer. NOT the creator's fault, and retrying may work.
 *   503 — Cloudinary is not configured on this deployment.
 *
 * TWO PAIRS THAT LOOK MERGEABLE AND ARE NOT — do not collapse them:
 *   YOUTUBE_VIDEO_UNAVAILABLE (422) vs YOUTUBE_VERIFY_FAILED (502). The first means the
 *     creator gave us a bad link and must fix it; the second means YouTube was
 *     unreachable. Collapsing them tells a creator to fix a link that was fine.
 *   ANIME_SERIES_NOT_FOUND (422) vs SERIES_NOT_FOUND (404). The first is a series id in a
 *     request BODY, the second a series id in the PATH. One literal cannot map to two
 *     statuses, which is why they are two literals — the same split the project mapper
 *     makes between NOT_FOUND and CATEGORY_NOT_FOUND.
 */

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";

/**
 * Every domain error the studio controllers can surface.
 *
 * The unions overlap on purpose: `VIDEO_NOT_FOUND` and `NOT_AN_ANIME_EPISODE` are
 * declared once in videos.service.ts and imported by the others, so TypeScript collapses
 * them into a single arm here. Two arms only merge when their payloads are identical —
 * which is exactly why any variant that must render as a DIFFERENT status gets a
 * different literal rather than a different payload.
 */
export type StudioDomainError = VideoError | ContentReviewError | PlaylistError | AnimeSeriesError;

const CHAPTER_RULE_MESSAGES: Readonly<
  Record<Extract<VideoError, { type: "INVALID_CHAPTERS" }>["reason"], string>
> = {
  TOO_FEW: "A video needs at least three chapters for a player to show them.",
  FIRST_NOT_ZERO: "The first chapter must start at 0:00.",
  NOT_ASCENDING: "Chapters must be in ascending order.",
  TOO_CLOSE: "Chapters must be at least 10 seconds apart.",
  PAST_END: "A chapter starts after the end of the video.",
};

/**
 * Maps a studio error to its HTTP shape. Does NOT touch `res` — a pure function, so it is
 * testable without a request, mirroring mapProjectErrorToResponse and
 * mapDiscoveryErrorToResponse.
 */
export function mapStudioErrorToResponse(error: StudioDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: lookups. Indistinguishable from "you may not see this".
    case "VIDEO_NOT_FOUND":
      return { statusCode: 404, message: "Video not found." };
    case "PLAYLIST_NOT_FOUND":
      return { statusCode: 404, message: "Playlist not found." };
    // A series id in the PATH. Its body-field twin, ANIME_SERIES_NOT_FOUND, is a 422 —
    // see the header note on why those are two literals and not one.
    case "SERIES_NOT_FOUND":
      return { statusCode: 404, message: "Series not found." };
    case "SEASON_NOT_FOUND":
      return { statusCode: 404, message: "Season not found." };
    case "EPISODE_NOT_FOUND":
      return { statusCode: 404, message: "Episode not found." };

    // --- 403: the ONLY variant, and only on /videos/admin/*. Names no resource and no
    // id, so it cannot be used to test whether an id exists — and it is decided before
    // any id is read, so the answer is identical for a real id and a garbage one.
    case "PLATFORM_CAPABILITY_REQUIRED":
      return { statusCode: 403, message: "This action requires a platform staff role." };

    // --- 422: the creator's link is the problem and they must change it.
    case "INVALID_YOUTUBE_URL":
      return {
        statusCode: 422,
        message: "That is not a YouTube video link.",
        errors: {
          youtubeUrl: ["Paste a youtube.com or youtu.be link, or the 11-character video id."],
        },
      };
    case "YOUTUBE_VIDEO_UNAVAILABLE":
      return {
        statusCode: 422,
        message: "YouTube will not let us embed that video.",
        errors: {
          youtubeUrl: [
            "The video is deleted, private, or has embedding disabled. Check it plays for a signed-out viewer.",
          ],
        },
      };

    // --- 502: YouTube did not answer. Not the creator's fault.
    case "YOUTUBE_VERIFY_FAILED":
      return {
        statusCode: 502,
        message: "We could not reach YouTube to check that video. Please try again.",
      };

    // --- 422: cross-field and cross-table rules a schema cannot express.
    case "GATING_UNSUPPORTED_FOR_SOURCE":
      // Names the two offending fields so the visibility step can mark both, and says
      // WHY — a UI that just says "invalid" here would look like a bug rather than a
      // deliberate refusal to promise protection we cannot deliver.
      return {
        statusCode: 422,
        message: "A YouTube-hosted video cannot be gated.",
        errors: {
          visibility: [
            "Investor-only playback is not possible while the video is hosted on YouTube — anyone with the link can watch it.",
          ],
          isNdaRequired: ["An NDA gate cannot be enforced on a YouTube-hosted video."],
        },
      };
    case "INCOMPLETE_FOR_PUBLISH":
      return {
        statusCode: 422,
        message: "This video is not complete enough to publish.",
        errors: { missing: [...error.missing] },
      };
    case "NOT_READY":
      return {
        statusCode: 422,
        message: "This video is not ready to publish yet.",
        errors: { uploadStatus: [`The video is ${error.uploadStatus}.`] },
      };
    case "INVALID_CHAPTERS":
      return {
        statusCode: 422,
        message: CHAPTER_RULE_MESSAGES[error.reason],
        errors: {
          chapters:
            error.index === null
              ? [CHAPTER_RULE_MESSAGES[error.reason]]
              : [`Chapter ${error.index + 1}: ${CHAPTER_RULE_MESSAGES[error.reason]}`],
        },
      };
    case "PRODUCT_NOT_OWNED":
      // Names EVERY offending id, not the first: a client sends up to 50 and must be
      // able to strike them all at once (the SKILL_NOT_FOUND precedent).
      return {
        statusCode: 422,
        message: "You can only attach products you own.",
        errors: { productIds: [...error.productIds] },
      };
    case "VIDEO_CATEGORY_NOT_AVAILABLE":
      // Same shape and the same reasoning. The message does not distinguish "no such
      // category" from "retired category", because the service does not either — a
      // creator fixes both by picking a different one, and separating them would tell
      // anyone with a session which ids exist.
      return {
        statusCode: 422,
        message: "You can only tag a video with categories that exist and are active.",
        errors: { categoryIds: [...error.categoryIds] },
      };
    case "TOO_MANY_VIDEO_CATEGORIES":
      // Reachable through this mapper only if the Zod `.max(3)` was somehow bypassed —
      // the wire schema refuses four items first. It exists because the service is where
      // the bound is actually an INVARIANT, and an invariant with no HTTP shape would be
      // an unhandled 500 the day an internal caller crosses it.
      return {
        statusCode: 422,
        message: `A video can be tagged with at most ${String(error.limit)} categories.`,
        errors: {
          categoryIds: [
            `You sent ${String(error.received)} distinct categories; the limit is ${String(error.limit)}.`,
          ],
        },
      };
    case "PLAYLIST_NOT_OWNED":
      return {
        statusCode: 422,
        message: "You can only add this video to your own playlists.",
        errors: { playlistIds: [...error.playlistIds] },
      };
    case "VIDEO_NOT_OWNED":
      return {
        statusCode: 422,
        message: "You can only add your own videos to a playlist.",
        errors: { videoIds: [...error.videoIds] },
      };
    case "ANIME_SERIES_NOT_FOUND":
      return {
        statusCode: 422,
        message: "That series does not exist.",
        errors: { "anime.seriesId": ["Unknown series."] },
      };
    case "ANIME_SEASON_NOT_FOUND":
      return {
        statusCode: 422,
        message: "That season does not exist.",
        errors: { "anime.seasonLabel": ["Unknown season."] },
      };
    case "NOT_AN_ANIME_EPISODE":
      return { statusCode: 422, message: "That video is not an anime episode." };

    // --- 409: lifecycle conflicts.
    case "REVIEW_NOT_PENDING":
      return {
        statusCode: 409,
        message: `That episode is already ${error.reviewStatus.replace("_", " ")}.`,
      };
    case "EPISODE_NUMBER_TAKEN":
      return {
        statusCode: 409,
        message: `Episode ${error.episodeNumber} already exists in that season.`,
      };
    case "SEASON_LABEL_TAKEN":
      return {
        statusCode: 409,
        message: `That series already has a season called "${error.seasonLabel}".`,
      };
    case "NO_TOKEN_REQUIRED":
      // Deferred route (Appendix A). A YouTube video has nothing to sign, and saying so
      // is more useful than a 404 that would imply the video is missing.
      return {
        statusCode: 409,
        message: "This video needs no playback token — it plays directly from YouTube.",
      };
    case "SOURCE_NOT_VERIFIED":
      // 409, NOT 422, and the difference is the point. 422 says "your input is wrong";
      // there is no input to correct here. The row is complete, the link is fine, and
      // `verify-youtube-video` is already retrying — the creator waits and publishes
      // again. That is a lifecycle conflict, which is what this file reserves 409 for.
      //
      // Its nearest neighbour NOT_READY maps to 422, and the two are genuinely different:
      // NOT_READY means the media is broken and the creator must act.
      return {
        statusCode: 409,
        message: "We are still confirming this video with YouTube. Try publishing again shortly.",
      };

    // --- Image pipeline, rendered identically to the product and avatar mappers.
    case "NOT_AN_IMAGE":
      return { statusCode: 422, message: "The uploaded file is not a valid image." };
    case "UNSUPPORTED_FORMAT":
      // The sentence lives in `image.ts` beside the allowlist it describes — six mappers
      // spelling it out themselves is six copies to update, and the one that got missed
      // would be telling users the wrong thing.
      return { statusCode: 422, message: describeUnsupportedImageFormat(error.detected) };
    case "DIMENSIONS_TOO_SMALL":
      return {
        statusCode: 422,
        message: `Image must be at least 64x64 pixels (received ${error.width}x${error.height}).`,
      };
    case "DIMENSIONS_TOO_LARGE":
      return {
        statusCode: 422,
        message: `Image dimensions are too large (received ${error.width}x${error.height}).`,
      };

    // --- Storage. 503 is "this deployment has no credentials", 502 is "the call failed".
    case "NOT_CONFIGURED":
      return { statusCode: 503, message: "Image uploads are not configured on this server." };
    case "UPLOAD_FAILED":
      return { statusCode: 502, message: "Could not store the image. Please try again." };
    case "DELETE_FAILED":
      return { statusCode: 502, message: "Could not remove the stored image. Please try again." };

    default: {
      // Adding a variant to any studio service union without handling it here breaks the
      // build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled studio error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondStudioError(res: Response, error: StudioDomainError): void {
  const { statusCode, message, errors } = mapStudioErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
