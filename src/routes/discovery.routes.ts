import express from "express";

import * as catalogController from "#src/controllers/discovery-catalog.controller.js";
import * as moderationController from "#src/controllers/discovery-moderation.controller.js";
import * as vocabularyController from "#src/controllers/discovery-vocabulary.controller.js";
import * as marketInsightsController from "#src/controllers/market-insights.controller.js";
import * as clustersController from "#src/controllers/problem-clusters.controller.js";
import * as talentController from "#src/controllers/talent-profiles.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
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
 * BODY SIZE: `app.ts` mounts `longFormBody` on `/discovery` ABOVE the global
 * 10 kb `express.json()`. That is load-bearing, not tidiness — a 5,000-character
 * description in Devanagari or CJK exceeds 10 kb in BYTES while passing a
 * `z.string().max()` that counts UTF-16 units, so without it the endpoint would reject
 * non-English reporters and only them.
 */
const router = express.Router();

// --- Problem clusters. Public read surface.
router.get("/problem-clusters", attachOptionalUser, clustersController.listProblemClusters);
router.get(
  "/problem-clusters/:clusterId",
  attachOptionalUser,
  clustersController.getProblemCluster,
);

/**
 * The cluster↔project links (§11j.1, §11j.4) — the second write-path dead end.
 *
 * `requireIdentifiedUser` IS applied here, unlike the `/admin/*` routes above: this write is
 * reachable by a non-staff founder, and the link feeds `linkedProjectCount` in the
 * opportunity score — a ranking-signal input, which is that guard's stated trigger.
 *
 * The FOUNDER of the project, or a moderator. Every refusal is a 404; see the service for
 * why a 403 cannot be correct on a route whose authorization depends on reading a project id.
 */
router.post(
  "/problem-clusters/:clusterId/project-links",
  requireAuth,
  discoveryModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  clustersController.linkProjectToCluster,
);

router.delete(
  "/problem-clusters/:clusterId/project-links/:projectId",
  requireAuth,
  discoveryModerationLimiter,
  requireIdentifiedUser,
  clustersController.unlinkProjectFromCluster,
);

// --- Problem reports. `/mine` is a literal and is declared FIRST.
router.get("/problem-reports/mine", requireAuth, clustersController.listMyProblemReports);
router.post(
  "/problem-reports",
  requireAuth,
  problemReportLimiter,
  // The sybil guard. `requireAuth` proves a session exists; the `anonymous()` plugin makes
  // that nearly free, and distinctReporterCount is the entire integrity of the score.
  requireIdentifiedUser,
  longFormBody,
  clustersController.createProblemReport,
);

/**
 * GET /discovery/problem-reports/:submissionId — the caller's own report (§11j.2).
 *
 * MUST stay below `/problem-reports/mine`, which is a literal in the same param position.
 * Declared above it, the shipped list would resolve as a submission whose id is "mine".
 */
router.get("/problem-reports/:submissionId", requireAuth, clustersController.getMyProblemReport);

// --- Taxonomy. CANONICAL; `/research-categories` aliases these same handlers.
router.get("/categories", attachOptionalUser, catalogController.listCategories);
router.post(
  "/categories",
  requireAuth,
  categoryCreateLimiter,
  requireIdentifiedUser,
  compactBody,
  catalogController.createCategory,
);

// --- Knowledge hub.
router.get("/regions", attachOptionalUser, catalogController.listRegions);
router.get("/skills", attachOptionalUser, catalogController.listSkills);
router.get("/market-insights", attachOptionalUser, catalogController.listMarketInsights);
// The detail behind §11k.2's demand-evidence chips. Two segments, so it collides with
// neither the list above nor the `/admin/market-insights` subtree below — but a literal
// `/market-insights/<something>` added later MUST be declared above this line.
router.get("/market-insights/:insightId", attachOptionalUser, catalogController.getMarketInsight);
router.get("/demand-signals", attachOptionalUser, catalogController.listDemandSignals);

// --- Talent. `/talent/me` and its sub-paths are literals; all declared before `/talent`.
router.get("/talent/me", requireAuth, talentController.getMyTalentProfile);
router.put(
  "/talent/me",
  requireAuth,
  talentProfileWriteLimiter,
  requireIdentifiedUser,
  compactBody,
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

/**
 * GET /discovery/talent/:talentUserIdOrHandle — the detail read behind a `/talent` card.
 *
 * DECLARED LAST IN THIS BLOCK, AND THAT IS NOT COSMETIC. Every `/talent/me` path above is a
 * literal in the same param position. Move this line above any of them and
 * `GET /discovery/talent/me` stops resolving to the caller's own profile and starts
 * resolving as "the user whose handle is `me`" — a silent, permanent break of a shipped
 * route that no type or test outside this file would catch.
 */
router.get("/talent/:talentUserIdOrHandle", requireAuth, talentController.getTalentProfile);

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
  compactBody,
  moderationController.decideCategory,
);
/**
 * Market-insight AUTHORING (§11j.4) — what makes `market_insight` writable at all.
 *
 * Until these existed the table had two readers and no writer anywhere in the repo, so
 * `/knowledge-hub` and the landing rail rendered empty on every environment, forever.
 *
 * `/publish` and `/unpublish` are LITERALS and are declared before the bare `/:insightId`
 * verbs. They exist as routes rather than as a PATCH key because `publishedAt` is
 * server-owned — an insight must never go live as a side effect of a typo fix.
 *
 * No `requireIdentifiedUser`, matching the three shipped `/discovery/admin/*` routes:
 * `platformRole` lives on `user` and is never exposed on the session, so an anonymous
 * account cannot hold one. The capability is checked IN-SERVICE, before any id is read.
 */
router.get(
  "/admin/market-insights",
  requireAuth,
  discoveryModerationLimiter,
  marketInsightsController.listMarketInsightsForModerator,
);

router.post(
  "/admin/market-insights",
  requireAuth,
  discoveryModerationLimiter,
  longFormBody,
  marketInsightsController.createMarketInsight,
);

router.post(
  "/admin/market-insights/:insightId/publish",
  requireAuth,
  discoveryModerationLimiter,
  marketInsightsController.setMarketInsightPublished(true),
);

router.post(
  "/admin/market-insights/:insightId/unpublish",
  requireAuth,
  discoveryModerationLimiter,
  marketInsightsController.setMarketInsightPublished(false),
);

router.patch(
  "/admin/market-insights/:insightId",
  requireAuth,
  discoveryModerationLimiter,
  longFormBody,
  marketInsightsController.updateMarketInsight,
);

router.delete(
  "/admin/market-insights/:insightId",
  requireAuth,
  discoveryModerationLimiter,
  marketInsightsController.deleteMarketInsight,
);

/**
 * The controlled vocabularies (§11j.4) — `discovery_skill` and `discovery_region`.
 *
 * §11j.4 itself calls these "lower priority, and arguably not a defect": both tables are
 * seeded, and no runtime write path is a legitimate answer for a controlled vocabulary. What
 * these add is correcting and extending them without a deploy, still moderator-only.
 *
 * `slug` is frozen on both PATCHes and `global` is not an accepted region kind — see the
 * controller for why each of those closes something.
 */
router.get(
  "/admin/skills",
  requireAuth,
  discoveryModerationLimiter,
  vocabularyController.listSkills,
);

router.post(
  "/admin/skills",
  requireAuth,
  discoveryModerationLimiter,
  compactBody,
  vocabularyController.createSkill,
);

router.patch(
  "/admin/skills/:skillId",
  requireAuth,
  discoveryModerationLimiter,
  compactBody,
  vocabularyController.updateSkill,
);

router.delete(
  "/admin/skills/:skillId",
  requireAuth,
  discoveryModerationLimiter,
  vocabularyController.deleteSkill,
);

router.get(
  "/admin/regions",
  requireAuth,
  discoveryModerationLimiter,
  vocabularyController.listRegions,
);

router.post(
  "/admin/regions",
  requireAuth,
  discoveryModerationLimiter,
  compactBody,
  vocabularyController.createRegion,
);

router.patch(
  "/admin/regions/:regionId",
  requireAuth,
  discoveryModerationLimiter,
  compactBody,
  vocabularyController.updateRegion,
);

router.delete(
  "/admin/regions/:regionId",
  requireAuth,
  discoveryModerationLimiter,
  vocabularyController.deleteRegion,
);

router.post(
  "/admin/merge-proposals/:proposalId/decide",
  requireAuth,
  discoveryModerationLimiter,
  compactBody,
  moderationController.decideMergeProposal,
);

export default router;
