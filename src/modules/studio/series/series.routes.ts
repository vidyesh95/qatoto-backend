import express from "express";

import { longFormBody } from "#src/middleware/json-body.js";
import { seriesPosterUploadLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as seriesController from "#src/modules/studio/series/series.controller.js";
import { uploadSeriesPoster } from "#src/modules/studio/series/upload-series-poster.js";

const router = express.Router();

/**
 * Anime catalog routes (docs/STUDIO_BACKEND_STRUCTURE.md §6).
 *
 * Episodes are normally created through the UPLOAD flow; these exist for catalog
 * management at /studio/series. §6 also omits season and episode update/delete entirely,
 * which would leave that editor unable to rename a season or fix an episode number — so
 * they are here.
 *
 * SEASONS AND EPISODES ARE NESTED, not root-mounted. §6 sketches
 * `POST /seasons/:id/episodes`, but a router mounted at /series serves that as
 * /series/seasons/:id/episodes, so the documented path would 404. Nesting also puts the
 * ownership chain (episode → season → series.ownerId) in the URL, which is exactly what
 * the service proves in one join instead of trusting a bare season id.
 *
 * `/mine` is declared before `/:seriesId` — Express matches in declaration order.
 */

/** POST /series */
router.post("/", requireAuth, longFormBody, seriesController.createSeries);

/** GET /series/mine — literal before /:seriesId. */
router.get("/mine", requireAuth, seriesController.getMySeries);

/** GET /series/:seriesId — the whole tree: seasons with their episodes. */
router.get("/:seriesId", requireAuth, seriesController.getSeriesById);

/** PATCH /series/:seriesId */
router.patch("/:seriesId", requireAuth, longFormBody, seriesController.updateSeries);

/** DELETE /series/:seriesId — cascades to seasons and episodes; videos survive. */
router.delete("/:seriesId", requireAuth, seriesController.deleteSeries);

/**
 * POST /series/:seriesId/poster — multipart `image`, replaces the poster.
 * DELETE /series/:seriesId/poster — takes it down.
 *
 * DECLARED BEFORE THE NESTED SEASON ROUTES for readability only, not for correctness — the
 * literal `poster` segment cannot collide with `:seasonId`, because those paths are one
 * segment deeper. The pair ships together: an asset a creator can put on a public catalogue
 * page and cannot remove is the wrong half of a feature to ship alone, and `PATCH` cannot
 * clear the column (`posterUrl` is `HttpUrlSchema`, so there is no null to send).
 *
 * The multer middleware runs INSIDE the route so the global express.json() never sees a
 * multipart body — the same arrangement as POST /videos/:videoId/thumbnail.
 *
 * BOTH CARRY `seriesPosterUploadLimiter`. `rate-limit-coverage.test.ts` catches a mutating
 * route that has neither a limiter nor an entry on its known-debt list, and it caught these
 * two — correctly, because each is a Cloudinary round-trip behind a 5 MB decode.
 */
router.post(
  "/:seriesId/poster",
  requireAuth,
  seriesPosterUploadLimiter,
  uploadSeriesPoster,
  seriesController.uploadPoster,
);
router.delete(
  "/:seriesId/poster",
  requireAuth,
  seriesPosterUploadLimiter,
  seriesController.deletePoster,
);

/** POST /series/:seriesId/seasons */
router.post("/:seriesId/seasons", requireAuth, longFormBody, seriesController.createSeason);

/** PATCH /series/:seriesId/seasons/:seasonId */
router.patch(
  "/:seriesId/seasons/:seasonId",
  requireAuth,
  longFormBody,
  seriesController.updateSeason,
);

/** DELETE /series/:seriesId/seasons/:seasonId */
router.delete("/:seriesId/seasons/:seasonId", requireAuth, seriesController.deleteSeason);

/** POST /series/:seriesId/seasons/:seasonId/episodes */
router.post(
  "/:seriesId/seasons/:seasonId/episodes",
  requireAuth,
  longFormBody,
  seriesController.createEpisode,
);

/** PATCH /series/:seriesId/seasons/:seasonId/episodes/:episodeId */
router.patch(
  "/:seriesId/seasons/:seasonId/episodes/:episodeId",
  requireAuth,
  longFormBody,
  seriesController.updateEpisode,
);

/** DELETE /series/:seriesId/seasons/:seasonId/episodes/:episodeId */
router.delete(
  "/:seriesId/seasons/:seasonId/episodes/:episodeId",
  requireAuth,
  seriesController.deleteEpisode,
);

export default router;
