import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import { evidenceBytesMatchMediaType } from "#src/middleware/upload-commerce-verification-evidence.js";
import {
  AddressParamsSchema,
  CreateCommerceOrganizationAddressSchema,
  CreateCommerceOrganizationMemberSchema,
  CreateCommerceOrganizationSchema,
  DecideCommerceVerificationSchema,
  DocumentParamsSchema,
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  MemberParamsSchema,
  OrganizationIdSchema,
  RecordCommerceDocumentScannerVerdictSchema,
  SubmitCommerceVerificationSchema,
  TransitionCommerceTradeStateSchema,
  UpdateCommerceOrganizationAddressSchema,
  UpdateCommerceOrganizationMemberSchema,
  UpdateCommerceOrganizationSchema,
  VerificationParamsSchema,
} from "#src/schemas/commerce-organizations.schemas.js";
import * as commerceOrganizationsService from "#src/services/commerce-organizations.service.js";
import type { CommerceOrganizationsError } from "#src/services/commerce-organizations.service.js";
import type { ApiResponse } from "#src/types/index.js";

function validationError(res: Response, error: z.ZodError): void {
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

function respondCommerceError(res: Response, error: CommerceOrganizationsError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Commerce organization resource not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
    case "ROLE_ESCALATION_FORBIDDEN":
    case "LAST_OWNER_REQUIRED":
    case "SELF_REVIEW_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This commerce organization action is not permitted.",
      } satisfies ApiResponse);
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This action requires a platform staff role.",
      } satisfies ApiResponse);
      return;
    case "CONFLICT":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "ADDRESS_LIMIT_REACHED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: `You can save at most ${String(error.limit)} ${error.addressKind} addresses.`,
        data: { addressKind: error.addressKind, limit: error.limit },
      } satisfies ApiResponse);
      return;
    case "IMAGE_REJECTED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: describeLogoRejection(error.imageError),
      } satisfies ApiResponse);
      return;
    /**
     * A37. 422 rather than 409: the request is well-formed and the trade state is not in
     * conflict with anything — the organization is simply missing a fact that activation
     * requires. An auto-provisioned buyer shell is the only row that can reach this.
     */
    case "COUNTRY_REQUIRED_FOR_ACTIVATION":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Set this organization's country before activating trade.",
      } satisfies ApiResponse);
      return;
    case "IMAGE_STORAGE_FAILED":
      res.status(502).json({
        status: "error",
        statusCode: 502,
        message: "Organization logo storage failed.",
      } satisfies ApiResponse);
      return;
    case "PII_ENCRYPTION_UNAVAILABLE":
    case "STORAGE_NOT_CONFIGURED":
      res.status(503).json({
        status: "error",
        statusCode: 503,
        message: "Secure commerce document storage is unavailable.",
      } satisfies ApiResponse);
      return;
    case "STORAGE_FAILED":
    case "STORAGE_CLEANUP_FAILED":
      res.status(502).json({
        status: "error",
        statusCode: 502,
        message: "Secure commerce document storage failed.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce organization error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeLogoRejection(
  imageError: Extract<CommerceOrganizationsError, { type: "IMAGE_REJECTED" }>["imageError"],
): string {
  switch (imageError.type) {
    case "NOT_AN_IMAGE":
      return "The uploaded file is not a readable image.";
    case "UNSUPPORTED_FORMAT":
      return describeUnsupportedImageFormat(imageError.detected);
    case "DIMENSIONS_TOO_SMALL":
      return "The logo is too small to display on a storefront.";
    case "DIMENSIONS_TOO_LARGE":
      return "The logo exceeds the maximum supported dimensions.";
    default: {
      const exhaustiveCheck: never = imageError;
      throw new Error(`Unhandled logo image error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function authenticatedRequest(req: Request, res: Response) {
  if (!req.user || !req.authSession) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  return { userId: req.user.id, sessionId: req.authSession.id };
}

function parseOrganizationId(req: Request, res: Response): string | null {
  const parsed = OrganizationIdSchema.safeParse(req.params);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return null;
  }
  return parsed.data.organizationId;
}

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return false;
  }
  return true;
}

export async function createOrganization(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const parsedBody = CreateCommerceOrganizationSchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);
  const created = await commerceOrganizationsService.createOrganization(
    authContext.userId,
    parsedBody.data,
  );
  if (!created.success) return respondCommerceError(res, created.error);
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Commerce organization created.",
    data: created.value,
  } satisfies ApiResponse);
}

export async function listMyOrganizations(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const organizations = await commerceOrganizationsService.listMyOrganizations(authContext.userId);
  if (!organizations.success) return respondCommerceError(res, organizations.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Commerce organizations loaded.",
    data: organizations.value,
  } satisfies ApiResponse);
}

export async function activateOrganization(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const parsedBody = EmptyRequestBodySchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);
  const organizationId = parseOrganizationId(req, res);
  if (!organizationId) return;
  const activated = await commerceOrganizationsService.activateOrganization({
    ...authContext,
    organizationId,
  });
  if (!activated.success) return respondCommerceError(res, activated.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Active commerce organization selected.",
    data: activated.value,
  } satisfies ApiResponse);
}

export async function updateOrganization(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = UpdateCommerceOrganizationSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  const updated = await commerceOrganizationsService.updateOrganization(
    authContext.userId,
    params.data.organizationId,
    body.data,
  );
  if (!updated.success) return respondCommerceError(res, updated.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Commerce organization updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

/**
 * Replace the organization logo with platform-hosted bytes (migration `0091`).
 *
 * Multipart, because the platform now holds the image rather than pointing at the
 * seller's. There is no JSON counterpart on purpose: `logoUrl` came off the update patch
 * in the same migration, so this is the only way a logo enters.
 */
export async function replaceOrganizationLogo(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  if (!params.success) return validationError(res, params.error);
  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "An image file is required in the `logo` field.",
    } satisfies ApiResponse);
    return;
  }

  const replaced = await commerceOrganizationsService.replaceOrganizationLogo({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    imageBytes: req.file.buffer,
  });
  if (!replaced.success) return respondCommerceError(res, replaced.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Organization logo updated.",
    data: replaced.value,
  } satisfies ApiResponse);
}

export async function createMember(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = CreateCommerceOrganizationMemberSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  const created = await commerceOrganizationsService.createMember(
    authContext.userId,
    params.data.organizationId,
    body.data,
  );
  if (!created.success) return respondCommerceError(res, created.error);
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Commerce organization member invited.",
    data: created.value,
  } satisfies ApiResponse);
}

export async function updateMember(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = MemberParamsSchema.safeParse(req.params);
  const body = UpdateCommerceOrganizationMemberSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  const updated = await commerceOrganizationsService.updateMember(
    authContext.userId,
    params.data.organizationId,
    params.data.memberId,
    body.data,
  );
  if (!updated.success) return respondCommerceError(res, updated.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Commerce organization member updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

export async function listAddresses(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const organizationId = parseOrganizationId(req, res);
  if (!organizationId) return;
  const addresses = await commerceOrganizationsService.listAddresses(
    authContext.userId,
    organizationId,
  );
  if (!addresses.success) return respondCommerceError(res, addresses.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Organization addresses loaded.",
    data: addresses.value,
  } satisfies ApiResponse);
}

export async function createAddress(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = CreateCommerceOrganizationAddressSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  const created = await commerceOrganizationsService.createAddress(
    authContext.userId,
    params.data.organizationId,
    body.data,
  );
  if (!created.success) return respondCommerceError(res, created.error);
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Organization address created.",
    data: created.value,
  } satisfies ApiResponse);
}

export async function updateAddress(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = AddressParamsSchema.safeParse(req.params);
  const body = UpdateCommerceOrganizationAddressSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  const updated = await commerceOrganizationsService.updateAddress(
    authContext.userId,
    params.data.organizationId,
    params.data.addressId,
    body.data,
  );
  if (!updated.success) return respondCommerceError(res, updated.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Organization address updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

export async function submitVerificationEvidence(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = SubmitCommerceVerificationSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  if (!req.file || !evidenceBytesMatchMediaType(req.file.buffer, req.file.mimetype)) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Evidence file content does not match an allowed media type.",
    } satisfies ApiResponse);
    return;
  }
  const submitted = await commerceOrganizationsService.submitVerificationEvidence({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    ...body.data,
    evidenceBytes: req.file.buffer,
    mediaType: req.file.mimetype,
    originalFileName: req.file.originalname,
  });
  if (!submitted.success) return respondCommerceError(res, submitted.error);
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Organization verification evidence submitted.",
    data: submitted.value,
  } satisfies ApiResponse);
}

export async function listVerifications(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const organizationId = parseOrganizationId(req, res);
  if (!organizationId) return;
  const verifications = await commerceOrganizationsService.listVerifications(
    authContext.userId,
    organizationId,
  );
  if (!verifications.success) return respondCommerceError(res, verifications.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Organization verifications loaded.",
    data: verifications.value,
  } satisfies ApiResponse);
}

export async function downloadVerificationEvidence(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = VerificationParamsSchema.safeParse(req.params);
  if (!params.success) return validationError(res, params.error);
  const downloaded = await commerceOrganizationsService.downloadVerificationEvidence({
    userId: authContext.userId,
    ...params.data,
  });
  if (!downloaded.success) return respondCommerceError(res, downloaded.error);
  const safeFileName = downloaded.value.fileName.replace(/[^A-Za-z0-9 ._-]/g, "_").slice(0, 120);
  res.setHeader("Content-Type", downloaded.value.mediaType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeFileName || "evidence"}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).send(downloaded.value.bytes);
}

export async function recordDocumentScannerVerdict(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = DocumentParamsSchema.safeParse(req.params);
  const body = RecordCommerceDocumentScannerVerdictSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  const recorded = await commerceOrganizationsService.recordDocumentScannerVerdict({
    scannerUserId: authContext.userId,
    ...params.data,
    ...body.data,
  });
  if (!recorded.success) return respondCommerceError(res, recorded.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Commerce document scanner verdict recorded.",
    data: recorded.value,
  } satisfies ApiResponse);
}

export async function decideVerification(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = VerificationParamsSchema.safeParse(req.params);
  const body = DecideCommerceVerificationSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  const decided = await commerceOrganizationsService.decideVerification({
    moderatorUserId: authContext.userId,
    ...params.data,
    ...body.data,
  });
  if (!decided.success) return respondCommerceError(res, decided.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Organization verification decided.",
    data: decided.value,
  } satisfies ApiResponse);
}

export async function transitionTradeState(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = TransitionCommerceTradeStateSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  const transitioned = await commerceOrganizationsService.transitionTradeState({
    moderatorUserId: authContext.userId,
    organizationId: params.data.organizationId,
    tradeState: body.data.tradeState,
    reason: body.data.reason,
  });
  if (!transitioned.success) return respondCommerceError(res, transitioned.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Organization trade state updated.",
    data: transitioned.value,
  } satisfies ApiResponse);
}
