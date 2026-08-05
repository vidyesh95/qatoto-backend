import express from "express";

import * as commerceRfqsController from "#src/controllers/commerce-rfqs.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { commerceRfqWriteLimiter } from "#src/middleware/rate-limit.js";
import {
  requireActiveBuyerCommerceOrganization,
  requireActiveCommerceOrganization,
  requireActiveProviderCommerceOrganization,
} from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const router = express.Router();

router.post(
  "/rfqs",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceRfqWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceRfqsController.createDraftRfq,
);

router.get(
  "/rfqs/mine",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
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
  requireActiveBuyerCommerceOrganization,
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
