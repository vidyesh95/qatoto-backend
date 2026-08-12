import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { commerceRfqWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
  requireActiveProviderCommerceOrganization,
  requireProvisionedBuyerCommerceWorkspace,
} from "#src/modules/store/organizations/require-active-commerce-organization.js";
import * as commerceRfqsController from "#src/modules/store/procurement/commerce-rfqs.controller.js";

const router = express.Router();

/**
 * §14. DRAFTING IS OPEN TO A PENDING WORKSPACE; BROADCASTING IS NOT.
 *
 * §14 named "RFQ broadcast" as one of the four places the trust gate still earns something,
 * and a draft is not a broadcast — nothing reaches a provider until `/open` and
 * `/invitations`, both of which keep `requireActiveBuyerCommerceOrganization` below. Writing
 * and revising a draft, and reading one's own, are the taps in front of that gate.
 */
router.post(
  "/rfqs",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceRfqWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceRfqsController.createDraftRfq,
);

router.get(
  "/rfqs/mine",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceRfqsController.listMyRfqs,
);

router.get(
  "/provider/rfqs",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceRfqsController.listProviderRfqs,
);

router.get(
  "/rfqs/:rfqId",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceRfqsController.getRfq,
);

router.patch(
  "/rfqs/:rfqId",
  requireAuth,
  requireProvisionedBuyerCommerceWorkspace,
  commerceRfqWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceRfqsController.updateDraftRfq,
);

router.post(
  "/rfqs/:rfqId/open",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceRfqWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceRfqsController.openRfq,
);

router.post(
  "/rfqs/:rfqId/invitations",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceRfqWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceRfqsController.inviteProviders,
);

router.post(
  "/rfqs/:rfqId/close",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceRfqWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceRfqsController.closeRfq,
);

export default router;
