import express from "express";

import * as commerceProvidersController from "#src/controllers/commerce-providers.controller.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import { idempotency } from "#src/middleware/idempotency.js";
import {
  commerceProviderWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireActiveCommerceOrganization } from "#src/middleware/require-active-commerce-organization.js";
import { requireAuth } from "#src/middleware/require-auth.js";

const commerceProvidersRouter = express.Router();

commerceProvidersRouter.post(
  "/providers/profile",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceProviderWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProvidersController.upsertProfile,
);

commerceProvidersRouter.post(
  "/providers/kinds",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceProviderWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProvidersController.addKindLink,
);

commerceProvidersRouter.get(
  "/providers/offerings/mine",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceProvidersController.listMineOfferings,
);

commerceProvidersRouter.post(
  "/providers/offerings",
  requireAuth,
  requireActiveCommerceOrganization,
  commerceProviderWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProvidersController.createOffering,
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
