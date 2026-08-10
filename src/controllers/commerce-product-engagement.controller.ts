import type { Request, Response } from "express";
import { z } from "zod";

import { computeClientSubnetHash } from "#src/lib/client-subnet.js";
import { MAXIMUM_VIEW_DWELL_SECONDS } from "#src/lib/commerce-view-clamp.js";
import * as commerceProductEngagementService from "#src/services/commerce-product-engagement.service.js";
import type { ProductEngagementKind } from "#src/services/commerce-product-engagement.service.js";
import * as commerceProductViewService from "#src/services/commerce-product-view.service.js";
import { resolveEligibleProductRefBySlug } from "#src/services/store-catalog.service.js";
import type { ApiResponse } from "#src/types/index.js";
import { respondValidationFailed } from "#src/controllers/project-error-response.js";

const EmptyObjectSchema = z.object({}).strict();

/**
 * The view beacon's body (STORE Phase 13).
 *
 * `dwellSeconds` is a CLAIM and is treated as one — `clampViewDwellSeconds` bounds it by
 * wall time before it reaches a column. The ceiling here is only a parse-level sanity
 * bound so an absurd number is a 422 rather than something the clamp has to reason about.
 *
 * `viewSource` is also client-supplied and is safe to accept only because nothing gates on
 * it: it selects no rate, no weight and no eligibility, and exists so an operator triaging
 * a spike can ask which surface it arrived through. Omitting it yields `unknown`, which is
 * an honest answer rather than an error.
 */
const ProductViewBeaconBodySchema = z
  .object({
    dwellSeconds: z.number().int().min(0).max(MAXIMUM_VIEW_DWELL_SECONDS),
    viewSource: z
      .enum(["product_detail", "search", "rail", "pathway", "companion", "unknown"])
      .default("unknown"),
  })
  .strict();

const ProductSlugParamsSchema = z
  .object({
    productSlug: z.string().trim().min(1).max(200),
  })
  .strict();

function sendZodError(res: Response, error: z.ZodError): void {
  /**
   * Delegates to the ONE shared responder (§0).
   *
   * This used to build its own body, and got two things wrong that only showed up in the browser:
   * it forwarded `fieldErrors` alone, so `.strict()`'s `unrecognized_keys` — the way EVERY rejected
   * server-owned field arrives — vanished into an empty object; and it put the payload under `data`,
   * which the client's envelope reader never looks at. The result was a 422 that said "Validation
   * failed." and named nothing.
   */
  respondValidationFailed(res, error);
}

/**
 * Parses params, refuses any query string, and resolves the slug to a publicly
 * eligible product.
 *
 * Slug resolution lives HERE rather than in the engagement service so the service can
 * stay free of a `store-catalog` import — the two would otherwise form a cycle, since
 * the catalog imports `loadProductEngagements` for the detail projection.
 *
 * A listing that is draft, suspended, unapproved, or owned by a non-trading
 * organization is a 404, indistinguishable from one that never existed (§11).
 */
async function resolveEngagementTarget(req: Request, res: Response): Promise<string | null> {
  const query = EmptyObjectSchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return null;
  }
  const params = ProductSlugParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return null;
  }

  const productRef = await resolveEligibleProductRefBySlug(params.data.productSlug);
  if (!productRef) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Product not found.",
    } satisfies ApiResponse);
    return null;
  }
  return productRef.id;
}

function requireViewerUserId(req: Request, res: Response): string | null {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  return req.user.id;
}

function buildToggleHandler(
  engagementKind: ProductEngagementKind,
  direction: "set" | "clear",
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const viewerUserId = requireViewerUserId(req, res);
    if (!viewerUserId) return;
    const productId = await resolveEngagementTarget(req, res);
    if (productId === null) return;

    const engagement =
      direction === "set"
        ? await commerceProductEngagementService.setProductEngagement(
            viewerUserId,
            productId,
            engagementKind,
            // Only the SET direction carries a subnet: the row being deleted already has
            // whichever block created it, and rewriting that on the way out would let an
            // attacker relocate its own history by un-saving from somewhere else.
            { subnetHash: computeClientSubnetHash(req.ip) },
          )
        : await commerceProductEngagementService.clearProductEngagement(
            viewerUserId,
            productId,
            engagementKind,
          );

    res.status(200).json({
      status: "success",
      statusCode: 200,
      message: "Engagement updated.",
      data: engagement,
    } satisfies ApiResponse);
  };
}

export const setProductSaved = buildToggleHandler("saved", "set");
export const clearProductSaved = buildToggleHandler("saved", "clear");
export const setProductBookmarked = buildToggleHandler("bookmarked", "set");
export const clearProductBookmarked = buildToggleHandler("bookmarked", "clear");

/**
 * A share may come from a signed-out visitor, so this handler does not require a
 * session — `attachOptionalUser` attributes it when there is one.
 *
 * Since Phase 13 an anonymous share still writes a row but never moves the counter, so a
 * signed-out caller receives the unchanged count back. That is deliberate and is not an
 * error the client should surface: the share happened, it simply is not a ranking input.
 */
export async function recordProductShare(req: Request, res: Response): Promise<void> {
  const productId = await resolveEngagementTarget(req, res);
  if (productId === null) return;

  const engagement = await commerceProductEngagementService.recordProductShare(
    req.user?.id ?? null,
    productId,
    { subnetHash: computeClientSubnetHash(req.ip) },
  );
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Share recorded.",
    data: engagement,
  } satisfies ApiResponse);
}

/**
 * `POST /store/products/:productSlug/view-beacon` (STORE Phase 13).
 *
 * Accepts an anonymous caller, because most product views are anonymous and a view
 * denominator that counted only signed-in readers would understate every conversion rate
 * on the platform. What an anonymous session cannot do is reach the conversion NUMERATOR —
 * that gate lives on `viewerId` in the session row, not here.
 *
 * Returns what the server RECORDED rather than what was asked for, so a client can
 * reconcile its own timer against the clamp instead of assuming its claim was accepted.
 */
export async function recordProductViewBeacon(req: Request, res: Response): Promise<void> {
  const body = ProductViewBeaconBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const productId = await resolveEngagementTarget(req, res);
  if (productId === null) return;

  const beacon = await commerceProductViewService.recordProductViewBeacon({
    productId,
    viewerUserId: req.user?.id ?? null,
    clientIp: req.ip,
    userAgent: req.get("user-agent") ?? "",
    viewSource: body.data.viewSource,
    claimedDwellSeconds: body.data.dwellSeconds,
  });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "View recorded.",
    data: beacon,
  } satisfies ApiResponse);
}
