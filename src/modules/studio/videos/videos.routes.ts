import express from "express";

import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { longFormBody } from "#src/middleware/json-body.js";
import {
  contentReviewLimiter,
  videoCreateLimiter,
  videoDocumentDeleteLimiter,
  videoDocumentDownloadLimiter,
  videoDocumentUploadLimiter,
  videoThumbnailUploadLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as adminReviewController from "#src/modules/studio/admin-review.controller.js";
import { uploadVideoDocumentFile } from "#src/modules/studio/videos/upload-video-document.js";
import { uploadVideoThumbnail } from "#src/modules/studio/videos/upload-video-thumbnail.js";
import * as videosController from "#src/modules/studio/videos/videos.controller.js";

const router = express.Router();

/**
 * Creator Studio video routes (docs/STUDIO_BACKEND_STRUCTURE.md §6).
 *
 * EVERY ROUTE HERE REQUIRES A SESSION WITH EXACTLY ONE EXCEPTION, and the exception is named
 * because this sentence used to have none: `GET /:videoId/documents/:documentId/file` is
 * `attachOptionalUser`, because a document attached to a PUBLIC video must be downloadable by the
 * public. Its gate is the video's own publicness, decided in the service. Do not "restore
 * consistency" by adding `requireAuth` to it — that would break the promise the studio's own copy
 * makes ("shown as a download under the video") for every signed-out reader.
 *
 * Everywhere else the creator id is ALWAYS `req.user.id` — no route accepts an owner in its body.
 * Ownership is re-checked inside the service on every `/:videoId` operation, and a video the caller
 * does not own is a 404, never a 403, so video ids cannot be probed (§0).
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
router.post("/", requireAuth, videoCreateLimiter, longFormBody, videosController.createVideo);

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
  longFormBody,
  adminReviewController.rejectReview,
);

/** GET /videos/:videoId — full video for the edit/detail flow. Owner only. */
router.get("/:videoId", requireAuth, videosController.getVideoById);

/** PATCH /videos/:videoId — partial metadata update; a changed URL is re-verified. */
router.patch("/:videoId", requireAuth, longFormBody, videosController.updateVideo);

/** POST /videos/:videoId/thumbnail — multipart `image`, replaces the oEmbed thumbnail. */
router.post(
  "/:videoId/thumbnail",
  requireAuth,
  videoThumbnailUploadLimiter,
  uploadVideoThumbnail,
  videosController.uploadThumbnail,
);

/**
 * POST /videos/:videoId/documents — multipart `document`, PDF, 25 MB (§11j).
 *
 * NO JSON BODY PARSER in this chain, exactly like the thumbnail route above and the research-paper
 * route it copies: `uploadVideoDocumentFile` IS the parser, and a JSON parser ahead of it would
 * consume the stream.
 *
 * NO `idempotency()` MIDDLEWARE, deliberately. The object key is content-addressed and
 * `video_document_content_uidx` is unique on `(video_id, content_sha256)`, so a retried upload
 * converges on the same object and the same row — stronger than a replayed response, and the same
 * argument `research-programs.routes.ts` makes for `POST …/papers/:paperId/file`.
 */
router.post(
  "/:videoId/documents",
  requireAuth,
  videoDocumentUploadLimiter,
  uploadVideoDocumentFile,
  videosController.attachDocument,
);

/** DELETE /videos/:videoId/documents/:documentId — owner only; removes the object, then the row. */
router.delete(
  "/:videoId/documents/:documentId",
  requireAuth,
  videoDocumentDeleteLimiter,
  videosController.detachDocument,
);

/**
 * GET /videos/:videoId/documents/:documentId/file — 302 to a short-lived presigned URL.
 *
 * ⚠️ THE ONE ROUTE ON THIS ROUTER WITHOUT `requireAuth`. See the header. Four segments deep, so it
 * shadows nothing and nothing shadows it.
 */
router.get(
  "/:videoId/documents/:documentId/file",
  attachOptionalUser,
  videoDocumentDownloadLimiter,
  videosController.downloadDocument,
);

/** PUT /videos/:videoId/chapters — replaces the whole chapter set. */
router.put("/:videoId/chapters", requireAuth, longFormBody, videosController.replaceChapters);

/** PUT /videos/:videoId/products — replaces the shoppable set; ownership re-verified. */
router.put(
  "/:videoId/products",
  requireAuth,
  longFormBody,
  videosController.replaceAttachedProducts,
);

/** PUT /videos/:videoId/playlists — sets which of the caller's playlists hold this video. */
router.put(
  "/:videoId/playlists",
  requireAuth,
  longFormBody,
  videosController.replaceVideoPlaylists,
);

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
