import express from "express";

import * as seriesController from "#src/controllers/series.controller.js";
import { requireAuth } from "#src/middleware/require-auth.js";

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
router.post("/", requireAuth, seriesController.createSeries);

/** GET /series/mine — literal before /:seriesId. */
router.get("/mine", requireAuth, seriesController.getMySeries);

/** GET /series/:seriesId — the whole tree: seasons with their episodes. */
router.get("/:seriesId", requireAuth, seriesController.getSeriesById);

/** PATCH /series/:seriesId */
router.patch("/:seriesId", requireAuth, seriesController.updateSeries);

/** DELETE /series/:seriesId — cascades to seasons and episodes; videos survive. */
router.delete("/:seriesId", requireAuth, seriesController.deleteSeries);

/** POST /series/:seriesId/seasons */
router.post("/:seriesId/seasons", requireAuth, seriesController.createSeason);

/** PATCH /series/:seriesId/seasons/:seasonId */
router.patch("/:seriesId/seasons/:seasonId", requireAuth, seriesController.updateSeason);

/** DELETE /series/:seriesId/seasons/:seasonId */
router.delete("/:seriesId/seasons/:seasonId", requireAuth, seriesController.deleteSeason);

/** POST /series/:seriesId/seasons/:seasonId/episodes */
router.post("/:seriesId/seasons/:seasonId/episodes", requireAuth, seriesController.createEpisode);

/** PATCH /series/:seriesId/seasons/:seasonId/episodes/:episodeId */
router.patch(
  "/:seriesId/seasons/:seasonId/episodes/:episodeId",
  requireAuth,
  seriesController.updateEpisode,
);

/** DELETE /series/:seriesId/seasons/:seasonId/episodes/:episodeId */
router.delete(
  "/:seriesId/seasons/:seasonId/episodes/:episodeId",
  requireAuth,
  seriesController.deleteEpisode,
);

export default router;
