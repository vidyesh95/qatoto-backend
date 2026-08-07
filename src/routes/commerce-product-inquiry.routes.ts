import express from "express";

import * as commerceProductInquiryController from "#src/controllers/commerce-product-inquiry.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { commerceMessageWriteLimiter } from "#src/middleware/rate-limit.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
} from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

/**
 * Pre-sales product inquiries (STORE Appendix A14) — the backend behind "Chat now".
 *
 * REQUIRES AN ACTIVE BUYER ORGANIZATION, and that gate is deliberate: §4.11 derives
 * thread participants from organization memberships, and every alternative that
 * loosened it meant nullable authorship on `commerce_message`, a shipped table with a
 * shipped wire contract.
 *
 * The buyer who cannot clear that bar is NOT dead-ended — A9's public question route
 * accepts any identified user, which is why it shipped first, and the product detail
 * read tells the client which of the two to offer via `contactAffordance` rather than
 * leaving it to guess.
 *
 * Shares the message-write limiter with the thread routes on purpose: opening an
 * inquiry and sending into it are one action from the buyer's side, and splitting the
 * budget would let the cheaper half be used to exhaust the other.
 */
const commerceProductInquiryRouter = express.Router();

/**
 * NO `compactBody`: this route reads no body at all. The product comes from the path,
 * the buyer organization from the session context, the seller organization from the
 * product row, and the first message is posted through the existing thread route.
 * `json-body-budget.test.ts` fails the build for a cap that guards nothing, because a
 * declared limit that cannot apply is documentation of a rule that does not exist.
 */
commerceProductInquiryRouter.post(
  "/products/:productId/inquiries",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceMessageWriteLimiter,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProductInquiryController.createOrGetProductInquiry,
);

/**
 * One route for both sides. An organization can be the buyer on one listing and the
 * seller on another, so `side` is a filter over rows the caller may already see rather
 * than a permission — two routes would imply otherwise.
 *
 * `requireActiveCommerceOrganization`, not the buyer variant: a seller reading its own
 * inquiry inbox is the other half of this feature.
 */
commerceProductInquiryRouter.get(
  "/inquiries",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceProductInquiryController.listProductInquiries,
);

export default commerceProductInquiryRouter;
