import express from "express";

import * as adminReviewController from "#src/controllers/admin-review.controller.js";
import * as videosController from "#src/controllers/videos.controller.js";
import {
  contentReviewLimiter,
  videoCreateLimiter,
  videoThumbnailUploadLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { uploadVideoThumbnail } from "#src/middleware/upload-video-thumbnail.js";

const router = express.Router();

/**
 * Creator Studio video routes (docs/STUDIO_BACKEND_STRUCTURE.md §6).
 *
 * EVERY route requires a session, and the creator id is ALWAYS `req.user.id` — no route
 * accepts an owner in its body. Ownership is re-checked inside the service on every
 * `/:videoId` operation, and a video the caller does not own is a 404, never a 403, so
 * video ids cannot be probed (§0).
 *
 * ROUTE ORDER IS LOAD-BEARING. Express matches in declaration order, so the literal
 * segments `/mine` and `/admin/...` MUST come before `/:videoId` — otherwise "mine" and
 * "admin" are captured as video ids and the review queue 404s for everyone.
 *
 * CHAIN ORDER, as everywhere in this codebase: auth → limiter → parser/upload →
 * controller. The body parser is mounted per-prefix in app.ts, not here.
 *
 * THE STAFF ROUTES LIVE ON THIS ROUTER, not a top-level /admin one, matching
 * /discovery/admin/* (discovery.routes.ts). A root /admin would claim a global namespace
 * for one domain's review queue. There is NO requireRole middleware in the chain: the
 * capability check happens inside the service so it can return a Result and take part in
 * the controller's exhaustive error switch (see platform-role.service.ts).
 */

/** POST /videos — parse the YouTube URL, verify it via oEmbed, create the row. */
router.post("/", requireAuth, videoCreateLimiter, videosController.createVideo);

/** GET /videos/mine — the caller's own videos, paginated. Literal before /:videoId. */
router.get("/mine", requireAuth, videosController.getMyVideos);

/**
 * GET /videos/admin/review — the anime moderation queue. Literal before /:videoId.
 * 403 when the caller lacks the `moderate_content` capability, decided BEFORE any id is
 * read so the route cannot be used as an id oracle.
 */
router.get(
  "/admin/review",
  requireAuth,
  contentReviewLimiter,
  adminReviewController.listReviewQueue,
);

/** POST /videos/admin/review/:videoId/approve — approve and publish into /anime. */
router.post(
  "/admin/review/:videoId/approve",
  requireAuth,
  contentReviewLimiter,
  adminReviewController.approveReview,
);

/** POST /videos/admin/review/:videoId/reject — reject with a reason. */
router.post(
  "/admin/review/:videoId/reject",
  requireAuth,
  contentReviewLimiter,
  adminReviewController.rejectReview,
);

/** GET /videos/:videoId — full video for the edit/detail flow. Owner only. */
router.get("/:videoId", requireAuth, videosController.getVideoById);

/** PATCH /videos/:videoId — partial metadata update; a changed URL is re-verified. */
router.patch("/:videoId", requireAuth, videosController.updateVideo);

/** POST /videos/:videoId/thumbnail — multipart `image`, replaces the oEmbed thumbnail. */
router.post(
  "/:videoId/thumbnail",
  requireAuth,
  videoThumbnailUploadLimiter,
  uploadVideoThumbnail,
  videosController.uploadThumbnail,
);

/** PUT /videos/:videoId/chapters — replaces the whole chapter set. */
router.put("/:videoId/chapters", requireAuth, videosController.replaceChapters);

/** PUT /videos/:videoId/products — replaces the shoppable set; ownership re-verified. */
router.put("/:videoId/products", requireAuth, videosController.replaceAttachedProducts);

/** PUT /videos/:videoId/playlists — sets which of the caller's playlists hold this video. */
router.put("/:videoId/playlists", requireAuth, videosController.replaceVideoPlaylists);

/** POST /videos/:videoId/publish — an anime episode goes to review, not live. */
router.post("/:videoId/publish", requireAuth, videosController.publishVideo);

/** POST /videos/:videoId/unpublish — back to draft. */
router.post("/:videoId/unpublish", requireAuth, videosController.unpublishVideo);

/**
 * GET /videos/:videoId/playback-token — DEFERRED (Appendix A); always 409 for an owner.
 * Mounted so the client contract does not move when self-hosted video lands.
 */
router.get("/:videoId/playback-token", requireAuth, videosController.getPlaybackToken);

/** DELETE /videos/:videoId — removes the row and any custom thumbnail we own. */
router.delete("/:videoId", requireAuth, videosController.deleteVideo);

export default router;
