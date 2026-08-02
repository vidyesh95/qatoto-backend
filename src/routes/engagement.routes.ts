import express from "express";

import * as engagementController from "#src/controllers/engagement.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commentCreateLimiter,
  commentLikeLimiter,
  commentUpdateLimiter,
  feedReadLimiter,
  playbackErrorLimiter,
  subscribeLimiter,
  videoLikeLimiter,
  videoSaveLimiter,
  videoShareLimiter,
  viewBeaconBurstLimiter,
  viewBeaconSustainedLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * The viewer-side engagement surface (HOME_BACKEND_STRUCTURE.md §5.2).
 *
 * ## Three routers out of one file, and where each mounts
 *
 * §5.2 describes one `engagement.routes.ts` holding four different URL prefixes. That is
 * a description of a FILE, not of a mount — and `/videos` and `/feed` already have
 * owners in app.ts. So this file exports three routers, the same shape
 * compensation.routes.ts, funding.routes.ts and workshop.routes.ts already use:
 *
 *   default        → mounted at "/videos", immediately AFTER the studio router
 *   commentRouter  → mounted at "/", owns /comments/:commentId*
 *   creatorRouter  → mounted at "/", owns /creators/:creatorId/subscribe
 *
 * The fourth, `GET /feed/watch/:videoId`, lives in feed.routes.ts — app.ts records
 * `/feed` as a prefix no other router shares, and that file already anticipated it.
 *
 * `commentRouter` and `creatorRouter` are root-mounted for the reason the notifications
 * and application-inbox routers are: a client holding a `commentId` from a comment list
 * has no reason to know which video owns it, and re-deriving
 * `/videos/:videoId/comments/:commentId` would let a caller ASSERT a video/comment
 * pairing the server must then re-check anyway.
 *
 * ## ⚠️ EVERY ROUTE HERE IS TWO SEGMENTS DEEP OR MORE, AND THAT IS LOAD-BEARING
 *
 * videos.routes.ts declares `GET /:videoId` behind `requireAuth`, and app.ts mounts the
 * studio router FIRST. A public single-segment route added to this router would be
 * PERMANENTLY SHADOWED: every logged-out viewer would get a 401 from the studio route
 * and the public handler would never run. Nothing type-checks wrong, no existing test
 * fails, and the symptom reads as an auth bug.
 *
 * That is why the public watch payload is `GET /feed/watch/:videoId` and not
 * `GET /videos/:videoId`. `engagement.routes.order.test.ts` asserts both halves of this.
 *
 * ## Chain order, and the choices inside it
 *
 * House order (research-programs.routes.ts): auth → limiter → idempotency →
 * requireIdentifiedUser → body cap → controller.
 *
 * **`attachOptionalUser` BEFORE the limiter, always.** The engagement limiters use the
 * default `userKey`, which prefers `req.user.id` and falls back to the IP. Running the
 * limiter first would key every signed-in viewer by IP and drop them all into one
 * shared NAT bucket.
 *
 * **`PUT`/`DELETE` for like, save, comment-like and subscribe** — not §5.2's
 * `POST`/`DELETE`. The repo already made this call for post reactions, with the reason:
 * the per-user unique key makes both verbs idempotent, so a double-tap on a slow
 * connection is harmless rather than a second like. Consequence: they carry no
 * idempotency key AND no `compactBody`, because they read no body — and
 * `json-body-budget.test.ts` fails the build for a body cap on a route that reads none.
 *
 * **`requireIdentifiedUser` on every authenticated write.** Better Auth's `anonymous()`
 * mints real sessions, so `requireAuth` alone admits unlimited throwaway identities into
 * counters that feed ranking: `likeCount`, `commentCount` and `saveCount` all land in
 * §4.1's engagement rate, and `subscriberCount` is public social proof.
 *
 * **`idempotency()` on exactly one route.** Comment create is the only write here with
 * no natural unique key, so it is the only one where a double-tapped submit button
 * genuinely posts twice. The beacon, playback-error and share are each covered by a
 * unique index instead — and for share that is the ONLY option, since `idempotency()`
 * no-ops without a session and share is reachable anonymously.
 *
 * **`POST /share` is optional-auth, but its counter is gated on a real account.** The
 * row is always written — an anonymous "copy link" is real traffic — while
 * `videoStats.shareCount` moves only for a signed-in sharer, because share count feeds
 * a ranking component and an anonymous caller must not be able to push one. That gate
 * lives in video-engagement.service.ts. DO NOT "FIX" IT.
 */

const router = express.Router();

/**
 * POST /videos/:videoId/view-beacon — THE ONLY UNAUTHENTICATED WRITE ON THE PLATFORM.
 *
 * TWO LIMITERS, chained: §7 asks for 60/min AND 200/hr and `createLimiter` takes one
 * window. Burst first, so a burst violator's `Retry-After` names the minute. Same shape
 * as `/signup/start` stacking its IP and email buckets.
 */
router.post(
  "/:videoId/view-beacon",
  attachOptionalUser,
  viewBeaconBurstLimiter,
  viewBeaconSustainedLimiter,
  compactBody,
  engagementController.recordViewBeacon,
);

/** POST /videos/:videoId/playback-error — the §8.2 fast dead-player path. */
router.post(
  "/:videoId/playback-error",
  attachOptionalUser,
  playbackErrorLimiter,
  compactBody,
  engagementController.reportPlaybackError,
);

/** PUT · DELETE /videos/:videoId/like — idempotent by verb. No body, no key, no cap. */
router.put(
  "/:videoId/like",
  requireAuth,
  videoLikeLimiter,
  requireIdentifiedUser,
  engagementController.likeVideo,
);
router.delete(
  "/:videoId/like",
  requireAuth,
  videoLikeLimiter,
  requireIdentifiedUser,
  engagementController.unlikeVideo,
);

/** PUT · DELETE /videos/:videoId/save — watch-later. Same shape as like. */
router.put(
  "/:videoId/save",
  requireAuth,
  videoSaveLimiter,
  requireIdentifiedUser,
  engagementController.saveVideo,
);
router.delete(
  "/:videoId/save",
  requireAuth,
  videoSaveLimiter,
  requireIdentifiedUser,
  engagementController.unsaveVideo,
);

/** POST /videos/:videoId/share — optional auth; see the counter note in the header. */
router.post(
  "/:videoId/share",
  attachOptionalUser,
  videoShareLimiter,
  compactBody,
  engagementController.recordShare,
);

/** GET /videos/:videoId/comments — public keyset read, per-viewer `hasLiked` embedded. */
router.get(
  "/:videoId/comments",
  attachOptionalUser,
  feedReadLimiter,
  engagementController.listVideoComments,
);

/** POST /videos/:videoId/comments — the ONE route carrying an idempotency key. */
router.post(
  "/:videoId/comments",
  requireAuth,
  commentCreateLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  engagementController.createVideoComment,
);

/**
 * /comments/:commentId* — root-mounted. A comment id is globally unique and the client
 * gets it from a listing, so requiring the owning video in the path would buy nothing
 * and let a caller assert a pairing the server has to re-check regardless.
 */
export const commentRouter = express.Router();

commentRouter.patch(
  "/comments/:commentId",
  requireAuth,
  commentUpdateLimiter,
  requireIdentifiedUser,
  compactBody,
  engagementController.updateComment,
);

/** Tombstone delete — author or the video's creator. No body, so no cap. */
commentRouter.delete(
  "/comments/:commentId",
  requireAuth,
  commentUpdateLimiter,
  requireIdentifiedUser,
  engagementController.deleteComment,
);

commentRouter.put(
  "/comments/:commentId/like",
  requireAuth,
  commentLikeLimiter,
  requireIdentifiedUser,
  engagementController.likeComment,
);
commentRouter.delete(
  "/comments/:commentId/like",
  requireAuth,
  commentLikeLimiter,
  requireIdentifiedUser,
  engagementController.unlikeComment,
);

/** /creators/:creatorId/subscribe — root-mounted, same reasoning as comments. */
export const creatorRouter = express.Router();

creatorRouter.put(
  "/creators/:creatorId/subscribe",
  requireAuth,
  subscribeLimiter,
  requireIdentifiedUser,
  engagementController.subscribeToCreator,
);
creatorRouter.delete(
  "/creators/:creatorId/subscribe",
  requireAuth,
  subscribeLimiter,
  requireIdentifiedUser,
  engagementController.unsubscribeFromCreator,
);

export default router;
