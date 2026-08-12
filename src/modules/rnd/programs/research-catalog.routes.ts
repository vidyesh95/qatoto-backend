import express from "express";

import * as catalogController from "#src/controllers/discovery-catalog.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { compactBody } from "#src/middleware/json-body.js";
import { categoryCreateLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as rolesController from "#src/modules/rnd/projects/project-roles.controller.js";

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

/**
 * LEGACY ALIASES for the taxonomy. `/discovery/categories` is CANONICAL (§11b); these two
 * paths remain because §11a still lists `GET /research-categories` and the idea wizard
 * ships against it.
 *
 * They are ALIASES, not a second implementation — same controller, same service, same
 * table. `research-categories.controller.ts` was deleted rather than kept as a thin
 * wrapper, because its own scope note said the two "must never be two implementations over
 * one table". Aliasing at the ROUTE layer respects routes → controllers → services;
 * a controller importing another controller would invert it.
 *
 * CRITICALLY, the alias reuses the SAME `categoryCreateLimiter` INSTANCE. A separate
 * `rateLimit({...})` here would give a caller 5 creations per path instead of 5 overall,
 * turning the alias into a rate-limit bypass. `requireIdentifiedUser` is present for the
 * same reason: omitting it on one path would reopen the sybil hole on both.
 *
 * The response shape is shared too, which means this path now returns `displayLabel`
 * instead of `label` and gained `pinIconKey` (§15). That break is deliberate and
 * scheduled — one shape from both paths, never two.
 */
router.get("/research-categories", attachOptionalUser, catalogController.listCategories);

router.post(
  "/research-categories",
  requireAuth,
  categoryCreateLimiter,
  requireIdentifiedUser,
  compactBody,
  catalogController.createCategory,
);

export default router;
