import express from "express";

import * as platformRolesController from "#src/controllers/platform-roles.controller.js";
import { compactBody } from "#src/middleware/json-body.js";
import { platformRoleWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

/**
 * Staff role administration (R_AND_D_BACKEND_STRUCTURE.md §4a Layer 3).
 *
 * THESE ROUTES REVERSE THE RULE THE COLUMN COMMENT STATES — that grants are a DBA action
 * and unreachable over HTTP. That rule existed because a self-grantable staff role would
 * defeat category moderation (§6) and the four-eyes escrow rule (§7) at once, so the
 * reversal is bounded rather than open: `manage_platform_roles` is held by `admin` ALONE,
 * nobody may change their own role, lookup is one exact email with no listing, and every
 * write lands on the append-only chain in the same transaction.
 *
 * `scripts/grant-platform-role.ts` REMAINS, and is still the only way to make the first
 * admin — everything here needs an admin to already exist.
 *
 * ROUTE ORDER: `/lookup` is a literal under `/admin/platform-roles`. If a
 * `/admin/platform-roles/:userId` is ever added it goes BELOW it, or `/lookup` resolves as
 * "the user whose id is lookup" and answers a plausible 404.
 *
 * NO CAPABILITY MIDDLEWARE, by the same reasoning as every other staff route: middleware
 * cannot return a `Result`, so it could not take part in the exhaustive switch that maps
 * domain errors to statuses. The check runs first inside the service instead.
 */

/** The caller's own standing. No capability — it reports on nobody else. */
router.get("/admin/whoami", requireAuth, platformRolesController.getOwnStaffContext);

router.get(
  "/admin/platform-roles/lookup",
  requireAuth,
  platformRolesController.lookupUserForRoleGrant,
);

router.put(
  "/admin/platform-roles",
  requireAuth,
  platformRoleWriteLimiter,
  compactBody,
  platformRolesController.setPlatformRole,
);

export default router;
