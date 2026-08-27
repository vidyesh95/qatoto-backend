import express from "express";

import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  accountDeletionRequestLimiter,
  channelProfileWriteLimiter,
  dataExportRequestLimiter,
  dataExportStatusLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as handleController from "#src/modules/auth/handles/handle.controller.js";
import * as privacyController from "#src/modules/auth/privacy/privacy.controller.js";
import * as channelProfileController from "#src/modules/auth/users/channel-profile.controller.js";
import { uploadAvatarPhoto } from "#src/modules/auth/users/upload-avatar.js";
import * as usersController from "#src/modules/auth/users/users.controller.js";
import * as engagementController from "#src/modules/home/engagement/engagement.controller.js";
import * as videoContentReportsController from "#src/modules/studio/video-content-reports.controller.js";
import * as creatorAnalyticsController from "#src/modules/studio/videos/creator-analytics.controller.js";

const router = express.Router();

/**
 * GET /users
 * Every active account's id, email and join date. **STAFF ONLY** — `requireAuth` for the
 * session, and a `view_platform_metrics` check inside the service for the role.
 *
 * ⚠️ THIS WAS OPEN. Until Privacy Part 3 it needed no session at all and answered with a
 * hundred real email addresses. Do not remove `requireAuth` without reading the note in
 * `users.service.ts`.
 */
router.get("/", requireAuth, usersController.getUsers);

/**
 * PATCH /users/me
 * Update the authenticated caller's own display name. Auth required; the user id
 * is derived from the session cookie, not the request body. Declared before the
 * `/:id` route so "me" is never swallowed as an id param.
 */
router.patch("/me", requireAuth, longFormBody, usersController.updateMyProfile);

/**
 * GET|PATCH /users/me/channel-profile
 *
 * The caller's own public description and links, as rendered in the channel About panel.
 *
 * ITS OWN PATH RATHER THAN TWO MORE FIELDS ON `PATCH /users/me`. That body is `.strict()` with a
 * REQUIRED `fullName`, so widening it would make every field optional — and at that point
 * `updateUserName` no longer describes the handler and its "Name updated successfully" response
 * stops being true. Every other capability on this router already owns its own path.
 *
 * `compactBody`, NOT `longFormBody`: a description capped at 5000 characters plus at most ten links
 * is nowhere near the 128 KB budget the R&D payloads need.
 *
 * NO IDEMPOTENCY. `links` is a replace-the-set write and `sortOrder` is assigned server-side, so
 * sending the same body twice produces the same rows — idempotent by construction rather than by
 * key. The middleware here is honour-if-present anyway and the frontend mints no header.
 *
 * DECLARED BEFORE `/:id`, like every `/me/*` route above it — `users.routes.order.test.ts` fails the
 * build if a `/me/*` route ever falls after a single-segment param route.
 */
router.get(
  "/me/channel-profile",
  requireAuth,
  channelProfileController.getMyChannelProfile,
);

router.patch(
  "/me/channel-profile",
  requireAuth,
  channelProfileWriteLimiter,
  compactBody,
  channelProfileController.updateMyChannelProfile,
);

/**
 * PATCH /users/me/photo  (multipart/form-data, field `photo`)
 * Set the caller's own profile photo. Auth required; the file is buffered and
 * size-capped by uploadAvatarPhoto before the controller validates the bytes.
 */
router.patch("/me/photo", requireAuth, uploadAvatarPhoto, usersController.updateMyPhoto);

/**
 * DELETE /users/me/photo
 * Remove the caller's own profile photo and reset to the placeholder state.
 */
router.delete("/me/photo", requireAuth, usersController.deleteMyPhoto);

/**
 * GET /users/me/handle
 * Panel bootstrap: the caller's current handle plus rate-limit + revert metadata.
 * Auth required; the user id comes from the session, never the request. Declared
 * before `/:id` so "me" is never swallowed as an id param.
 */
router.get("/me/handle", requireAuth, handleController.getMyHandle);

/**
 * PATCH /users/me/handle
 * Authoritative set/revert of the caller's handle (full server-side transaction).
 * Auth required; id from the session.
 */
router.patch("/me/handle", requireAuth, longFormBody, handleController.updateMyHandle);

/**
 * GET /users/me/linked-accounts
 * The caller's linked providers (credential / google / github) and the email each
 * is linked as — drives the "Connected" rows in the settings panel. Auth required;
 * id + email come from the session, never the request. Declared before `/:id` so
 * "me" is never swallowed as an id param.
 */
router.get("/me/linked-accounts", requireAuth, usersController.getLinkedAccounts);

/**
 * GET /users/me/watch-time
 * The caller's own watch time — today, this week, this month, this year — plus a 30-day series
 * and a 24-bucket hour histogram. Auth required; the id comes from the session and there is
 * deliberately no `/:id` counterpart. Optional `?timeZone=` decides where a day starts and is
 * trusted for nothing else. Declared before `/:id` so "me" is never swallowed as an id param.
 */
router.get("/me/watch-time", requireAuth, engagementController.getMyWatchTime);

/**
 * GET /users/me/muted-creators
 * The channels the caller has told the feed not to recommend. Same arrangement as
 * `/me/watch-time` directly above: an engagement-module controller on this router,
 * because this is where a client looks for facts about itself, and declared before `/:id`
 * so "me" is never swallowed as an id param.
 *
 * THIS ROUTE IS WHAT MAKES THE MUTE REVERSIBLE. A muted creator's videos never reach the
 * feed again, so the card carrying the undo control is exactly the card now hidden —
 * without a list, nothing anywhere could lift the mute. Read-only and unpaginated; see
 * the service for why a cursor here would be machinery for a page that cannot exist.
 */
router.get("/me/muted-creators", requireAuth, engagementController.listMyMutedCreators);

/**
 * GET /users/me/not-interested-videos
 * The videos the caller told the feed not to recommend. The other half of the pair directly
 * above, and it exists for the same reason: the in-menu Undo lives on the card that is now
 * hidden, so without a list a dismissal is permanent by accident.
 *
 * PAGINATED, WHERE `/me/muted-creators` IS NOT. Muting is a deliberate act against a channel
 * and tops out in the tens; dismissing is one tap on one card and accumulates without limit.
 * `?limit=` (1..50, default 20) and `?cursor=` — keyset, so a malformed cursor is a 422 and
 * never a silent first page.
 */
router.get(
  "/me/not-interested-videos",
  requireAuth,
  engagementController.listMyNotInterestedVideos,
);

/**
 * GET /users/me/video-reports
 * The caller's own content reports and how each was resolved — the data behind
 * `/report-history`. Third in this small family of self-reads, declared before `/:id`.
 *
 * IT IS HERE RATHER THAN ON THE REPORTS ROUTER because `GET /videos/reports` would be one
 * segment deep and permanently shadowed by the studio router's `GET /:videoId`.
 *
 * NO CAPABILITY, and the projection is deliberately narrow: the reporter learns their
 * report's status and nothing about who decided it or who else reported the same video.
 */
router.get("/me/video-reports", requireAuth, videoContentReportsController.listMyVideoReports);

/**
 * GET /users/me/liked-videos
 * GET /users/me/saved-videos
 * GET /users/me/subscriptions
 *
 * THE LIBRARY READS — the three collections `/library` could not render because nothing listed
 * them. Their WRITE halves have shipped since §3.1: `PUT`/`DELETE /videos/:videoId/like`,
 * `.../save` and `/creators/:creatorId/subscribe` have been filling `video_like`, `video_save`
 * and `creator_subscription` the whole time, and no route anywhere read a row back. A viewer
 * could like a video and then have no way to find it again.
 *
 * ON THIS ROUTER, LIKE THE REST OF THE `/me` FAMILY, and declared before `/:id` so "me" is
 * never swallowed as an id param. The controllers are engagement-module ones, the same seam
 * `/me/watch-time` above documents: the reads are engagement-domain, the paths belong where a
 * client already looks for facts about itself.
 *
 * ALL THREE ARE PAGINATED — `?limit=` (1..50, default 20) and `?cursor=`, keyset, so a
 * malformed cursor is a 422 and never a silent first page. That includes subscriptions, where
 * `/me/muted-creators` above is deliberately unpaginated; the service explains why the same
 * test lands on opposite sides for the two.
 *
 * THE TWO VIDEO LISTS ARE PUBLIC-GATED and `/me/not-interested-videos` above is not — a like
 * hides nothing, so its list must not become an oracle over a creator's withdrawn catalogue,
 * while a dismissal DOES hide content and gating its undo list would make the preference
 * unliftable. `listCollectedVideos` states the whole argument.
 */
router.get("/me/liked-videos", requireAuth, engagementController.listMyLikedVideos);
router.get("/me/saved-videos", requireAuth, engagementController.listMySavedVideos);
router.get("/me/subscriptions", requireAuth, engagementController.listMySubscriptions);

/**
 * GET /users/me/creator-summary
 * The caller's own lifetime totals — subscribers, published videos, views — behind
 * `/studio/analytics`.
 *
 * IT IS HERE RATHER THAN ON THE VIDEOS ROUTER for the reason `/me/video-reports` directly above
 * records: `app.ts` mounts `videosRouter` at `/videos` first, so any two-segment `/videos/X` is
 * permanently shadowed by that router's `GET /:videoId`.
 *
 * ZERO, NOT NULL, for a creator with no stats row — see the service, which explains why this is
 * the opposite call to `/me/watch-time` and why both are right.
 */
router.get("/me/creator-summary", requireAuth, creatorAnalyticsController.getCreatorSummary);

/**
 * GET /users/me/video-analytics
 * Per-video counters for the caller's own videos. Page and limit only — there is no `?sort=`,
 * because `video_stats` has no index to order by.
 *
 * The counters are QATOTO-SIDE. A YouTube-hosted video's own views live in the creator's YouTube
 * Studio; these count watching that happened here, through the §3.3 beacon.
 */
router.get("/me/video-analytics", requireAuth, creatorAnalyticsController.listVideoAnalytics);

/**
 * GET /users/me/video-comments
 * Every comment across the caller's own videos, newest first — the data behind
 * `/studio/comments`. Fifth in this family of self-reads, declared before `/:id`.
 *
 * IT ADDS NO AUTHORIZATION. `DELETE /comments/:commentId` has always allowed the video's creator
 * as well as the comment's author (HOME §8.4); this is the read that finally lets them find the
 * comment without opening each video in turn.
 *
 * INCLUDES REPLIES, which is why `0136` adds a non-partial index — the public thread's index
 * covers top-level comments only, and an inbox built on it would silently hide most of them.
 */
router.get("/me/video-comments", requireAuth, engagementController.listMyVideoComments);

/**
 * POST /users/me/deletion-request
 * Deactivate the caller's own account NOW and schedule its anonymization 30 days out.
 *
 * NO `requireIdentifiedUser`. Every other write that matters carries it, and this one
 * deliberately does not: it would 403 an anonymous account into a dead end where it
 * cannot close itself, which is the opposite of what a right to erasure is for.
 *
 * NO BODY PARSER, because there is no body. The subject is the session (§1.1) and the
 * grace period is the server's — there is nothing a client could send here that the
 * server would not have to overrule. `json-body-budget.test.ts` fails the build for a
 * body cap on a route that reads none.
 *
 * THERE IS NO CANCEL ROUTE. Signing in is the cancel — see
 * `databaseHooks.session.create.before` in `src/lib/auth.ts`.
 *
 * Declared before `/:id` so "me" is never swallowed as an id param.
 */
router.post(
  "/me/deletion-request",
  requireAuth,
  accountDeletionRequestLimiter,
  privacyController.createDeletionRequest,
);

/**
 * POST /users/me/export
 * Ask for a copy of everything held about the caller (GDPR Art. 15/20). Answers **202** —
 * a worker builds the archive and `GET` below reports on it.
 *
 * `requireIdentifiedUser` HERE, unlike the deletion route above, and the asymmetry is the
 * point: an anonymous throwaway generating full-table walks is a denial-of-service with no
 * subject-access argument behind it, whereas an anonymous account closing ITSELF is
 * exactly the right this exists to serve.
 */
router.post(
  "/me/export",
  requireAuth,
  dataExportRequestLimiter,
  requireIdentifiedUser,
  privacyController.createDataExport,
);

/**
 * GET /users/me/export
 * The caller's latest export, plus a five-minute download link once it is ready.
 *
 * Its own limiter, separate from the request one above, because the panel polls this every
 * three seconds while a file builds — and polling must never consume the allowance needed
 * to ask for the export in the first place.
 */
router.get("/me/export", requireAuth, dataExportStatusLimiter, privacyController.getDataExport);

/**
 * GET /users/:id
 * One account by id. **STAFF ONLY**, same reasoning as `GET /users` above — it leaked the
 * same addresses, one row at a time.
 */
router.get("/:id", requireAuth, usersController.getUserById);

export default router;
