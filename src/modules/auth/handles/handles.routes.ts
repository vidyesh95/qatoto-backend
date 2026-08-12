import express from "express";

import { handleAvailabilityLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as handleController from "#src/modules/auth/handles/handle.controller.js";

const router = express.Router();

/**
 * GET /handles/availability?handle=<raw>
 * Tier-1 live availability check (debounced from the client). Auth required so
 * the result can distinguish the caller's own current/revertable handle from a
 * stranger's taken one; rate-limited per user because typing fires many calls.
 */
router.get(
  "/availability",
  requireAuth,
  handleAvailabilityLimiter,
  handleController.getHandleAvailability,
);

export default router;
