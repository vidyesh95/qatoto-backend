import express from "express";

import * as dailyLogsController from "#src/controllers/daily-logs.controller.js";
import * as workshopController from "#src/controllers/workshop.controller.js";
import { parseCompactJsonBody } from "#src/middleware/json-body.js";
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
  parseCompactJsonBody,
  workshopController.createColumn,
);

router.post(
  "/:projectSlug/workshop/columns/reorder",
  requireAuth,
  workshopBoardWriteLimiter,
  parseCompactJsonBody,
  workshopController.reorderColumns,
);

router.patch(
  "/:projectSlug/workshop/columns/:columnId",
  requireAuth,
  workshopBoardWriteLimiter,
  parseCompactJsonBody,
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
  parseCompactJsonBody,
  workshopController.createTask,
);

/** POST …/tasks/:taskId/move — the server derives the rank; the client sends neighbours. */
router.post(
  "/:projectSlug/workshop/tasks/:taskId/move",
  requireAuth,
  workshopBoardWriteLimiter,
  parseCompactJsonBody,
  workshopController.moveTask,
);

router.patch(
  "/:projectSlug/workshop/tasks/:taskId",
  requireAuth,
  workshopBoardWriteLimiter,
  parseCompactJsonBody,
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

/** A linked file is evidence §9 can point at, so the caller must be an accountable one. */
router.post(
  "/:projectSlug/workshop/files",
  requireAuth,
  workshopFileCreateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  workshopController.addFileLink,
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
  parseCompactJsonBody,
  workshopController.postChatMessage,
);

router.post(
  "/:projectSlug/workshop/chat/read",
  requireAuth,
  chatMessageLimiter,
  parseCompactJsonBody,
  workshopController.markChatRead,
);

router.patch(
  "/:projectSlug/workshop/chat/:messageId",
  requireAuth,
  chatMessageLimiter,
  parseCompactJsonBody,
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
  parseCompactJsonBody,
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
  parseCompactJsonBody,
  dailyLogsController.submitDailyLog,
);

router.get("/:projectSlug/daily-logs/:logId", requireAuth, dailyLogsController.getDailyLog);

router.patch(
  "/:projectSlug/daily-logs/:logId",
  requireAuth,
  dailyLogWriteLimiter,
  parseCompactJsonBody,
  dailyLogsController.updateDailyLog,
);

router.delete(
  "/:projectSlug/daily-logs/:logId",
  requireAuth,
  dailyLogWriteLimiter,
  dailyLogsController.deleteDailyLog,
);

export default router;
