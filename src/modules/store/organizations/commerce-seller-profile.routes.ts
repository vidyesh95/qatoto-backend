import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  commerceOrganizationEvidenceLimiter,
  commerceOrganizationWriteLimiter,
  productCatalogDepthWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceSellerProfileController from "#src/modules/store/organizations/commerce-seller-profile.controller.js";
import { uploadCommerceCertificate } from "#src/modules/store/organizations/upload-commerce-certificate.js";
import { uploadOrganizationMediaImage } from "#src/modules/store/organizations/upload-organization-media.js";
import { uploadStakeholderPhotoFile } from "#src/modules/store/organizations/upload-stakeholder-photo.js";

/**
 * Seller profile depth (Appendix A13, Phase 12).
 *
 * WHY A SEPARATE ROUTER from commerce-organizations.routes.ts, when every path here is
 * under `/organizations/:organizationId`: that file owns identity, membership, addresses and
 * verification — the things that decide whether an organization may trade at all. This file
 * owns the company's public FACE. They authorize differently (`PROFILE_MANAGERS` is narrower
 * than the address managers), they rate-limit differently, and mixing them would put
 * marketing copy in the same module as the trade-state gate.
 *
 * `/admin/certifications/:certificationId/decision` carries NO capability middleware, and
 * that is the posture commerce-content-reports.routes.ts established: `moderate_commerce` is
 * demanded by the SERVICE, inside the transaction that writes the decision, so the check and
 * the write cannot drift apart.
 */
const router = express.Router();

router.patch(
  "/organizations/:organizationId/seller-profile",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceSellerProfileController.upsertSellerProfile,
);

/**
 * The three PUT-replace surfaces. `longFormBody` because a twelve-row site-access list with
 * notes exceeds the compact cap, matching what `PUT /products/:id/variants` needed.
 */
router.put(
  "/organizations/:organizationId/site-access",
  requireAuth,
  commerceOrganizationWriteLimiter,
  longFormBody,
  idempotency({ required: true }),
  commerceSellerProfileController.replaceSiteAccess,
);
router.put(
  "/organizations/:organizationId/stakeholders",
  requireAuth,
  commerceOrganizationWriteLimiter,
  longFormBody,
  idempotency({ required: true }),
  commerceSellerProfileController.replaceStakeholders,
);
/**
 * Migration `0091`. Multipart, so no body-cap middleware — multer owns this body, as on
 * the company-media upload below.
 */
router.post(
  "/organizations/:organizationId/stakeholders/:stakeholderId/photo",
  requireAuth,
  productCatalogDepthWriteLimiter,
  uploadStakeholderPhotoFile,
  idempotency({ required: true }),
  commerceSellerProfileController.replaceStakeholderPhoto,
);
router.put(
  "/organizations/:organizationId/capabilities",
  requireAuth,
  commerceOrganizationWriteLimiter,
  longFormBody,
  idempotency({ required: true }),
  commerceSellerProfileController.replaceCapabilities,
);

/**
 * `media/reorder` is declared BEFORE `media/:mediaId` so "reorder" is never read as a media
 * id — the same ordering `/:id/images/reorder` needs in products.routes.ts.
 */
router.patch(
  "/organizations/:organizationId/media/reorder",
  requireAuth,
  productCatalogDepthWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceSellerProfileController.reorderOrganizationMedia,
);
router.post(
  "/organizations/:organizationId/media",
  requireAuth,
  productCatalogDepthWriteLimiter,
  uploadOrganizationMediaImage,
  idempotency({ required: true }),
  commerceSellerProfileController.addOrganizationMedia,
);
/**
 * No `compactBody`: this controller reads params only. `json-body-budget.test.ts` treats a
 * declared cap on a route that never reads a body as a documented lie and fails the build.
 */
router.delete(
  "/organizations/:organizationId/media/:mediaId",
  requireAuth,
  productCatalogDepthWriteLimiter,
  idempotency({ required: true }),
  commerceSellerProfileController.deleteOrganizationMedia,
);

/**
 * Certification evidence has its OWN multipart middleware, not the verification one.
 *
 * That was the plan, and the plan was wrong: `uploadCommerceVerificationEvidence` sets
 * `fields: 2` for its own two text parts, and a certification sends six — so every
 * submission came back a flat 422 from multer's `LIMIT_FIELD_COUNT`. The HTTP smoke caught
 * it; nothing else could have, because the field cap lives in middleware no unit test loads.
 * The size cap and media-type allowlist are still shared.
 *
 * The evidence limiter, not the write limiter: an upload is the expensive path.
 */
router.get(
  "/organizations/:organizationId/certifications",
  requireAuth,
  commerceSellerProfileController.listCertifications,
);
router.post(
  "/organizations/:organizationId/certifications",
  requireAuth,
  commerceOrganizationEvidenceLimiter,
  uploadCommerceCertificate,
  idempotency({ required: true }),
  commerceSellerProfileController.submitCertification,
);

router.post(
  "/admin/certifications/:certificationId/decision",
  requireAuth,
  commerceOrganizationWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceSellerProfileController.decideCertification,
);

export default router;
