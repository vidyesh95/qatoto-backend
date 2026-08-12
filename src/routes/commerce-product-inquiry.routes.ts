import express from "express";

import * as commerceProductInquiryController from "#src/controllers/commerce-product-inquiry.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { commerceMessageWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireProvisionedBuyerCommerceWorkspace } from "#src/modules/store/organizations/require-active-commerce-organization.js";

/**
 * Pre-sales product inquiries (STORE Appendix A14) — the backend behind "Chat now".
 *
 * REQUIRES A BUYER ORGANIZATION, and that requirement is deliberate: §4.11 derives thread
 * participants from organization memberships, and every alternative that loosened it meant
 * nullable authorship on `commerce_message`, a shipped table with a shipped wire contract.
 *
 * WHAT PHASE 21 CHANGED IS WHO CAN CLEAR IT, NOT THE REQUIREMENT. Until §14's
 * auto-provisioning was built, "an organization exists" meant "staff have reviewed you", so
 * this route answered 403 to every new buyer. It now runs on
 * `requireProvisionedBuyerCommerceWorkspace`: the organization is still mandatory and still
 * the source of authorship, and it is now minted on the spot rather than waited for.
 *
 * A14's `contactAffordance` keeps all three values, but §14 records the consequence:
 * `ask_question` stops being the common case for a signed-in visitor, because a signed-in
 * visitor now has an organization. A9's public question route still accepts any identified
 * user and remains the answer for a visitor who is not signed in.
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
/**
 * §14, consequence for A14. Opens on a possibly-`pending` workspace since Phase 21 — §14's
 * own note says `ask_question` stops being the common case for a signed-in visitor "because
 * a signed-in visitor now has an organization", which only holds if the inquiry itself does
 * not demand an activated one.
 */
commerceProductInquiryRouter.post(
  "/products/:productId/inquiries",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceMessageWriteLimiter,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProductInquiryController.createOrGetProductInquiry,
);

/**
 * One route for both sides. An organization can be the buyer on one listing and the
 * seller on another, so `side` is a filter over rows the caller may already see rather
 * than a permission — two routes would imply otherwise.
 *
 * The same guard as the write, not a buyer-specific one: a seller reading its own inquiry
 * inbox is the other half of this feature, and both sides may be a pending workspace.
 */
commerceProductInquiryRouter.get(
  "/inquiries",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceProductInquiryController.listProductInquiries,
);

export default commerceProductInquiryRouter;
