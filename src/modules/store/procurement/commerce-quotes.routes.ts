import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { commerceQuoteWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
  requireActiveProviderCommerceOrganization,
} from "#src/modules/store/organizations/require-active-commerce-organization.js";
import * as commerceQuotesController from "#src/modules/store/procurement/commerce-quotes.controller.js";

const router = express.Router();

router.post(
  "/rfqs/:rfqId/quotes",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceQuoteWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.createQuoteShell,
);

router.post(
  "/quotes/:quoteId/revisions",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceQuoteWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.appendRevision,
);

router.post(
  "/quotes/:quoteId/revisions/:revision/submit",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceQuoteWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.submitRevision,
);

/**
 * A38. Discards an unsubmitted revision, and it is the missing half of a promise the API already
 * made: `appendRevision` refuses a second draft with "Submit or abandon the existing unsubmitted
 * revision before appending another", and nothing delivered the abandon.
 *
 * Without it the surface had a terminal state. A revision whose `validityDeadlineAt` passed could
 * not be submitted (`QUOTE_EXPIRED`), could not be replaced (the guard above), and could not be
 * started over (one quote per provider per RFQ, whatever its status) — so the quote was dead for
 * that RFQ with no operator path out.
 *
 * **NO BODY MIDDLEWARE, deliberately, and it must stay that way.** The handler reads no `req.body`,
 * and `json-body-budget.test.ts` fails the build for a declared cap that guards nothing — so adding
 * `compactBody` here without also parsing a body would break CI. The three trust DELETEs document
 * the same pairing.
 *
 * IDEMPOTENCY IS STILL REQUIRED. The middleware is verb-agnostic and fingerprints method + URL +
 * body, so an undefined body hashes fine — and a retried discard that the server already applied
 * must not be mistaken for a second, different discard once the numbering has moved.
 *
 * Declared here rather than at the end so the revision lifecycle reads append → submit → abandon in
 * one block. Route ordering is not load-bearing: this is the router's only DELETE.
 */
router.delete(
  "/quotes/:quoteId/revisions/:revision",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceQuoteWriteLimiter,
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.abandonRevision,
);

/**
 * A38. The provider's own bids across every RFQ, and the twin of `GET /commerce/provider/rfqs`.
 *
 * `requireActiveProviderCommerceOrganization`, matching the write routes above rather than the
 * RFQ-scoped read below: this list is defined by authorship, and only a provider organization
 * can author a quote.
 *
 * A LITERAL PATH SEGMENT beside no `:param` route of the same depth, so ordering is not load
 * bearing here — `/quotes/:quoteId` is `/quotes` + one segment and cannot capture `/provider`.
 */
router.get(
  "/provider/quotes",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceQuotesController.listProviderQuotes,
);

/**
 * A44. The caller's accepted quote product lines, so a seller can name what a listing's goods cost.
 *
 * NEUTRAL GUARD, like `GET /quotes/:quoteId` below rather than the buyer- or provider-specific
 * ones. The caller is a SELLER writing a listing and was the BUYER of the quote — one organization
 * in two roles, which §1.3 already contemplates. The service authorizes on
 * `commerce_rfq.buyerOrganizationId`, which is the only place a quote's buyer is recorded.
 *
 * Declared before `/quotes/:quoteId`: no shadowing is possible (different first segment) but the
 * route-order sweep reads this file, and keeping collection reads above parameterised ones is the
 * convention it enforces.
 */
router.get(
  "/sourcing/quote-lines",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceQuotesController.listSourcingQuoteLines,
);

router.get(
  "/rfqs/:rfqId/quotes",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceQuotesController.listQuotesForRfq,
);

router.get(
  "/quotes/:quoteId",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceQuotesController.getQuote,
);

router.post(
  "/quotes/:quoteId/accept",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceQuoteWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.acceptQuote,
);

router.post(
  "/quotes/:quoteId/decline",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceQuoteWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.declineQuote,
);

router.post(
  "/quotes/:quoteId/withdraw",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceQuoteWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.withdrawQuote,
);

export default router;
