import type { Response } from "express";

import type { CreatorSubscriptionError } from "#src/modules/home/engagement/creator-subscriptions.service.js";
import type { VideoCommentError } from "#src/modules/home/engagement/video-comments.service.js";
import type { VideoEngagementError } from "#src/modules/home/engagement/video-engagement.service.js";
import type { VideoWatchError } from "#src/modules/home/engagement/video-watch.service.js";

/**
 * Error mapping for the home-feed engagement controllers
 * (docs/HOME_BACKEND_STRUCTURE.md §5.4).
 *
 * The transport-generic helpers are IMPORTED from project-error-response.ts, never
 * copied — the same arrangement discovery- and studio-error-response.ts use.
 *
 * THE STATUS POLICY FOR ENGAGEMENT, stated once:
 *
 *   404 — every lookup and read-authorization failure. "No such video", "not
 *         published", "source unverified", "still in review" and "upload failed" are
 *         one indistinguishable answer, so the public surface cannot be used to
 *         enumerate a creator's unreleased catalogue by id.
 *   403 — ONLY where the caller has ALREADY SEEN the resource, so the refusal
 *         discloses nothing new. A comment is publicly readable along with its
 *         author's handle, so "not your comment" is a 403 rather than a 404. Same line
 *         project-error-response.ts draws.
 *   409 — lifecycle: comments turned off, reply depth, already tombstoned. Nothing in
 *         the request is wrong; the state of the thing it addresses is.
 *   422 — parse failures, and a BODY-carried id that does not resolve.
 *   401 — no session, from requireAuth.
 *
 * ONE PAIR THAT LOOKS MERGEABLE AND IS NOT — do not collapse it:
 *   COMMENT_NOT_FOUND (404) is a commentId in the PATH.
 *   PARENT_COMMENT_NOT_ON_VIDEO (422) is a parentCommentId in the BODY.
 *   One literal cannot render as two statuses, which is why they are two literals —
 *   the same split studio-error-response.ts makes between SERIES_NOT_FOUND and
 *   ANIME_SERIES_NOT_FOUND.
 *
 * TWO VARIANTS DELIBERATELY ABSENT, so nobody adds them by reflex:
 *   SELF_ENGAGEMENT_FORBIDDEN — liking your own video is capped at exactly one by the
 *     unique key, and §4.1's engagement rate divides by unique viewers. One like is
 *     not a ranking lever, and an arm nothing can reach is noise.
 *   Anything the beacon could raise beyond VIDEO_NOT_FOUND — §3.3 says a disagreeing
 *     `reportedDurationSeconds` is IGNORED, not rejected. A beacon that 4xxs is a
 *     beacon the client retries, on the watch page, forever.
 */

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";

/**
 * `VIDEO_NOT_FOUND` is declared once and imported by the other three unions, so
 * TypeScript collapses the identical arms here into one. Two arms merge only when their
 * payloads match — which is exactly why a variant that must render as a DIFFERENT
 * status gets a different literal rather than a different payload.
 */
export type EngagementDomainError =
  | VideoEngagementError
  | VideoCommentError
  | VideoWatchError
  | CreatorSubscriptionError;

export function mapEngagementErrorToResponse(error: EngagementDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: lookups and read authorization, all indistinguishable.
    case "VIDEO_NOT_FOUND":
      return { statusCode: 404, message: "Video not found." };
    case "COMMENT_NOT_FOUND":
      return { statusCode: 404, message: "Comment not found." };
    case "CREATOR_NOT_FOUND":
      return { statusCode: 404, message: "Creator not found." };

    // --- 403: the caller can already see the row; the refusal is about a rule, not
    // --- about the existence of anything.
    case "COMMENT_NOT_AUTHOR":
      return { statusCode: 403, message: "You can only edit your own comment." };
    case "COMMENT_DELETE_FORBIDDEN":
      return {
        statusCode: 403,
        message: "Only the comment's author or the video's creator can delete it.",
      };
    case "SELF_SUBSCRIPTION_FORBIDDEN":
      // 403 rather than 422: there is no input to correct, and the caller learns
      // nothing they did not already know about themselves.
      return { statusCode: 403, message: "You cannot subscribe to your own channel." };

    // --- 409: lifecycle.
    case "COMMENTS_DISABLED":
      // A WRITE-ONLY error. Reads return an empty list instead, because the video is
      // public and its comment section is simply closed — a 409 on a read would make
      // the client render an error where it should render nothing.
      return { statusCode: 409, message: "Comments are turned off for this video." };
    case "REPLY_DEPTH_EXCEEDED":
      return { statusCode: 409, message: "You can only reply to a top-level comment." };
    case "COMMENT_ALREADY_DELETED":
      return { statusCode: 409, message: "That comment has already been deleted." };

    // --- 422: a body-carried id, and a malformed cursor.
    case "PARENT_COMMENT_NOT_ON_VIDEO":
      return {
        statusCode: 422,
        message: "That comment is not on this video.",
        errors: { parentCommentId: ["Unknown comment."] },
      };
    case "CURSOR_MALFORMED":
      // Never a silent first page: a client that silently restarts a list shows
      // duplicates and reports it as a backend bug.
      return {
        statusCode: 422,
        message: "That page cursor is not valid.",
        errors: { cursor: ["Omit it to start from the first page."] },
      };

    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled engagement error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondEngagementError(res: Response, error: EngagementDomainError): void {
  const { statusCode, message, errors } = mapEngagementErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
