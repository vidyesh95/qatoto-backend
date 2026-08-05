import express from "express";

import * as commerceOrganizationsController from "#src/controllers/commerce-organizations.controller.js";
import * as commerceProvidersController from "#src/controllers/commerce-providers.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { commerceProviderWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireActiveCommerceOrganization } from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { uploadCommerceVerificationEvidence } from "#src/middleware/upload-commerce-verification-evidence.js";

const commerceProvidersRouter = express.Router();

function mountProviderWriteRoutes(pathPrefix: "/providers" | "/providers/:organizationId"): void {
  commerceProvidersRouter.post(
    `${pathPrefix}/profile`,
    requireAuth,
    requireActiveCommerceOrganization,
    commerceProviderWriteLimiter,
    longFormBody,
    idempotency({ required: true, scope: "active_organization" }),
    commerceProvidersController.upsertProfile,
  );

  commerceProvidersRouter.post(
    `${pathPrefix}/kinds`,
    requireAuth,
    requireActiveCommerceOrganization,
    commerceProviderWriteLimiter,
    compactBody,
    idempotency({ required: true, scope: "active_organization" }),
    commerceProvidersController.addKindLink,
  );

  commerceProvidersRouter.get(
    `${pathPrefix}/offerings/mine`,
    requireAuth,
    requireActiveCommerceOrganization,
    commerceProvidersController.listMineOfferings,
  );

  commerceProvidersRouter.post(
    `${pathPrefix}/offerings`,
    requireAuth,
    requireActiveCommerceOrganization,
    commerceProviderWriteLimiter,
    longFormBody,
    idempotency({ required: true, scope: "active_organization" }),
    commerceProvidersController.createOffering,
  );
}

// Temporary aliases without :organizationId must register BEFORE param routes so
// `/providers/profile` is not captured as `:organizationId = "profile"`.
mountProviderWriteRoutes("/providers");
// Spec paths (STORE §6.1). Controllers authorize :organizationId against active org.
mountProviderWriteRoutes("/providers/:organizationId");

commerceProvidersRouter.post(
  "/providers/:organizationId/evidence",
  requireAuth,
  commerceProviderWriteLimiter,
  uploadCommerceVerificationEvidence,
  idempotency({ required: true }),
  commerceOrganizationsController.submitVerificationEvidence,
);

commerceProvidersRouter.patch(
  "/service-offerings/:offeringId",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceProviderWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProvidersController.updateOffering,
);

commerceProvidersRouter.post(
  "/service-offerings/:offeringId/submit",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceProviderWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProvidersController.submitOffering,
);

commerceProvidersRouter.put(
  "/service-offerings/:offeringId/coverage",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceProviderWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProvidersController.setCoverage,
);

commerceProvidersRouter.post(
  "/admin/service-offerings/:offeringId/moderate",
  requireAuth,
  commerceProviderWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceProvidersController.moderateOffering,
);

commerceProvidersRouter.post(
  "/admin/products/:productId/moderate",
  requireAuth,
  commerceProviderWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceProvidersController.moderateProduct,
);

commerceProvidersRouter.post(
  "/admin/suppliers/:supplierId/link-organization",
  requireAuth,
  commerceProviderWriteLimiter,
  compactBody,
  idempotency({ required: true }),
  commerceProvidersController.linkSupplier,
);

export default commerceProvidersRouter;
