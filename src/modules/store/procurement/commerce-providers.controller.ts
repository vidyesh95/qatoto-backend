import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import {
  AddKindLinkSchema,
  CreateOfferingSchema,
  LinkSupplierSchema,
  ModerateOfferingSchema,
  ModerateProductSchema,
  OfferingParamsSchema,
  ProductParamsSchema,
  RouteOrganizationIdSchema,
  SetCoverageSchema,
  SupplierParamsSchema,
  UpdateOfferingSchema,
  UpsertProfileSchema,
} from "#src/modules/store/procurement/commerce-providers.schemas.js";
import * as commerceProvidersService from "#src/modules/store/procurement/commerce-providers.service.js";
import type { ApiResponse } from "#src/types/index.js";

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

function requireCommerceContext(
  req: Request,
  res: Response,
): {
  organizationId: string;
  memberRole: CommerceOrganizationMemberRole;
  userId: string;
} | null {
  if (!req.user || !req.commerceOrganization) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }

  const routeOrganizationIdRaw = req.params.organizationId;
  if (typeof routeOrganizationIdRaw === "string") {
    const routeOrganizationId = RouteOrganizationIdSchema.safeParse(routeOrganizationIdRaw);
    if (!routeOrganizationId.success) {
      sendZodError(res, routeOrganizationId.error);
      return null;
    }
    const match = commerceProvidersService.assertOrganizationContextMatch({
      activeOrganizationId: req.commerceOrganization.organizationId,
      routeOrganizationId: routeOrganizationId.data,
    });
    if (!match.success) {
      mapProviderError(res, match.error);
      return null;
    }
  }

  return {
    userId: req.user.id,
    organizationId: req.commerceOrganization.organizationId,
    memberRole: req.commerceOrganization.memberRole,
  };
}

function mapProviderError(
  res: Response,
  error: commerceProvidersService.CommerceProvidersError,
): void {
  switch (error.type) {
    case "FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Missing capability for this commerce provider action.",
      } satisfies ApiResponse);
      return;
    case "NOT_FOUND":
    case "ORGANIZATION_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "ORGANIZATION_CONTEXT_MISMATCH":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Active commerce organization does not match the route organization.",
      } satisfies ApiResponse);
      return;
    case "PROFILE_REQUIRED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Create a provider profile before managing kinds or offerings.",
      } satisfies ApiResponse);
      return;
    case "KIND_LINK_EXISTS":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Provider kind is already linked.",
      } satisfies ApiResponse);
      return;
    case "KIND_LINK_REQUIRED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Link this provider kind before creating an offering.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This action conflicts with the current offering state.",
      } satisfies ApiResponse);
      return;
    case "VALIDATION":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveError: never = error;
      void exhaustiveError;
      throw new Error("Unhandled commerce providers error.");
    }
  }
}

export async function upsertProfile(req: Request, res: Response): Promise<void> {
  const context = requireCommerceContext(req, res);
  if (!context) return;
  const parsed = UpsertProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.upsertProviderProfile({
    userId: context.userId,
    organizationId: context.organizationId,
    memberRole: context.memberRole,
    ...parsed.data,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Provider profile saved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function addKindLink(req: Request, res: Response): Promise<void> {
  const context = requireCommerceContext(req, res);
  if (!context) return;
  const parsed = AddKindLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.addProviderKindLink({
    userId: context.userId,
    organizationId: context.organizationId,
    memberRole: context.memberRole,
    providerKind: parsed.data.providerKind,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Provider kind linked.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function createOffering(req: Request, res: Response): Promise<void> {
  const context = requireCommerceContext(req, res);
  if (!context) return;
  const parsed = CreateOfferingSchema.safeParse(req.body);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.createServiceOffering({
    userId: context.userId,
    organizationId: context.organizationId,
    memberRole: context.memberRole,
    ...parsed.data,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Service offering created.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listMineOfferings(req: Request, res: Response): Promise<void> {
  const context = requireCommerceContext(req, res);
  if (!context) return;
  const result = await commerceProvidersService.listMineOfferings(
    context.organizationId,
    context.memberRole,
  );
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Offerings.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function updateOffering(req: Request, res: Response): Promise<void> {
  const context = requireCommerceContext(req, res);
  if (!context) return;
  const params = OfferingParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const parsed = UpdateOfferingSchema.safeParse(req.body);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.updateServiceOffering({
    offeringId: params.data.offeringId,
    organizationId: context.organizationId,
    memberRole: context.memberRole,
    ...parsed.data,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Service offering updated.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function submitOffering(req: Request, res: Response): Promise<void> {
  const context = requireCommerceContext(req, res);
  if (!context) return;
  const params = OfferingParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const result = await commerceProvidersService.submitServiceOffering({
    offeringId: params.data.offeringId,
    organizationId: context.organizationId,
    memberRole: context.memberRole,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Service offering submitted for review.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function setCoverage(req: Request, res: Response): Promise<void> {
  const context = requireCommerceContext(req, res);
  if (!context) return;
  const params = OfferingParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const parsed = SetCoverageSchema.safeParse(req.body);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.setOfferingCoverage({
    offeringId: params.data.offeringId,
    organizationId: context.organizationId,
    memberRole: context.memberRole,
    coverages: parsed.data.coverages,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Coverage replaced.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function moderateOffering(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  const params = OfferingParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const parsed = ModerateOfferingSchema.safeParse(req.body);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.moderateServiceOffering({
    moderatorUserId: req.user.id,
    offeringId: params.data.offeringId,
    decision: parsed.data.decision,
    reason: parsed.data.reason,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Offering moderated.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function moderateProduct(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  const params = ProductParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const parsed = ModerateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.moderateProduct({
    moderatorUserId: req.user.id,
    productId: params.data.productId,
    moderationState: parsed.data.moderationState,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product moderated.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function linkSupplier(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  const params = SupplierParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const parsed = LinkSupplierSchema.safeParse(req.body);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return;
  }
  const result = await commerceProvidersService.linkSupplierToCommerceOrganization({
    moderatorUserId: req.user.id,
    supplierId: params.data.supplierId,
    commerceOrganizationId: parsed.data.commerceOrganizationId,
  });
  if (!result.success) {
    mapProviderError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Supplier linked to commerce organization.",
    data: result.value,
  } satisfies ApiResponse);
}
