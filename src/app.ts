import { toNodeHandler } from "better-auth/node";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";

import { config } from "#src/config/index.js";
import { auth } from "#src/lib/auth.js";
import { errorHandler } from "#src/middleware/error-handler.js";
import { parseJsonBodyOnce } from "#src/middleware/json-body.js";
import { notFoundHandler } from "#src/middleware/not-found.js";
import { requestId } from "#src/middleware/request-id.js";
import { requestLog } from "#src/middleware/request-log.js";
import handlesRouter from "#src/modules/auth/handles/handles.routes.js";
import authRouter from "#src/modules/auth/session/auth.routes.js";
import usersRouter from "#src/modules/auth/users/users.routes.js";
import engagementRouter, {
  commentRouter,
  creatorRouter,
} from "#src/modules/home/engagement/engagement.routes.js";
import feedRouter from "#src/modules/home/feed/feed.routes.js";
import promotionsRouter from "#src/modules/home/promotions/promotions.routes.js";
import spotlightRouter from "#src/modules/home/spotlight/spotlight.routes.js";
import platformAuditRouter from "#src/modules/platform/audit/platform-audit.routes.js";
import notificationsRouter from "#src/modules/platform/notifications/notifications.routes.js";
import platformRolesRouter from "#src/modules/platform/roles/platform-roles.routes.js";
import fundingRouter, { projectFundingRouter } from "#src/modules/rnd/funding/funding.routes.js";
import researchCatalogRouter from "#src/modules/rnd/programs/research-catalog.routes.js";
import researchProgramsRouter, {
  researchPaperCategoryRouter,
} from "#src/modules/rnd/programs/research-programs.routes.js";
import researchProjectsRouter, {
  applicationInboxRouter,
} from "#src/modules/rnd/projects/research-projects.routes.js";
import proofOfEffortRouter, {
  integrationCallbackRouter,
} from "#src/modules/rnd/proof-of-effort/proof-of-effort.routes.js";
import workshopRouter, { dailyLogFeedRouter } from "#src/modules/rnd/workshop/workshop.routes.js";
import playlistsRouter from "#src/modules/studio/playlists/playlists.routes.js";
import seriesRouter from "#src/modules/studio/series/series.routes.js";
import videosRouter from "#src/modules/studio/videos/videos.routes.js";
import commerceCartRouter from "#src/routes/commerce-cart.routes.js";
import commerceCatalogRouter from "#src/routes/commerce-catalog.routes.js";
import commerceCategoriesRouter from "#src/routes/commerce-categories.routes.js";
import commerceContentReportsRouter from "#src/routes/commerce-content-reports.routes.js";
import commerceDocumentsRouter from "#src/routes/commerce-documents.routes.js";
import commerceFactoriesRouter from "#src/routes/commerce-factories.routes.js";
import commerceFreightRatesRouter from "#src/routes/commerce-freight-rates.routes.js";
import commerceFulfillmentRouter from "#src/routes/commerce-fulfillment.routes.js";
import commerceMerchandisingRouter from "#src/routes/commerce-merchandising.routes.js";
import commerceMessagesRouter from "#src/routes/commerce-messages.routes.js";
import commerceOrdersRouter from "#src/routes/commerce-orders.routes.js";
import commerceOrganizationsRouter from "#src/routes/commerce-organizations.routes.js";
import commercePaymentsRouter from "#src/routes/commerce-payments.routes.js";
import commerceProductEngagementRouter from "#src/routes/commerce-product-engagement.routes.js";
import commerceProductInquiryRouter from "#src/routes/commerce-product-inquiry.routes.js";
import commerceProductQaRouter from "#src/routes/commerce-product-qa.routes.js";
import commerceProvidersRouter from "#src/routes/commerce-providers.routes.js";
import commerceQuotesRouter from "#src/routes/commerce-quotes.routes.js";
import commerceRankingRouter from "#src/routes/commerce-ranking.routes.js";
import commerceRfqsRouter from "#src/routes/commerce-rfqs.routes.js";
import commerceSellerProfileRouter from "#src/routes/commerce-seller-profile.routes.js";
import commerceSettlementRouter from "#src/routes/commerce-settlement.routes.js";
import commerceTrustRouter from "#src/routes/commerce-trust.routes.js";
import commerceWebhooksRouter from "#src/routes/commerce-webhooks.routes.js";
import communityCofounderRouter from "#src/routes/community-cofounder.routes.js";
import communityForumRouter from "#src/routes/community-forum.routes.js";
import compensationRouter, { governanceRouter } from "#src/routes/compensation.routes.js";
import discoveryRouter from "#src/routes/discovery.routes.js";
import docsRouter from "#src/routes/docs.routes.js";
import indexRouter from "#src/routes/index.js";
import productsRouter from "#src/routes/products.routes.js";
import storeRouter from "#src/routes/store.routes.js";
import supplierRouter, { projectGoToMarketRouter } from "#src/routes/suppliers.routes.js";

const app = express();

// Trust first proxy (nginx, load balancer, etc.)
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// CORS — restricted to known frontend origin
app.use(
  cors({
    origin: config.FRONTEND_URL,
    credentials: true,
  }),
);

// Request tracing
app.use(requestId);

// Logging. Structured JSON lines carrying `req.requestId`, which morgan's format
// string could not reach — see src/middleware/request-log.ts (§11l.2 item 6).
app.use(requestLog);

// Better Auth handler — MUST mount before express.json(); it parses its own
// request bodies off the raw stream. A body parser ahead of it consumes the
// stream and breaks every auth POST (sign-in, OTP, reset). See BACKEND_STRUCTURE §5c.
//
// The wrapper exists because of the `bearer()` plugin (src/lib/auth.ts, §4a). Its
// AFTER hook has `matcher: () => true`, so it stamps `set-auth-token` — the session
// token itself — onto EVERY auth response, browsers included, and adds it to
// Access-Control-Expose-Headers so page script can read it. The session cookie is
// httpOnly precisely to keep that value away from page script; publishing it would
// upgrade any XSS from "act inside the page" to "exfiltrate a portable session".
// R_AND_D_BACKEND_STRUCTURE.md §0: the frontend is a hostile presentation layer.
//
// So: emit the header only to callers that identify as native. Web behaviour is
// byte-identical to before this plugin was added.
const NATIVE_CLIENT_HEADER = "x-qatoto-client";
const authNodeHandler = toNodeHandler(auth.handler);

app.all("/api/auth/*splat", (req, res) => {
  if (req.headers[NATIVE_CLIENT_HEADER] === "native") {
    void authNodeHandler(req, res);
    return;
  }

  const originalSetHeader = res.setHeader.bind(res);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  res.setHeader = ((headerName: string, headerValue: never) => {
    if (headerName.toLowerCase() === "set-auth-token") {
      return res;
    }
    return originalSetHeader(headerName, headerValue);
  }) as typeof res.setHeader;

  void authNodeHandler(req, res);
});

// ONE JSON parse, at the 128 kb ceiling, recording the body's byte length. Each route then
// declares its own cap with `compactBody` (16 kb) or `longFormBody` (128 kb), enforced as an
// ordinary check against that number rather than as a second parser (§11l.4).
//
// IT HAS TO WORK THIS WAY. body-parser sets `req._body` on the first successful parse and
// every later parser short-circuits, so the first parse wins — always. Three prefix parsers
// and a 10 kb global one used to sit here, ahead of every router, which meant not one of the
// 77 per-route parsers inside those routers ever ran. Routes behind a prefix got 128 kb;
// everything else got 10 kb, including routes whose schemas produce far more than that.
//
// The ceiling is 128 kb because `limit` counts BYTES while `z.string().max(n)` counts UTF-16
// code units: a 5,000-character description is ~5 kb in ASCII but up to 15 kb in UTF-8 for
// Devanagari or CJK. A cap that ignores that rejects payloads Zod accepts, for non-English
// users only — a bug that never surfaces in English-language testing.
//
// THE TRADE: a 100 kb body aimed at a 16 kb route is now buffered before being rejected,
// where a root-mounted route previously stopped at 10 kb. The ceiling is small, and the six
// routers behind the old prefix mounts already buffered this much.

// STORE Phase 14 — INBOUND CONNECTOR WEBHOOKS NEED THE RAW BYTES, AND THIS LINE IS WHY IT
// WORKS. Their authentication is an HMAC computed over exactly what the provider sent, and
// `JSON.stringify(req.body)` reorders keys and drops whitespace, so a body that has been
// through the JSON parser can never reproduce the sender's digest. Verifying a
// re-serialized body would mean accepting bodies nobody signed.
//
// It sits ABOVE `parseJsonBodyOnce` for the reason that block documents: body-parser sets
// `req._body` on the first successful parse and every later parser short-circuits, so the
// first parse wins. Moving this line below it silently disables signature checking on every
// webhook — the controller therefore refuses any request whose body is not a Buffer rather
// than trusting that this ordering held.
//
// SCOPED TO `/webhooks`, never global: raw-parsing the whole application would break every
// JSON route in it.
app.use("/webhooks", express.raw({ type: "*/*", limit: "512kb" }));

app.use(parseJsonBodyOnce);
// Kept for completeness and deliberately unchanged: no route in this application reads a
// urlencoded body. Every non-JSON body is multipart, handled by multer off the raw stream.
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

// Cookie parsing
app.use(cookieParser());

// --- Routes ---
app.use("/", indexRouter);
app.use("/", authRouter);
app.use("/users", usersRouter);
app.use("/handles", handlesRouter);
app.use("/commerce", commerceOrganizationsRouter);
/**
 * A13. Declared AFTER the organizations router even though every path is under
 * `/organizations/:organizationId`. Express matches in declaration order and the paths do
 * not collide — `seller-profile`, `site-access`, `stakeholders`, `capabilities`, `media` and
 * `certifications` are all segments that router does not claim.
 */
app.use("/commerce", commerceSellerProfileRouter);
app.use("/commerce", commerceProvidersRouter);
app.use("/commerce", commerceRfqsRouter);
app.use("/commerce", commerceQuotesRouter);
app.use("/commerce", commerceMessagesRouter);
app.use("/commerce", commerceCartRouter);
app.use("/commerce", commerceOrdersRouter);
app.use("/commerce", commercePaymentsRouter);
app.use("/commerce", commerceFulfillmentRouter);
app.use("/commerce", commerceFreightRatesRouter);
app.use("/commerce", commerceTrustRouter);
app.use("/commerce", commerceCatalogRouter);
// The browse taxonomy's ADMIN surface and the seller request queue. The public category
// reads stay on `/store` (store.routes.ts) where the rest of the storefront lives.
app.use("/commerce", commerceCategoriesRouter);
app.use("/commerce", commerceMerchandisingRouter);
app.use("/commerce", commerceProductQaRouter);
app.use("/commerce", commerceContentReportsRouter);
app.use("/commerce", commerceProductInquiryRouter);
// STORE Phase 13 — ranking transparency and the appeal path.
app.use("/commerce", commerceRankingRouter);
// STORE Phase 15 — trade attachments (A30). `/documents` collides with no other
// commerce segment; the verification-evidence upload lives under
// `/providers/:organizationId/evidence` and its download under
// `/organizations/:organizationId/verifications/...`.
app.use("/commerce", commerceDocumentsRouter);
// STORE Phase 14 — negotiated settlement agreements. Mounted after the other commerce
// routers; its segments (`/settlement`, `/settlement-agreements`, and a sub-path under
// `/threads`) collide with none of them.
app.use("/commerce", commerceSettlementRouter);
/**
 * STORE Phase 17 — manufacturing inquiries, seller-owned factory depth and staff site
 * audits (§16). The PUBLIC directory reads are on `storeRouter` instead.
 *
 * Declared after `commerceSellerProfileRouter` even though three of its paths sit under
 * `/organizations/:organizationId`: `production-lines`, `sites` and `factory-terms` are
 * segments that router does not claim, the same argument A13's mount note already makes.
 */
app.use("/commerce", commerceFactoriesRouter);
/**
 * STORE Phase 18 — the business forum's write surface (§17).
 *
 * A NEW PREFIX, AND THAT IS THE POINT (§1.1). Community is a sibling context, not a row in
 * commerce's table: no organization is required to post, nothing is priced, nothing is
 * ordered, and a forum reply confers no standing in a dispute. Mounting it under
 * `/commerce` would make that claim in the URL every client sees.
 *
 * Its PUBLIC reads are on `storeRouter` instead, because `/store` is the prefix a
 * signed-out visitor browses — the precedent being `commerceProductEngagementRouter`, which
 * mounts at `/store` while owning no store table.
 */
app.use("/community", communityForumRouter);
/**
 * STORE Phase 19 — the cofounder directory (§18). Declared after the forum router; their
 * segments (`/forum/*` and `/cofounder-profiles/*`) collide nowhere, and both `/admin`
 * sub-paths are distinct literals.
 */
app.use("/community", communityCofounderRouter);
/**
 * STORE Phase 14. Inbound connector webhooks, mounted at `/webhooks` and NOT under
 * `/commerce`, because everything under that prefix requires a session and an active
 * organization and these routes have neither — their caller is an external system
 * authenticated by an HMAC over the raw body.
 *
 * The prefix must match the `express.raw` mount above, which is what keeps the body
 * unparsed. The two are a pair: change one and signature verification stops working.
 */
app.use("/webhooks", commerceWebhooksRouter);
app.use("/store", storeRouter);
/**
 * A11. Buyer engagement WRITES share the `/store` prefix but not `store.routes.ts`'s
 * middleware: that router applies `attachOptionalUser, storeReadLimiter` to everything
 * it owns, which is right for reads and wrong for writes. Declared after the read
 * router; the paths do not overlap (PUT/DELETE/POST vs GET).
 */
app.use("/store", commerceProductEngagementRouter);
app.use("/products", productsRouter);
// The home-page carousel. GET /promotions/slides is public; every /promotions/admin/*
// route is gated by `manage_promotions` inside the service.
app.use("/promotions", promotionsRouter);
// The home-page Spotlight rail. GET /spotlight/videos is public; admin routes are gated
// by `manage_promotions` inside the service (same blast radius as the carousel).
app.use("/spotlight", spotlightRouter);
// The home feed's public read surface (HOME_BACKEND_STRUCTURE.md §5.1). Grouped with the
// carousel above because both are front-page data sources, but UNLIKE the /research-projects
// stack below, ordering here is NOT load-bearing: /feed is a single-segment prefix that no
// other router shares, so nothing can swallow or be swallowed by it.
app.use("/feed", feedRouter);
app.use("/research-projects", researchProjectsRouter);
// Same prefix, declared AFTER: the workshop router owns /:projectSlug/workshop/* and
// /:projectSlug/daily-logs/* (§8). No collision — researchProjectsRouter's "/:projectSlug"
// matches that one segment exactly and never swallows a deeper path.
app.use("/research-projects", workshopRouter);
// Same prefix again, declared AFTER both: the Proof-of-Effort router owns
// /:projectSlug/effort-claims/*, /equity/*, /allocation-proposals/*, /disputes/*,
// /audit-trail/*, /slice-ledger and /proof-of-effort (§9). Still no collision, for the
// same reason — a single-segment "/:projectSlug" never swallows a deeper path.
app.use("/research-projects", proofOfEffortRouter);
// Same prefix a fourth time, declared AFTER all three: the funding router owns
// /:projectSlug/funding-rounds, /:projectSlug/milestones, /:projectSlug/escrow/*,
// /:projectSlug/compensation and /:projectSlug/investor-confidence (§7). Still no
// collision, for the same reason — a single-segment "/:projectSlug" never swallows a
// deeper path.
app.use("/research-projects", projectFundingRouter);
// Same prefix a fifth time, declared AFTER all four: the compensation router owns
// /:projectSlug/compensation-agreements/*, /compensation-periods/*,
// /compensation-period-lines/* and /members/:memberUserId/compensation-agreement (§7A).
// Still no collision, for the same reason — a single-segment "/:projectSlug" never
// swallows a deeper path.
//
// Everything it owns is project-scoped, unlike §7's funding router: nobody reaches a
// compensation statement holding an id and no project, so proving membership from the URL
// is both possible and correct here.
app.use("/research-projects", compensationRouter);
// Same prefix a SIXTH time, declared after all five: the go-to-market router owns
// /:projectSlug/launch-readiness (§11i). Still no collision, for the same reason — a
// single-segment "/:projectSlug" never swallows a deeper path.
//
// The readiness checklist is DERIVED from research_project.stage, project_stats, the §9.11
// bake event, the project's supplier engagements and its linked store listings. Nothing is
// stored and no body sets a state, so there is no field a client could assert "ready" with.
app.use("/research-projects", projectGoToMarketRouter);
// §10 — research programs. Its own prefix, so unlike the six routers sharing
// "/research-projects" there is no inter-router ordering hazard here. A program is a
// distinct entity from a project (§10): thousands of open contributors, a branch tree, a
// public paper library and contribution tracking that is not equity.
app.use("/research-programs", researchProgramsRouter);
app.use("/discovery", discoveryRouter);
// Creator Studio. The anime review queue is nested at /videos/admin/review rather than a
// root /admin, matching /discovery/admin/* — one domain's moderation surface should not
// claim the global namespace.
app.use("/videos", videosRouter);
// The viewer-side half of the same prefix (HOME_BACKEND_STRUCTURE.md §5.2), declared
// AFTER the studio router — and that order is LOAD-BEARING, not cosmetic.
//
// videosRouter owns `GET /:videoId` behind `requireAuth`. Express matches routers in
// declaration order, so anything single-segment added to engagementRouter would be
// permanently shadowed by it: a logged-out viewer would get a 401 and the public
// handler would never run, with nothing failing to compile and no test going red.
// Every route in engagementRouter is therefore two segments deep or more, and
// engagement.routes.order.test.ts asserts exactly that.
app.use("/videos", engagementRouter);
// Root-mounted, like notificationsRouter and applicationInboxRouter: a comment id and a
// creator id are globally unique and come from a listing, so nesting them under the
// owning video would make the client assert a pairing the server re-checks anyway.
app.use("/", commentRouter);
app.use("/", creatorRouter);
app.use("/playlists", playlistsRouter);
app.use("/series", seriesRouter);
// Cross-project R&D resources (/open-roles, /research-categories) mount at the root,
// exactly as the spec mounts the funding router at "/".
app.use("/", researchCatalogRouter);
// The §10 paper taxonomy, root-mounted at /research-paper-categories. Program-independent
// on purpose — one vocabulary the whole platform shares, exactly as researchCatalogRouter's
// /research-categories is for projects. Nesting it per-program would make "Longevity
// Biology" mean something different in two places.
app.use("/", researchPaperCategoryRouter);
// The four §4c STAGE ROUTES' cross-project halves (Appendix B), all root-mounted for the
// one reason: a visitor arriving from a landing-page stage card has not picked a project
// and holds no slug. That is the whole point of the pages — team building, daily logs and
// governance previously lived only as tabs INSIDE a project, so someone who had not chosen
// one could not reach them at all.
//
// `/daily-logs` and `/daily-logs/streak-leaderboard` (§8, §11h). The feed is scoped to the
// caller's OWN memberships, derived from `project_member` in SQL — there is no request
// field that widens it. The leaderboard is public: a streak count over an already-public
// project is project metadata, while a log is a member's work record.
app.use("/", dailyLogFeedRouter);
// `/governance/summary` (§7A, §11h). Aggregates and mechanics, never people — a month-end
// statement line names someone and what they are owed, and that stays behind membership on
// the per-project tab. The caller's own lines are the one exception.
app.use("/", governanceRouter);
// `/suppliers`, `/supplier-capabilities` and `/launch-ready-projects` (§6-family, §11i).
// Root-mounted like researchCatalogRouter — a supplier directory belongs to no project.
app.use("/", supplierRouter);
// `/applications/mine` and `/invites/mine` (§5, §11j.2). Root-mounted because neither
// question is about one project: an applicant asks what they applied to, an invitee asks
// who invited them, and neither holds a slug. The project-scoped lists on
// researchProjectsRouter are the FOUNDER's inbox and are maintainer-gated, so they can
// never answer either — which is why an invitee previously had no way to obtain the
// inviteId that /accept and /decline both require.
app.use("/", applicationInboxRouter);
// The notification inbox (§11l.2). Root-mounted for the same reason the application inbox
// is — an inbox belongs to a person, not to a project, and somebody arriving from an email
// has not picked one. Caller-scoped in SQL on every route; there is no `?userId=`.
app.use("/", notificationsRouter);
// The platform moderation log (§11l.2). Root-mounted at /admin/audit-trail rather than
// under /discovery/admin, because it spans taxonomy, the supplier directory, content
// review and role grants — filing it under one would imply the others are not covered.
app.use("/", platformAuditRouter);
// Staff role administration (§4a Layer 3). Root-mounted beside the log it writes to: a
// grant is a platform-wide fact, not a fact about any one domain.
app.use("/", platformRolesRouter);
// §7's id-keyed half: /funding-rounds, /pledges, /milestones, /escrow-releases,
// /provider-transfers and /funding/deals. Root-mounted because a backer arriving from a
// deal-flow list holds a round id and has no reason to know which project owns it — the
// handler resolves the id to a project and proves membership against that.
//
// THERE IS NO WEBHOOK ROUTE AND NO RAW-BODY MOUNT (§11). Settlement runs through
// POST /provider-transfers/:transferId/settle, gated on the platform `audit_escrow`
// capability, because the card network this would have been signed by is deferred
// (Appendix A3) and a raw-body branch for a route that does not exist is a security
// surface bought for nothing.
app.use("/", fundingRouter);
// The §9 integration callback. Root-mounted because a provider's redirect URI is fixed at
// app-registration time and cannot carry a project slug; the project and the member come
// out of the signed `state` instead (§9.10).
app.use("/", integrationCallbackRouter);
app.use("/", docsRouter);

// --- Error handling ---
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
