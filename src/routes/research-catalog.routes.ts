import express from "express";

import * as rolesController from "#src/controllers/project-roles.controller.js";
import * as categoriesController from "#src/controllers/research-categories.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { parseCompactJsonBody } from "#src/middleware/json-body.js";
import { categoryCreateLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

const router = express.Router();

/**
 * CROSS-PROJECT R&D resources.
 *
 * These are not project-scoped, so they deliberately do NOT nest under
 * `/research-projects/` — mounted at `/` in app.ts, exactly as §11 mounts the funding
 * router at `/` for `/funding-rounds`, `/pledges` and `/milestones`.
 */

/** GET /open-roles — the cross-project rail behind the landing page and /talent. */
router.get("/open-roles", attachOptionalUser, rolesController.listOpenRolesAcrossProjects);

/** GET /research-categories — approved facets only by default. */
router.get("/research-categories", attachOptionalUser, categoriesController.listCategories);

/**
 * POST /research-categories — the wizard's step 1 "create a new category".
 * Lands `pending`; `requireIdentifiedUser` because the taxonomy is a uniqueness quota
 * and a spam surface (§4a).
 */
router.post(
  "/research-categories",
  requireAuth,
  categoryCreateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  categoriesController.createCategory,
);

export default router;
