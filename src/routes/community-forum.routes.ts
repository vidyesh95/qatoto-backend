import express from "express";

import * as communityForumController from "#src/controllers/community-forum.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  communityContentReportLimiter,
  communityForumReplyCreateLimiter,
  communityForumThreadCreateLimiter,
  communityForumVoteLimiter,
  communityModerationLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * The business forum's WRITE surface (STORE_BACKEND_STRUCTURE.md §17).
 *
 * MOUNTED AT `/community`, NOT `/commerce` (§1.1). Community is a sibling context: no
 * organization is required to post, nothing is priced, nothing is ordered. The public READS
 * live on `/store` because that is the prefix a signed-out visitor browses — a mount point
 * rather than a context claim.
 *
 * CHAIN ORDER, following `research-programs.routes.ts`, the closest built precedent:
 * auth → limiter → idempotency → requireIdentifiedUser → parser → controller.
 *
 * `requireIdentifiedUser` IS ON EVERY AUTHORING ROUTE. `src/lib/auth.ts` registers the
 * `anonymous()` plugin, so a session on its own proves nothing about identity — and this is
 * the one surface on the platform where a stranger's text reaches every visitor. It is
 * deliberately ABSENT from the moderation routes, whose gate is the platform capability,
 * and from the read routes.
 *
 * NO CAPABILITY MIDDLEWARE ON `/admin/*`. `moderate_content` is checked INSIDE the service
 * before any id is read, so the refusal is a `Result` rather than a probe — the rule
 * `commerce-content-reports.routes.ts` states at length.
 */
const router = express.Router();

// --- Literal `/forum/threads/mine` BEFORE `/forum/threads/:threadId/...`. Different depth
// here, so no collision today; declared first anyway so a later two-segment route under
// `/forum/threads/:threadId` cannot swallow it.

router.get(
  "/forum/threads/mine",
  requireAuth,
  communityForumVoteLimiter,
  communityForumController.listMyForumThreads,
);

/**
 * `Idempotency-Key` REQUIRED. A retry without one posts the question twice and a moderator
 * then has to reject one by hand.
 *
 * `longFormBody`: a 20,000-character body will not fit the 16 KB compact cap.
 */
router.post(
  "/forum/threads",
  requireAuth,
  communityForumThreadCreateLimiter,
  idempotency({ required: true, scope: "user" }),
  requireIdentifiedUser,
  longFormBody,
  communityForumController.createForumThread,
);

router.post(
  "/forum/threads/:threadId/replies",
  requireAuth,
  communityForumReplyCreateLimiter,
  idempotency({ required: true, scope: "user" }),
  requireIdentifiedUser,
  longFormBody,
  communityForumController.createForumReply,
);

/**
 * Accepting an answer takes no idempotency key: it is a SET to one value, so a replay lands
 * on the same state. `DELETE` reads no body and therefore carries no cap —
 * `json-body-budget.test.ts` fails the build for a cap guarding nothing.
 */
router.post(
  "/forum/threads/:threadId/accepted-reply",
  requireAuth,
  communityForumVoteLimiter,
  requireIdentifiedUser,
  compactBody,
  communityForumController.setAcceptedReply,
);

router.delete(
  "/forum/threads/:threadId/accepted-reply",
  requireAuth,
  communityForumVoteLimiter,
  requireIdentifiedUser,
  communityForumController.clearAcceptedReply,
);

/**
 * The helpful toggle carries NO `idempotency()` and NO body parser: `PUT` and `DELETE` of a
 * boolean are idempotent by verb and neither has a body (A24). Same rule the review and
 * answer helpful routes document.
 */
router.put(
  "/forum/replies/:replyId/helpful",
  requireAuth,
  communityForumVoteLimiter,
  requireIdentifiedUser,
  communityForumController.endorseReply,
);

router.delete(
  "/forum/replies/:replyId/helpful",
  requireAuth,
  communityForumVoteLimiter,
  requireIdentifiedUser,
  communityForumController.withdrawReplyEndorsement,
);

/**
 * No idempotency key: the partial unique index on `(target, reporter)` already makes a
 * second report of the same thing a 409 rather than a duplicate row.
 */
router.post(
  "/reports",
  requireAuth,
  communityContentReportLimiter,
  requireIdentifiedUser,
  compactBody,
  communityForumController.createCommunityReport,
);

// --- Moderation. Gated on `moderate_content` inside the service.

router.get(
  "/admin/forum/threads",
  requireAuth,
  communityModerationLimiter,
  communityForumController.listForumModerationQueue,
);

router.post(
  "/admin/forum/threads/:threadId/moderate",
  requireAuth,
  communityModerationLimiter,
  idempotency({ required: true, scope: "user" }),
  compactBody,
  communityForumController.moderateForumThread,
);

router.post(
  "/admin/forum/replies/:replyId/moderate",
  requireAuth,
  communityModerationLimiter,
  idempotency({ required: true, scope: "user" }),
  compactBody,
  communityForumController.moderateForumReply,
);

router.get(
  "/admin/content-reports",
  requireAuth,
  communityModerationLimiter,
  communityForumController.listCommunityReports,
);

router.post(
  "/admin/content-reports/:reportId/decisions",
  requireAuth,
  communityModerationLimiter,
  idempotency({ required: true, scope: "user" }),
  compactBody,
  communityForumController.dismissCommunityReport,
);

export default router;
