import express from "express";

import * as spotlightController from "#src/controllers/spotlight.controller.js";
import { compactBody } from "#src/middleware/json-body.js";
import { spotlightWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

/**
 * The home-page Spotlight rail.
 *
 * ONE PUBLIC ROUTE AND TWO ADMIN ROUTES. The public read is BARE — no requireAuth, no
 * attachOptionalUser, no limiter — for the same reasons as GET /promotions/slides: the
 * payload is identical for every visitor, and an IP-keyed limiter on a front-page data
 * source is a self-inflicted outage behind a CDN or corporate NAT.
 *
 * Capability (`manage_promotions`) is checked inside the service, not as middleware.
 */

/** GET /spotlight/videos — PUBLIC. Eligible slots only, already ordered. */
router.get("/videos", spotlightController.listActiveSpotlightVideos);

/** GET /spotlight/admin/slots — every stored slot. */
router.get(
  "/admin/slots",
  requireAuth,
  spotlightWriteLimiter,
  spotlightController.listSpotlightSlotsForStaff,
);

/** PUT /spotlight/admin/slots — replace the whole ordered set. */
router.put(
  "/admin/slots",
  requireAuth,
  spotlightWriteLimiter,
  compactBody,
  spotlightController.replaceSpotlightSlots,
);

export default router;
