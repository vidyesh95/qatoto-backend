import express from "express";

import { longFormBody } from "#src/middleware/json-body.js";
import { playlistMutationLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as playlistsController from "#src/modules/studio/playlists/playlists.controller.js";

const router = express.Router();

/**
 * Playlist routes (docs/STUDIO_BACKEND_STRUCTURE.md §6).
 *
 * THE PLAYLIST IS OWNER-SCOPED; ITS CONTENTS ARE NOT, and that split is recent. `creatorId`
 * is still `req.user.id` and never a body field, and a playlist the caller does not own is
 * still a 404 rather than a 403 so ids cannot be probed. What changed is that the VIDEOS in
 * it may be anyone's, so long as they are publicly servable — see the service header.
 *
 * `/mine` is declared BEFORE `/:playlistId` — Express matches in declaration order, so
 * the literal has to come first or "mine" is captured as a playlist id.
 *
 * NO `requireIdentifiedUser` ANYWHERE HERE, unchanged and deliberate. A playlist is the
 * caller's own collection: it moves no public counter, and an anonymous session filling one
 * affects nobody else's screen. The two new single-video routes keep that.
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

/**
 * PUT · DELETE /playlists/:playlistId/videos/:videoId — ONE video, the card menu's verb.
 *
 * Declared after the collection route above; the extra segment is what distinguishes them,
 * so order is not load-bearing between these two. Both ids are in the path, so neither
 * reads a body — hence no `longFormBody` (a cap on a bodyless route fails
 * `json-body-budget.test.ts`) and no idempotency key, `playlist_item_unq` being what makes
 * both verbs idempotent.
 *
 * THE ONLY LIMITED ROUTES ON THIS ROUTER, and that is a start rather than an inconsistency:
 * `rate-limit-coverage.test.ts` keeps a `ROUTES_WITHOUT_A_LIMITER` snapshot and says of it
 * "the right direction for this list is DOWN". These two are reachable from every card in
 * the feed rather than from one studio screen, so they are the pair that most needed it.
 */
router.put(
  "/:playlistId/videos/:videoId",
  requireAuth,
  playlistMutationLimiter,
  playlistsController.addVideoToPlaylist,
);
router.delete(
  "/:playlistId/videos/:videoId",
  requireAuth,
  playlistMutationLimiter,
  playlistsController.removeVideoFromPlaylist,
);

export default router;
