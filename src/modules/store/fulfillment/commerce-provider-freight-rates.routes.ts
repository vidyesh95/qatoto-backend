import express from "express";

import { idempotency } from "#src/middleware/idempotency.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceProviderFreightRateReadLimiter,
  commerceProviderFreightRateWriteLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import * as commerceProviderFreightRatesController from "#src/modules/store/fulfillment/commerce-provider-freight-rates.controller.js";
import { requireActiveProviderCommerceOrganization } from "#src/modules/store/organizations/require-active-commerce-organization.js";

/**
 * §19.12 — THE LANES AN APPROVED FREIGHT PROVIDER AUTHORS FOR ITSELF.
 *
 * ITS OWN ROUTER, not a wing of `commerce-freight-rates.routes.ts`. Every route in that file is
 * a platform-owned reference row behind `moderate_commerce`; every route here is
 * organization-scoped supply-side work behind a membership guard and a provider approval.
 * Sharing a file would carry one file's gate assumption onto routes that do not have it, and
 * that misread has a security shape.
 *
 * WHY THIS SURFACE EXISTS AT ALL. A36 recorded the freight tables as blocked on a purchase —
 * "no forwarder lane list has been bought". That was an ACCESS problem wearing a budget's
 * clothes: the six staff routes are `moderate_commerce`, so the only party who may type a
 * forwarder's tariff is Qatoto, including the tariff of a forwarder already approved and
 * selling on `/store/providers`. Nothing is being bought here. The supply side is being let in.
 *
 * NO CUSTOMS-DWELL TWIN, AND THAT IS NOT AN OMISSION. `commerce_customs_dwell_estimate` has no
 * provider column — it is scoped by destination, origin and commodity and is platform-wide. A
 * forwarder is not a broker, and a per-provider dwell figure would have nothing to key on.
 * Dwell stays `moderate_commerce`.
 *
 * ⚠️ THE GUARD IS THE MEMBERSHIP HALF ONLY. `requireActiveProviderCommerceOrganization` proves
 * an active organization and a provider-shaped member role, exactly as it does for
 * `GET /commerce/provider/rfqs` and `/provider/quotes`. IT DOES NOT PROVE THE ORGANIZATION MAY
 * SELL FREIGHT. That check — a `verified` `commerce_provider_kind_link` of kind
 * `freight_forwarder` or `logistics_operator` — is the first statement of every service
 * function, so it returns a `Result` that takes part in the controller's exhaustive switch, and
 * so it provably runs BEFORE any card id or filter value is read. A route-level guard would
 * make the capability probeable from the route table, and a filter-first service would make
 * each read an existence oracle for lanes.
 *
 * ⚠️ `providerOrganizationId` NEVER APPEARS IN A BODY OR A QUERY. It is derived from the
 * session, and the `.strict()` schemas REFUSE a submitted one with a 422 naming the field
 * rather than ignoring it — a submitted one is a forwarder authoring a competitor's tariff, and
 * a silently dropped field is an attempt that looked like it worked.
 *
 * ROUTE ORDER IS NOT LOAD-BEARING HERE. `/provider/freight-rate-cards` is a collection one
 * segment shorter than `:rateCardId`, and `/breaks` sits one level BELOW `:rateCardId` rather
 * than beside it, so no pattern on this router can capture another. The hazard would return the
 * day a literal lands at the SAME depth as `:rateCardId` — `/provider/freight-rate-cards/import`
 * would have to be declared ABOVE the `:rateCardId` routes, because there Express's
 * first-declared-wins order is the only thing separating them.
 *
 * `Idempotency-Key` IS REQUIRED ON EVERY WRITE AND ON NO READ. A retried create is a duplicate
 * tariff that would supersede the card the first attempt just minted, leaving the lane priced by
 * a row nobody meant to write; a retried list changes nothing and has no body to key on.
 *
 * SCOPE IS `active_organization`, NOT `user` — the opposite of the staff routes, and for the
 * mirror of their reason. A moderator acts for the platform and may belong to no commerce
 * organization at all; a provider always acts as one, and two operators at the same forwarder
 * retrying the same submission must collide rather than publish it twice.
 */
const router = express.Router();

router.get(
  "/provider/freight-rate-cards",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceProviderFreightRateReadLimiter,
  commerceProviderFreightRatesController.listProviderFreightRateCards,
);

router.post(
  "/provider/freight-rate-cards",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceProviderFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProviderFreightRatesController.createProviderFreightRateCard,
);

router.post(
  "/provider/freight-rate-cards/:rateCardId/breaks",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceProviderFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProviderFreightRatesController.appendProviderFreightRateBreak,
);

router.patch(
  "/provider/freight-rate-cards/:rateCardId/breaks",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceProviderFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProviderFreightRatesController.replaceProviderFreightRateBreaks,
);

router.patch(
  "/provider/freight-rate-cards/:rateCardId",
  requireAuth,
  requireActiveProviderCommerceOrganization,
  commerceProviderFreightRateWriteLimiter,
  compactBody,
  idempotency({ required: true, scope: "active_organization" }),
  commerceProviderFreightRatesController.updateProviderFreightRateCard,
);

export default router;
