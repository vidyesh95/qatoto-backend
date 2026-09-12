import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  blueprintHeroImageUploadLimiter,
  blueprintHeroWriteLimiter,
  caseStudyModerationLimiter,
  caseStudySubmitLimiter,
  showcaseLaunchModerationLimiter,
  showcaseLaunchSubmitLimiter,
  showcaseWriteUpImageUploadLimiter,
  teardownModerationLimiter,
  teardownSubmitLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as blueprintHeroController from "#src/modules/home/blueprints/blueprint-hero.controller.js";
import * as caseStudyController from "#src/modules/home/blueprints/case-study.controller.js";
import * as showcaseLaunchController from "#src/modules/home/blueprints/showcase-launch.controller.js";
import * as teardownController from "#src/modules/home/blueprints/teardown.controller.js";
import { uploadBlueprintHeroSlideImageFile } from "#src/modules/home/blueprints/upload-blueprint-hero-image.js";
import {
  uploadShowcaseLaunchSubmissionFiles,
  uploadShowcaseWriteUpImageFile,
} from "#src/modules/home/blueprints/upload-showcase-launch-images.js";

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

/** GET /blueprints/teardowns/options — LITERAL, must stay above /:teardownSlug. */
router.get("/teardowns/options", teardownController.listTeardownOptions);

/** GET /blueprints/teardowns/slugs — LITERAL, must stay above /:teardownSlug. Readable gate. */
router.get("/teardowns/slugs", teardownController.listPublicTeardownSlugs);

/** GET /blueprints/teardowns — the index, its filters and its tag facets in one payload. */
router.get("/teardowns", teardownController.listPublicTeardowns);

/** GET /blueprints/teardowns/:teardownSlug/claim-targets — ids and titles, provably no URLs. */
router.get("/teardowns/:teardownSlug/claim-targets", teardownController.getTeardownClaimTargets);

/** GET /blueprints/teardowns/:teardownSlug — one readable teardown. DECLARED LAST of the five. */
router.get("/teardowns/:teardownSlug", teardownController.getPublicTeardown);

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

export default router;
