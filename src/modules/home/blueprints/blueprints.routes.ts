import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import { blueprintHeroImageUploadLimiter, blueprintHeroWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as blueprintHeroController from "#src/modules/home/blueprints/blueprint-hero.controller.js";
import { uploadBlueprintHeroSlideImageFile } from "#src/modules/home/blueprints/upload-blueprint-hero-image.js";

const router = express.Router();

/**
 * The public `/blueprints` surface: the hero carousel at the top of the Blueprints hub.
 *
 * ONE PUBLIC ROUTE AND SIX ADMIN ROUTES. The public read is BARE — no requireAuth, no
 * attachOptionalUser, no limiter — for the same reasons as GET /promotions/slides: the
 * payload is identical for every visitor, and an IP-keyed limiter on a page's opening
 * element is a self-inflicted outage behind a CDN or corporate NAT.
 *
 * THIS MODULE WAS `/anime`. The hero carousel is all that survived the vertical's retirement:
 * the two public series reads (`/series`, `/series/:seriesSlug`) went with it, and with them
 * the second route-order hazard this comment used to describe.
 *
 * ROUTE ORDER IS STILL LOAD-BEARING ONCE: `/admin/hero-slides/reorder` is a literal and must
 * precede `/admin/hero-slides/:slideId`, or "reorder" is captured as a slide id and that
 * handler never runs.
 *
 * Capability (`manage_promotions`) is checked INSIDE the service, not as middleware:
 * middleware cannot return a `Result` and so cannot join the controller's exhaustive error
 * switch, and the check has to run before any id is read or the route becomes an id oracle.
 *
 * Chain order on every admin route is auth -> limiter -> parser/upload -> controller. A
 * multipart route carries ONLY the upload limiter, never both: stacking two limiters on one
 * route double-counts every request against the stricter of them.
 */

/** GET /blueprints/hero-slides — PUBLIC. Live slides only, already ordered. */
router.get("/hero-slides", blueprintHeroController.listActiveHeroSlides);

/** GET /blueprints/admin/hero-slides — every stored slide. */
router.get(
  "/admin/hero-slides",
  requireAuth,
  blueprintHeroWriteLimiter,
  blueprintHeroController.listHeroSlidesForStaff,
);

/** POST /blueprints/admin/hero-slides — multipart create, image and metadata together. */
router.post(
  "/admin/hero-slides",
  requireAuth,
  blueprintHeroImageUploadLimiter,
  uploadBlueprintHeroSlideImageFile,
  blueprintHeroController.createHeroSlide,
);

/** PATCH /blueprints/admin/hero-slides/reorder — LITERAL, must stay above /:slideId. */
router.patch(
  "/admin/hero-slides/reorder",
  requireAuth,
  blueprintHeroWriteLimiter,
  compactBody,
  blueprintHeroController.reorderHeroSlides,
);

/** PATCH /blueprints/admin/hero-slides/:slideId — metadata only. */
router.patch(
  "/admin/hero-slides/:slideId",
  requireAuth,
  blueprintHeroWriteLimiter,
  compactBody,
  blueprintHeroController.updateHeroSlide,
);

/** PATCH /blueprints/admin/hero-slides/:slideId/image — multipart, replace in place. */
router.patch(
  "/admin/hero-slides/:slideId/image",
  requireAuth,
  blueprintHeroImageUploadLimiter,
  uploadBlueprintHeroSlideImageFile,
  blueprintHeroController.replaceHeroSlideImage,
);

/** DELETE /blueprints/admin/hero-slides/:slideId — remove the slide and its image. */
router.delete(
  "/admin/hero-slides/:slideId",
  requireAuth,
  blueprintHeroWriteLimiter,
  blueprintHeroController.deleteHeroSlide,
);

export default router;
