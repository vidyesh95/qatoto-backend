import express from "express";

import * as commerceTrustController from "#src/controllers/commerce-trust.controller.js";
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
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
} from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { uploadProductImage } from "#src/middleware/upload-product-image.js";

const router = express.Router();

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

router.delete(
  "/reviews/:reviewId/media/:mediaId",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceReviewWriteLimiter,
  compactBody,
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
  compactBody,
  commerceTrustController.setReviewHelpfulVote,
);

router.delete(
  "/reviews/:reviewId/helpful",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceReviewVoteLimiter,
  compactBody,
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
  compactBody,
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

export default router;
