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
 * one of those would imply the others are not covered. Two routes, different verbs, no path
 * parameters — nothing here can shadow anything, so there is no `*.routes.order.test.ts`.
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

router.get(
  "/admin/feedback",
  requireAuth,
  contentReviewLimiter,
  feedbackController.listPlatformFeedback,
);

export default router;
