import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceProductEngagementService from "#src/services/commerce-product-engagement.service.js";
import type { ProductEngagementKind } from "#src/services/commerce-product-engagement.service.js";
import { resolveEligibleProductRefBySlug } from "#src/services/store-catalog.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();

const ProductSlugParamsSchema = z
  .object({
    productSlug: z.string().trim().min(1).max(200),
  })
  .strict();

function sendZodError(res: Response, error: z.ZodError): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "Validation failed.",
    data: z.flattenError(error).fieldErrors,
  } satisfies ApiResponse);
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
 */
export async function recordProductShare(req: Request, res: Response): Promise<void> {
  const productId = await resolveEngagementTarget(req, res);
  if (productId === null) return;

  const engagement = await commerceProductEngagementService.recordProductShare(
    req.user?.id ?? null,
    productId,
  );
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Share recorded.",
    data: engagement,
  } satisfies ApiResponse);
}
