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
