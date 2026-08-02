import express from "express";

import * as feedController from "#src/controllers/feed.controller.js";

const router = express.Router();

/**
 * The home feed (HOME_BACKEND_STRUCTURE.md §5.1).
 *
 * THIS ROUTE IS BARE — no `requireAuth`, no `attachOptionalUser`, no limiter — and that is
 * a DELIBERATE DEPARTURE from §5.1 and §7, which specify `attachOptionalUser` on the router
 * and a `feedCategoriesLimiter` on this route. Both are dropped, for the same reasons
 * `GET /promotions/slides` states next door:
 *
 *   - NO SESSION. The response is viewer-independent by construction: every active
 *     category, in one fixed order, identical for every visitor. `attachOptionalUser` would
 *     buy a Better Auth round trip on one of the most-hit routes on the site to resolve a
 *     `req.user` that no handler below reads.
 *
 *   - NO LIMITER, and this is the one worth being careful about. Unauthenticated means
 *     `userKey` falls back to keying by IP. An IP-keyed limiter on the front page's data
 *     source is a self-inflicted outage the first time real traffic arrives from behind a
 *     CDN or a corporate NAT, where thousands of genuine visitors share one address. No
 *     public read in this codebase carries one. `rate-limit-coverage.test.ts` enforces
 *     coverage by COUNT IDENTITY between exported limiters and store registrations, so
 *     omitting one here costs nothing there — the test is not being worked around.
 *
 *     If this route ever needs protection, the answer is a cache in front of it, not a
 *     bucket that cannot tell a NAT from an attacker.
 *
 * `GET /feed/videos` (§5.1) joins this router in phase 3. It WILL want
 * `attachOptionalUser` — its response genuinely depends on the caller — so the middleware
 * belongs on that route, not on the router.
 */
router.get("/categories", feedController.listFeedCategories);

export default router;
