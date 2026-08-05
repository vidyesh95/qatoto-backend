import express from "express";

import * as commerceOrganizationsController from "#src/controllers/commerce-organizations.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceOrganizationEvidenceLimiter,
  commerceOrganizationWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { uploadCommerceVerificationEvidence } from "#src/middleware/upload-commerce-verification-evidence.js";

const router = express.Router();

router.post(
  "/organizations",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.createOrganization,
);
router.get("/organizations/mine", requireAuth, commerceOrganizationsController.listMyOrganizations);
router.post(
  "/organizations/:organizationId/activate",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.activateOrganization,
);
router.patch(
  "/organizations/:organizationId",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.updateOrganization,
);
router.post(
  "/organizations/:organizationId/members",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.createMember,
);
router.patch(
  "/organizations/:organizationId/members/:memberId",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.updateMember,
);
router.get(
  "/organizations/:organizationId/addresses",
  requireAuth,
  commerceOrganizationsController.listAddresses,
);
router.post(
  "/organizations/:organizationId/addresses",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.createAddress,
);
router.patch(
  "/organizations/:organizationId/addresses/:addressId",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.updateAddress,
);
router.get(
  "/organizations/:organizationId/verifications",
  requireAuth,
  commerceOrganizationsController.listVerifications,
);
router.post(
  "/organizations/:organizationId/verifications",
  requireAuth,
  commerceOrganizationEvidenceLimiter,
  uploadCommerceVerificationEvidence,
  idempotency({ required: true }),
  commerceOrganizationsController.submitVerificationEvidence,
);
router.get(
  "/organizations/:organizationId/verifications/:verificationId/evidence",
  requireAuth,
  commerceOrganizationsController.downloadVerificationEvidence,
);
router.post(
  "/organizations/:organizationId/documents/:documentId/scanner-verdict",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.recordDocumentScannerVerdict,
);
router.post(
  "/organizations/:organizationId/verifications/:verificationId/decision",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.decideVerification,
);
router.post(
  "/admin/organizations/:organizationId/trade-state",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceOrganizationsController.transitionTradeState,
);

export default router;
