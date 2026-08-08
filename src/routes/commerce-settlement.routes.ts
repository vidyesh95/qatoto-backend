import express from "express";

import * as commerceSettlementController from "#src/controllers/commerce-settlement.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import { commerceSettlementWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireActiveCommerceOrganization } from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

/**
 * Negotiated settlement agreements (STORE Phase 14).
 *
 * Scoped to an ACTIVE commerce organization rather than a buyer or seller one, because
 * either party may propose: a seller offering escrow to reassure a new buyer, or a buyer
 * asking for it on a large first order, are the same route. Which side the caller is on is
 * checked in the service against the agreement's own parties.
 */
const router = express.Router();

router.get(
  "/settlement/escrow-providers",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceSettlementController.listEligibleEscrowProviders,
);

router.get(
  "/threads/:threadId/settlement-agreements",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceSettlementController.listThreadAgreements,
);

router.post(
  "/threads/:threadId/settlement-agreements",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceSettlementWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceSettlementController.proposeAgreement,
);

router.post(
  "/settlement-agreements/:agreementId/responses",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceSettlementWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceSettlementController.respondToAgreement,
);

export default router;
