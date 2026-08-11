import type { NextFunction, Request, Response } from "express";

import {
  provisionBuyerCommerceWorkspace,
  type BuyerCommerceWorkspaceError,
} from "#src/services/commerce-buyer-workspace.service.js";
import {
  resolveActiveBuyerCommerceOrganization,
  resolveActiveCommerceOrganization,
  resolveActiveProviderCommerceOrganization,
  resolveActiveSellerCommerceOrganization,
  type ActiveBuyerCommerceOrganizationAccessError,
  type ActiveProviderCommerceOrganizationAccessError,
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

/**
 * Attaches a seller organization when the caller has one, and continues when they do
 * not.
 *
 * Guided pathway authoring (§15.5) has two legitimate authors: a SELLER proposing a
 * set of its own goods, and a PLATFORM MERCHANDISER curating one. A merchandiser acts
 * for the platform and may not belong to any commerce organization at all, so the
 * hard seller guard would lock them out of the surface the specification gives them.
 *
 * This does not weaken anything: a caller with no organization is not authorized by
 * this middleware, it is merely passed on to a service that demands the
 * `moderate_commerce` platform capability instead. Neither path is anonymous.
 */
export async function attachOptionalSellerCommerceOrganization(
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
  if (accessResult.success) {
    req.commerceOrganization = accessResult.value;
  }
  next();
}

/** RFQ buyer guard: active trade plus buyer/owner/administrator membership. */
export async function requireActiveBuyerCommerceOrganization(
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

  const accessResult = await resolveActiveBuyerCommerceOrganization({
    userId: req.user.id,
    activeOrganizationId: req.authSession.activeOrganizationId,
  });
  if (!accessResult.success) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: activeBuyerAccessErrorMessage(accessResult.error),
    } satisfies ApiResponse);
    return;
  }

  req.commerceOrganization = accessResult.value;
  next();
}

/**
 * Buyer workspace guard: resolves the caller's own organization, creating one on first use.
 *
 * MOUNT THIS ONLY IN FRONT OF THE TAPS §14 NAMED. §14 decided a buyer organization is
 * auto-provisioned rather than waited for, and named exactly where the trust gate still
 * earns something — `checkout/confirm`, RFQ broadcast, seller listing, provider offerings.
 * Those keep `requireActiveBuyerCommerceOrganization` and its siblings. This guard belongs
 * on cart, `checkout/prepare`, RFQ drafting, product inquiry, messaging and document upload,
 * where the previous behaviour was a 403 on a signed-in buyer's very first tap.
 *
 * It attaches `req.buyerCommerceWorkspace`, never `req.commerceOrganization` — see the
 * comment on that property for why the two must not be merged.
 */
export async function requireProvisionedBuyerCommerceWorkspace(
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

  const workspaceResult = await provisionBuyerCommerceWorkspace({
    userId: req.user.id,
    sessionId: req.authSession.id,
    activeOrganizationId: req.authSession.activeOrganizationId,
  });
  if (!workspaceResult.success) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: buyerWorkspaceErrorMessage(workspaceResult.error),
    } satisfies ApiResponse);
    return;
  }

  req.buyerCommerceWorkspace = workspaceResult.value;
  next();
}

/** Provider quote guard: active trade plus provider_operator/admin/owner membership. */
export async function requireActiveProviderCommerceOrganization(
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

  const accessResult = await resolveActiveProviderCommerceOrganization({
    userId: req.user.id,
    activeOrganizationId: req.authSession.activeOrganizationId,
  });
  if (!accessResult.success) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: activeProviderAccessErrorMessage(accessResult.error),
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

function activeBuyerAccessErrorMessage(error: ActiveBuyerCommerceOrganizationAccessError): string {
  switch (error.type) {
    case "ACTIVE_BUYER_ORGANIZATION_REQUIRED":
    case "ACTIVE_BUYER_MEMBERSHIP_REQUIRED":
      return "An active buyer organization membership is required.";
    default: {
      const exhaustiveError: never = error;
      void exhaustiveError;
      throw new Error("Unhandled active buyer organization access error.");
    }
  }
}

function buyerWorkspaceErrorMessage(error: BuyerCommerceWorkspaceError): string {
  switch (error.type) {
    case "BUYER_WORKSPACE_ACCESS_LOST":
      // Deliberately the same sentence the other guards use. Distinguishing "your seat was
      // revoked" from "you switched organizations mid-request" on the wire would tell a
      // caller about membership changes they were not otherwise shown.
      return "An active buyer organization membership is required.";
    case "ACCOUNT_NOT_FOUND":
      return "Please sign in.";
    default: {
      const exhaustiveError: never = error;
      void exhaustiveError;
      throw new Error("Unhandled buyer commerce workspace error.");
    }
  }
}

function activeProviderAccessErrorMessage(
  error: ActiveProviderCommerceOrganizationAccessError,
): string {
  switch (error.type) {
    case "ACTIVE_PROVIDER_ORGANIZATION_REQUIRED":
    case "ACTIVE_PROVIDER_MEMBERSHIP_REQUIRED":
      return "An active provider organization membership is required.";
    default: {
      const exhaustiveError: never = error;
      void exhaustiveError;
      throw new Error("Unhandled active provider organization access error.");
    }
  }
}
