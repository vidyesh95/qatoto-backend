import express from "express";

import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  blueprintCommentCreateLimiter,
  blueprintContentReportLimiter,
  blueprintCommentLikeLimiter,
  blueprintCommentUpdateLimiter,
  blueprintEngagementReadLimiter,
  blueprintHeroImageUploadLimiter,
  blueprintHeroWriteLimiter,
  blueprintLikeLimiter,
  blueprintReportModerationLimiter,
  blueprintSaveLimiter,
  blueprintUpvoteLimiter,
  blueprintViewBeaconBurstLimiter,
  blueprintViewBeaconSustainedLimiter,
  caseStudyModerationLimiter,
  caseStudySubmitLimiter,
  showcaseLaunchModerationLimiter,
  showcaseLaunchSubmitLimiter,
  showcaseWriteUpImageUploadLimiter,
  teardownModerationLimiter,
  blueprintDraftSaveLimiter,
  teardownFileDownloadLimiter,
  teardownFileUploadLimiter,
  teardownSubmitLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as blueprintContentReportController from "#src/modules/home/blueprints/blueprint-content-report.controller.js";
import * as blueprintDraftController from "#src/modules/home/blueprints/blueprint-draft.controller.js";
import * as blueprintEngagementController from "#src/modules/home/blueprints/blueprint-engagement.controller.js";
import * as blueprintHeroController from "#src/modules/home/blueprints/blueprint-hero.controller.js";
import * as caseStudyController from "#src/modules/home/blueprints/case-study.controller.js";
import * as showcaseLaunchController from "#src/modules/home/blueprints/showcase-launch.controller.js";
import * as teardownController from "#src/modules/home/blueprints/teardown.controller.js";
import { uploadBlueprintHeroSlideImageFile } from "#src/modules/home/blueprints/upload-blueprint-hero-image.js";
import {
  uploadShowcaseLaunchSubmissionFiles,
  uploadShowcaseWriteUpImageFile,
} from "#src/modules/home/blueprints/upload-showcase-launch-images.js";
import { uploadTeardownSubmissionFileParser } from "#src/modules/home/blueprints/upload-teardown-submission-file.js";

const router = express.Router();

/**
 * The `/blueprints` surface: the hero carousel, and posting and moderating showcase launches.
 *
 * THE HERO: ONE PUBLIC ROUTE AND SIX ADMIN ROUTES. The public read is BARE — no requireAuth, no
 * attachOptionalUser, no limiter — for the same reasons as GET /promotions/slides: the
 * payload is identical for every visitor, and an IP-keyed limiter on a page's opening
 * element is a self-inflicted outage behind a CDN or corporate NAT.
 *
 * THIS MODULE WAS `/anime`. The hero carousel is all that survived the vertical's retirement:
 * the two public series reads (`/series`, `/series/:seriesSlug`) went with it, and with them
 * the second route-order hazard this comment used to describe.
 *
 * ROUTE ORDER IS STILL LOAD-BEARING ONCE: `/admin/hero-slides/reorder` is a literal and must
 * precede `/admin/hero-slides/:slideId`, or "reorder" is captured as a slide id and that
 * handler never runs.
 *
 * Capability (`manage_promotions`) is checked INSIDE the service, not as middleware:
 * middleware cannot return a `Result` and so cannot join the controller's exhaustive error
 * switch, and the check has to run before any id is read or the route becomes an id oracle.
 *
 * Chain order on every admin route is auth -> limiter -> parser/upload -> controller. A
 * multipart route carries ONLY the upload limiter, never both: stacking two limiters on one
 * route double-counts every request against the stricter of them.
 */

/** GET /blueprints/hero-slides — PUBLIC. Live slides only, already ordered. */
router.get("/hero-slides", blueprintHeroController.listActiveHeroSlides);

/** GET /blueprints/admin/hero-slides — every stored slide. */
router.get(
  "/admin/hero-slides",
  requireAuth,
  blueprintHeroWriteLimiter,
  blueprintHeroController.listHeroSlidesForStaff,
);

/** POST /blueprints/admin/hero-slides — multipart create, image and metadata together. */
router.post(
  "/admin/hero-slides",
  requireAuth,
  blueprintHeroImageUploadLimiter,
  uploadBlueprintHeroSlideImageFile,
  blueprintHeroController.createHeroSlide,
);

/** PATCH /blueprints/admin/hero-slides/reorder — LITERAL, must stay above /:slideId. */
router.patch(
  "/admin/hero-slides/reorder",
  requireAuth,
  blueprintHeroWriteLimiter,
  compactBody,
  blueprintHeroController.reorderHeroSlides,
);

/** PATCH /blueprints/admin/hero-slides/:slideId — metadata only. */
router.patch(
  "/admin/hero-slides/:slideId",
  requireAuth,
  blueprintHeroWriteLimiter,
  compactBody,
  blueprintHeroController.updateHeroSlide,
);

/** PATCH /blueprints/admin/hero-slides/:slideId/image — multipart, replace in place. */
router.patch(
  "/admin/hero-slides/:slideId/image",
  requireAuth,
  blueprintHeroImageUploadLimiter,
  uploadBlueprintHeroSlideImageFile,
  blueprintHeroController.replaceHeroSlideImage,
);

/** DELETE /blueprints/admin/hero-slides/:slideId — remove the slide and its image. */
router.delete(
  "/admin/hero-slides/:slideId",
  requireAuth,
  blueprintHeroWriteLimiter,
  blueprintHeroController.deleteHeroSlide,
);

/**
 * SHOWCASE LAUNCHES — three maker routes and two moderator routes. NONE IS PUBLIC: the public
 * showcase pages still read frontend fixtures, so nothing here serves a reader.
 *
 * CHAIN ORDER ON THE MULTIPART ROUTES IS auth -> limiter -> requireIdentifiedUser -> parser ->
 * idempotency, which differs from the JSON write routes elsewhere on purpose:
 *   * identity BEFORE the parser, so an anonymous session is refused before multer buffers
 *     5 MB into memory;
 *   * idempotency AFTER the parser, because its fingerprint hashes the uploaded file — before the
 *     parser there is no file to hash, and one key reused with a different image would replay.
 *
 * The moderator routes check `moderate_content` inside the controller, before any id is read.
 *
 * ROUTE ORDER: every literal under `/showcases/` — `write-up-images`, `mine`, `slugs` — is declared
 * above `/showcases/:launchSlug`, which must stay LAST. Express matches in declaration order, so a
 * param route above them would swallow `mine` as a slug and answer a stranger's launch to a maker
 * asking for their own. `blueprints.routes.order.test.ts` derives the literal list rather than
 * naming it, so the next literal is guarded without anyone remembering to add it.
 */

/** POST /blueprints/showcases/write-up-images — one image, stored unclaimed until a launch uses it. */
router.post(
  "/showcases/write-up-images",
  requireAuth,
  showcaseWriteUpImageUploadLimiter,
  requireIdentifiedUser,
  uploadShowcaseWriteUpImageFile,
  showcaseLaunchController.uploadWriteUpImage,
);

/** POST /blueprints/showcases — multipart: `draft` JSON text part, then `headingImage`. */
router.post(
  "/showcases",
  requireAuth,
  showcaseLaunchSubmitLimiter,
  requireIdentifiedUser,
  uploadShowcaseLaunchSubmissionFiles,
  idempotency({ required: true }),
  showcaseLaunchController.submitLaunch,
);

/** GET /blueprints/showcases/mine — the maker's own launches, every state. */
router.get("/showcases/mine", requireAuth, showcaseLaunchController.listMyLaunches);

/*
 * THE PUBLIC READS. Bare — no `requireAuth`, no `attachOptionalUser`, no limiter — for the reason
 * `/hero-slides` above is bare and `GET /feed/categories` is: the answer is identical for every
 * visitor, so there is no session worth resolving and nothing to key a bucket on but an IP, which
 * behind a CDN or a NAT is an outage aimed at ourselves. These are cacheable; a cache belongs in
 * front of them rather than a limiter inside them.
 *
 * Only `published` launches are ever visible, and the service applies that to the facet counts as
 * well as the list — a tag chip that promises more launches than the list can show is a count the
 * reader can see is wrong.
 */

/** GET /blueprints/showcases/slugs — published slugs for the frontend's prerender step. */
router.get("/showcases/slugs", showcaseLaunchController.listPublicShowcaseSlugs);

/** GET /blueprints/showcases — the public feed, with its tag facets in the same payload. */
router.get("/showcases", showcaseLaunchController.listPublicShowcaseFeed);

/** GET /blueprints/showcases/:launchSlug — one published launch. DECLARED LAST, see the docblock. */
router.get("/showcases/:launchSlug", showcaseLaunchController.getPublicShowcaseLaunch);

/*
 * THE SHOWCASE ENGAGEMENT WRITES.
 *
 * ⚠️ NONE OF THESE IS A NEW LITERAL. Every path below contains a `:`, so the derived literal lists
 * `blueprints.routes.order.test.ts` asserts with `toEqual` are UNCHANGED — `mine`, `slugs` and the
 * rest still sit above `/:launchSlug` and nothing new joins them. Each is also two segments longer
 * than the bare param route, so Express cannot confuse them.
 *
 * ⚠️ THE BEACON IS NOT A BARE PUBLIC READ, and must never be added to `barePublicRoutes`. That rule
 * is about reads whose payload is identical for every visitor; this inserts a row and moves a
 * counter. `attachOptionalUser` precedes BOTH limiters because they key on `req.user.id` first and
 * fall back to the IP — limiter-first would bucket every signed-in reader by NAT.
 *
 * ⚠️ LIKE AND UPVOTE ARE `PUT`/`DELETE`, NOT `POST`. The composite primary key is the idempotence
 * mechanism, so there is no body, no idempotency key and no body-size cap: a double-tap on a slow
 * connection is a no-op rather than a second row.
 *
 * `requireIdentifiedUser` on every authenticated write, because Better Auth's `anonymous()` mints
 * real sessions — and `upvote_count` is the leading key of `showcase_launch_stats_top_idx`, which
 * ranks the feed's `top` page. That is the highest-value counter on this surface.
 */

router.post(
  "/showcases/:launchSlug/view-beacon",
  attachOptionalUser,
  blueprintViewBeaconBurstLimiter,
  blueprintViewBeaconSustainedLimiter,
  blueprintEngagementController.makeViewBeaconHandler("showcase", "launchSlug"),
);

router.put(
  "/showcases/:launchSlug/like",
  requireAuth,
  blueprintLikeLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("showcase", "like", "launchSlug"),
);
router.delete(
  "/showcases/:launchSlug/like",
  requireAuth,
  blueprintLikeLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("showcase", "like", "launchSlug"),
);

router.put(
  "/showcases/:launchSlug/upvote",
  requireAuth,
  blueprintUpvoteLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("showcase", "upvote", "launchSlug"),
);
router.delete(
  "/showcases/:launchSlug/upvote",
  requireAuth,
  blueprintUpvoteLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("showcase", "upvote", "launchSlug"),
);

/** GET is optional-auth so a signed-in reader sees their own comment likes in one read. */
router.get(
  "/showcases/:launchSlug/comments",
  attachOptionalUser,
  blueprintEngagementReadLimiter,
  blueprintEngagementController.makeListCommentsHandler("showcase", "launchSlug"),
);
router.post(
  "/showcases/:launchSlug/comments",
  requireAuth,
  blueprintCommentCreateLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  blueprintEngagementController.makeCreateCommentHandler("showcase", "launchSlug"),
);

/*
 * TEARDOWNS — five PUBLIC reads and nothing else. There is no teardown write path yet; the twelve
 * rows arrive through `pnpm db:seed-blueprint-teardowns`, which parses them with the same schema an
 * authoring route will.
 *
 * Bare, for the reason the showcase reads above are bare: the answer is identical for every
 * visitor, so there is no session worth resolving and nothing to key a bucket on but an IP, which
 * behind a CDN or a NAT is an outage aimed at ourselves.
 *
 * ⚠️ TWO DIFFERENT GATES SIT BEHIND THESE FIVE ROUTES, and the service holds them apart on purpose.
 * `/teardowns` and `/teardowns/options` LIST (`published`, `flagged`); `/teardowns/slugs`,
 * `/teardowns/:teardownSlug` and its `claim-targets` are READABLE (those two plus `quarantined`).
 * A quarantine withholds a teardown's files; it does not delete its address.
 *
 * ROUTE ORDER: `options` and `slugs` are literals and must stay above `/:teardownSlug`, or either
 * word is captured as a slug and the wrong handler answers. `:teardownSlug/claim-targets` is
 * declared before the bare `:teardownSlug` for readability rather than necessity — the two differ by
 * a path segment, so Express cannot confuse them.
 */

/**
 * POST /blueprints/teardowns — the authoring wizard's one submit. 202 and a three-field receipt.
 *
 * ⚠️ `longFormBody` (128 KB), NOT `compactBody` (16 KB), AND THE NUMBER IS DERIVED. `summary` alone
 * is 2,000 characters, which `json-body-budget.test.ts` counts at four bytes each — 8 KB before a
 * single part, material or link. The same test refuses a cap below what the schema accepts, and
 * `teardown-submission.schemas.ts` caps every array for that reason: the frontend's draft schema
 * bounds none of them, and an unbounded array would pass the budget test while the parser 413s a
 * real submission with nothing in the schema to explain why.
 *
 * IDENTITY BEFORE THE PARSER. `requireIdentifiedUser` refuses an anonymous session before 128 KB is
 * buffered, and a teardown is a named byline and a one-survey-per-unit quota — exactly the class of
 * write that gate exists for.
 */
router.post(
  "/teardowns",
  requireAuth,
  teardownSubmitLimiter,
  requireIdentifiedUser,
  longFormBody,
  idempotency({ required: true }),
  teardownController.submitTeardown,
);

/**
 * GET /blueprints/teardowns/mine — LITERAL, must stay above /:teardownSlug.
 *
 * ⚠️ CAPTURED AS A SLUG, THIS WOULD ANSWER A STRANGER'S PUBLISHED TEARDOWN TO AN AUTHOR ASKING FOR
 * THEIR OWN — the hazard the showcase and case-study lists carry the same warning about. `mine` is
 * also in `RESERVED_TEARDOWN_SLUGS` and in `teardown_slug_ck`, so no teardown can be published at an
 * address this literal shadows.
 */
router.get("/teardowns/mine", requireAuth, teardownController.listMyTeardowns);

/*
 * GET /blueprints/teardowns/mine/:submissionId — one of the author's own, document and all.
 *
 * ⚠️ UNDER `/mine/` RATHER THAN A NEW LITERAL, AND THAT IS NOT COSMETIC. The obvious spelling —
 * `/teardowns/submissions/:submissionId` — is THREE segments, which puts it in the same shape as
 * `/teardowns/:teardownSlug/claim-targets`: a teardown slugged `submissions` would have its
 * claim-targets shadowed by this route. `mine` is already in `teardown_slug_ck`'s reserved list, so
 * nesting here costs no migration and cannot collide with any slug that could ever exist.
 *
 * ⚠️ IT DOES NOT REOPEN A DECISION. A rejection stays terminal — this hands the author their own
 * document so a wizard can seed a DRAFT from it and submit afresh, which
 * `teardown_submission_subject_live_uidx` already permits by excluding `rejected`.
 */
router.get("/teardowns/mine/:submissionId", requireAuth, teardownController.getMySubmission);

/** GET /blueprints/teardowns/options — LITERAL, must stay above /:teardownSlug. */
router.get("/teardowns/options", teardownController.listTeardownOptions);

/** GET /blueprints/teardowns/slugs — LITERAL, must stay above /:teardownSlug. Readable gate. */
router.get("/teardowns/slugs", teardownController.listPublicTeardownSlugs);

/*
 * POST /blueprints/teardowns/uploads — one CAD file or PDF, staged until a submission claims it.
 *
 * A NEW LITERAL under this arm's prefix, so it must stay above `/:teardownSlug` AND be reserved by
 * `teardown_slug_ck` — otherwise a teardown could one day be published at `/teardowns/uploads` and
 * shadow it. `RESERVED_TEARDOWN_SLUGS` carries the same member and the verify script compares the
 * two as data.
 *
 * CHAIN ORDER auth -> limiter -> requireIdentifiedUser -> parser, matching the showcase multipart
 * rule: an anonymous or credential-less caller is refused BEFORE multer buffers 50 MB into memory.
 *
 * ⚠️ NO `idempotency()`. The object key is content-addressed on `(uploader, sha256)` and the column
 * is unique, so a retry converges on the same object and the same row — the storage layer is
 * idempotent by construction, which `attachVideoDocument` argues is stronger than a replayed
 * response. `POST /blueprints/showcases/write-up-images` carries none for the same reason.
 */
router.post(
  "/teardowns/uploads",
  requireAuth,
  teardownFileUploadLimiter,
  requireIdentifiedUser,
  uploadTeardownSubmissionFileParser,
  teardownController.uploadSubmissionFile,
);

/** GET /blueprints/teardowns — the index, its filters and its tag facets in one payload. */
router.get("/teardowns", teardownController.listPublicTeardowns);

/** GET /blueprints/teardowns/:teardownSlug/claim-targets — ids and titles, provably no URLs. */
router.get("/teardowns/:teardownSlug/claim-targets", teardownController.getTeardownClaimTargets);

/**
 * GET /blueprints/teardowns/:teardownSlug/market-signal — BARE, and READABLE-gated.
 *
 * ⚠️ IT SURVIVES A QUARANTINE, deliberately. A quarantine is a claim about the publisher's FILES
 * and says nothing about whether a market for the product exists — so suppressing this band would
 * let a moderation action quietly delete an unrelated fact. Same gate as the detail read beside it.
 */
router.get("/teardowns/:teardownSlug/market-signal", teardownController.getTeardownMarketSignal);

/*
 * THE TWO FILE DOWNLOADS. Four segments each, so neither adds a literal and neither can shadow
 * `/:teardownSlug`.
 *
 * ⚠️ NOT BARE READS, AND NOT AN EXCEPTION TO THE BARE-READ RULE — they fail both of its own
 * clauses. That rule is about reads whose payload is IDENTICAL FOR EVERY VISITOR and which a cache
 * belongs in front of; these answer a 302 to a 300-second bearer capability minted per request,
 * under `Cache-Control: no-store`. `GET /videos/:videoId/documents/:documentId/file` is the shipped
 * precedent: anonymous-reachable, private bucket, same shape.
 *
 * ⚠️ GATED ON **LIST**, NOT ON READABLE, WHICH IS THE ONE PLACE THIS DIFFERS FROM THE DETAIL READ
 * BESIDE IT. A quarantined teardown's PAGE is served — that is what READABLE is for — but a
 * quarantine is precisely a withholding of the publisher's FILES, and `withheldPayload()` already
 * blanks both lists for exactly that reason. Serving the bytes from a separate route while the page
 * hides them would put the control back where it was before it moved server-side.
 */
router.get(
  "/teardowns/:teardownSlug/documents/:fileId",
  teardownFileDownloadLimiter,
  teardownController.downloadTeardownDocument,
);
router.get(
  "/teardowns/:teardownSlug/fabrication-files/:fileId",
  teardownFileDownloadLimiter,
  teardownController.downloadTeardownManufacturingFile,
);

/*
 * THE TWO MODEL DOWNLOADS. `assembly-model` is three segments and DOES add a literal under
 * `/teardowns/:teardownSlug/`, which is a different namespace from `/teardowns/` itself — it cannot
 * collide with a slug, only with another sub-route, and there is none.
 *
 * Gated identically to the file downloads: `assembly` is in `withheldPayload()`, so a quarantine
 * takes the geometry away and this route is the only address the viewer has for it.
 */
router.get(
  "/teardowns/:teardownSlug/assembly-model",
  teardownFileDownloadLimiter,
  teardownController.downloadTeardownAssemblyModel,
);
router.get(
  "/teardowns/:teardownSlug/part-models/:partId",
  teardownFileDownloadLimiter,
  teardownController.downloadTeardownPartModel,
);

/** GET /blueprints/teardowns/:teardownSlug — one readable teardown. DECLARED LAST of the five. */
router.get("/teardowns/:teardownSlug", teardownController.getPublicTeardown);

/*
 * THE TEARDOWN ENGAGEMENT WRITES. Same shape as the showcase arm's, with `save` in place of
 * `upvote` — `teardown_stats` carries `save_count` and no `upvote_count`, and the schema says so.
 *
 * ⚠️ THE BEACON HERE GATES ON READABLE, NOT ON ENGAGEABLE, which is the one place this arm differs.
 * A quarantined teardown's page IS served, with its notice and its files withheld, so recording
 * that it was opened is the honest record. Every other write below refuses a quarantined row:
 * nothing new may be endorsed while a rights claim is unresolved. `blueprint-engagement-gate.ts`
 * holds those two predicates apart and explains why they must not be merged.
 */

router.post(
  "/teardowns/:teardownSlug/view-beacon",
  attachOptionalUser,
  blueprintViewBeaconBurstLimiter,
  blueprintViewBeaconSustainedLimiter,
  blueprintEngagementController.makeViewBeaconHandler("teardown", "teardownSlug"),
);

router.put(
  "/teardowns/:teardownSlug/like",
  requireAuth,
  blueprintLikeLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("teardown", "like", "teardownSlug"),
);
router.delete(
  "/teardowns/:teardownSlug/like",
  requireAuth,
  blueprintLikeLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("teardown", "like", "teardownSlug"),
);

router.put(
  "/teardowns/:teardownSlug/save",
  requireAuth,
  blueprintSaveLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("teardown", "save", "teardownSlug"),
);
router.delete(
  "/teardowns/:teardownSlug/save",
  requireAuth,
  blueprintSaveLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("teardown", "save", "teardownSlug"),
);

router.get(
  "/teardowns/:teardownSlug/comments",
  attachOptionalUser,
  blueprintEngagementReadLimiter,
  blueprintEngagementController.makeListCommentsHandler("teardown", "teardownSlug"),
);
router.post(
  "/teardowns/:teardownSlug/comments",
  requireAuth,
  blueprintCommentCreateLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  blueprintEngagementController.makeCreateCommentHandler("teardown", "teardownSlug"),
);

/*
 * CASE STUDIES — the third arm, and the first with a write path on the backend. Four PUBLIC reads,
 * two writer routes and two moderator routes.
 *
 * ⚠️ ONE GATE, NOT TWO. A teardown needs LIST and READABLE because a quarantine withholds its files
 * while leaving its address alive; a case study has no files, so `published, flagged` is the whole
 * gate. What this arm withholds instead is ONE FIELD — a first-hand writer may keep a company's name
 * from readers — and `GET /admin/case-studies/review-queue` is the only route in this router that
 * serves the real one.
 *
 * ROUTE ORDER: `mine`, `options` and `slugs` are literals and must stay above
 * `/:caseStudySlug`, or each word is captured as a slug — and `mine` captured as a slug would answer
 * a stranger's case study to a writer asking for their own. `GET` and `POST /case-studies` share a
 * path and differ by method, which is why the order test keys handler counts by "<method> <path>".
 *
 * The four bare reads carry no limiter, for the reason the showcase reads above are bare: the answer
 * is identical for every visitor, so there is nothing to key a bucket on but an IP, which behind a
 * CDN or a NAT is an outage aimed at ourselves.
 */

/** POST /blueprints/case-studies — JSON submit, lands `pending_review`. */
router.post(
  "/case-studies",
  requireAuth,
  caseStudySubmitLimiter,
  requireIdentifiedUser,
  /*
   * ⚠️ `longFormBody` (128 KB), NOT `compactBody` (16 KB), AND THE NUMBER IS DERIVED. A case study
   * carries two 2,000-character prose fields, twelve steps, twelve pitfalls and ten sources; at the
   * four-bytes-per-character worst case `json-body-budget.test.ts` computes, that is about 90 KB —
   * the largest JSON body on this surface, and a 16 KB cap would 413 a draft the form accepts.
   */
  longFormBody,
  idempotency({ required: true }),
  caseStudyController.submitCaseStudy,
);

/** GET /blueprints/case-studies/mine — LITERAL, must stay above /:caseStudySlug. */
router.get("/case-studies/mine", requireAuth, caseStudyController.listMyCaseStudies);

/** GET /blueprints/case-studies/options — LITERAL. Slug and title for the composer's select. */
router.get("/case-studies/options", caseStudyController.listCaseStudyOptions);

/** GET /blueprints/case-studies/slugs — LITERAL. Visible slugs for the prerender step. */
router.get("/case-studies/slugs", caseStudyController.listPublicCaseStudySlugs);

/** GET /blueprints/case-studies — the index, with its one discipline filter. */
router.get("/case-studies", caseStudyController.listPublicCaseStudies);

/** GET /blueprints/case-studies/:caseStudySlug — one case study. DECLARED LAST of the reads. */
router.get("/case-studies/:caseStudySlug", caseStudyController.getPublicCaseStudy);

/*
 * THE CASE-STUDY ENGAGEMENT WRITES — A BEACON AND A LIKE, AND NOTHING ELSE.
 *
 * ⚠️ NO COMMENTS, NO UPVOTE, NO SAVE, AND THE ABSENCE IS THE CONTRACT. `case_study_stats` has
 * exactly two counters, and this arm "is a numbered lesson with no discussion surface". A route
 * whose counter does not exist is the unverified code the field sweeps exist to catch — and the
 * service refuses the verb outright rather than no-oping, so a client that tries gets told why.
 */

router.post(
  "/case-studies/:caseStudySlug/view-beacon",
  attachOptionalUser,
  blueprintViewBeaconBurstLimiter,
  blueprintViewBeaconSustainedLimiter,
  blueprintEngagementController.makeViewBeaconHandler("case_study", "caseStudySlug"),
);

router.put(
  "/case-studies/:caseStudySlug/like",
  requireAuth,
  blueprintLikeLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("case_study", "like", "caseStudySlug"),
);
router.delete(
  "/case-studies/:caseStudySlug/like",
  requireAuth,
  blueprintLikeLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.makeToggleHandler("case_study", "like", "caseStudySlug"),
);

/*
 * THE TWO CROSS-ARM ENGAGEMENT ROUTES.
 *
 * ⚠️ `/comments/:commentId` IS MOUNTED HERE RATHER THAN AT THE ROOT. A second root-mounted
 * `/comments/:commentId` would collide with `engagement.routes.ts`'s `commentRouter` in `app.ts`.
 * The service resolves the id with two primary-key lookups — showcase, then teardown — and
 * collapses "no such comment" with "a comment under a blueprint you cannot see" into one 404.
 *
 * ⚠️ `/engagement/state` EXISTS SO THE PUBLIC READS CAN STAY BARE. Adding `viewerState` to them
 * would make every one per-viewer, force a session resolve on a page's opening element, and destroy
 * the cacheability that is the whole justification for their having no limiter.
 */

router.get(
  "/engagement/state",
  requireAuth,
  blueprintEngagementReadLimiter,
  blueprintEngagementController.getBlueprintViewerState,
);

/*
 * READER REPORTS.
 *
 * ⚠️ BY SLUG, WHICH IS THE OPPOSITE OF THE MODERATION VERBS, AND BOTH ARE RIGHT. The reporter is
 * standing on a public page and the slug is the only handle they have; the moderator is working a
 * queue that hands them an id.
 *
 * ⚠️ AUTHENTICATED AND IDENTIFIED, NOT BARE. The bare rule is about READS whose payload is identical
 * for every visitor. Beyond that: the partial unique index — one report per person per target — is
 * the anti-brigading control, and AN ANONYMOUS REPORT CANNOT BE DEDUPLICATED. An anonymous intake
 * would make the queue's depth something anybody could manufacture.
 *
 * ⚠️ NO IDEMPOTENCY KEY, and it would be redundant: the partial unique index already makes a
 * double-submit a 409 rather than a second row.
 *
 * ⚠️ RESOLVED UNDER THE READABLE GATE, so a QUARANTINED teardown still accepts a report —
 * `claim-targets`' reasoning exactly: a second rights holder may have an entirely different
 * objection, and refusing would use one quarantine to blunt the control that produced it.
 */

router.post(
  "/teardowns/:teardownSlug/reports",
  requireAuth,
  blueprintContentReportLimiter,
  requireIdentifiedUser,
  compactBody,
  blueprintContentReportController.makeCreateReportHandler("teardown", "teardownSlug"),
);

router.post(
  "/case-studies/:caseStudySlug/reports",
  requireAuth,
  blueprintContentReportLimiter,
  requireIdentifiedUser,
  compactBody,
  blueprintContentReportController.makeCreateReportHandler("case_study", "caseStudySlug"),
);

/*
 * The showcase arm's intake. Resolved under `('published','flagged')` — this arm has ONE gate,
 * like case studies, because `showcase_launch_moderation_state_ck` has no `quarantined` label for
 * a wider READABLE set to contain.
 *
 * No new limiter: `blueprintContentReportLimiter` is per-account and its ceiling bounds somebody
 * walking the catalogue reporting many different blueprints, which is arm-agnostic. A third
 * namespace would give that walk a third budget to hide in.
 */
router.post(
  "/showcases/:launchSlug/reports",
  requireAuth,
  blueprintContentReportLimiter,
  requireIdentifiedUser,
  compactBody,
  blueprintContentReportController.makeCreateReportHandler("showcase", "launchSlug"),
);

/*
 * THE DRAFT STORE — `/blueprints/drafts`.
 *
 * ⚠️ MOUNTED AT THE ROUTER ROOT RATHER THAN UNDER AN ARM, because one table serves all three
 * wizards. The arm is a column, not a path segment: three per-arm prefixes would each be a new
 * literal needing its own reserved-slug entry and CHECK widening, for a set of routes whose only
 * queries are "list mine" and "load one".
 *
 * ⚠️ THERE IS NO STAFF ROUTE HERE, AND THERE WILL NOT BE. A case-study draft can hold a company
 * name its author means to withhold, and §6's guarantee is that exactly ONE route in this router
 * serves such a name. A moderator-visible draft would make it two.
 *
 * `longFormBody` on both writers — the document is capped at 256 KiB by the column, and a route
 * with no declared cap fails `json-body-budget.test.ts` by name.
 */
router.post(
  "/drafts",
  requireAuth,
  blueprintDraftSaveLimiter,
  requireIdentifiedUser,
  longFormBody,
  blueprintDraftController.createDraft,
);

/** A flat list, labels only — a wizard index must not pull three 256 KiB documents to draw it. */
router.get("/drafts", requireAuth, blueprintDraftController.listMyDrafts);

router.get("/drafts/:draftId", requireAuth, blueprintDraftController.getMyDraft);

router.put(
  "/drafts/:draftId",
  requireAuth,
  blueprintDraftSaveLimiter,
  requireIdentifiedUser,
  longFormBody,
  blueprintDraftController.replaceDraft,
);

router.delete(
  "/drafts/:draftId",
  requireAuth,
  blueprintDraftSaveLimiter,
  requireIdentifiedUser,
  blueprintDraftController.deleteDraft,
);

/**
 * GET /blueprints/reports/mine — a flat list under a hard cap.
 *
 * ⚠️ IT EXISTS BECAUSE "a report that vanishes is indistinguishable from one nobody read."
 * Deliberately narrow: no moderator identity (naming them makes a takedown personal), no
 * resolution note, and no count of who else reported the same target (that makes brigading
 * measurable). What it carries is the status.
 */
router.get("/reports/mine", requireAuth, blueprintContentReportController.listMyBlueprintReports);

/**
 * GET /blueprints/admin/content-reports — the moderator queue, oldest first.
 *
 * ⚠️ A NEW ROUTE RATHER THAN AN ARM OF THE THREE REVIEW QUEUES. Those are keyed on
 * `pending_review` and backed by partial indexes on exactly that predicate; a report is about a row
 * that already PASSED that decision. And widening the case-study queue in particular would widen
 * the ONE route in this router that serves a withheld company's real name.
 */
router.get(
  "/admin/content-reports",
  requireAuth,
  blueprintContentReportController.listBlueprintReportQueue,
);

router.post(
  "/admin/content-reports/:reportId/dismiss",
  requireAuth,
  blueprintReportModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  idempotency({ required: true }),
  blueprintContentReportController.dismissBlueprintReport,
);

router.patch(
  "/comments/:commentId",
  requireAuth,
  blueprintCommentUpdateLimiter,
  requireIdentifiedUser,
  compactBody,
  blueprintEngagementController.updateBlueprintComment,
);
router.delete(
  "/comments/:commentId",
  requireAuth,
  blueprintCommentUpdateLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.deleteBlueprintComment,
);

router.put(
  "/comments/:commentId/like",
  requireAuth,
  blueprintCommentLikeLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.setBlueprintCommentLike,
);
router.delete(
  "/comments/:commentId/like",
  requireAuth,
  blueprintCommentLikeLimiter,
  requireIdentifiedUser,
  blueprintEngagementController.setBlueprintCommentLike,
);

/** GET /blueprints/admin/case-studies/review-queue — `moderate_content`, oldest first. */
router.get("/admin/case-studies/review-queue", requireAuth, caseStudyController.listReviewQueue);

/** POST /blueprints/admin/case-studies/:submissionId/moderate — publish or send back. */
router.post(
  "/admin/case-studies/:submissionId/moderate",
  requireAuth,
  caseStudyModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  idempotency({ required: true }),
  caseStudyController.moderateCaseStudy,
);

/** GET /blueprints/admin/showcases/review-queue — `moderate_content`, oldest first. */
router.get("/admin/showcases/review-queue", requireAuth, showcaseLaunchController.listReviewQueue);

/** POST /blueprints/admin/showcases/:submissionId/moderate — publish or send back. */
router.post(
  "/admin/showcases/:submissionId/moderate",
  requireAuth,
  showcaseLaunchModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  idempotency({ required: true }),
  showcaseLaunchController.moderateLaunch,
);

/** GET /blueprints/admin/teardowns/review-queue — `moderate_content`, oldest first. */
router.get(
  "/admin/teardowns/review-queue",
  requireAuth,
  teardownController.listTeardownReviewQueue,
);

/**
 * POST /blueprints/admin/teardowns/:submissionId/moderate — publish or send back.
 *
 * ⚠️ PUBLISHING IS WHERE A `teardown` ROW IS BORN, which is why this body carries two fields the
 * author never sent: `thumbnailUrl` and `difficulty` are NOT NULL on that table and the wizard
 * collects neither. They are editorial judgements about the write-up, which is the same kind of
 * decision as the public slug every other arm already asks a moderator to mint — and the line that
 * keeps a moderator from being asked to invent a fact about a unit they never held.
 *
 * `compactBody`, because a decision is a five-field object and a note.
 */
router.post(
  "/admin/teardowns/:submissionId/moderate",
  requireAuth,
  teardownModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  idempotency({ required: true }),
  teardownController.moderateTeardown,
);

/*
 * THE THREE VERBS THAT ACT ON A PUBLISHED BLUEPRINT — flag, quarantine, restore.
 *
 * ⚠️ A DIFFERENT OBJECT FROM `/:submissionId/moderate` ABOVE, AND THE PARAM NAME SAYS SO. That
 * route decides a SUBMISSION: publish it or send it back. These move a row that is already public,
 * and on the teardown arm that is literally a different table with a different id. The param is
 * `:teardownId`, never `:submissionId`, so the two cannot be confused at a glance or in a handler.
 *
 * ⚠️ ID-ADDRESSED, NOT SLUG-ADDRESSED, WHICH IS THE OPPOSITE OF THE ENGAGEMENT ROUTES ABOVE — and
 * the split is principled. A reader is standing on a public page and the slug is the only handle
 * they have; a moderator is working a queue that hands them an id, and §5's audit payload is ids
 * only. Slug-addressing here would also be unspellable on the case-study arm, whose `public_slug`
 * is NULL until a moderator mints one.
 *
 * ROUTE ORDER: both are three-segment paths ending in a distinct literal, so Express cannot
 * confuse them with the `/:submissionId/moderate` siblings. Neither adds a literal under an arm's
 * public prefix, so the derived literal lists are untouched.
 *
 * The existing moderation limiters are reused rather than given new namespaces: a flag and a
 * publish are the same person working the same queue, and two budgets for one queue would let
 * abuse of either hide in the other's headroom.
 */

router.post(
  "/admin/teardowns/:teardownId/moderation-state",
  requireAuth,
  teardownModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  idempotency({ required: true }),
  teardownController.setTeardownModerationState,
);

router.post(
  "/admin/case-studies/:caseStudyId/moderation-state",
  requireAuth,
  caseStudyModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  idempotency({ required: true }),
  caseStudyController.setCaseStudyModerationState,
);

/*
 * ⚠️ ON THIS ARM `:launchId` AND `:submissionId` ADDRESS THE SAME ROW IN THE SAME TABLE, which is
 * the one place the paragraph above needs a qualifier. A showcase has no separate submission
 * table — `showcase_launch` is both the paperwork and the published row — so the two routes really
 * do take the same id. The param is still named `:launchId`, because what the name records is
 * which ACT is being performed: `/moderate` decides a launch awaiting review, this moves one that
 * is already public. Naming it `:submissionId` here would make the two routes look interchangeable
 * to a reader, and they are not — their verb vocabularies are disjoint.
 */
router.post(
  "/admin/showcases/:launchId/moderation-state",
  requireAuth,
  showcaseLaunchModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  idempotency({ required: true }),
  showcaseLaunchController.setShowcaseLaunchModerationState,
);

export default router;
