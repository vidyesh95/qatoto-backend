import express from "express";

import * as commerceProductEngagementController from "#src/controllers/commerce-product-engagement.controller.js";
import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { compactBody } from "#src/middleware/json-body.js";
import {
  commerceProductEngagementLimiter,
  commerceProductShareLimiter,
  commerceProductViewBeaconLimiter,
} from "#src/middleware/rate-limit.js";
import { requireAuth } from "#src/middleware/require-auth.js";
import { requireIdentifiedUser } from "#src/middleware/require-identified-user.js";

/**
 * Buyer engagement writes on a public listing (STORE Appendix A11).
 *
 * MOUNTED UNDER `/store` but declared in its own router, because `store.routes.ts`
 * applies `attachOptionalUser, storeReadLimiter` to every route it owns — a posture
 * that is exactly right for reads and wrong for writes. Keeping the writes here means
 * that file stays a pure read surface and neither router has to special-case the other.
 *
 * NO IDEMPOTENCY KEY on the toggles. PUT and DELETE of a boolean are idempotent by
 * verb, and the composite primary key `(productId, userId, engagementKind)` is what
 * makes a double-tap harmless — the same rule the video like/save routes document.
 *
 * Saves are USER-scoped, so these need a session but NOT a commerce organization:
 * an organization only becomes usable after a staff verification decision, and putting
 * a bookmark behind that would be absurd.
 */
const commerceProductEngagementRouter = express.Router();

commerceProductEngagementRouter.put(
  "/products/:productSlug/save",
  requireAuth,
  requireIdentifiedUser,
  commerceProductEngagementLimiter,
  commerceProductEngagementController.setProductSaved,
);

commerceProductEngagementRouter.delete(
  "/products/:productSlug/save",
  requireAuth,
  requireIdentifiedUser,
  commerceProductEngagementLimiter,
  commerceProductEngagementController.clearProductSaved,
);

commerceProductEngagementRouter.put(
  "/products/:productSlug/bookmark",
  requireAuth,
  requireIdentifiedUser,
  commerceProductEngagementLimiter,
  commerceProductEngagementController.setProductBookmarked,
);

commerceProductEngagementRouter.delete(
  "/products/:productSlug/bookmark",
  requireAuth,
  requireIdentifiedUser,
  commerceProductEngagementLimiter,
  commerceProductEngagementController.clearProductBookmarked,
);

/**
 * Shares accept an anonymous caller — most shares are — so `attachOptionalUser`
 * rather than `requireAuth`. The row records who when it knows, and null when it does
 * not, instead of refusing the count.
 */
commerceProductEngagementRouter.post(
  "/products/:productSlug/share",
  attachOptionalUser,
  commerceProductShareLimiter,
  commerceProductEngagementController.recordProductShare,
);

/**
 * The product view beacon (STORE Phase 13).
 *
 * THE SECOND UNAUTHENTICATED WRITE ON THIS PLATFORM, and it is worth being explicit about
 * why that is acceptable here. It accepts an anonymous caller because most product views
 * are anonymous, and a view denominator counting only signed-in readers would understate
 * every conversion rate the ranking engine computes.
 *
 * What keeps it from being a free ranking lever is not the limiter below — it is the
 * unique index pinning a caller to one session row per product per UTC day, the
 * server-side dwell clamp bounding that row by wall time, and the fact that an anonymous
 * session can never reach the conversion numerator. The limiter only stops the write path
 * being a cheap denial of service.
 *
 * POST rather than PUT despite being idempotent: the row it lands on is chosen by a
 * server-derived fingerprint, not by anything in the URL, so there is no resource the
 * caller could name to make PUT meaningful.
 */
commerceProductEngagementRouter.post(
  "/products/:productSlug/view-beacon",
  attachOptionalUser,
  commerceProductViewBeaconLimiter,
  // Two scalars — a bounded integer and a six-member enum. `compactBody` is already far
  // more than this body can legitimately be; there is no smaller declared cap, and picking
  // a bespoke number by eye is what `json-body-budget.ts` exists to stop.
  compactBody,
  commerceProductEngagementController.recordProductViewBeacon,
);

export default commerceProductEngagementRouter;
