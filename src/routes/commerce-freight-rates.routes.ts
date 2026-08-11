import express from "express";

import * as commerceFreightRatesController from "#src/controllers/commerce-freight-rates.controller.js";
import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceFreightRateReadLimiter,
  commerceFreightRateWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";

/**
 * The §19 delivery surface's REFERENCE DATA — the platform's own freight admin (Store Phase 20,
 * reads added per §19.10).
 *
 * ITS OWN ROUTER, not a wing of `commerce-fulfillment.routes.ts`. Every route in that file is
 * organization-scoped operational work behind membership guards; these are platform-owned
 * reference rows behind `moderate_commerce`. Sharing a file would carry the surrounding gate
 * assumption onto routes that do not have it, and that misread has a security shape.
 *
 * NO BUYER-FACING READ IS HERE, AND NONE WILL BE. §19.5 extends
 * `GET /store/products/:productSlug/delivery-estimate` on the store router and adds
 * `GET /commerce/orders/:orderId/arrival-window` on the orders router — both routers that
 * already exist. A second copy of either would be two endpoints answering one question.
 *
 * THE TWO READS BELOW ARE THE OPERATOR'S, WHICH IS A DIFFERENT ASK (§19.10). A buyer asks what
 * a shipment costs; a moderator asks what rows this platform holds. Four of the six writes take
 * an id no other route yields, so without these the lifecycle half of this surface — shorten,
 * withdraw, correct the bands — could not be called at all. Worse, `POST /freight-rate-cards`
 * closes the incumbent on its lane inside its own transaction and names it only in that one
 * reply, so an operator with no list replaces a live price and is told afterwards.
 *
 * NO CAPABILITY MIDDLEWARE IN ANY CHAIN, reads included, and it is not an omission.
 * `moderate_commerce` is checked INSIDE each service so it returns a `Result` that takes part
 * in the controller's exhaustive switch, and so it can be proven to run BEFORE any id OR FILTER
 * VALUE is read. A route-level guard would make the capability probeable from the route table,
 * and a filter-first service would make each read an existence oracle for lanes and providers.
 *
 * ROUTE ORDER: `/admin/freight-rate-cards` is the collection itself, so it cannot be shadowed
 * by `:rateCardId` — Express matches the segment count first, and the two disagree. `/breaks`
 * sits one level BELOW `:rateCardId`, not beside it. A future literal at the same depth —
 * `/admin/freight-rate-cards/lookup` — MUST still be declared above the `:rateCardId` routes
 * or it is dead.
 *
 * `Idempotency-Key` IS REQUIRED ON EVERY WRITE AND ON NO READ. A retried create is a duplicate
 * price list that would supersede the card the first attempt just minted, leaving the lane
 * priced by a row nobody meant to write; a retried list changes nothing and has no body to key
 * on. Scope is `user`, not `active_organization`: a moderator acts for the platform and may not
 * belong to any commerce organization at all.
 *
 * THE READS TAKE THEIR OWN LIMITER. Paging a lane's history must not spend the allowance the
 * operator then needs to fix what the page showed them.
 */
const router = express.Router();

router.get(
  "/admin/freight-rate-cards",
  requireAuth,
  commerceFreightRateReadLimiter,
  commerceFreightRatesController.listFreightRateCards,
);

router.get(
  "/admin/customs-dwell-estimates",
  requireAuth,
  commerceFreightRateReadLimiter,
  commerceFreightRatesController.listCustomsDwellEstimates,
);

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
