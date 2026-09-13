import type { Response } from "express";

import type { BlueprintCommentError } from "#src/modules/home/blueprints/blueprint-comments.service.js";
import type { BlueprintEngagementError } from "#src/modules/home/blueprints/blueprint-engagement.service.js";

/**
 * Error mapping for the blueprint engagement and comment controllers.
 *
 * ⚠️ ITS OWN FILE, not an arm of `engagement-error-response.ts`. That union is closed over five
 * VIDEO services, so extending it would force `VIDEO_NOT_FOUND` into a blueprint controller's
 * exhaustive `switch` — an arm that surface can never produce. The blueprints module already runs
 * three separate responders for exactly this reason.
 *
 * THE STATUS POLICY, restated so this file stands alone:
 *   401 — no session. Answered by the middleware, never here.
 *   403 — the caller has ALREADY SEEN this row and its author in a public listing, so refusing
 *         them tells them nothing they did not know. Only `NOT_AUTHOR` qualifies.
 *   404 — every gate failure and every lookup failure, collapsed. A blueprint that does not
 *         exist, one that is not `published`, and one that is quarantined answer with the SAME
 *         BYTES; so do "no such comment" and "a comment under a blueprint you cannot see".
 *         Distinguishing any of them is an oracle over other people's moderation state.
 *   409 — a conflict with the current state rather than a bad request: a reply-to-a-reply
 *         (nothing in the body is wrong, the thread shape is), a repeat tombstone, and a verb the
 *         arm does not offer.
 *   422 — parse failures and a malformed cursor. Answered by `respondValidationFailed`, except
 *         the cursor, which reaches here as a domain error.
 *
 * ⚠️ `BLUEPRINT_VERB_NOT_AVAILABLE_ON_ARM` IS A 409 AND NOT A 404. A showcase cannot be saved and
 * a case study cannot be upvoted, and that is a property of the ARM rather than of the row — the
 * blueprint exists and the caller may well be looking at it. A 404 would say "no such launch",
 * which is false. The asymmetry is stated in three schema comments as contract, so the refusal
 * names it rather than hiding it.
 */

export {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";

export function respondBlueprintEngagementError(
  res: Response,
  error: BlueprintEngagementError,
): void {
  switch (error.type) {
    case "BLUEPRINT_CONTENT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That blueprint is not available.",
      });
      return;
    case "BLUEPRINT_VERB_NOT_AVAILABLE_ON_ARM":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That action is not offered on this kind of blueprint.",
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled blueprint engagement error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondBlueprintCommentError(res: Response, error: BlueprintCommentError): void {
  switch (error.type) {
    case "BLUEPRINT_CONTENT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That blueprint is not available.",
      });
      return;
    case "BLUEPRINT_COMMENT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That comment is not available.",
      });
      return;
    case "BLUEPRINT_PARENT_COMMENT_NOT_ON_TARGET":
      // Collapsed with "no such comment" by the SERVICE, which is where the oracle rule lives;
      // by the time it reaches here the caller has already been told nothing specific.
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That comment is not available.",
      });
      return;
    case "BLUEPRINT_REPLY_DEPTH_EXCEEDED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Replies go one level deep. Reply to the original comment instead.",
      });
      return;
    case "BLUEPRINT_COMMENT_NOT_AUTHOR":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You can only change your own comment.",
      });
      return;
    case "BLUEPRINT_COMMENT_ALREADY_DELETED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That comment has already been removed.",
      });
      return;
    case "BLUEPRINT_CURSOR_MALFORMED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That page cursor is not valid.",
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled blueprint comment error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
