import express from "express";

import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  contentReportLimiter,
  paperCategoryCreateLimiter,
  paperCreateLimiter,
  paperDownloadLimiter,
  paperUploadLimiter,
  postReactionLimiter,
  programBranchWriteLimiter,
  programCreateLimiter,
  programModerationLimiter,
  programPostCreateLimiter,
  programProfileWriteLimiter,
  researchEffortLogLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as programsController from "#src/modules/rnd/programs/research-programs.controller.js";
import { uploadResearchPaperFile } from "#src/modules/rnd/programs/upload-research-paper.js";

const router = express.Router();

/**
 * Research programs — Project Immortal and anything like it
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * MOUNTED AT `/research-programs`. It is the only router at that prefix, so unlike the four
 * that share `/research-projects` there is no ordering hazard between routers here — only
 * within this file.
 *
 * CHAIN ORDER, everywhere: auth → limiter → idempotency → requireIdentifiedUser → parser →
 * controller. The limiter precedes `requireIdentifiedUser` so an unidentified caller cannot
 * hammer that guard's extra query, and both follow `requireAuth` because every limiter keys
 * on `req.user.id`.
 *
 * WHERE `requireIdentifiedUser` GOES, and why it is on MORE routes here than in §9 despite
 * this domain minting no equity. `requireAuth` only proves a session exists, and
 * `anonymous()` mints real sessions — so on a PUBLIC UGC surface the guard is what stops a
 * throwaway identity from proposing programs, uploading papers, posting, reacting and
 * reporting. §9 applies it to writes that move equity; §10 applies it to writes that
 * PUBLISH SOMETHING OTHER PEOPLE READ, which is this domain's equivalent stake. Reads are
 * exempt, and so is nothing else.
 *
 * WHERE `attachOptionalUser` GOES: every public read. A published program is readable
 * signed out, but a signed-in reader gets `isClaimedByViewer`, `isReactedByViewer` and
 * `isUploadedByViewer` — all per-viewer facts (§10) — so the reads need the session when
 * there is one and must not fail when there is not.
 *
 * NO SEPARATE AUTHORIZATION MIDDLEWARE. Visibility, ownership and staff capability are all
 * proven inside the controller (`resolveVisibleProgram`, `resolveOwnedProgram`,
 * `resolveStaff`), because middleware cannot return a `Result` and so cannot participate in
 * the exhaustive error switch. Read-authorization failure is 404, never 403, so a stranger
 * cannot enumerate which program slugs have been submitted.
 *
 * ROUTE ORDER: literal segments before `/:param`, everywhere, and
 * `research-programs.routes.order.test.ts` is what keeps it that way. The three that matter:
 *
 *   `/slugs`, `/mine` and `/review-queue`  BEFORE  `/:programSlug`
 *   `…/moderation/queue` and `…/moderation/actions`  BEFORE nothing, but they must not be
 *       reachable as a `:programSlug` — they are not, because they are deeper paths
 *   `…/contributors/me`  BEFORE  nothing today, but it is declared before any
 *       `…/contributors/:x` is ever added — `me` is a literal and would otherwise be
 *       swallowed
 *
 * BODY CAPS: `compactBody` (16 KB) on everything except the two routes that carry prose —
 * a program's mission statement and a post's body both reach 4–10 KB of text, and
 * `longFormBody` (128 KB) is the cap the §8 daily-log routes already use for the same
 * reason.
 */

// ---------------------------------------------------------------------------
// Collection-level reads. LITERAL PATHS FIRST — see the ordering note above.
// ---------------------------------------------------------------------------

/** GET /research-programs — the public index. Published and archived only. */
router.get("/", attachOptionalUser, programsController.listPrograms);

/**
 * GET /research-programs/slugs — for the frontend's `generateStaticParams`.
 *
 * Public and unauthenticated: it returns published slugs, which are already public URLs.
 * Declared before `/:programSlug` or `slugs` would be read as a program slug.
 */
router.get("/slugs", programsController.listProgramSlugs);

/** GET /research-programs/mine — own programs at any status, including `pending`. */
router.get("/mine", requireAuth, programsController.listOwnPrograms);

/** GET /research-programs/review-queue — `pending` programs, oldest first. Moderator only. */
router.get("/review-queue", requireAuth, programsController.listProgramReviewQueue);

/**
 * POST /research-programs — proposes one. Lands `pending`, invisible until reviewed.
 *
 * `idempotency()` because a retried submit must not put two identical programs in a human's
 * review queue. `longFormBody` for the mission statement.
 */
router.post(
  "/",
  requireAuth,
  programCreateLimiter,
  idempotency(),
  requireIdentifiedUser,
  longFormBody,
  programsController.createProgram,
);

// ---------------------------------------------------------------------------
// One program
// ---------------------------------------------------------------------------

/** GET /research-programs/:programSlug — public detail. 404 for pending unless yours. */
router.get("/:programSlug", attachOptionalUser, programsController.getProgram);

/** GET …/stats — the four hero tiles. **404 when never computed**, never fabricated zeroes. */
router.get("/:programSlug/stats", attachOptionalUser, programsController.getProgramStats);

/** PATCH …/:programSlug — creator only. No `status`, no `slug`. */
router.patch(
  "/:programSlug",
  requireAuth,
  programProfileWriteLimiter,
  requireIdentifiedUser,
  longFormBody,
  programsController.updateProgram,
);

/** POST …/moderate — publish or reject. Moderator only; appends to the platform audit chain. */
router.post(
  "/:programSlug/moderate",
  requireAuth,
  programModerationLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.moderateProgram,
);

// ---------------------------------------------------------------------------
// Branches. `status` and `overlappingGroupCount` are job-derived and appear in no body.
// ---------------------------------------------------------------------------

/** GET …/branches — the whole tree in one read. */
router.get("/:programSlug/branches", attachOptionalUser, programsController.listBranches);

/** POST …/branches — anyone signed in, on a published program. */
router.post(
  "/:programSlug/branches",
  requireAuth,
  programBranchWriteLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.createBranch,
);

/**
 * POST · DELETE …/branches/:branchId/claim — idempotent by the unique index.
 *
 * Declared BEFORE `PATCH …/branches/:branchId` for readability only; they cannot collide,
 * because `/claim` is a deeper path than the PATCH's terminal `:branchId`.
 *
 * No `idempotency()` middleware: the unique index already makes both verbs idempotent, and a
 * key would add a stored record per double-tap for no gain.
 */
router.post(
  "/:programSlug/branches/:branchId/claim",
  requireAuth,
  programBranchWriteLimiter,
  requireIdentifiedUser,
  programsController.claimBranch,
);

router.delete(
  "/:programSlug/branches/:branchId/claim",
  requireAuth,
  programBranchWriteLimiter,
  requireIdentifiedUser,
  programsController.releaseBranchClaim,
);

/** PATCH …/branches/:branchId — edit, reorder, re-parent. Re-parent rewrites the subtree. */
router.patch(
  "/:programSlug/branches/:branchId",
  requireAuth,
  programBranchWriteLimiter,
  requireIdentifiedUser,
  compactBody,
  programsController.updateBranch,
);

// ---------------------------------------------------------------------------
// Papers. Two-step: the row, then the bytes.
// ---------------------------------------------------------------------------

/** GET …/papers — keyset. Non-approved rows visible only to their uploader and to staff. */
router.get("/:programSlug/papers", attachOptionalUser, programsController.listPapers);

/**
 * POST …/papers — the metadata row. `moderationStatus` lands `queued`.
 *
 * `longFormBody`, not `compactBody`, and `json-body-budget.test.ts` is what proved it:
 * `abstractText` alone is 5,000 characters, which `z.string().max()` counts as UTF-16 code
 * units while the parser's `limit` counts BYTES — so a Devanagari or CJK abstract reaches
 * ~15 kB and the whole schema's worst case is ~23 kB. Under a 16 kB cap that is a 413 for
 * non-English users only, which is exactly the bug that never shows up in English-language
 * testing.
 */
router.post(
  "/:programSlug/papers",
  requireAuth,
  paperCreateLimiter,
  idempotency(),
  requireIdentifiedUser,
  longFormBody,
  programsController.createPaper,
);

/**
 * GET …/papers/:paperId/download — a 5-minute presigned URL.
 *
 * `requireAuth`, not `attachOptionalUser`: a download link is a bearer capability, and
 * handing one to an anonymous caller means handing it to anyone they pass it to. The rest of
 * the library is public; the bytes are gated.
 *
 * Declared BEFORE `DELETE …/papers/:paperId` and the two POSTs for readability; `/download`
 * is a deeper path so no collision is possible.
 */
router.get(
  "/:programSlug/papers/:paperId/download",
  requireAuth,
  paperDownloadLimiter,
  programsController.downloadPaper,
);

/**
 * POST …/papers/:paperId/file — multipart `paper`.
 *
 * NO JSON BODY PARSER in this chain, and that is deliberate: `uploadResearchPaperFile` is
 * the parser, and a JSON parser ahead of it would consume the stream. Its 25 MB cap is
 * imported from `src/modules/rnd/pdf.ts` so the two cannot disagree.
 *
 * No `idempotency()` middleware — the content-addressed storage key plus the partial unique
 * index on `contentSha256` make a retried upload converge on the same object, which is
 * stronger than a replayed response.
 */
router.post(
  "/:programSlug/papers/:paperId/file",
  requireAuth,
  paperUploadLimiter,
  requireIdentifiedUser,
  uploadResearchPaperFile,
  programsController.attachPaperFile,
);

/** POST …/papers/:paperId/report — one report per user per target. */
router.post(
  "/:programSlug/papers/:paperId/report",
  requireAuth,
  contentReportLimiter,
  requireIdentifiedUser,
  compactBody,
  programsController.reportPaper,
);

/** POST …/papers/:paperId/moderate — the reviewer's verdict. Moderator only. */
router.post(
  "/:programSlug/papers/:paperId/moderate",
  requireAuth,
  programModerationLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.moderatePaper,
);

/** DELETE …/papers/:paperId — uploader while `queued`, or staff. Removes the bytes too. */
router.delete(
  "/:programSlug/papers/:paperId",
  requireAuth,
  paperCreateLimiter,
  requireIdentifiedUser,
  programsController.deletePaper,
);

// ---------------------------------------------------------------------------
// Posts, replies, reactions, reports
// ---------------------------------------------------------------------------

/** GET …/posts — a track's feed, with up to three inline replies per post. */
router.get("/:programSlug/posts", attachOptionalUser, programsController.listPosts);

/** GET …/posts/:postId/replies — the full thread, oldest first. */
router.get(
  "/:programSlug/posts/:postId/replies",
  attachOptionalUser,
  programsController.listReplies,
);

/** POST …/posts — an informal paper (titled) or an idea (untitled). */
router.post(
  "/:programSlug/posts",
  requireAuth,
  programPostCreateLimiter,
  idempotency(),
  requireIdentifiedUser,
  longFormBody,
  programsController.createPost,
);

/** POST …/posts/:postId/replies — one level deep; deeper is a 409. */
router.post(
  "/:programSlug/posts/:postId/replies",
  requireAuth,
  programPostCreateLimiter,
  idempotency(),
  requireIdentifiedUser,
  longFormBody,
  programsController.createReply,
);

/**
 * PUT · DELETE …/posts/:postId/reaction — **idempotent by verb** (§10).
 *
 * `PUT`/`DELETE` rather than `POST`/`POST` so a double-tap on a slow connection is harmless
 * rather than a second like. Neither carries a body, and neither needs an idempotency key —
 * the per-user unique index is the mechanism.
 */
router.put(
  "/:programSlug/posts/:postId/reaction",
  requireAuth,
  postReactionLimiter,
  requireIdentifiedUser,
  programsController.addReaction,
);

router.delete(
  "/:programSlug/posts/:postId/reaction",
  requireAuth,
  postReactionLimiter,
  requireIdentifiedUser,
  programsController.removeReaction,
);

/** POST …/posts/:postId/report — one report per user per target. */
router.post(
  "/:programSlug/posts/:postId/report",
  requireAuth,
  contentReportLimiter,
  requireIdentifiedUser,
  compactBody,
  programsController.reportPost,
);

/** POST …/posts/:postId/moderate — hide or restore. Reversible, and both directions audited. */
router.post(
  "/:programSlug/posts/:postId/moderate",
  requireAuth,
  programModerationLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.moderatePost,
);

// ---------------------------------------------------------------------------
// Moderation queue. Literal `moderation/*` paths; moderator only.
// ---------------------------------------------------------------------------

/** GET …/moderation/queue — open reports oldest first, plus a queued-paper count. */
router.get("/:programSlug/moderation/queue", requireAuth, programsController.listModerationQueue);

/** GET …/moderation/actions — this program's decision log, the queryable view of the chain. */
router.get(
  "/:programSlug/moderation/actions",
  requireAuth,
  programsController.listModerationActions,
);

/** POST …/reports/:reportId/dismiss — "we looked, this is fine". Recorded either way. */
router.post(
  "/:programSlug/reports/:reportId/dismiss",
  requireAuth,
  programModerationLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.dismissReport,
);

// ---------------------------------------------------------------------------
// Contributors, effort, contributions. `contributors/me` is a LITERAL — declared first.
// ---------------------------------------------------------------------------

/** GET …/contributors — the roster, filtered by role IN SQL. */
router.get("/:programSlug/contributors", attachOptionalUser, programsController.listContributors);

/** POST …/contributors/me — joins. 409 if already a contributor; PATCH to change details. */
router.post(
  "/:programSlug/contributors/me",
  requireAuth,
  programProfileWriteLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.joinProgram,
);

/** PATCH …/contributors/me — your own participation. Nobody else's. */
router.patch(
  "/:programSlug/contributors/me",
  requireAuth,
  programProfileWriteLimiter,
  requireIdentifiedUser,
  compactBody,
  programsController.updateOwnParticipation,
);

/**
 * POST …/effort-logs — self-reported time. Not equity, not verified, mints nothing.
 *
 * Carries a BODY-LEVEL `idempotencyKey` with its own unique index, as well as the
 * `idempotency()` middleware. Both, deliberately: the middleware replays a whole response
 * for a repeated HTTP request, and the column makes the ROW unique for a repeated
 * submission even across two different requests. §9's claim submit takes both for the same
 * reason.
 */
router.post(
  "/:programSlug/effort-logs",
  requireAuth,
  researchEffortLogLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.logEffort,
);

/** POST …/contributions — a RECORD OF INTENT. No money moves; the response says so. */
router.post(
  "/:programSlug/contributions",
  requireAuth,
  researchEffortLogLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.recordContribution,
);

// ---------------------------------------------------------------------------
// Product opportunities. Creator-or-staff writes, unlike everything else here.
// ---------------------------------------------------------------------------

/** GET …/product-opportunities — public, largest projection first. */
router.get(
  "/:programSlug/product-opportunities",
  attachOptionalUser,
  programsController.listOpportunities,
);

/** POST …/product-opportunities — creator or staff. `bigint` cents as a decimal string. */
router.post(
  "/:programSlug/product-opportunities",
  requireAuth,
  programProfileWriteLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  programsController.createOpportunity,
);

/** DELETE …/product-opportunities/:opportunityId — creator or staff. */
router.delete(
  "/:programSlug/product-opportunities/:opportunityId",
  requireAuth,
  programProfileWriteLimiter,
  requireIdentifiedUser,
  programsController.deleteOpportunity,
);

export default router;

/**
 * The paper taxonomy, ROOT-MOUNTED at `/research-paper-categories`.
 *
 * A separate router because the taxonomy is program-independent — one vocabulary the whole
 * platform shares, exactly as `/research-categories` is for projects. Nesting it under
 * `/research-programs/:programSlug` would imply each program has its own, which would make
 * "Longevity Biology" mean something different in two places.
 *
 * Exported by NAME and mounted at `/` in `src/app.ts`, the same arrangement
 * `integrationCallbackRouter` uses.
 */
export const researchPaperCategoryRouter = express.Router();

/** GET /research-paper-categories — approved by default. Public. */
researchPaperCategoryRouter.get(
  "/research-paper-categories",
  programsController.listPaperCategories,
);

/** POST /research-paper-categories — lands `pending`, awaiting moderation. */
researchPaperCategoryRouter.post(
  "/research-paper-categories",
  requireAuth,
  paperCategoryCreateLimiter,
  requireIdentifiedUser,
  compactBody,
  programsController.createPaperCategory,
);

/**
 * POST /research-paper-categories/:categoryId/decide — `moderate_taxonomy`.
 *
 * No capability middleware and no `requireIdentifiedUser`: the capability check lives in the
 * service and runs BEFORE the id is read, so this route is not an id oracle. That is the same
 * arrangement `/discovery/admin/categories/:categoryId/decide` uses.
 */
researchPaperCategoryRouter.post(
  "/research-paper-categories/:categoryId/decide",
  requireAuth,
  programModerationLimiter,
  compactBody,
  programsController.decidePaperCategory,
);
