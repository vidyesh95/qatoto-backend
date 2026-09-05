import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import { animeHeroImageUploadLimiter, animeHeroWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as animeHeroController from "#src/modules/home/anime/anime-hero.controller.js";
import * as animeSeriesController from "#src/modules/home/anime/anime-series.controller.js";
import { uploadAnimeHeroSlideImageFile } from "#src/modules/home/anime/upload-anime-hero-image.js";

const router = express.Router();

/**
 * The public `/anime` surface: the hero carousel, and the anime catalogue a stranger can
 * browse.
 *
 * THREE PUBLIC ROUTES AND SIX ADMIN ROUTES. The public reads are BARE — no requireAuth, no
 * attachOptionalUser, no limiter — for the same reasons as GET /promotions/slides: the
 * payload is identical for every visitor, and an IP-keyed limiter on a page's opening
 * element is a self-inflicted outage behind a CDN or corporate NAT.
 *
 * ROUTE ORDER IS LOAD-BEARING TWICE OVER:
 *   - `/admin/hero-slides/reorder` is a literal and must precede `/admin/hero-slides/:slideId`,
 *     or "reorder" is captured as a slide id and that handler never runs.
 *   - `/series` must precede `/series/:seriesSlug` for the same reason — Express matches in
 *     declaration order, and the list route would otherwise be unreachable.
 *
 * Capability (`manage_promotions`) is checked INSIDE the service, not as middleware:
 * middleware cannot return a `Result` and so cannot join the controller's exhaustive error
 * switch, and the check has to run before any id is read or the route becomes an id oracle.
 *
 * Chain order on every admin route is auth -> limiter -> parser/upload -> controller. A
 * multipart route carries ONLY the upload limiter, never both: stacking two limiters on one
 * route double-counts every request against the stricter of them.
 */

/** GET /anime/hero-slides — PUBLIC. Live slides only, already ordered. */
router.get("/hero-slides", animeHeroController.listActiveHeroSlides);

/** GET /anime/series — PUBLIC. Series with at least one watchable episode. */
router.get("/series", animeSeriesController.listPublicSeries);

/** GET /anime/series/:seriesSlug — PUBLIC. The detail tree, or 404. */
router.get("/series/:seriesSlug", animeSeriesController.getPublicSeries);

/** GET /anime/admin/hero-slides — every stored slide. */
router.get(
  "/admin/hero-slides",
  requireAuth,
  animeHeroWriteLimiter,
  animeHeroController.listHeroSlidesForStaff,
);

/** POST /anime/admin/hero-slides — multipart create, image and metadata together. */
router.post(
  "/admin/hero-slides",
  requireAuth,
  animeHeroImageUploadLimiter,
  uploadAnimeHeroSlideImageFile,
  animeHeroController.createHeroSlide,
);

/** PATCH /anime/admin/hero-slides/reorder — LITERAL, must stay above /:slideId. */
router.patch(
  "/admin/hero-slides/reorder",
  requireAuth,
  animeHeroWriteLimiter,
  compactBody,
  animeHeroController.reorderHeroSlides,
);

/** PATCH /anime/admin/hero-slides/:slideId — metadata only. */
router.patch(
  "/admin/hero-slides/:slideId",
  requireAuth,
  animeHeroWriteLimiter,
  compactBody,
  animeHeroController.updateHeroSlide,
);

/** PATCH /anime/admin/hero-slides/:slideId/image — multipart, replace in place. */
router.patch(
  "/admin/hero-slides/:slideId/image",
  requireAuth,
  animeHeroImageUploadLimiter,
  uploadAnimeHeroSlideImageFile,
  animeHeroController.replaceHeroSlideImage,
);

/** DELETE /anime/admin/hero-slides/:slideId — remove the slide and its image. */
router.delete(
  "/admin/hero-slides/:slideId",
  requireAuth,
  animeHeroWriteLimiter,
  animeHeroController.deleteHeroSlide,
);

export default router;
