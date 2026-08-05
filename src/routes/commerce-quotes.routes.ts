import express from "express";

import * as commerceQuotesController from "#src/controllers/commerce-quotes.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { commerceQuoteWriteLimiter } from "#src/middleware/rate-limit.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
  requireActiveProviderCommerceOrganization,
} from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

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
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.submitRevision,
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
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.declineQuote,
);

router.post(
  "/quotes/:quoteId/withdraw",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceQuoteWriteLimiter,
  idempotency({ required: true, scope: "active_organization" }),
  commerceQuotesController.withdrawQuote,
);

export default router;
