import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import {
  promotionalSlideImageUploadLimiter,
  promotionalSlideWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as promotionsController from "#src/modules/home/promotions/promotions.controller.js";
import { uploadPromotionalSlideImage } from "#src/modules/home/promotions/upload-promotional-slide-image.js";

const router = express.Router();

/**
 * The home-page promotional carousel.
 *
 * ONE PUBLIC ROUTE AND SIX ADMIN ROUTES. The public read is BARE — no `requireAuth`, no
 * `attachOptionalUser`, no limiter:
 *   - No session, because a slide is identical for every visitor and nothing about it
 *     depends on who is asking. `attachOptionalUser` would cost a Better Auth round trip
 *     on the most-hit route on the site to learn something no handler reads.
 *   - No limiter, deliberately. Unauthenticated means `userKey` falls back to IP, and an
 *     IP-keyed limiter on the front page's data source is a self-inflicted outage the
 *     first time real traffic arrives behind a CDN or a corporate NAT. No public read in
 *     this codebase carries one.
 *
 * ROUTE ORDER IS LOAD-BEARING. Express matches in declaration order, so the literal
 * `/admin/slides/reorder` MUST come before `/admin/slides/:slideId` — otherwise "reorder"
 * is captured as a slide id and every reorder 404s.
 *
 * CHAIN ORDER, as everywhere here: auth → limiter → parser/upload → controller.
 *
 * THERE IS NO CAPABILITY MIDDLEWARE IN ANY CHAIN, and that is not an omission. The
 * `manage_promotions` check happens inside the service so it can return a `Result` and
 * take part in the controller's exhaustive error switch (see platform-role.service.ts),
 * and so it can be proven to run BEFORE any id is read.
 */

/** GET /promotions/slides — PUBLIC. Live slides only, already ordered. */
router.get("/slides", promotionsController.listActiveSlides);

/** GET /promotions/admin/slides — every slide, retired and scheduled included. */
router.get(
  "/admin/slides",
  requireAuth,
  promotionalSlideWriteLimiter,
  promotionsController.listSlidesForStaff,
);

/**
 * POST /promotions/admin/slides (multipart/form-data, field `image`) — create.
 * Carries only the upload limiter; see its comment for why not both.
 */
router.post(
  "/admin/slides",
  requireAuth,
  promotionalSlideImageUploadLimiter,
  uploadPromotionalSlideImage,
  promotionsController.createSlide,
);

/** PATCH /promotions/admin/slides/reorder — LITERAL, must precede /:slideId. */
router.patch(
  "/admin/slides/reorder",
  requireAuth,
  promotionalSlideWriteLimiter,
  compactBody,
  promotionsController.reorderSlides,
);

/** PATCH /promotions/admin/slides/:slideId — alt text, destination, schedule, active. */
router.patch(
  "/admin/slides/:slideId",
  requireAuth,
  promotionalSlideWriteLimiter,
  compactBody,
  promotionsController.updateSlide,
);

/** PATCH /promotions/admin/slides/:slideId/image (multipart) — replace in place. */
router.patch(
  "/admin/slides/:slideId/image",
  requireAuth,
  promotionalSlideImageUploadLimiter,
  uploadPromotionalSlideImage,
  promotionsController.replaceSlideImage,
);

/** DELETE /promotions/admin/slides/:slideId — remove the slide and its image. */
router.delete(
  "/admin/slides/:slideId",
  requireAuth,
  promotionalSlideWriteLimiter,
  promotionsController.deleteSlide,
);

export default router;
