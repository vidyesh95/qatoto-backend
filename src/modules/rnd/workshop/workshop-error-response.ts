import type { Response } from "express";

import type { DailyLogError } from "#src/modules/rnd/workshop/daily-logs.service.js";
import type { WorkshopBoardError } from "#src/modules/rnd/workshop/workshop-board.service.js";
import type { WorkshopChatError } from "#src/modules/rnd/workshop/workshop-chat.service.js";
import type { WorkshopFileError } from "#src/modules/rnd/workshop/workshop-files.service.js";

/**
 * The §8 error mapper.
 *
 * A SECOND MAPPER RATHER THAN AN EXTENSION OF project-error-response.ts, following the
 * precedent studio-error-response.ts set beside it: the §8 services compose their own
 * error union, and folding them into the projects mapper would make one exhaustive switch
 * responsible for two domains that ship on different schedules.
 *
 * THE STATUS POLICY IS THE SAME ONE (§4a/§13), restated because it is the part a reviewer
 * checks:
 *   404 — every authorization and lookup failure. "No such project", "not a member",
 *         "role below the minimum" and "that column belongs to another project" are
 *         indistinguishable, so a stranger cannot probe which ids exist. Never 403.
 *   403 — only where membership is ALREADY PROVEN and the refusal names a rule that
 *         reveals nothing new (NOT_THE_AUTHOR).
 *   422 — parse failures and cross-table validation a schema cannot express.
 *   409 — lifecycle conflicts (already submitted, column not empty, link already added).
 *   502/503 — a third party did not answer, or is not configured. Never the caller's
 *         fault, and the split matters: 502 says retry, 503 says an operator must act.
 */
export type WorkshopDomainError =
  | WorkshopBoardError
  | WorkshopFileError
  | WorkshopChatError
  | DailyLogError;

export function mapWorkshopErrorToResponse(error: WorkshopDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: every authorization and lookup failure, all indistinguishable.
    case "NOT_FOUND":
      return { statusCode: 404, message: "Project not found." };
    case "COLUMN_NOT_FOUND":
      return { statusCode: 404, message: "Board column not found." };
    case "TASK_NOT_FOUND":
      return { statusCode: 404, message: "Task not found." };
    case "FILE_NOT_FOUND":
      return { statusCode: 404, message: "File not found." };
    case "MESSAGE_NOT_FOUND":
      return { statusCode: 404, message: "Message not found." };
    case "DAILY_LOG_NOT_FOUND":
      return { statusCode: 404, message: "Daily log not found." };

    // --- 403: membership is proven; the refusal is about a rule.
    case "NOT_THE_AUTHOR":
      return { statusCode: 403, message: "Only the author can do that." };

    // --- 409: lifecycle conflicts.
    case "COLUMN_NOT_EMPTY":
      return {
        statusCode: 409,
        // Naming the count tells the member what to do next, and the refusal exists so a
        // mis-tap cannot delete other people's cards.
        message: `Move or delete this column's ${error.taskCount} card(s) before removing it.`,
      };
    case "COLUMN_LIMIT_REACHED":
      return { statusCode: 409, message: `A board can hold at most ${error.limit} columns.` };
    case "FILE_LINK_ALREADY_ADDED":
      return { statusCode: 409, message: "That link is already on this project." };
    case "DAILY_LOG_ALREADY_EXISTS":
      return {
        statusCode: 409,
        message: `You already have a log for ${error.logDate}. Edit it instead.`,
      };
    case "DAILY_LOG_ALREADY_SUBMITTED":
      return {
        statusCode: 409,
        // The rule §8 states plainly: a submitted log is evidence, and evidence its
        // author can still rewrite is not evidence.
        message: "This log has been submitted and can no longer be changed.",
      };
    case "EDIT_WINDOW_CLOSED":
      return {
        statusCode: 409,
        message: `Messages can only be edited within ${error.windowMinutes} minutes of sending.`,
      };
    case "RANK_CONTENDED":
      return {
        statusCode: 409,
        // Honest about the cause: someone else moved a card into the same gap. The client
        // re-reads the board and drops again.
        message: "Another member moved a card at the same time. Refresh and try again.",
      };

    // --- 422: validation a schema could not do alone.
    case "COLUMN_SET_MISMATCH":
      return {
        statusCode: 422,
        message: "A reorder must list every column on this board exactly once.",
        errors: { columnIds: ["Must match the board's current columns."] },
      };
    case "ASSIGNEE_NOT_A_MEMBER":
      return {
        statusCode: 422,
        message: "That person is not an active member of this project.",
        errors: { assigneeMemberId: ["Not an active member."] },
      };
    case "MOVE_ANCHOR_INVALID":
      return {
        statusCode: 422,
        message: "Those neighbouring cards are no longer where the board says they are.",
        errors: { move: ["Refresh the board and move the card again."] },
      };
    case "CURSOR_MALFORMED":
      return {
        statusCode: 422,
        message: "That page cursor is not valid.",
        errors: { cursor: ["Send the cursor returned by the previous page, or none."] },
      };
    case "DAILY_LOG_EMPTY":
      return {
        statusCode: 422,
        message: "A log needs a written note, a video, or both.",
        errors: { narrative: ["Add a note or attach a video before submitting."] },
      };
    case "LOG_DATE_IN_FUTURE":
      return {
        statusCode: 422,
        message: "A log cannot be filed for a day that has not happened.",
        errors: { logDate: [`${error.logDate} is in the future.`] },
      };

    // --- 422: external links. The host allowlist is the whole security model of a
    // --- linked file (§8), so each refusal names what was wrong with the URL.
    case "LINK_UNPARSEABLE":
      return {
        statusCode: 422,
        message: "That is not a valid link.",
        errors: { externalUrl: ["Paste a full https:// link."] },
      };
    case "LINK_NOT_HTTPS":
      return {
        statusCode: 422,
        message: "Links must be https.",
        errors: { externalUrl: [`Received a ${error.scheme}: link.`] },
      };
    case "LINK_HOST_NOT_ALLOWED":
      return {
        statusCode: 422,
        message: "Files can only be linked from an approved service.",
        errors: {
          externalUrl: [
            `${error.host} is not on the allowlist. Use Google Drive or Docs, Dropbox, GitHub, OneDrive, Figma or Notion.`,
          ],
        },
      };
    case "LINK_TOO_LONG":
      return {
        statusCode: 422,
        message: "That link is too long.",
        errors: { externalUrl: [`${error.length} characters; the maximum is 2048.`] },
      };

    // --- YouTube. The 422/502 split is load-bearing: the first means the member must
    // --- fix their link, the second means YouTube did not answer and a retry may work.
    // --- Collapsing them tells a member to fix a link that was fine (studio §8).
    case "INVALID_YOUTUBE_URL":
      return {
        statusCode: 422,
        message: "That is not a YouTube video link.",
        errors: { youtubeUrl: ["Paste a link like https://youtube.com/watch?v=…"] },
      };
    case "YOUTUBE_VIDEO_UNAVAILABLE":
      return {
        statusCode: 422,
        message: "That video is not available. It may be private, deleted, or embedding-disabled.",
        errors: { youtubeUrl: [`Video ${error.youtubeVideoId} could not be loaded.`] },
      };
    case "YOUTUBE_VERIFY_FAILED":
      return { statusCode: 502, message: "Could not reach YouTube. Please try again." };

    default: {
      // Adding a variant to any of the four service unions without handling it here
      // breaks the build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled workshop error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondWorkshopError(res: Response, error: WorkshopDomainError): void {
  const { statusCode, message, errors } = mapWorkshopErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
