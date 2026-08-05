import type { Request, Response } from "express";
import {
  ipKeyGenerator,
  rateLimit,
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";

import { createRateLimitStore } from "#src/middleware/rate-limit-store.js";
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

interface LimiterSpec {
  /**
   * This limiter's bucket namespace in the shared store, and its identity there.
   *
   * MUST BE UNIQUE — `createRateLimitStore` throws at module load on a duplicate, because
   * two limiters sharing a namespace would silently merge their buckets into a limit that is
   * wrong for both. Renaming one resets that limiter's live windows exactly once.
   */
  readonly namespace: string;
  readonly windowMs: number;
  readonly limit: number;
  /**
   * `userKey` by default, since all but three limiters sit behind `requireAuth`. Pass `"ip"`
   * to leave the key generator UNSET so express-rate-limit uses its own — that is what the
   * three signup limiters have always done, and it is an absence rather than a function, so
   * it cannot be expressed by passing something.
   */
  readonly keyGenerator?: ((req: Request) => string) | "ip";
}

/**
 * The one place a limiter is built, so the shared store cannot be forgotten on one.
 *
 * WHY A FACTORY. Thirty-three of these repeated the same five options inline and three
 * spread a `sharedOptions` object; adding `store:` to all of them by hand is a change that
 * looks done at thirty-five. It also has to be a NEW store per limiter — express-rate-limit
 * throws `ERR_ERL_STORE_REUSE` when one object is handed to two — with a distinct prefix, or
 * the library's double-count check fires on `/signup/start`, where an IP-keyed and an
 * email-keyed limiter stack and can produce the same key string.
 */
function createLimiter(spec: LimiterSpec): RateLimitRequestHandler {
  const options: Partial<Options> = {
    windowMs: spec.windowMs,
    limit: spec.limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitExceededHandler,
    store: createRateLimitStore(spec.namespace, spec.windowMs),
  };

  // Genuinely absent rather than `undefined`, so the library applies its own default instead
  // of us depending on its option-normalizing behaviour.
  if (spec.keyGenerator !== "ip") {
    options.keyGenerator = spec.keyGenerator ?? userKey;
  }

  return rateLimit(options);
}

/** /signup/start — at most 8 OTP-send requests per IP per 15 min. */
export const otpRequestIpLimiter = createLimiter({
  namespace: "otpRequestIp",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 8,
  keyGenerator: "ip",
});

/** /signup/start — at most 4 OTP-send requests per email per 15 min. */
export const otpRequestEmailLimiter = createLimiter({
  namespace: "otpRequestEmail",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 4,
  keyGenerator: emailKey,
});

/**
 * /signup/complete — at most 12 verify+create attempts per IP per 15 min.
 * Complements Better Auth's per-OTP `allowedAttempts` (3) guard on the code itself.
 */
export const signupCompleteIpLimiter = createLimiter({
  namespace: "signupCompleteIp",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 12,
  keyGenerator: "ip",
});

const ONE_MINUTE_MS = 60 * 1000;

/**
 * Authenticated-user key for per-account buckets. `requireAuth` runs before this limiter
 * and sets `req.user`, so the id is always present on the routes that use it.
 *
 * ⚠️ THE FALLBACK USED TO BE `""` AND THAT WAS A SHARED BUCKET (§11l.2 item 7). Every
 * unauthenticated caller keyed to the same empty string, so on any route where the ordering
 * was ever wrong — or where a limiter was mounted before `requireAuth` — one client could
 * exhaust the window for every anonymous caller at once. Harmless today because every
 * limiter using this key sits behind `requireAuth`; a self-inflicted denial of service the
 * first time one does not.
 *
 * The fallback is now the IP, through `ipKeyGenerator`, which is the helper
 * express-rate-limit exports precisely so an IPv6 caller is keyed by its /56 subnet rather
 * than by a single address it can trivially rotate within.
 */
function userKey(req: Request): string {
  const userId = req.user?.id;
  if (userId !== undefined) return userId;
  return ipKeyGenerator(req.ip ?? "");
}

/**
 * GET /handles/availability — Tier-1 live check. Debounced typing (300–500ms)
 * still fires many calls per session, so cap each user at 60 probes/min. Keyed by
 * user id (not IP) so one user behind a shared NAT can't starve another, and a
 * single user can't hammer the cheap SELECT unbounded.
 */
export const handleAvailabilityLimiter = createLimiter({
  namespace: "handleAvailability",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * POST /products — cap listing creation at 30/min per seller. Keyed by user id
 * (requireAuth runs first) so one seller can't script-spam draft rows, while a
 * shared NAT doesn't starve other sellers.
 */
export const productCreateLimiter = createLimiter({
  namespace: "productCreate",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});

/**
 * POST /products/:id/images — image upload is the expensive path (5 MB buffer +
 * sharp decode/re-encode + Cloudinary round-trip). Cap at 60/min per seller;
 * a full 9-image listing is well within one window.
 */
export const productImageUploadLimiter = createLimiter({
  namespace: "productImageUpload",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
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
export const projectCreateLimiter = createLimiter({
  namespace: "projectCreate",
  windowMs: ONE_MINUTE_MS,
  limit: 20,
});

/**
 * POST …/applications — the anti-spam surface that matters most on this domain: an
 * application is visible to a founder, so a flood is both a DB cost and a harassment
 * vector. The partial unique index already caps ONE live application per role, so this
 * bounds churn across many projects.
 */
export const applicationCreateLimiter = createLimiter({
  namespace: "applicationCreate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
});

/**
 * POST …/invites — an invite lands in someone else's notifications, so this is
 * outbound-to-a-third-party and is capped tighter than inbound applications.
 */
export const inviteCreateLimiter = createLimiter({
  namespace: "inviteCreate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
});

/**
 * POST /research-categories — the taxonomy is client-writable, which makes it a spam
 * surface (§5). Rows land `pending`, so the real cost of abuse is moderator time;
 * 5 per 15 minutes is generous for a wizard step nobody legitimately repeats.
 */
export const categoryCreateLimiter = createLimiter({
  namespace: "categoryCreate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 5,
});

/**
 * POST/DELETE …/watch — idempotent and cheap, but it moves a counter, so an unbounded
 * tap loop is pointless write amplification on the hottest row in the domain.
 */
export const projectWatchLimiter = createLimiter({
  namespace: "projectWatch",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * POST …/cover — the expensive path: a 5 MB buffer, a sharp decode/re-encode, and a
 * Cloudinary round-trip. Mirrors productImageUploadLimiter but tighter, because a
 * project has exactly ONE cover and re-uploading it is rare.
 */
export const projectCoverUploadLimiter = createLimiter({
  namespace: "projectCoverUpload",
  windowMs: ONE_MINUTE_MS,
  limit: 20,
});

/**
 * POST …/roles — role churn is cheap but writes compensation strands too. Generous,
 * since a founder legitimately adds several roles in one sitting at publish time.
 */
export const projectRoleWriteLimiter = createLimiter({
  namespace: "projectRoleWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
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
export const problemReportLimiter = createLimiter({
  namespace: "problemReport",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
});

/**
 * PUT/DELETE /discovery/talent/me and the publish toggle — cheap writes, but publishing
 * flips a row into a directory other people read and invite from, so an unbounded
 * publish/unpublish loop is notification amplification once §5's invite flow reads it.
 */
export const talentProfileWriteLimiter = createLimiter({
  namespace: "talentProfileWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});

/**
 * POST /discovery/admin/* — staff are trusted, but a COMPROMISED staff session is the
 * worst case in this domain: mass-approving spam taxonomy or mass-merging clusters
 * destroys `distinctReporterCount` irreversibly, because an approved merge deletes the
 * source rows. Generous enough for a real moderation sitting, low enough that scripted
 * mass-approval trips it and shows up in the logs.
 */
export const discoveryModerationLimiter = createLimiter({
  namespace: "discoveryModeration",
  windowMs: ONE_MINUTE_MS,
  limit: 120,
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
export const videoCreateLimiter = createLimiter({
  namespace: "videoCreate",
  windowMs: ONE_MINUTE_MS,
  limit: 20,
});

/**
 * POST /videos/:videoId/thumbnail — a 5 MB buffer, a sharp decode/re-encode and a
 * Cloudinary round-trip. Same shape and reasoning as projectCoverUploadLimiter: a video
 * has exactly one thumbnail and re-uploading it is rare.
 */
export const videoThumbnailUploadLimiter = createLimiter({
  namespace: "videoThumbnailUpload",
  windowMs: ONE_MINUTE_MS,
  limit: 20,
});

/**
 * /videos/admin/review* — staff throughput, mirroring discoveryModerationLimiter. A
 * moderator legitimately works through a queue quickly, so this is generous; it exists
 * to bound a COMPROMISED staff session, not to pace an honest one.
 */
export const contentReviewLimiter = createLimiter({
  namespace: "contentReview",
  windowMs: ONE_MINUTE_MS,
  limit: 120,
});

/**
 * The workshop board writes — create/rename/delete a column, create/update/delete/move a
 * task (§8).
 *
 * Generous, because a real drag session is a burst: reordering a board or triaging a
 * standup produces dozens of writes in a minute and none of them cost anything beyond one
 * row. This exists to bound a loop, not to pace a member.
 */
export const workshopBoardWriteLimiter = createLimiter({
  namespace: "workshopBoardWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 120,
});

/**
 * POST …/workshop/files — adding a link (§8).
 *
 * Tighter than the board because each accepted row is a URL other members will click, so
 * an unbounded loop is a way to fill a teammate's file list with links. It costs the
 * server nothing — there is no upload — which is exactly why the bound has to be about
 * the social surface rather than about load.
 */
export const workshopFileCreateLimiter = createLimiter({
  namespace: "workshopFileCreate",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});

/**
 * POST/PATCH …/workshop/chat — team chat (§8).
 *
 * Sized for a fast typist in a real conversation and no higher. Chat is the one §8 surface
 * that notifies other people, so the ceiling is about flooding a channel rather than about
 * database cost.
 */
export const chatMessageLimiter = createLimiter({
  namespace: "chatMessage",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * POST/PATCH/DELETE …/daily-logs — draft writes (§8).
 *
 * A member files at most one log a day and edits it a handful of times, so this is
 * deliberately low. Each create may also cost one outbound oEmbed call to verify a pasted
 * YouTube link, and that budget is shared with the studio's upload path.
 */
export const dailyLogWriteLimiter = createLimiter({
  namespace: "dailyLogWrite",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
});

/**
 * POST …/daily-logs/:logId/submit — the expensive one (§8).
 *
 * Every accepted submit queues one Gemini call, and that call is drawn against a FREE-TIER
 * REQUEST BUDGET shared by the whole deployment. The unique index already caps a member at
 * one log per claimed day, so this bounds the remaining lever: resubmitting a failed
 * analysis in a loop. Ten in fifteen minutes is far past any honest retry.
 */
export const dailyLogSubmitLimiter = createLimiter({
  namespace: "dailyLogSubmit",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
});

/**
 * POST …/effort-claims and …/reverify — the input to the entire equity ledger (§9).
 *
 * Every accepted claim queues a four-stage pipeline whose grounding stage fans out across
 * external providers. A member files at most one claim per daily log — the unique index
 * says so — which leaves re-verification as the only lever, and this bounds it. It is also
 * the anti-griefing bound on `reverify`, which any member may call on any claim: twenty in
 * fifteen minutes is far past any honest use and far below anything that would exhaust a
 * worker.
 */
export const effortClaimLimiter = createLimiter({
  namespace: "effortClaim",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
});

/**
 * POST …/dispute, …/votes, …/resolve, …/withdraw — the consensus surface (§9.8).
 *
 * A dispute FREEZES another member's slices, so the abuse case is real: raise, withdraw,
 * raise again, forever. The original-clock rule already defeats the hostage-taking, and
 * this bounds the noise it would generate on the transparency ledger.
 */
export const disputeLimiter = createLimiter({
  namespace: "dispute",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
});

/**
 * POST …/fair-market-rate and …/lock — negotiating the one number a body may carry (§9.6).
 *
 * Low on purpose. A rate is negotiated between two people over days, not adjusted in a
 * loop, and each proposal appends to an immutable hash chain that nobody can prune.
 */
export const fairMarketRateLimiter = createLimiter({
  namespace: "fairMarketRate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 15,
});

/**
 * GET …/audit-trail/verify — re-walks and re-hashes every entry in a project's chain (§9.9).
 *
 * Unbounded, this is a cheap way to make the server SHA-256 a few hundred thousand rows on
 * demand. It is also the endpoint a monitoring dashboard polls, so the bound is generous
 * enough for a minute-by-minute check and nothing more.
 */
export const chainVerifyLimiter = createLimiter({
  namespace: "chainVerify",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
});

/**
 * POST /funding-rounds/:roundId/pledges — the money path's front door (§4a, §7).
 *
 * LOW, and for a reason that is not throughput. Every pledge appends three rows to an
 * append-only hash-chained ledger that nobody can prune, so a loop here is a loop that
 * permanently enlarges a financial record. It also increments a public backer count once
 * settled, which is the number an outsider reads as social proof.
 *
 * Fifteen in fifteen minutes is far past any honest backer and far below anything that
 * would make a ledger unreadable.
 */
export const pledgeLimiter = createLimiter({
  namespace: "pledge",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 15,
});

/**
 * POST · PATCH on funding rounds and milestones (§7).
 *
 * Founder-facing planning writes. Higher than the pledge bound because editing a roadmap
 * is a normal burst — a founder laying out eight milestones in a sitting is not abuse —
 * and none of it moves money on its own.
 */
export const fundingRoundWriteLimiter = createLimiter({
  namespace: "fundingRoundWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * POST …/escrow-releases, …/approve, …/reject — the four-eyes surface (§7).
 *
 * The lowest bound in this file. A release request is a payout request; an approval is a
 * payout. Neither is a thing anyone does in a loop, and both append to the ledger.
 * A low ceiling here also blunts the obvious grief: request, get rejected, request again.
 */
export const escrowReleaseLimiter = createLimiter({
  namespace: "escrowRelease",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
});

/**
 * POST /provider-transfers/:transferId/settle · /fail — staff only, and still bounded.
 *
 * The caller already holds `audit_escrow`, so this is not an anti-abuse bound: it is a
 * blast-radius bound. Settlement is the ONE path that moves `raisedAmountInCents`, and a
 * compromised or scripted auditor session should not be able to walk the whole pending
 * queue in a second.
 */
export const escrowSettlementLimiter = createLimiter({
  namespace: "escrowSettlement",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * POST …/members/:id/compensation-agreement · …/accept (§7A.2).
 *
 * A negotiation, not a loop. A founder proposing pay for a ten-person team in one sitting
 * fits comfortably; a script walking every member id does not. The accept side shares the
 * bound because it is the same conversation from the other end.
 */
export const compensationAgreementLimiter = createLimiter({
  namespace: "compensationAgreement",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
});

/**
 * POST …/compensation-periods/:id/finalize · /countersign · /supersede (§7A.5).
 *
 * The lowest bound in this file, and for the same reason `escrowReleaseLimiter` was:
 * these are the acts that decide what someone is owed, and none of them is a thing anyone
 * does in a loop. Finalizing is once a month per project. A low ceiling also blunts the
 * obvious grief — supersede, supersede, supersede — which would otherwise let one account
 * fill a project's audit chain with reversals.
 */
export const compensationPeriodDecisionLimiter = createLimiter({
  namespace: "compensationPeriodDecision",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
});

/**
 * POST …/compensation-period-lines/:lineId/payments · …/confirm (§7A).
 *
 * Higher than the decision bound because a founder settling a month for a large team
 * records one attestation per line in a single sitting, and each one is append-only
 * evidence rather than a state change. The idempotency key already makes a retried POST
 * harmless, so this is an abuse bound rather than a correctness one.
 */
export const paymentRecordLimiter = createLimiter({
  namespace: "paymentRecord",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 120,
});

/**
 * POST /suppliers · PATCH /suppliers/:supplierId (§11i).
 *
 * NOT AN ANTI-ABUSE BOUND — the caller already holds `moderate_taxonomy`, so this is a
 * blast-radius bound, the same reasoning `escrowSettlementLimiter` records. A moderator
 * curating a directory in one sitting adds a handful of listings; a compromised staff
 * session should not be able to rewrite the whole catalogue before anyone notices.
 *
 * Deliberately keyed on `req.user.id` like every other limiter here, which means it runs
 * AFTER `requireAuth` and BEFORE the in-service capability check. A non-moderator therefore
 * spends their own budget discovering they are not staff, rather than the moderator's.
 */
export const supplierWriteLimiter = createLimiter({
  namespace: "supplierWrite",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 60,
});

// ---------------------------------------------------------------------------
// §10 research programs (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
//
// This surface is PUBLIC UGC at scale — anyone signed in may create branches, upload
// papers, post, reply, react and report — so unlike the project surfaces, most of these
// really are anti-abuse bounds rather than blast-radius ones. Every limiter is keyed on
// `req.user.id` (the default), which means an unauthenticated caller never reaches one.
// ---------------------------------------------------------------------------

/**
 * POST /research-programs (§11f).
 *
 * Deliberately tight. A program is a public top-level entity that lands in a human
 * moderator's review queue, so the cost of abuse is somebody's attention rather than a
 * row — and a queue flooded faster than it can be read is a queue that stops being read.
 * Nobody legitimately proposes four research programs in a quarter of an hour.
 */
export const programCreateLimiter = createLimiter({
  namespace: "programCreate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 3,
});

/**
 * POST · PATCH …/branches, and POST · DELETE …/branches/:branchId/claim (§11f).
 *
 * One limiter for both, on purpose: a re-parent rewrites a whole subtree's `ancestorPath`
 * in one transaction, which is the most expensive write on this surface, and a claim
 * toggle is the cheapest. Sharing the bucket means a loop cannot spend the cheap budget to
 * drive the expensive path.
 */
export const programBranchWriteLimiter = createLimiter({
  namespace: "programBranchWrite",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 60,
});

/** POST …/papers — the metadata row. Cheap, but it consumes a DOI uniquely (§11f). */
export const paperCreateLimiter = createLimiter({
  namespace: "paperCreate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
});

/**
 * POST …/papers/:paperId/file (§11f).
 *
 * The most expensive request in the domain: up to 25 MB buffered in memory, hashed, and
 * PUT to object storage. Lower than `paperCreate` because a metadata row that never gets a
 * file costs a row, while an upload loop costs bandwidth and storage priced per gigabyte.
 */
export const paperUploadLimiter = createLimiter({
  namespace: "paperUpload",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
});

/** GET …/papers/:paperId/download — mints a presigned URL. Signing is cheap; a link is a capability. */
export const paperDownloadLimiter = createLimiter({
  namespace: "paperDownload",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 120,
});

/** POST …/posts and …/posts/:postId/replies — the discussion surface (§11f). */
export const programPostCreateLimiter = createLimiter({
  namespace: "programPostCreate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
});

/**
 * PUT · DELETE …/posts/:postId/reaction (§11f).
 *
 * GENEROUS BY DESIGN, and the reason is worth stating: reactions are idempotent by verb, so
 * a double-tap is already harmless and a user scrolling a long thread legitimately fires
 * many. This is a bound on scripted vote manipulation, not on enthusiasm — the per-user
 * unique index is what actually stops one person inflating a count.
 */
export const postReactionLimiter = createLimiter({
  namespace: "postReaction",
  windowMs: ONE_MINUTE_MS,
  limit: 120,
});

/**
 * POST …/posts/:postId/report · …/papers/:paperId/report (§11f).
 *
 * A report costs a moderator's attention, and one report per user per target is already
 * enforced by a partial unique index — so this bounds someone walking the whole program
 * reporting everything, which the unique index cannot see.
 */
export const contentReportLimiter = createLimiter({
  namespace: "contentReport",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
});

/**
 * POST …/effort-logs · …/contributions (§11f).
 *
 * Both carry a body-level idempotency key with a unique index, so a retry is already
 * harmless. This is an abuse bound: effort minutes feed a public stat tile, and a loop
 * could inflate "hours logged" even though nothing about it touches equity.
 */
export const researchEffortLogLimiter = createLimiter({
  namespace: "researchEffortLog",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 60,
});

/** POST /research-paper-categories — the taxonomy is a spam surface, so it is moderated and bounded. */
export const paperCategoryCreateLimiter = createLimiter({
  namespace: "paperCategoryCreate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
});

/**
 * The §10 moderation writes — program, paper and post decisions, and report dismissal.
 *
 * NOT AN ANTI-ABUSE BOUND. The caller already holds `moderate_content`, so this is a
 * blast-radius bound in the same spirit as `supplierWriteLimiter`: a compromised staff
 * session should not be able to hide an entire program's discussion before anyone notices.
 * Generous, because clearing a backlog in one sitting is the normal case.
 *
 * Keyed on `req.user.id` like every other limiter, so it runs after `requireAuth` and
 * BEFORE the in-controller capability check — a non-moderator therefore spends their own
 * budget discovering they are not staff, rather than a moderator's.
 */
export const programModerationLimiter = createLimiter({
  namespace: "programModeration",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 200,
});

/**
 * PUT /admin/platform-roles — granting and revoking staff roles.
 *
 * THE TIGHTEST LIMIT IN THIS FILE, and the reason is blast radius rather than abuse: the
 * caller already holds `manage_platform_roles`, so this bounds what a stolen ADMIN session
 * can do before anyone reads the audit chain. Promoting a handful of accounts is the normal
 * case; promoting twenty in a quarter hour is an incident.
 *
 * Runs after `requireAuth` and before the in-service capability check, so a non-admin spends
 * their own budget learning they are not one.
 */
export const platformRoleWriteLimiter = createLimiter({
  namespace: "platformRoleWrite",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
});

/**
 * POST · PATCH …/contributors/me, and the product-opportunity writes.
 *
 * One bucket for a person's own participation record plus the creator-only opportunity
 * rail: both are low-frequency, self-describing writes with no fan-out.
 */
export const programProfileWriteLimiter = createLimiter({
  namespace: "programProfileWrite",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
});

/**
 * The promotional-carousel admin writes — create, update, reorder, delete, and the admin
 * list.
 *
 * ONE BUCKET for all of them: they are low-frequency staff actions against a table that
 * holds at most a dozen rows, and splitting them would document a distinction that does
 * not exist. Thirty a minute is far above any human merchandising pace and far below
 * anything that could hurt.
 */
export const promotionalSlideWriteLimiter = createLimiter({
  namespace: "promotionalSlideWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});

/**
 * The two multipart routes — create and image replace.
 *
 * The expensive path: a 5 MB buffer, a sharp decode and AVIF re-encode, and a Cloudinary
 * round trip, per request. Tighter than the write bucket because the cost is CPU and
 * egress rather than a row.
 *
 * NOTE that POST /promotions/admin/slides carries ONLY this limiter, not both — stacking
 * two limiters on one route double-counts every request against the stricter of them.
 */
export const promotionalSlideImageUploadLimiter = createLimiter({
  namespace: "promotionalSlideImageUpload",
  windowMs: ONE_MINUTE_MS,
  limit: 20,
});

/**
 * Spotlight admin reads and the whole-set replace write.
 *
 * Same shape as the promotional-slide write bucket: low-frequency staff actions against a
 * three-row table. Thirty a minute is far above any human merchandising pace.
 */
export const spotlightWriteLimiter = createLimiter({
  namespace: "spotlightWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});

// ---------------------------------------------------------------------------
// HOME FEED ENGAGEMENT (HOME_BACKEND_STRUCTURE.md §7)
//
// EVERY LIMITER BELOW USES THE DEFAULT `userKey`, including the ones on optional-auth
// routes, and that is deliberate. `userKey` already falls back to
// `ipKeyGenerator(req.ip)`, so a signed-in caller gets a per-account bucket and an
// anonymous one gets an IPv6-/56 bucket — out of ONE generator. Passing
// `keyGenerator: "ip"` would be strictly worse: it would drop every signed-in viewer
// into the shared NAT bucket alongside everyone else at their office.
//
// CONSEQUENCE FOR ROUTE ORDER: `attachOptionalUser` MUST precede these limiters, or a
// signed-in viewer is keyed by IP anyway.
// ---------------------------------------------------------------------------

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * GET /feed/watch/:videoId and GET /videos/:videoId/comments.
 *
 * A DELIBERATE DEPARTURE from the "no limiter on a public read" rule stated in
 * feed.routes.ts and promotions.routes.ts. That rule exists because an IP-keyed bucket
 * on a viewer-independent, cacheable response is a self-inflicted outage behind a
 * corporate NAT. Neither of these responses is that: both carry `viewerState`, so they
 * are per-video AND per-viewer, no cache absorbs them, and each one runs real joins.
 *
 * 300/min is set so that a large NAT never reaches it and a scraper does.
 */
export const feedReadLimiter = createLimiter({
  namespace: "feedRead",
  windowMs: ONE_MINUTE_MS,
  limit: 300,
});

/** Public `/store/*` reads — same bound and optional-auth keying as the home feed. */
export const storeReadLimiter = createLimiter({
  namespace: "storeRead",
  windowMs: ONE_MINUTE_MS,
  limit: 300,
});

/** Authenticated commerce provider mutations. */
export const commerceProviderWriteLimiter = createLimiter({
  namespace: "commerceProviderWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * Authenticated commerce organization profile, membership, address, activation,
 * and moderation mutations. Bound below the provider write limiter because org
 * creation and member invites are higher-value abuse targets.
 */
export const commerceOrganizationWriteLimiter = createLimiter({
  namespace: "commerceOrganizationWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});

/**
 * Verification evidence uploads. Separate from ordinary org writes because each
 * attempt stores encrypted private bytes and must stay expensive to spray.
 */
export const commerceOrganizationEvidenceLimiter = createLimiter({
  namespace: "commerceOrganizationEvidence",
  windowMs: ONE_MINUTE_MS,
  limit: 10,
});

/**
 * RFQ create/open/invite/close mutations. Bound tightly because broadcast invites
 * can fan out to many providers and are a high-value abuse target.
 */
export const commerceRfqWriteLimiter = createLimiter({
  namespace: "commerceRfqWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});

/** Quote draft/revision/submit/accept/decline/withdraw mutations. */
export const commerceQuoteWriteLimiter = createLimiter({
  namespace: "commerceQuoteWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/** Negotiation message appends on RFQ/quote threads. */
export const commerceMessageWriteLimiter = createLimiter({
  namespace: "commerceMessageWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * Cart line set/remove mutations (Store Phase 4). Generous — a buyer legitimately
 * adjusts quantities across many product lines while assembling an order — but still
 * bounded, since each write takes a row lock and supersedes any active checkout prepare.
 */
export const commerceCartWriteLimiter = createLimiter({
  namespace: "commerceCartWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * Checkout prepare/confirm (Store Phase 4). Tighter than cart writes: prepare holds
 * inventory reservations and confirm decrements stock and creates orders, so both are
 * bound well below honest checkout pace while still allowing legitimate retries.
 */
export const commerceCheckoutWriteLimiter = createLimiter({
  namespace: "commerceCheckoutWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 20,
});

/**
 * POST /videos/:videoId/view-beacon — the BURST half of §7's "60/min, 200/hr".
 *
 * TWO LIMITERS RATHER THAN ONE, because `LimiterSpec` carries a single window and
 * `createRateLimitStore` is keyed to it. Chained on the route, exactly like
 * `/signup/start` stacks its IP and email buckets. Each has its own namespace and
 * therefore its own store prefix, which is what keeps express-rate-limit's
 * double-count guard quiet.
 *
 * Burst is declared FIRST so a burst violator's `Retry-After` names the minute rather
 * than the hour.
 *
 * The client heartbeats every ~15s, so 60/min is 15x an honest single-tab viewer.
 */
export const viewBeaconBurstLimiter = createLimiter({
  namespace: "viewBeaconBurst",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/**
 * POST /videos/:videoId/view-beacon — the SUSTAINED half.
 *
 * The burst bound alone permits 3,600/hr, which is a farm running at a comfortable
 * walking pace. 200/hr is roughly 50 minutes of continuous honest playback, and it is
 * the bound that actually costs an attacker something.
 *
 * This is the tightest pair on the platform because the beacon is the only
 * unauthenticated write on it.
 */
export const viewBeaconSustainedLimiter = createLimiter({
  namespace: "viewBeaconSustained",
  windowMs: ONE_HOUR_MS,
  limit: 200,
});

/**
 * POST /videos/:videoId/playback-error (§8.2).
 *
 * A player fires `onError` once per video per load, so this is not a throughput bound.
 * It bounds the manufacture of the three distinct fingerprints that flip a
 * competitor's video to `uploadStatus: "failed"`. The distinct-fingerprint requirement
 * is the real defence; this stops one client walking the catalogue reporting
 * everything.
 */
export const playbackErrorLimiter = createLimiter({
  namespace: "playbackError",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
});

/**
 * PUT · DELETE /videos/:videoId/like.
 *
 * Generous, for the same reason `programPostReactionLimiter` is: the verb is already
 * idempotent and the unique index is what stops one person inflating a count. This
 * bounds scripted manipulation, not enthusiasm.
 */
export const videoLikeLimiter = createLimiter({
  namespace: "videoLike",
  windowMs: ONE_MINUTE_MS,
  limit: 120,
});

/** PUT · DELETE /videos/:videoId/save — watch-later. Same shape, same reasoning. */
export const videoSaveLimiter = createLimiter({
  namespace: "videoSave",
  windowMs: ONE_MINUTE_MS,
  limit: 120,
});

/**
 * POST /videos/:videoId/share.
 *
 * Tighter than like/save because a share APPENDS a row rather than toggling one, and
 * because it is the one engagement write reachable without a full account — so this
 * limiter carries the weight `requireIdentifiedUser` carries everywhere else.
 */
export const videoShareLimiter = createLimiter({
  namespace: "videoShare",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 60,
});

/**
 * POST /videos/:videoId/comments.
 *
 * §8.4 ships comments with NO reporting flow and NO automated moderation, so this
 * limiter plus the 2000-character cap is the entire anti-spam story for v1. Sized for
 * a fast typist in a real thread and no higher.
 */
export const commentCreateLimiter = createLimiter({
  namespace: "commentCreate",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 30,
});

/** PATCH · DELETE /comments/:commentId — a person editing their own words. */
export const commentUpdateLimiter = createLimiter({
  namespace: "commentUpdate",
  windowMs: ONE_MINUTE_MS,
  limit: 60,
});

/** PUT · DELETE /comments/:commentId/like — same reasoning as videoLikeLimiter. */
export const commentLikeLimiter = createLimiter({
  namespace: "commentLike",
  windowMs: ONE_MINUTE_MS,
  limit: 120,
});

/**
 * PUT · DELETE /creators/:creatorId/subscribe.
 *
 * Tighter than a like because a subscribe moves a PUBLIC counter on somebody else's
 * profile — the same split `inviteCreateLimiter` makes against `applicationCreateLimiter`.
 */
export const subscribeLimiter = createLimiter({
  namespace: "subscribe",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 60,
});

// NOT HERE, deliberately: `feedCategoriesLimiter`. §7 names it, but feed.routes.ts
// already refused it in writing — `/feed/categories` is a small, viewer-independent,
// cacheable list, and an IP-keyed bucket on it is an outage behind a shared NAT.
// Exporting an unused limiter would satisfy the coverage test while documenting a bound
// nothing enforces, which is worse than not having one.

/**
 * Order cancel mutations (Store Phase 4). A buyer or counterparty cancels an order at
 * most a handful of times; the state-predicate update already makes a retried POST
 * harmless, so this bounds a scripted cancel loop rather than honest use.
 */
export const commerceOrderWriteLimiter = createLimiter({
  namespace: "commerceOrderWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});

/**
 * Shipment create/event and service-engagement transition mutations (Store Phase 4).
 * Each write commits inventory or state changes visible to the other party, so this is
 * bound below honest counterparty-operations pace while still tolerating idempotent retries.
 */
export const commerceFulfillmentWriteLimiter = createLimiter({
  namespace: "commerceFulfillmentWrite",
  windowMs: ONE_MINUTE_MS,
  limit: 30,
});
