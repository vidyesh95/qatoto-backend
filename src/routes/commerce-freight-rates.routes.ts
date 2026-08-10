import express from "express";

import * as commerceFreightRatesController from "#src/controllers/commerce-freight-rates.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import { commerceFreightRateWriteLimiter } from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";

/**
 * The §19 delivery surface's REFERENCE DATA — admin writes only (Store Phase 20).
 *
 * ITS OWN ROUTER, not a wing of `commerce-fulfillment.routes.ts`. Every route in that file is
 * organization-scoped operational work behind membership guards; these are platform-owned
 * reference rows behind `moderate_commerce`. Sharing a file would carry the surrounding gate
 * assumption onto routes that do not have it, and that misread has a security shape.
 *
 * THE READS ARE NOT HERE AND WILL NOT BE. §19.5 extends
 * `GET /store/products/:productSlug/delivery-estimate` on the store router and adds
 * `GET /commerce/orders/:orderId/arrival-window` on the orders router — both routers that
 * already exist. A second copy of either would be two endpoints answering one question.
 *
 * NO CAPABILITY MIDDLEWARE IN ANY CHAIN, and it is not an omission. `moderate_commerce` is
 * checked INSIDE each service so it returns a `Result` that takes part in the controller's
 * exhaustive switch, and so it can be proven to run BEFORE any id is read. A route-level
 * guard would make the capability probeable from the route table, and an id-first service
 * would make each route an existence oracle.
 *
 * ROUTE ORDER: there is no literal sibling under `/admin/freight-rate-cards/` today, so
 * nothing here can be shadowed. `/breaks` sits one level BELOW `:rateCardId`, not beside it.
 * A future literal — `/admin/freight-rate-cards/lookup` — MUST be declared above the
 * `:rateCardId` routes or it is dead.
 *
 * `Idempotency-Key` IS REQUIRED ON EVERY ONE. A retried create is a duplicate price list that
 * would supersede the card the first attempt just minted, leaving the lane priced by a row
 * nobody meant to write. Scope is `user`, not `active_organization`: a moderator acts for the
 * platform and may not belong to any commerce organization at all.
 */
const router = express.Router();

router.post(
  "/admin/freight-rate-cards",
  requireAuth,
  commerceFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceFreightRatesController.createFreightRateCard,
);

router.post(
  "/admin/freight-rate-cards/:rateCardId/breaks",
  requireAuth,
  commerceFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceFreightRatesController.appendFreightRateBreak,
);

router.patch(
  "/admin/freight-rate-cards/:rateCardId/breaks",
  requireAuth,
  commerceFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceFreightRatesController.replaceFreightRateBreaks,
);

router.patch(
  "/admin/freight-rate-cards/:rateCardId",
  requireAuth,
  commerceFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceFreightRatesController.updateFreightRateCard,
);

router.post(
  "/admin/customs-dwell-estimates",
  requireAuth,
  commerceFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceFreightRatesController.createCustomsDwellEstimate,
);

router.patch(
  "/admin/customs-dwell-estimates/:dwellEstimateId",
  requireAuth,
  commerceFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "user" }),
  commerceFreightRatesController.retireCustomsDwellEstimate,
);

export default router;
