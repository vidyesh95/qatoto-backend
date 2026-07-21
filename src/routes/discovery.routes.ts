import express from "express";

import * as catalogController from "#src/controllers/discovery-catalog.controller.js";
import * as moderationController from "#src/controllers/discovery-moderation.controller.js";
import * as clustersController from "#src/controllers/problem-clusters.controller.js";
import * as talentController from "#src/controllers/talent-profiles.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { parseCompactJsonBody } from "#src/middleware/json-body.js";
import {
  categoryCreateLimiter,
  discoveryModerationLimiter,
  problemReportLimiter,
  talentProfileWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * Discovery — problem clusters, taxonomy, knowledge hub, talent directory
 * (R_AND_D_BACKEND_STRUCTURE.md §11b).
 *
 * CHAIN ORDER, everywhere: auth → limiter → requireIdentifiedUser → parser → controller.
 * The limiter precedes `requireIdentifiedUser` so an unidentified caller cannot hammer
 * that guard's extra query, and both follow `requireAuth` because every limiter keys on
 * `req.user.id`.
 *
 * ROUTE ORDER: literal segments before `/:param`, always — `/problem-reports/mine` before
 * anything parameterised, `/talent/me` and its sub-paths before `/talent`. Same rule as
 * the users router's `/me` and the products router's `/mine`.
 *
 * READ AUTH: public reads use `attachOptionalUser`; `/talent` alone uses `requireAuth`,
 * because it is the ONLY §6 read that returns other people's personal data (name, avatar,
 * location, availability). A civic aggregate is not a roster of people.
 *
 * BODY SIZE: `app.ts` mounts `parseLongFormJsonBody` on `/discovery` ABOVE the global
 * 10 kb `express.json()`. That is load-bearing, not tidiness — a 5,000-character
 * description in Devanagari or CJK exceeds 10 kb in BYTES while passing a
 * `z.string().max()` that counts UTF-16 units, so without it the endpoint would reject
 * non-English reporters and only them.
 */
const router = express.Router();

// --- Problem clusters. Public read surface.
router.get("/problem-clusters", attachOptionalUser, clustersController.listProblemClusters);
router.get("/problem-clusters/:clusterId", attachOptionalUser, clustersController.getProblemCluster);

// --- Problem reports. `/mine` is a literal and is declared FIRST.
router.get("/problem-reports/mine", requireAuth, clustersController.listMyProblemReports);
router.post(
  "/problem-reports",
  requireAuth,
  problemReportLimiter,
  // The sybil guard. `requireAuth` proves a session exists; the `anonymous()` plugin makes
  // that nearly free, and distinctReporterCount is the entire integrity of the score.
  requireIdentifiedUser,
  clustersController.createProblemReport,
);

// --- Taxonomy. CANONICAL; `/research-categories` aliases these same handlers.
router.get("/categories", attachOptionalUser, catalogController.listCategories);
router.post(
  "/categories",
  requireAuth,
  categoryCreateLimiter,
  requireIdentifiedUser,
  parseCompactJsonBody,
  catalogController.createCategory,
);

// --- Knowledge hub.
router.get("/regions", attachOptionalUser, catalogController.listRegions);
router.get("/skills", attachOptionalUser, catalogController.listSkills);
router.get("/market-insights", attachOptionalUser, catalogController.listMarketInsights);
router.get("/demand-signals", attachOptionalUser, catalogController.listDemandSignals);

// --- Talent. `/talent/me` and its sub-paths are literals; all declared before `/talent`.
router.get("/talent/me", requireAuth, talentController.getMyTalentProfile);
router.put(
  "/talent/me",
  requireAuth,
  talentProfileWriteLimiter,
  requireIdentifiedUser,
  talentController.putMyTalentProfile,
);
router.delete(
  "/talent/me",
  requireAuth,
  talentProfileWriteLimiter,
  // No requireIdentifiedUser: that guard exists to make CREATING exposure expensive.
  // Gating removal behind it would trap someone in a directory they want out of.
  talentController.deleteMyTalentProfile,
);
router.post(
  "/talent/me/publish",
  requireAuth,
  talentProfileWriteLimiter,
  // Publishing CREATES exposure, so it is guarded; unpublish and delete only remove it.
  requireIdentifiedUser,
  talentController.publishMyTalentProfile,
);
router.post(
  "/talent/me/unpublish",
  requireAuth,
  talentProfileWriteLimiter,
  talentController.unpublishMyTalentProfile,
);
router.get("/talent", requireAuth, talentController.listTalent);

// --- Platform moderation. The capability check is IN-SERVICE, not middleware (§4a Layer 3)
//     — and it runs BEFORE any id is read, so these routes are not id oracles.
router.get(
  "/admin/merge-proposals",
  requireAuth,
  discoveryModerationLimiter,
  moderationController.listMergeProposals,
);
router.post(
  "/admin/categories/:categoryId/decide",
  requireAuth,
  discoveryModerationLimiter,
  parseCompactJsonBody,
  moderationController.decideCategory,
);
router.post(
  "/admin/merge-proposals/:proposalId/decide",
  requireAuth,
  discoveryModerationLimiter,
  parseCompactJsonBody,
  moderationController.decideMergeProposal,
);

export default router;
