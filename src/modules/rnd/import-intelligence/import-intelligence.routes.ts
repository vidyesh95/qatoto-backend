import express from "express";

import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { importIntelligenceWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as importIntelligenceController from "#src/modules/rnd/import-intelligence/import-intelligence.controller.js";

/**
 * §11m — import intelligence and localization.
 *
 * ROOT-MOUNTED, beside §11i's supplier router and just as independent: this domain FKs to
 * `discovery_region`, `research_category` and `supplier_capability`, and nothing already
 * shipped FKs to it.
 *
 * NO ROLE MIDDLEWARE ON THE WRITES, and that is the §4a Layer 3 rule rather than an
 * omission: `requirePlatformCapability` runs IN-SERVICE, before any id is read, so these
 * routes are not id oracles and the refusal participates in the controller's exhaustive
 * error switch. A middleware cannot return a `Result`.
 *
 * `requireIdentifiedUser` IS ON THE WRITES even though they are moderator-gated, because
 * `src/lib/auth.ts` registers the `anonymous()` plugin and a session proves nothing about
 * identity on its own.
 *
 * ROUTE ORDER: literal segments before `/:param`. `/import-commodity-kinds` is a distinct
 * top-level path and cannot be swallowed by `/import-commodities/:hsCode` — the names
 * differ — but the two nested literals `/trade-flows` and `/substitutes` DO sit under a
 * param, so they are declared after it in the file and matched by their own full paths.
 * `import-intelligence.routes.order.test.ts` asserts none of this drifts.
 *
 * READS ARE PUBLIC (`attachOptionalUser`), not unauthenticated. The session is read for
 * exactly one purpose — the substitutes read widens to include drafts for a moderator —
 * and never to authorize. They are NOT in `PUBLICLY_RESOLVABLE`, which is for routes
 * carrying neither guard; `attachOptionalUser` already tells the spec they are public.
 *
 * THERE IS NO WRITE ROUTE FOR `import_commodity` OR `commodity_trade_flow`, deliberately.
 * The Comtrade ingest is their only author (§10A): a submission path would need a
 * moderation queue, a limiter and an abuse story bought before the first real dataset, and
 * `supplier_capability` settled the same argument the same way.
 */

const importIntelligenceRouter = express.Router();

// --- Reads. The kind vocabulary first: a literal path, no parameters, no pagination.
importIntelligenceRouter.get(
  "/import-commodity-kinds",
  attachOptionalUser,
  importIntelligenceController.listImportCommodityKinds,
);

// --- Which countries have data at all. A literal path, no parameters, no pagination.
importIntelligenceRouter.get(
  "/import-reporters",
  attachOptionalUser,
  importIntelligenceController.listImportReporters,
);

// --- The rank-ordered leaderboard for the newest `asOf`.
importIntelligenceRouter.get(
  "/localization-assessments",
  attachOptionalUser,
  importIntelligenceController.listLocalizationAssessments,
);

// --- The same population as the leaderboard, counted per score cell. A SIBLING LITERAL of
//     the route above, not a nested one: `/localization-assessments` declares no `/:id`, but
//     a nested `/localization-assessments/grid` would put a literal one path-segment away
//     from any future param route and make the ordering load-bearing for no benefit.
importIntelligenceRouter.get(
  "/localization-assessment-grid",
  attachOptionalUser,
  importIntelligenceController.listLocalizationAssessmentGrid,
);

// --- The HS6 directory.
importIntelligenceRouter.get(
  "/import-commodities",
  attachOptionalUser,
  importIntelligenceController.listImportCommodities,
);

// --- Nested literals under the param. Declared after the collection above and before the
//     bare `/:hsCode` below, so neither can shadow the other.
importIntelligenceRouter.get(
  "/import-commodities/:hsCode/trade-flows",
  attachOptionalUser,
  importIntelligenceController.listTradeFlows,
);

importIntelligenceRouter.get(
  "/import-commodities/:hsCode/substitutes",
  attachOptionalUser,
  importIntelligenceController.listSubstitutes,
);

importIntelligenceRouter.get(
  "/import-commodities/:hsCode",
  attachOptionalUser,
  importIntelligenceController.getImportCommodity,
);

// --- Writes. Chain order is fixed (§11i): requireAuth -> limiter -> requireIdentifiedUser
//     -> body parser -> controller.

// --- Ask for one product's pathway narrative and capital band. NO BODY PARSER: the
//     assessment is named by the path and there is nothing else to say, so there is nothing
//     to parse and nothing a caller could smuggle in.
//
//     ⚠️ THE ONLY AUTHENTICATED ENDPOINT IN THIS ROUTER, and the reason is the bill. Every
//     read above is public because reading costs a query; this one spends a metered Gemini
//     call, so leaving it on `attachOptionalUser` like its neighbours would publish a
//     denial-of-wallet. It answers 202 — a queued job is not a verdict.
importIntelligenceRouter.post(
  "/localization-assessments/:assessmentId/pathway",
  requireAuth,
  importIntelligenceWriteLimiter,
  requireIdentifiedUser,
  importIntelligenceController.requestPathwayNarrative,
);

importIntelligenceRouter.post(
  "/domestic-substitutes",
  requireAuth,
  importIntelligenceWriteLimiter,
  requireIdentifiedUser,
  longFormBody,
  importIntelligenceController.createDomesticSubstitute,
);

importIntelligenceRouter.patch(
  "/domestic-substitutes/:substituteId",
  requireAuth,
  importIntelligenceWriteLimiter,
  requireIdentifiedUser,
  longFormBody,
  importIntelligenceController.updateDomesticSubstitute,
);

// --- Advisory only: recording a decision moves no score, no rank and no trade figure.
importIntelligenceRouter.post(
  "/localization-pathway-suggestions/:suggestionId/decision",
  requireAuth,
  importIntelligenceWriteLimiter,
  requireIdentifiedUser,
  // COMPACT, not long-form: the body is an enum and a 2,000-character note. The two
  // substitute routes carry 4,000-character notes plus a URL and need the larger tier;
  // `json-body-budget.test.ts` sweeps for exactly this mismatch and caught it here.
  compactBody,
  importIntelligenceController.decidePathwaySuggestion,
);

export default importIntelligenceRouter;
