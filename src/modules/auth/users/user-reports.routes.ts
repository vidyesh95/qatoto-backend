import express from "express";

import { compactBody } from "#src/middleware/json-body.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { contentReviewLimiter, userReportLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as userReportsController from "#src/modules/auth/users/user-reports.controller.js";

/**
 * Reporting a person's profile, and the moderator queue that answers it.
 *
 * ## MOUNTED AT `/users`, AND THE ORDERING HAZARD IS NOT THE VIDEO ONE
 *
 * `/videos` has three routers stacked with a `GET /:videoId` catch-all, which is why every route
 * there is two segments deep. `/users` is mounted alone, so nothing external shadows this. The
 * hazard here is INTRA-router: `users.routes.ts` declares `GET /:id` last, and every `/me/*` route
 * before it, enforced by `users.routes.order.test.ts`. This router is mounted after that one, so
 * `POST /users/:userId/reports` cannot be reached by a single-segment param — it is two segments and
 * a different verb.
 *
 * ## NO CAPABILITY MIDDLEWARE ON THE ADMIN ROUTES
 *
 * `moderate_content` is checked INSIDE the service, before any id is read. A route-level guard makes
 * the capability probeable and an id-first service makes the route an existence oracle; doing it in
 * that order avoids both. Middleware also cannot return a `Result`, so it could not take part in the
 * controller's exhaustive error switch.
 *
 * ## THE IDEMPOTENCY ASYMMETRY IS THE VIDEO QUEUE'S, AND FOR THE SAME REASON
 *
 * The report route is `idempotency({ scope: "user" })` WITHOUT `required`: a double-submitted form
 * should not become a second row, but the partial unique index already answers 409, so requiring the
 * header would only turn a working request into a 400.
 *
 * The decide and restore routes ARE `required: true`. Each appends a hash-chained audit entry, and a
 * retried request that appends a second one makes the chain claim two decisions were taken.
 */
const router = express.Router();

router.post(
  "/:userId/reports",
  requireAuth,
  requireIdentifiedUser,
  userReportLimiter,
  compactBody,
  idempotency({ scope: "user" }),
  userReportsController.reportUser,
);

router.get(
  "/admin/reports",
  requireAuth,
  contentReviewLimiter,
  userReportsController.listUserReports,
);

router.post(
  "/admin/reports/:reportId/decisions",
  requireAuth,
  contentReviewLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  userReportsController.decideUserReport,
);

/**
 * The subject id is in the BODY rather than the path, matching the video restore route: the body
 * already has to carry a required `reasonNote`, and splitting one write across both is how the two
 * drift apart.
 */
router.post(
  "/admin/profile-text/restore",
  requireAuth,
  contentReviewLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  userReportsController.restoreUserProfileText,
);

export default router;
