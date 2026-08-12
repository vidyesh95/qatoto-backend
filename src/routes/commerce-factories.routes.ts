import express from "express";

import * as storeFactoriesController from "#src/controllers/store-factories.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody, longFormBody } from "#src/middleware/json-body.js";
import {
  factoryDepthWriteLimiter,
  manufacturingInquiryReadLimiter,
  manufacturingInquiryWriteLimiter,
  siteAuditWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireActiveCommerceOrganization } from "#src/modules/store/organizations/require-active-commerce-organization.js";

/**
 * Manufacturing inquiries and seller-owned factory depth (§16.3, §16.5).
 *
 * Mounted at `/commerce`. The PUBLIC directory reads live on `storeRouter` instead, because
 * a signed-out visitor browses `/store` — the same split every other commerce surface uses.
 *
 * CHAIN ORDER, as everywhere here: auth → organization → limiter → parser → idempotency →
 * controller.
 *
 * ROUTE ORDER IS LOAD-BEARING. `/factories/inquiries/...` and `/factories/:factorySlug/...`
 * are both three segments deep, so a literal declared after the parameter would be
 * captured as `:factorySlug = "inquiries"`. Literals first, and
 * `commerce-factories.routes.order.test.ts` asserts it stays that way.
 *
 * NO CAPABILITY MIDDLEWARE ON THE `/admin/*` PAIR. `moderate_commerce` is checked INSIDE
 * the service before any id is read, so the refusal is a `Result` — a route-level guard
 * makes the capability probeable, and an id-first service makes the route an existence
 * oracle. This is the rule `commerce-content-reports.routes.ts` states at length.
 */
const router = express.Router();

// --- Literal `/factories/inquiries/*` first. See the ordering note above.

router.get(
  "/factories/inquiries/mine",
  requireAuth,
  requireActiveCommerceOrganization,
  manufacturingInquiryReadLimiter,
  storeFactoriesController.listMyManufacturingInquiries,
);

router.get(
  "/factories/inquiries/received",
  requireAuth,
  requireActiveCommerceOrganization,
  manufacturingInquiryReadLimiter,
  storeFactoriesController.listReceivedManufacturingInquiries,
);

router.get(
  "/factories/inquiries/:inquiryId",
  requireAuth,
  requireActiveCommerceOrganization,
  manufacturingInquiryReadLimiter,
  storeFactoriesController.getManufacturingInquiry,
);

/**
 * The three transitions carry NO `compactBody`: none of them reads `req.body`, and
 * `json-body-budget.test.ts` fails the build for a cap guarding nothing.
 *
 * They also carry NO `idempotency()`. Each is a guarded single transition — `send` refuses
 * anything but `draft`, `answer` anything but `sent`, `close` anything but a live row — so
 * a replay is a 409 rather than a duplicate. The CREATE below is the one that needs a key,
 * because a retry there is a second row in a human's queue.
 */
router.post(
  "/factories/inquiries/:inquiryId/send",
  requireAuth,
  requireActiveCommerceOrganization,
  manufacturingInquiryWriteLimiter,
  storeFactoriesController.sendManufacturingInquiry,
);

router.post(
  "/factories/inquiries/:inquiryId/answer",
  requireAuth,
  requireActiveCommerceOrganization,
  manufacturingInquiryWriteLimiter,
  storeFactoriesController.answerManufacturingInquiry,
);

router.post(
  "/factories/inquiries/:inquiryId/close",
  requireAuth,
  requireActiveCommerceOrganization,
  manufacturingInquiryWriteLimiter,
  storeFactoriesController.closeManufacturingInquiry,
);

/**
 * `Idempotency-Key` REQUIRED. A retry without one is a second inquiry in the factory's
 * queue, which a human then has to close by hand.
 *
 * `longFormBody`: `productDescription` is 5000 characters and `notes` another 4000, so the
 * 16 KB compact cap would refuse a legitimate brief.
 */
router.post(
  "/factories/:factorySlug/inquiries",
  requireAuth,
  requireActiveCommerceOrganization,
  manufacturingInquiryWriteLimiter,
  longFormBody,
  idempotency({ required: true, scope: "active_organization" }),
  storeFactoriesController.createManufacturingInquiry,
);

// --- Seller-owned factory depth. Authorized by membership inside the service.

router.put(
  "/organizations/:organizationId/production-lines",
  requireAuth,
  factoryDepthWriteLimiter,
  longFormBody,
  storeFactoriesController.replaceProductionLines,
);

router.put(
  "/organizations/:organizationId/sites",
  requireAuth,
  factoryDepthWriteLimiter,
  longFormBody,
  storeFactoriesController.replaceOrganizationSites,
);

router.put(
  "/organizations/:organizationId/factory-terms",
  requireAuth,
  factoryDepthWriteLimiter,
  compactBody,
  storeFactoriesController.replaceFactoryTerms,
);

// --- Staff site audits.

router.get(
  "/admin/organizations/:organizationId/site-audits",
  requireAuth,
  siteAuditWriteLimiter,
  storeFactoriesController.listSiteAudits,
);

router.post(
  "/admin/organizations/:organizationId/site-audits",
  requireAuth,
  siteAuditWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  storeFactoriesController.recordSiteAudit,
);

router.post(
  "/admin/site-audits/:auditId/withdraw",
  requireAuth,
  siteAuditWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  storeFactoriesController.withdrawSiteAudit,
);

export default router;
