import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceDisputeWriteLimiter,
  commerceReviewMediaUploadLimiter,
  commerceReviewReplyLimiter,
  commerceReviewVoteLimiter,
  commerceReviewWriteLimiter,
  commerceTrustModerationLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { uploadProductImage } from "#src/modules/store/catalog/upload-product-image.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
  requireActiveSellerCommerceOrganization,
} from "#src/modules/store/organizations/require-active-commerce-organization.js";
import * as commerceTrustController from "#src/modules/store/trust/commerce-trust.controller.js";

const router = express.Router();

/**
 * Declared BEFORE the parameterized write below so the two read as one surface: this list
 * is where a buyer LEARNS a `completionId`, and without it the write under it is
 * unreachable. A read, so no rate limiter, no `compactBody`, no idempotency — matching
 * `GET /commerce/orders`.
 */
router.get(
  "/completions",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceTrustController.listBuyerCompletions,
);

router.post(
  "/completions/:completionId/reviews",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceReviewWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.createReview,
);

/**
 * A38. The author's one correction, within 30 days — Alibaba's rule.
 *
 * DECLARED BEFORE the `/reviews/:reviewId/...` routes below only for readability; PATCH shares
 * a verb with none of them. There is NO matching DELETE, and that absence is the design:
 * removal goes through A12's content report and a moderator's decision, so a seller cannot buy
 * a rating's withdrawal from the buyer who left it.
 *
 * `requireActiveBuyerCommerceOrganization`, matching review creation — the same organization
 * that wrote it is the only one that may correct it.
 */
router.patch(
  "/reviews/:reviewId",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceReviewWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.editOwnReview,
);

/**
 * A38. The author reading back their own review.
 *
 * THE ONLY AUTHOR-FACING REVIEW **READ**. Everything else on this surface is a write, so before this
 * route a buyer could publish a review and its photos and then never see them again — closing the
 * tab made the attachments unlistable and unremovable, and a YouTube video its host later deleted
 * became invisible rather than reported.
 *
 * IT IS DELIBERATELY NOT THE PUBLIC READ. The product page filters `state = 'visible'` media out and
 * carries no `state`; this one keeps both, because the author is the only party who can replace a
 * dead attachment.
 *
 * ROUTE ORDER: declared before `/reviews/:reviewId/media` and friends, but the paths differ in depth
 * so Express cannot confuse them. No limiter — `rate-limit-coverage.test.ts` scopes its bounds to
 * mutating verbs, and this is a session-scoped single-row read.
 */
router.get(
  "/reviews/:reviewId",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceTrustController.getOwnReview,
);

/**
 * Appendix A8 — review depth.
 *
 * ROUTE ORDER: `/reviews/:reviewId/media/:mediaId` is declared after
 * `/reviews/:reviewId/media` so the collection POST is never swallowed by the item
 * path — the same rule `/mine` before `/:id` follows elsewhere.
 *
 * `uploadProductImage` is reused VERBATIM. It is product-specific in nothing but its
 * filename: multer memory storage, one file, a 5 MB cap surfaced as 413, and an
 * `image/*` first-pass gate. There were already three near-copies of that file in this
 * repo and a fourth would be three too many.
 */
router.post(
  "/reviews/:reviewId/media",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceReviewMediaUploadLimiter,
  uploadProductImage,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.attachReviewPhoto,
);

router.post(
  "/reviews/:reviewId/videos",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceReviewWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.attachReviewVideo,
);

/**
 * NO `compactBody` on this route or the three below it: none of their handlers reads
 * `req.body`, and `json-body-budget.test.ts` fails the build for a cap that guards
 * nothing — it documents a limit that does not exist.
 */
router.delete(
  "/reviews/:reviewId/media/:mediaId",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceReviewWriteLimiter,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.detachReviewMedia,
);

/**
 * NO IDEMPOTENCY MIDDLEWARE on the helpful toggle, and that is deliberate: PUT and
 * DELETE of a boolean are idempotent by verb, so a double-tap on a slow connection is
 * already harmless. Same rule the like/save/subscribe routes document.
 *
 * `requireActiveCommerceOrganization` rather than the buyer variant — any trading
 * organization that is not a party to the review may vote on it. The two parties are
 * refused in the service and again by `commerce_review_vote_relationship_guard`.
 */
router.put(
  "/reviews/:reviewId/helpful",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceReviewVoteLimiter,
  commerceTrustController.setReviewHelpfulVote,
);

router.delete(
  "/reviews/:reviewId/helpful",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceReviewVoteLimiter,
  commerceTrustController.clearReviewHelpfulVote,
);

/**
 * The reply is written by the organization the review is ABOUT, which may be a product
 * seller or a service provider — so the generic organization guard, with
 * `memberCanOperateCounterparty` narrowing the role in the service.
 */
router.put(
  "/reviews/:reviewId/reply",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceReviewReplyLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.upsertReviewReply,
);

router.delete(
  "/reviews/:reviewId/reply",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceReviewReplyLimiter,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.deleteReviewReply,
);

router.post(
  "/orders/:orderId/disputes",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceDisputeWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.openDispute,
);

/**
 * A28. The participant reads, which had no route at all: a buyer could file a dispute
 * over a $200,000 order and had nothing that answered "what is happening with it". The
 * two party indexes existed with no reader.
 *
 * NOT under `/admin`. These are scoped to the caller's organization by the service, and
 * a non-party gets `404` rather than `403` so the route cannot enumerate dispute ids.
 */
router.get(
  "/disputes",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceTrustController.listParticipantDisputes,
);

router.get(
  "/disputes/:disputeId",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceTrustController.getDispute,
);

/**
 * A40. The write A28's read has been waiting for. `commerce_dispute_event_kind` has carried
 * `note_added` since `0052` with no writer, so a buyer could open a dispute over a six-figure
 * order and then say nothing further, and the seller could read the accusation and not answer it.
 *
 * Same guard as the two reads above — both parties may add, because both may read, and a
 * counterparty who cannot respond makes the timeline a one-sided record of a two-sided
 * disagreement. `requireActiveCommerceOrganization` rather than the buyer variant for exactly
 * that reason; `openDispute` above keeps its own because only a buyer may OPEN one.
 *
 * Idempotency is `required`, matching every other dispute write: a retried note on a flaky
 * connection must not append the same paragraph twice to an append-only table.
 */
router.post(
  "/disputes/:disputeId/notes",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceDisputeWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceTrustController.addDisputeNote,
);

router.get(
  "/admin/disputes",
  requireAuth,
  commerceTrustModerationLimiter,
  commerceTrustController.listModeratorDisputes,
);

router.post(
  "/admin/disputes/:disputeId/decisions",
  requireAuth,
  commerceTrustModerationLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceTrustController.decideDispute,
);

/**
 * A38. The seller's review inbox, and the read the reply routes above never had.
 *
 * `PUT|DELETE /reviews/:reviewId/reply` took an id only the PUBLIC per-product and
 * per-organization reads produced, so finding a review awaiting an answer meant paging every
 * review of every listing from the browser. `?unreplied=true` is that search, done server-side.
 *
 * `requireActiveSellerCommerceOrganization`, not the generic guard the reply writes carry: this
 * list is defined by being the SUBJECT of the reviews, and reviews are left about sellers.
 */
router.get(
  "/seller/reviews",
  requireAuth,
  requireActiveSellerCommerceOrganization,
  commerceTrustController.listSellerReviewInbox,
);

export default router;
