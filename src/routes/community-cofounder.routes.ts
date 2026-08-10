import express from "express";

import * as communityCofounderController from "#src/controllers/community-cofounder.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  cofounderProfileWriteLimiter,
  communityModerationLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * The cofounder directory's WRITE surface (STORE_BACKEND_STRUCTURE.md §18.3).
 *
 * MOUNTED AT `/community`, NOT `/commerce` (§1.1). A cofounder profile is not an
 * organization, nothing here is priced and nothing is ordered. The public READS are on
 * `/store`, which is the prefix a signed-out visitor browses.
 *
 * THE LIFECYCLE THE FRONTEND CONTRACT OMITTED IS THE POINT OF THIS FILE. As specified,
 * `POST` answered `draft`, public reads returned only `published`, and there was no publish
 * route, no `/mine` read and no withdraw — a user created a profile nobody could ever see,
 * including themselves. All seven of the missing routes are here.
 *
 * `requireIdentifiedUser` IS ON EVERY AUTHORING ROUTE. §18.4 settles which identity notion
 * this surface uses and forbids inventing a second one, and this is that one: the badge on
 * the profile derives from `isIdentifiedUser`, the predicate this same middleware enforces.
 *
 * NO ROUTE TAKES A `:userId`. The viewer posts about themselves, and `/mine` is the only
 * addressing an owner gets — a directory of people who did not consent to being in it is a
 * different product with a different legal shape.
 */
const router = express.Router();

// --- Literal `/cofounder-profiles/mine*` before any parameterised sibling.

router.get(
  "/cofounder-profiles/mine",
  requireAuth,
  cofounderProfileWriteLimiter,
  communityCofounderController.getMyCofounderProfile,
);

router.patch(
  "/cofounder-profiles/mine",
  requireAuth,
  cofounderProfileWriteLimiter,
  requireIdentifiedUser,
  longFormBody,
  communityCofounderController.updateMyCofounderProfile,
);

/**
 * The three transitions read no body, so they carry no cap and no idempotency key: each is
 * a guarded single transition that answers 409 on a replay rather than acting twice.
 */
router.post(
  "/cofounder-profiles/mine/submit",
  requireAuth,
  cofounderProfileWriteLimiter,
  requireIdentifiedUser,
  communityCofounderController.submitMyCofounderProfile,
);

router.post(
  "/cofounder-profiles/mine/withdraw",
  requireAuth,
  cofounderProfileWriteLimiter,
  communityCofounderController.withdrawMyCofounderProfile,
);

/**
 * ITS OWN ROUTE rather than a field on the PATCH, because it is the ONE edit a published
 * profile may make without re-entering moderation. Everything else is content a moderator
 * approved.
 */
router.patch(
  "/cofounder-profiles/mine/engagement-state",
  requireAuth,
  cofounderProfileWriteLimiter,
  compactBody,
  communityCofounderController.setMyEngagementState,
);

/**
 * `Idempotency-Key` REQUIRED. A retry without one is a duplicate profile of the same
 * person — which the unique index would refuse, but as a 409 the author has to interpret
 * rather than as the original result.
 */
router.post(
  "/cofounder-profiles",
  requireAuth,
  cofounderProfileWriteLimiter,
  idempotency({ required: true, scope: "user" }),
  requireIdentifiedUser,
  longFormBody,
  communityCofounderController.createCofounderProfile,
);

// --- Moderation. `moderate_content` is checked INSIDE the service, before any id is read.

router.get(
  "/admin/cofounder-profiles",
  requireAuth,
  communityModerationLimiter,
  communityCofounderController.listCofounderModerationQueue,
);

router.post(
  "/admin/cofounder-profiles/:profileId/moderate",
  requireAuth,
  communityModerationLimiter,
  idempotency({ required: true, scope: "user" }),
  compactBody,
  communityCofounderController.moderateCofounderProfile,
);

export default router;
