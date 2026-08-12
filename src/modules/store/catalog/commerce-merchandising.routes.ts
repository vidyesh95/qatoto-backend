import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  commerceOrganizationEvidenceLimiter,
  commercePathwayWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceMerchandisingController from "#src/modules/store/catalog/commerce-merchandising.controller.js";
import {
  attachOptionalSellerCommerceOrganization,
  requireActiveBuyerCommerceOrganization,
} from "#src/modules/store/organizations/require-active-commerce-organization.js";
import { uploadCommerceVerificationEvidence } from "#src/modules/store/organizations/upload-commerce-verification-evidence.js";
import { uploadPathwayImageFile } from "#src/modules/store/storefront/upload-pathway-image.js";

/**
 * Guided pathway authoring and moderation (STORE_BACKEND_STRUCTURE.md §15.8).
 *
 * Public reads live on the store router; only writes are here.
 *
 * Two things about these chains are deliberate. First, `moderate_commerce` is checked
 * INSIDE the services, never here — the capability is not probeable from the route
 * table, matching `commerce-catalog.routes.ts` and `commerce-trust.routes.ts`. Second,
 * the authoring routes attach a seller organization OPTIONALLY: §15.5 gives a set two
 * legitimate authors, and a platform merchandiser may belong to no commerce
 * organization at all, so a hard seller guard would lock them out of their own surface.
 *
 * That second point is also why idempotency here is scoped to the USER rather than the
 * active organization: the organization scope refuses a caller who has none, which
 * would 403 every merchandiser before the service ever saw the request. User scope is
 * strictly narrower, never wider — a key still cannot be replayed across accounts.
 */
const router = express.Router();

router.post(
  "/pathways",
  requireAuth,
  attachOptionalSellerCommerceOrganization,
  commercePathwayWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceMerchandisingController.createPathway,
);

router.get(
  "/pathways/mine",
  requireAuth,
  attachOptionalSellerCommerceOrganization,
  commerceMerchandisingController.listAuthoredPathways,
);

router.patch(
  "/pathways/:pathwayId",
  requireAuth,
  attachOptionalSellerCommerceOrganization,
  commercePathwayWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceMerchandisingController.updatePathway,
);

/**
 * Migration `0091`. Multipart, so no `compactBody` — multer owns this body. Registered
 * BEFORE `/pathways/:pathwayId/slots` for readability only; the paths are disjoint.
 */
router.post(
  "/pathways/:pathwayId/images/:imageSlot",
  requireAuth,
  attachOptionalSellerCommerceOrganization,
  commerceOrganizationEvidenceLimiter,
  uploadPathwayImageFile,
  idempotency({ required: true, scope: "user" }),
  commerceMerchandisingController.replacePathwayImage,
);

router.put(
  "/pathways/:pathwayId/slots",
  requireAuth,
  attachOptionalSellerCommerceOrganization,
  commercePathwayWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "user" }),
  commerceMerchandisingController.replacePathwaySlots,
);

router.put(
  "/pathways/:pathwayId/slots/:slotId/candidates",
  requireAuth,
  attachOptionalSellerCommerceOrganization,
  commercePathwayWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "user" }),
  commerceMerchandisingController.replacePathwaySlotCandidates,
);

router.post(
  "/pathways/:pathwayId/submit",
  requireAuth,
  attachOptionalSellerCommerceOrganization,
  commercePathwayWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceMerchandisingController.submitPathway,
);

/**
 * The queue exists so the moderate route is reachable: without it a reviewer would
 * have to be handed an id out of band, which is how a review step quietly stops
 * happening.
 */
router.get(
  "/admin/pathways",
  requireAuth,
  commercePathwayWriteLimiter,
  commerceMerchandisingController.listPathwayModerationQueue,
);

router.post(
  "/admin/pathways/:pathwayId/moderate",
  requireAuth,
  commercePathwayWriteLimiter,
  compactBody,
  // Scoped to the user, not an organization: a moderator acts for the platform.
  idempotency({ required: true, scope: "user" }),
  commerceMerchandisingController.moderatePathway,
);

/**
 * A18. Buyer-uploaded customization artwork. Reuses the verification-evidence upload
 * middleware verbatim — same size cap, same allowlist, same magic-byte check — because
 * the threat model is identical: untrusted bytes from an authenticated stranger.
 */
router.post(
  "/customization-assets",
  requireAuth,
  requireActiveBuyerCommerceOrganization,
  commerceOrganizationEvidenceLimiter,
  uploadCommerceVerificationEvidence,
  commerceMerchandisingController.uploadCustomizationAsset,
);

export default router;
