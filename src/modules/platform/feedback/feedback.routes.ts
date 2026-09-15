import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import { contentReviewLimiter, platformFeedbackLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as feedbackController from "#src/modules/platform/feedback/feedback.controller.js";

/**
 * Site feedback, and the staff queue that reads it.
 *
 * ## ROOT-MOUNTED, LIKE THE AUDIT LOG AND THE ROLE GRANTS BESIDE IT
 *
 * Feedback is about the product, not about a project, a video or a store. Filing it under
 * one of those would imply the others are not covered.
 *
 * ## STILL NO `*.routes.order.test.ts`, BUT THE OLD REASON EXPIRED
 *
 * This said "two routes, different verbs, no path parameters — nothing here can shadow
 * anything". There are four routes now and one of them HAS a parameter, so that sentence is
 * retired rather than quietly left to rot. The conclusion survives on a narrower argument:
 * `GET /feedback/mine` cannot be shadowed because the only other `/feedback` route is a POST,
 * and `POST /admin/feedback/:feedbackId/decisions` cannot be shadowed because the only other
 * `/admin/feedback` route is a GET. No two routes here share a method AND a prefix, so
 * declaration order cannot decide which one answers.
 *
 * ⚠️ A FIFTH ROUTE COULD BREAK THAT. `GET /feedback/:feedbackId` would shadow
 * `GET /feedback/mine` if declared first, and that is the day this module needs the order test
 * every module with a real parameter collision already has.
 *
 * ## THE LIMITER AND `requireIdentifiedUser` ARE A PAIR
 *
 * `requireAuth` only proves a session exists, and the `anonymous()` plugin makes one nearly
 * free — so a per-user limiter on its own bounds nothing at all. The guard makes minting an
 * identity expensive; the limiter bounds what one identity can do with it. Exactly the
 * reasoning `problemReportLimiter` records for the other free-text write into a staff queue.
 *
 * ## NO `idempotency()`, AND THAT IS A DECISION RATHER THAN AN OMISSION
 *
 * The report routes take a key because a partial unique index gives a replay an honest 409
 * to answer with. Feedback has no uniqueness invariant: two identical notes are two notes,
 * and nothing downstream counts them. A key here would buy deduplication nobody asked for
 * and turn a working request into a 400 whenever the header went missing.
 *
 * ## NO CAPABILITY MIDDLEWARE ON THE ADMIN ROUTE
 *
 * `moderate_content` is checked INSIDE the service, first. A route-level guard makes the
 * capability probeable, and middleware cannot return a `Result`, so it could not take part
 * in the controller's exhaustive error switch.
 */
const router = express.Router();

router.post(
  "/feedback",
  requireAuth,
  platformFeedbackLimiter,
  requireIdentifiedUser,
  compactBody,
  feedbackController.createPlatformFeedback,
);

/**
 * The submitter's own notes.
 *
 * `requireAuth` AND NOTHING ELSE, which is the shape every caller's-own read in this codebase
 * takes — `GET /support/cases` and `GET /notifications` carry no limiter and no
 * `requireIdentifiedUser` either. The guard prices minting an identity, and that is a cost
 * worth charging for a WRITE into a staff queue; reading back rows you already created reaches
 * nothing you did not already put there. Declared BEFORE the admin routes only for readability
 * — see the ordering note above for why nothing here depends on it.
 */
router.get("/feedback/mine", requireAuth, feedbackController.listOwnPlatformFeedback);

router.get(
  "/admin/feedback",
  requireAuth,
  contentReviewLimiter,
  feedbackController.listPlatformFeedback,
);

/**
 * Triage: mark a note read, or close it.
 *
 * `contentReviewLimiter` rather than a new one — its own doc already names `/feedback` among
 * the surfaces it covers, and it is what the queue GET beside it carries. NO `idempotency()`:
 * this appends nothing to the audit chain, so a replayed decision sets the same flag to the
 * same value. See `feedback.service.ts` for why there is no chain entry to protect.
 */
router.post(
  "/admin/feedback/:feedbackId/decisions",
  requireAuth,
  contentReviewLimiter,
  compactBody,
  feedbackController.decidePlatformFeedback,
);

export default router;
