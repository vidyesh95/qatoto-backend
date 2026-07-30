import express from "express";

import * as dailyLogsController from "#src/controllers/daily-logs.controller.js";
import * as workshopController from "#src/controllers/workshop.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  chatMessageLimiter,
  dailyLogSubmitLimiter,
  dailyLogWriteLimiter,
  workshopBoardWriteLimiter,
  workshopFileCreateLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

const router = express.Router();

/**
 * The Virtual Workshop and daily logs (R_AND_D_BACKEND_STRUCTURE.md §8, §11d).
 *
 * MOUNTED AT `/research-projects`, AFTER researchProjectsRouter. There is no collision:
 * that router's `/:projectSlug` matches exactly one segment and never swallows a deeper
 * path. Splitting §8 into its own router keeps the projects router readable and matches
 * the folder layout §3 describes.
 *
 * CHAIN ORDER, everywhere: auth → limiter → requireIdentifiedUser → parser → controller.
 * The limiter precedes `requireIdentifiedUser` so an unidentified caller cannot hammer
 * that guard's extra query, and both follow `requireAuth` because every limiter keys on
 * `req.user.id` — the same reasoning research-projects.routes.ts records.
 *
 * WHERE `requireIdentifiedUser` GOES, by the §4a STRUCTURAL RULE rather than by feel:
 * every write that produces EFFORT or EVIDENCE. That is daily-log create and submit (the
 * input to the entire equity ledger) and workshop file links (evidence a §9 claim can
 * point at). The board and chat get limiters only — they carry no distinct-count, no
 * uniqueness quota and no effort, and `requireAuth` plus proven membership is the right
 * bar for them.
 *
 * NO SEPARATE AUTHORIZATION MIDDLEWARE. Membership is proven inside each controller via
 * `requireProjectRole`, because a middleware cannot return a `Result` and so cannot
 * participate in the exhaustive error switch (§4a Layer 2).
 *
 * ROUTE ORDER: literal segments before `/:id` everywhere — `/columns/reorder` before
 * `/columns/:columnId`, `/tasks/:taskId/move` before `/tasks/:taskId`.
 */

// --- The workshop surface.

/** GET /research-projects/:projectSlug/workshop — board + files + first chat page. */
router.get("/:projectSlug/workshop", requireAuth, workshopController.getWorkshop);

/** GET …/workshop/board */
router.get("/:projectSlug/workshop/board", requireAuth, workshopController.getBoard);

// --- Board columns. `/reorder` is a literal and MUST precede `/:columnId`.

router.post(
  "/:projectSlug/workshop/columns",
  requireAuth,
  workshopBoardWriteLimiter,
  compactBody,
  workshopController.createColumn,
);

router.post(
  "/:projectSlug/workshop/columns/reorder",
  requireAuth,
  workshopBoardWriteLimiter,
  longFormBody,
  workshopController.reorderColumns,
);

router.patch(
  "/:projectSlug/workshop/columns/:columnId",
  requireAuth,
  workshopBoardWriteLimiter,
  compactBody,
  workshopController.updateColumn,
);

router.delete(
  "/:projectSlug/workshop/columns/:columnId",
  requireAuth,
  workshopBoardWriteLimiter,
  workshopController.deleteColumn,
);

// --- Tasks. `/tasks/:taskId/move` is more specific than `/tasks/:taskId`, and Express
// --- matches in declaration order, so it is declared first.

router.post(
  "/:projectSlug/workshop/tasks",
  requireAuth,
  workshopBoardWriteLimiter,
  longFormBody,
  workshopController.createTask,
);

/** POST …/tasks/:taskId/move — the server derives the rank; the client sends neighbours. */
router.post(
  "/:projectSlug/workshop/tasks/:taskId/move",
  requireAuth,
  workshopBoardWriteLimiter,
  longFormBody,
  workshopController.moveTask,
);

router.patch(
  "/:projectSlug/workshop/tasks/:taskId",
  requireAuth,
  workshopBoardWriteLimiter,
  longFormBody,
  workshopController.updateTask,
);

router.delete(
  "/:projectSlug/workshop/tasks/:taskId",
  requireAuth,
  workshopBoardWriteLimiter,
  workshopController.deleteTask,
);

// --- Files. Links, not uploads: there is no multipart handler on this router at all.

router.get("/:projectSlug/workshop/files", requireAuth, workshopController.listFiles);

/** GET …/workshop/files/:fileId — member only. A removed file reads as absent (§11j.2). */
router.get("/:projectSlug/workshop/files/:fileId", requireAuth, workshopController.getFile);

/** A linked file is evidence §9 can point at, so the caller must be an accountable one. */
router.post(
  "/:projectSlug/workshop/files",
  requireAuth,
  workshopFileCreateLimiter,
  requireIdentifiedUser,
  compactBody,
  workshopController.addFileLink,
);

/** PATCH …/workshop/files/:fileId — rename or re-kind. The URL is immutable (§11j.3). */
router.patch(
  "/:projectSlug/workshop/files/:fileId",
  requireAuth,
  workshopFileCreateLimiter,
  // No requireIdentifiedUser, matching the DELETE below: that guard is on the POST because
  // CREATING a link mints §9 evidence. A rename mints nothing.
  compactBody,
  workshopController.updateFileLink,
);

router.delete(
  "/:projectSlug/workshop/files/:fileId",
  requireAuth,
  workshopFileCreateLimiter,
  workshopController.removeFileLink,
);

// --- Chat. `/chat/read` is a literal and MUST precede `/chat/:messageId`.

router.get("/:projectSlug/workshop/chat", requireAuth, workshopController.listChat);

router.post(
  "/:projectSlug/workshop/chat",
  requireAuth,
  chatMessageLimiter,
  compactBody,
  workshopController.postChatMessage,
);

router.post(
  "/:projectSlug/workshop/chat/read",
  requireAuth,
  chatMessageLimiter,
  longFormBody,
  workshopController.markChatRead,
);

router.patch(
  "/:projectSlug/workshop/chat/:messageId",
  requireAuth,
  chatMessageLimiter,
  compactBody,
  workshopController.editChatMessage,
);

router.delete(
  "/:projectSlug/workshop/chat/:messageId",
  requireAuth,
  chatMessageLimiter,
  workshopController.deleteChatMessage,
);

// --- Daily logs. `/:logId/submit` and `/:logId/transcript` are literals under the param,
// --- so they are declared before the bare `/:logId` verbs.

router.get("/:projectSlug/daily-logs", requireAuth, dailyLogsController.listDailyLogs);

/**
 * A daily log is the input to the entire equity ledger, so create and submit both run
 * `requireIdentifiedUser`: `requireAuth` proves a session exists, and an anonymous session
 * is a real session (§4a Layer 1).
 */
router.post(
  "/:projectSlug/daily-logs",
  requireAuth,
  dailyLogWriteLimiter,
  requireIdentifiedUser,
  longFormBody,
  dailyLogsController.createDailyLog,
);

router.get(
  "/:projectSlug/daily-logs/:logId/transcript",
  requireAuth,
  dailyLogsController.getDailyLogTranscript,
);

/** POST …/daily-logs/:logId/submit — 202 and a receipt, never a verdict. */
router.post(
  "/:projectSlug/daily-logs/:logId/submit",
  requireAuth,
  dailyLogSubmitLimiter,
  requireIdentifiedUser,
  compactBody,
  dailyLogsController.submitDailyLog,
);

router.get("/:projectSlug/daily-logs/:logId", requireAuth, dailyLogsController.getDailyLog);

router.patch(
  "/:projectSlug/daily-logs/:logId",
  requireAuth,
  dailyLogWriteLimiter,
  longFormBody,
  dailyLogsController.updateDailyLog,
);

router.delete(
  "/:projectSlug/daily-logs/:logId",
  requireAuth,
  dailyLogWriteLimiter,
  dailyLogsController.deleteDailyLog,
);

/**
 * §8's CROSS-PROJECT half, root-mounted (§11h, Appendix B2).
 *
 * A second router from this file rather than a second file, mirroring the funding domain's
 * `fundingRouter` / `projectFundingRouter` split: one domain, one route file, two mounts.
 * Root-mounted because a member arriving from the `/build-log` stage page holds no project
 * slug — the same reason `researchCatalogRouter` and `fundingRouter` mount at `/`.
 *
 * NO `requireProjectRole` ON EITHER ROUTE, and neither is a hole:
 *   - `/daily-logs` has no project in the URL to prove membership against, so the service
 *     derives the caller's membership set from `project_member` in SQL instead. There is
 *     no request field that can widen it.
 *   - `/daily-logs/streak-leaderboard` is public on purpose. A streak count over an
 *     already-public project is project metadata; a log is a member's work record.
 *
 * ROUTE ORDER: the literal `/daily-logs/streak-leaderboard` is declared FIRST. Nothing
 * parameterised follows it today, and the rule is stated here so nobody later adds
 * `/daily-logs/:logId` above it.
 */
export const dailyLogFeedRouter = express.Router();

dailyLogFeedRouter.get(
  "/daily-logs/streak-leaderboard",
  attachOptionalUser,
  dailyLogsController.listDailyLogStreakLeaderboard,
);

dailyLogFeedRouter.get("/daily-logs", requireAuth, dailyLogsController.listDailyLogFeed);

export default router;
