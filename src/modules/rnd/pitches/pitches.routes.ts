/**
 * §12 pitch routes.
 *
 * TWO ROUTERS. The default one is mounted at `/` and owns `/pitches*` plus the one
 * `/funding-outcomes/:outcomeId/confirm` path; `projectPitchRouter` is mounted at
 * `/research-projects` and owns the project-scoped create and list. Same split as
 * `funding.routes.ts`, and for the same reason: a pitch is addressed by its own id
 * everywhere except at creation, where it does not have one yet.
 *
 * CHAIN ORDER, everywhere: auth → limiter → idempotency → requireIdentifiedUser → parser →
 * controller.
 *
 * ROUTE ORDER IS LOAD-BEARING. `/mine`, `/slugs` and `/review-queue` are literal segments
 * and are declared BEFORE `/:pitchSlug`, or Express matches the parameter first and a
 * founder asking for their own list gets a 404 for a pitch called "mine".
 *
 * NOTE THE TWO PARAMETER NAMES. Public reads take `:pitchSlug` (a slug is the public
 * identity and is what a link carries); every mutation takes `:pitchId`, because an id is
 * stable and a caller holding one has already been shown the row. The sub-path after the
 * parameter is what keeps them unambiguous.
 */

import express from "express";

import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { idempotency } from "#src/middleware/idempotency.js";
// `longFormBody` (128 KB) on the two routes that carry a pitch's prose, `compactBody`
// (16 KB) everywhere else. NOT a preference: a maximal legal body here is a 2000-character
// summary plus two 2048-character URLs, which `json-body-budget.test.ts` measures at ~25 KB
// once JSON escaping is counted — so `compactBody` would 413 a body this route's own schema
// declares valid. The test is what caught it.
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  pitchCreateLimiter,
  pitchModerationLimiter,
  pitchOutcomeLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";
import * as pitchesController from "#src/modules/rnd/pitches/pitches.controller.js";

const router = express.Router();

// --- Public reads. `attachOptionalUser` so a founder viewing their own pitch sees their
// --- unconfirmed funding records while a stranger does not.
router.get("/pitches", pitchesController.getPublicPitches);
router.get("/pitches/slugs", pitchesController.getPublishedPitchSlugs);

// --- Founder-scoped reads. Literal segments, before the slug parameter below.
router.get("/pitches/mine", requireAuth, pitchesController.getMyPitches);

// --- Moderation. The queue is a literal segment too.
router.get("/pitches/review-queue", requireAuth, pitchesController.getPitchReviewQueue);

// --- The public detail read. MUST come after every literal segment above.
router.get("/pitches/:pitchSlug", attachOptionalUser, pitchesController.getPitchBySlug);

// --- Founder writes.
router.patch(
  "/pitches/:pitchId",
  requireAuth,
  pitchCreateLimiter,
  requireIdentifiedUser,
  longFormBody,
  pitchesController.patchPitch,
);

router.post(
  "/pitches/:pitchId/submit",
  requireAuth,
  pitchCreateLimiter,
  requireIdentifiedUser,
  pitchesController.submitPitchForReview,
);

router.post(
  "/pitches/:pitchId/close",
  requireAuth,
  pitchCreateLimiter,
  requireIdentifiedUser,
  pitchesController.closePitchForFounder,
);

router.delete(
  "/pitches/:pitchId",
  requireAuth,
  requireIdentifiedUser,
  pitchesController.deletePitchDraft,
);

// --- Moderation verdict. The limiter is keyed on `req.user.id` and runs BEFORE the
// --- in-controller capability check, so a non-moderator spends their own budget
// --- discovering they are not staff rather than a moderator's.
router.post(
  "/pitches/:pitchId/moderate",
  requireAuth,
  pitchModerationLimiter,
  requireIdentifiedUser,
  compactBody,
  pitchesController.postPitchModeration,
);

// --- Funding outcomes. BOTH LAYERS OF IDEMPOTENCY on the record route: the middleware
// --- replays a whole response for a repeated HTTP request, and the body's
// --- `idempotencyKey` with its unique index makes the ROW unique for a repeated
// --- submission even across two different requests.
router.post(
  "/pitches/:pitchId/funding-outcomes",
  requireAuth,
  pitchOutcomeLimiter,
  idempotency(),
  requireIdentifiedUser,
  compactBody,
  pitchesController.postPitchOutcome,
);

router.post(
  "/funding-outcomes/:outcomeId/confirm",
  requireAuth,
  pitchOutcomeLimiter,
  requireIdentifiedUser,
  pitchesController.postOutcomeConfirmation,
);

export default router;

/** Mounted at `/research-projects`. */
export const projectPitchRouter = express.Router();

// NO PROJECT-SCOPED LIST ROUTE. `GET /pitches/mine` supersedes it — it is cross-project,
// founder-scoped and already carries the project name each row needs. A second read whose
// only difference is a narrower WHERE would have had no caller, and an uncalled route is
// unverified code the same way an uncalled hook is.

projectPitchRouter.post(
  "/:projectSlug/pitches",
  requireAuth,
  pitchCreateLimiter,
  idempotency(),
  requireIdentifiedUser,
  longFormBody,
  pitchesController.createProjectPitch,
);
