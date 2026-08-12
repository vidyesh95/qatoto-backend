import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import { commerceProductRelationWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceRankingController from "#src/modules/store/catalog/commerce-ranking.controller.js";
import { requireActiveSellerCommerceOrganization } from "#src/modules/store/organizations/require-active-commerce-organization.js";

/**
 * Ranking transparency and appeals (STORE Phase 13, stage 5).
 *
 * TWO ROUTES, and neither exposes the score's inputs. A seller sees its position, whether it
 * is suppressed and why; a moderator lifts or imposes a suppression. The component
 * breakdown, the raw counts and the category statistics stay internal — publishing them
 * would hand anyone with a seller account a specification of exactly what to forge.
 *
 * `moderate_commerce` is checked INSIDE the service rather than in this chain, matching
 * `commerce-catalog.routes.ts`: a capability visible in the route table is one an attacker
 * can probe for.
 */
const router = express.Router();

router.get(
  "/products/:productId/ranking-status",
  requireAuth,
  requireActiveSellerCommerceOrganization,
  commerceRankingController.getProductRankingStatus,
);

router.post(
  "/admin/products/:productId/ranking-enforcement",
  requireAuth,
  commerceProductRelationWriteLimiter,
  compactBody,
  // User-scoped, not organization-scoped: a moderator acts for the platform and may not
  // belong to a commerce organization at all.
  idempotency({ required: true, scope: "user" }),
  commerceRankingController.moderateProductRanking,
);

export default router;
