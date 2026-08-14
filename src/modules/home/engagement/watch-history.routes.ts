import express from "express";

import { watchHistoryLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as watchHistoryController from "#src/modules/home/engagement/watch-history.controller.js";

/**
 * `/watch-history` — a viewer editing their own history. The READ half is
 * `GET /feed/videos?mode=watched`, which is a feed mode and stays in feed.routes.ts.
 *
 * ## ⚠️ ITS OWN ROUTER AND ITS OWN MOUNT, NOT engagementRouter
 *
 * engagementRouter mounts at `/videos`, AFTER the studio router that owns
 * `GET /:videoId` behind `requireAuth`. Its header states the consequence: every route
 * in it must be two segments deep or more, and `engagement.routes.order.test.ts`
 * asserts exactly that. A clear-all added there would have to be
 * `DELETE /videos/watch-history` — single-segment, permanently shadowed by the studio
 * route, and failing as a 401 that looks like an auth bug.
 *
 * Mounting at `/watch-history` also puts the resource where it belongs: this collection
 * is the viewer's, not a video's, and only ONE of the three routes names a video at all.
 *
 * ## Chain
 *
 * `requireAuth`, not `attachOptionalUser`. Watch history is per-user by definition —
 * there is no anonymous history to edit (`feed.service.ts` refuses to SERVE one for the
 * same reason: a fingerprint is shared by everyone behind a NAT), so no session is a 401
 * rather than a silent no-op.
 *
 * `requireIdentifiedUser` because Better Auth's `anonymous()` mints real sessions, and
 * these writes feed the already-watched and new-to-you exclusions in the ranker.
 *
 * No `idempotency()` and no `compactBody`: all three verbs are idempotent against a
 * nullable column, and none of them reads a body — `json-body-budget.test.ts` fails the
 * build for a body cap on a route that reads none.
 */

const router = express.Router();

/**
 * DELETE · PUT /watch-history/videos/:videoId — remove one video, and undo that.
 *
 * The verb pair on one path, exactly like `PUT`/`DELETE /videos/:videoId/save`. `PUT` is
 * Undo rather than a separate `/restore` sub-path because the thing being written is one
 * nullable column with two states, and two paths would imply two resources.
 */
router.delete(
  "/videos/:videoId",
  requireAuth,
  watchHistoryLimiter,
  requireIdentifiedUser,
  watchHistoryController.hideVideoFromWatchHistory,
);
router.put(
  "/videos/:videoId",
  requireAuth,
  watchHistoryLimiter,
  requireIdentifiedUser,
  watchHistoryController.restoreVideoToWatchHistory,
);

/**
 * DELETE /watch-history — clear it all.
 *
 * Single-segment and safe here, because this router owns its own mount prefix and
 * nothing else is mounted at `/watch-history`. Declared AFTER `/videos/:videoId` for
 * legibility only; Express cannot confuse the two, since one is a bare mount-root match.
 */
router.delete(
  "/",
  requireAuth,
  watchHistoryLimiter,
  requireIdentifiedUser,
  watchHistoryController.clearWatchHistory,
);

export default router;
