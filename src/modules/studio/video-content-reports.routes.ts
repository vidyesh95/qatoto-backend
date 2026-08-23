import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import { contentReviewLimiter, videoContentReportLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as reportsController from "#src/modules/studio/video-content-reports.controller.js";

const router = express.Router();

/**
 * Video content reporting — the reporter's write and the staff queue.
 *
 * ## Mounted at `/videos`, not at a root `/admin`
 *
 * `app.ts` states the rule for the anime review queue and it applies unchanged here: "one
 * domain's moderation surface should not claim the global namespace." The three routers
 * mounted at `/` — the audit chain, role grants, platform metrics — earn `/admin` because
 * they are not any one domain's.
 *
 * ## EVERY ROUTE HERE IS AT LEAST TWO SEGMENTS DEEP, AND THAT IS LOAD-BEARING
 *
 * This router mounts at `/videos` AFTER the studio router, whose `GET /:videoId` sits behind
 * `requireAuth` and matches any single segment. A one-segment route here would be
 * permanently shadowed and would answer 401 to logged-out callers —
 * `engagement.routes.order.test.ts` exists because that already happened once.
 *
 * `/admin/content-reports` is two segments, so `/:videoId` cannot claim it.
 *
 * IT IS ALSO WHY THE REPORTER'S OWN LIST IS NOT HERE. `GET /videos/reports` would be one
 * segment and shadowed; it lives at `GET /users/me/video-reports`, beside
 * `/users/me/watch-time` and `/users/me/muted-creators`, where a client already looks for
 * facts about itself.
 *
 * ## No capability middleware on `/admin/*`, on purpose
 *
 * `moderate_content` is checked INSIDE the service, before any id is read. A route-level
 * guard makes the capability probeable and an id-first service makes the route an existence
 * oracle; doing it in that order avoids both. Commerce and the anime queue state the same.
 */

/**
 * POST /videos/:videoId/reports
 *
 * `requireIdentifiedUser`, unlike the two feed-preference writes on the engagement router.
 * Those change only the caller's own feed and move no counter, so an anonymous session is
 * harmless there. A report is a claim ABOUT SOMEONE ELSE that puts their video in front of
 * staff, and unlimited throwaway identities filing them is the shape a brigading attempt
 * takes. The partial unique index caps one person at one report per video; this is what
 * stops one person being many people.
 *
 * `idempotency({ scope: "user" })` and NOT `required: true`: a double-submitted form should
 * not become a second row, but a client that omits the header still gets the unique index
 * answering 409, so requiring it would only turn a working request into a 400.
 */
router.post(
  "/:videoId/reports",
  requireAuth,
  requireIdentifiedUser,
  videoContentReportLimiter,
  compactBody,
  idempotency({ scope: "user" }),
  reportsController.reportVideo,
);

/**
 * GET /videos/admin/content-reports — the queue, keyset-paginated.
 *
 * `contentReviewLimiter` rather than a new one: it is already the `moderate_content` video
 * staff bucket, generous on purpose because a moderator legitimately works a queue quickly.
 * It exists to bound a COMPROMISED staff session, not to pace an honest one.
 */
router.get("/admin/content-reports", requireAuth, contentReviewLimiter, reportsController.listVideoReports);

/**
 * POST /videos/admin/content-reports/:reportId/decisions
 *
 * `idempotency({ required: true })`, unlike the report route above. A decision writes an
 * audit-chain entry, and a retried request that appends a second entry makes the chain claim
 * two decisions were taken. The client must name the attempt.
 */
router.post(
  "/admin/content-reports/:reportId/decisions",
  requireAuth,
  contentReviewLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  reportsController.decideVideoReport,
);

/**
 * POST /videos/admin/content/restore
 *
 * ITS OWN ROUTE, not a dismissal. A video can be hidden with no open report left to dismiss
 * — hidden, reports actioned and closed, later reconsidered — and without this it would be
 * hidden permanently.
 *
 * The video id is in the BODY rather than the path, because the body already has to carry a
 * required `reasonNote` and splitting one write across both is how the two drift apart.
 */
router.post(
  "/admin/content/restore",
  requireAuth,
  contentReviewLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  reportsController.restoreVideo,
);

export default router;
