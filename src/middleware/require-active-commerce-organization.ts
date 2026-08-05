import type { NextFunction, Request, Response } from "express";

import {
  resolveActiveCommerceOrganization,
  resolveActiveSellerCommerceOrganization,
  type ActiveSellerCommerceOrganizationAccessError,
} from "#src/services/commerce-organization-access.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Mount after `requireAuth` on organization-protected commerce routes.
 * No organization route is introduced in Phase 0; this is the authorization seam.
 */
export async function requireActiveCommerceOrganization(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user || !req.authSession) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const accessResult = await resolveActiveCommerceOrganization({
    userId: req.user.id,
    activeOrganizationId: req.authSession.activeOrganizationId,
  });
  if (!accessResult.success) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active commerce organization membership is required.",
    } satisfies ApiResponse);
    return;
  }

  req.commerceOrganization = accessResult.value;
  next();
}

/** Product-route guard: active trade plus a fresh seller/owner membership check. */
export async function requireActiveSellerCommerceOrganization(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user || !req.authSession) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const accessResult = await resolveActiveSellerCommerceOrganization({
    userId: req.user.id,
    sessionId: req.authSession.id,
    activeOrganizationId: req.authSession.activeOrganizationId,
  });
  if (!accessResult.success) {
    const accessMessage = activeSellerAccessErrorMessage(accessResult.error);
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: accessMessage,
    } satisfies ApiResponse);
    return;
  }

  req.commerceOrganization = accessResult.value;
  next();
}

function activeSellerAccessErrorMessage(
  error: ActiveSellerCommerceOrganizationAccessError,
): string {
  switch (error.type) {
    case "ACTIVE_SELLER_ORGANIZATION_REQUIRED":
    case "ACTIVE_SELLER_MEMBERSHIP_REQUIRED":
      return "An active seller organization membership is required.";
    default: {
      const exhaustiveError: never = error;
      void exhaustiveError;
      throw new Error("Unhandled active seller organization access error.");
    }
  }
}
