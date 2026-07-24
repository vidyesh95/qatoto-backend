import type { Request, Response } from "express";
import { rateLimit, type Options } from "express-rate-limit";

import type { ApiResponse } from "#src/types/index.js";

/**
 * Rate limiters for the OTP signup endpoints.
 *
 * Better Auth's own rate limiter does NOT cover these routes: they call
 * `auth.api.*` server-side, and "server-side requests made using auth.api aren't
 * affected by rate limiting" (Better Auth docs). So these Express limiters are the
 * primary defense against OTP spam / email-bombing on our custom routes.
 *
 * Two independent angles guard /signup/start:
 *   - per-IP   → one client can't blast codes at many different inboxes.
 *   - per-email → one inbox can't be flooded with codes (anti-bomb), even via rotating IPs.
 */

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * 429 response in the project's ApiResponse envelope, surfacing the retry delay.
 */
function rateLimitExceededHandler(_req: Request, res: Response): void {
  const retryAfterHeader = res.getHeader("Retry-After");
  const retryAfterSeconds =
    typeof retryAfterHeader === "string" ? Number(retryAfterHeader) : undefined;

  const response: ApiResponse<{ retryAfterSeconds?: number }> = {
    status: "error",
    statusCode: 429,
    message: "Too many requests. Please wait before trying again.",
    data: retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined,
  };
  res.status(429).json(response);
}

/**
 * Lowercased, trimmed email from the request body — the per-email bucket key.
 * Non-string/missing emails collapse to one shared bucket; those requests fail
 * validation in the controller anyway.
 */
function emailKey(req: Request): string {
  const rawEmail: unknown = req.body?.email;
  return typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
}

const sharedOptions = {
  windowMs: FIFTEEN_MINUTES_MS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
} satisfies Partial<Options>;

/** /signup/start — at most 8 OTP-send requests per IP per 15 min. */
export const otpRequestIpLimiter = rateLimit({
  ...sharedOptions,
  limit: 8,
});

/** /signup/start — at most 4 OTP-send requests per email per 15 min. */
export const otpRequestEmailLimiter = rateLimit({
  ...sharedOptions,
  limit: 4,
  keyGenerator: emailKey,
});

/**
 * /signup/complete — at most 12 verify+create attempts per IP per 15 min.
 * Complements Better Auth's per-OTP `allowedAttempts` (3) guard on the code itself.
 */
export const signupCompleteIpLimiter = rateLimit({
  ...sharedOptions,
  limit: 12,
});

const ONE_MINUTE_MS = 60 * 1000;

/**
 * Authenticated-user key for per-account buckets. `requireAuth` runs before this
 * limiter and sets `req.user`, so the id is always present on the routes that use
 * it; the empty-string fallback only guards against misordering.
 */
function userKey(req: Request): string {
  return req.user?.id ?? "";
}

/**
 * GET /handles/availability — Tier-1 live check. Debounced typing (300–500ms)
 * still fires many calls per session, so cap each user at 60 probes/min. Keyed by
 * user id (not IP) so one user behind a shared NAT can't starve another, and a
 * single user can't hammer the cheap SELECT unbounded.
 */
export const handleAvailabilityLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST /products — cap listing creation at 30/min per seller. Keyed by user id
 * (requireAuth runs first) so one seller can't script-spam draft rows, while a
 * shared NAT doesn't starve other sellers.
 */
export const productCreateLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST /products/:id/images — image upload is the expensive path (5 MB buffer +
 * sharp decode/re-encode + Cloudinary round-trip). Cap at 60/min per seller;
 * a full 9-image listing is well within one window.
 */
export const productImageUploadLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

// ---------------------------------------------------------------------------
// Research & Development (R_AND_D_BACKEND_STRUCTURE.md §4a).
//
// All per-user, keyed on `userKey` because `requireAuth` runs first in every chain.
// Keying by IP instead would let one user behind a shared NAT starve another, and
// would be trivially defeated by rotating an IP — the point of these is to bound what
// ONE ACCOUNT can do, which is also why they sit alongside `requireIdentifiedUser`:
// the limiter bounds an account, the guard makes accounts expensive to mint.
// ---------------------------------------------------------------------------

/**
 * POST /research-projects — a project create is one transaction writing five rows
 * (project, founder member, interval, stats, genesis audit). 20/min is far above any
 * human wizard pace and well below script-spam.
 */
export const projectCreateLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST …/applications — the anti-spam surface that matters most on this domain: an
 * application is visible to a founder, so a flood is both a DB cost and a harassment
 * vector. The partial unique index already caps ONE live application per role, so this
 * bounds churn across many projects.
 */
export const applicationCreateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST …/invites — an invite lands in someone else's notifications, so this is
 * outbound-to-a-third-party and is capped tighter than inbound applications.
 */
export const inviteCreateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST /research-categories — the taxonomy is client-writable, which makes it a spam
 * surface (§5). Rows land `pending`, so the real cost of abuse is moderator time;
 * 5 per 15 minutes is generous for a wizard step nobody legitimately repeats.
 */
export const categoryCreateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST/DELETE …/watch — idempotent and cheap, but it moves a counter, so an unbounded
 * tap loop is pointless write amplification on the hottest row in the domain.
 */
export const projectWatchLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST …/cover — the expensive path: a 5 MB buffer, a sharp decode/re-encode, and a
 * Cloudinary round-trip. Mirrors productImageUploadLimiter but tighter, because a
 * project has exactly ONE cover and re-uploading it is rare.
 */
export const projectCoverUploadLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST …/roles — role churn is cheap but writes compensation strands too. Generous,
 * since a founder legitimately adds several roles in one sitting at publish time.
 */
export const projectRoleWriteLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST /discovery/problem-reports — THE sybil surface of the whole domain (§6).
 *
 * `problem_cluster.distinctReporterCount` is the entire integrity of the opportunity
 * score, so this limiter and `requireIdentifiedUser` are a PAIR: the guard makes minting
 * an identity expensive, and this bounds what one identity can do with it. Tighter than
 * applications because a report is anonymous-to-the-reader and therefore carries no social
 * cost to spam. Ten genuine civic reports in fifteen minutes is already an implausible
 * amount of typing.
 *
 * It also bounds outbound geocoding: every accepted report that misses the cache costs one
 * call against a 1 req/s provider budget.
 */
export const problemReportLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * PUT/DELETE /discovery/talent/me and the publish toggle — cheap writes, but publishing
 * flips a row into a directory other people read and invite from, so an unbounded
 * publish/unpublish loop is notification amplification once §5's invite flow reads it.
 */
export const talentProfileWriteLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST /discovery/admin/* — staff are trusted, but a COMPROMISED staff session is the
 * worst case in this domain: mass-approving spam taxonomy or mass-merging clusters
 * destroys `distinctReporterCount` irreversibly, because an approved merge deletes the
 * source rows. Generous enough for a real moderation sitting, low enough that scripted
 * mass-approval trips it and shows up in the logs.
 */
export const discoveryModerationLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST /videos — the ONLY route in the codebase that makes an outbound request on the
 * request path (the oEmbed verify, STUDIO_BACKEND_STRUCTURE.md §9), so this limiter is
 * that call's budget as much as it is abuse control.
 *
 * It is also LOAD-BEARING FOR A SCHEMA DECISION. §4 deliberately leaves
 * `video.youtubeVideoId` indexed but NOT unique, because two Qatoto rows may legitimately
 * point at one YouTube video, and defers abuse control ("one account spamming the feed
 * with one video") to exactly this limiter. Removing it re-opens that hole.
 */
export const videoCreateLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST /videos/:videoId/thumbnail — a 5 MB buffer, a sharp decode/re-encode and a
 * Cloudinary round-trip. Same shape and reasoning as projectCoverUploadLimiter: a video
 * has exactly one thumbnail and re-uploading it is rare.
 */
export const videoThumbnailUploadLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * /videos/admin/review* — staff throughput, mirroring discoveryModerationLimiter. A
 * moderator legitimately works through a queue quickly, so this is generous; it exists
 * to bound a COMPROMISED staff session, not to pace an honest one.
 */
export const contentReviewLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * The workshop board writes — create/rename/delete a column, create/update/delete/move a
 * task (§8).
 *
 * Generous, because a real drag session is a burst: reordering a board or triaging a
 * standup produces dozens of writes in a minute and none of them cost anything beyond one
 * row. This exists to bound a loop, not to pace a member.
 */
export const workshopBoardWriteLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST …/workshop/files — adding a link (§8).
 *
 * Tighter than the board because each accepted row is a URL other members will click, so
 * an unbounded loop is a way to fill a teammate's file list with links. It costs the
 * server nothing — there is no upload — which is exactly why the bound has to be about
 * the social surface rather than about load.
 */
export const workshopFileCreateLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST/PATCH …/workshop/chat — team chat (§8).
 *
 * Sized for a fast typist in a real conversation and no higher. Chat is the one §8 surface
 * that notifies other people, so the ceiling is about flooding a channel rather than about
 * database cost.
 */
export const chatMessageLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST/PATCH/DELETE …/daily-logs — draft writes (§8).
 *
 * A member files at most one log a day and edits it a handful of times, so this is
 * deliberately low. Each create may also cost one outbound oEmbed call to verify a pasted
 * YouTube link, and that budget is shared with the studio's upload path.
 */
export const dailyLogWriteLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});

/**
 * POST …/daily-logs/:logId/submit — the expensive one (§8).
 *
 * Every accepted submit queues one Gemini call, and that call is drawn against a FREE-TIER
 * REQUEST BUDGET shared by the whole deployment. The unique index already caps a member at
 * one log per claimed day, so this bounds the remaining lever: resubmitting a failed
 * analysis in a loop. Ten in fifteen minutes is far past any honest retry.
 */
export const dailyLogSubmitLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitExceededHandler,
  keyGenerator: userKey,
});
