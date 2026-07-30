import express from "express";

import * as playlistsController from "#src/controllers/playlists.controller.js";
import { longFormBody } from "#src/middleware/json-body.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

/**
 * Creator playlist routes (docs/STUDIO_BACKEND_STRUCTURE.md §6).
 *
 * Owner-scoped throughout: `creatorId` is `req.user.id`, never a body field, and a
 * playlist the caller does not own is a 404 rather than a 403 so ids cannot be probed.
 *
 * `/mine` is declared BEFORE `/:playlistId` — Express matches in declaration order, so
 * the literal has to come first or "mine" is captured as a playlist id.
 */

/** POST /playlists */
router.post("/", requireAuth, longFormBody, playlistsController.createPlaylist);

/** GET /playlists/mine — literal before /:playlistId. */
router.get("/mine", requireAuth, playlistsController.getMyPlaylists);

/** GET /playlists/:playlistId — includes the ordered item list for the picker. */
router.get("/:playlistId", requireAuth, playlistsController.getPlaylistById);

/** PATCH /playlists/:playlistId — rename, re-describe, change visibility or ordering. */
router.patch("/:playlistId", requireAuth, longFormBody, playlistsController.updatePlaylist);

/** DELETE /playlists/:playlistId — removes the grouping, never the videos in it. */
router.delete("/:playlistId", requireAuth, playlistsController.deletePlaylist);

/** PUT /playlists/:playlistId/videos — replaces membership AND order. */
router.put(
  "/:playlistId/videos",
  requireAuth,
  longFormBody,
  playlistsController.replacePlaylistVideos,
);

export default router;
