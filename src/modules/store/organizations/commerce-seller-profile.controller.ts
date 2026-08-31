import type { Request, Response } from "express";
import { z } from "zod";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  AddOrganizationMediaSchema,
  CertificationParamsSchema,
  DecideCertificationSchema,
  ListCertificationsForModerationQuerySchema,
  MediaParamsSchema,
  OrganizationCertificationParamsSchema,
  OrganizationIdSchema,
  ReorderOrganizationMediaSchema,
  ReplaceCapabilitiesSchema,
  ReplaceSiteAccessSchema,
  ReplaceStakeholdersSchema,
  StakeholderParamsSchema,
  SubmitCertificationSchema,
  UpsertSellerProfileSchema,
} from "#src/modules/store/organizations/commerce-seller-profile.schemas.js";
import * as commerceSellerProfileService from "#src/modules/store/organizations/commerce-seller-profile.service.js";
import type { CommerceSellerProfileError } from "#src/modules/store/organizations/commerce-seller-profile.service.js";
import { evidenceBytesMatchMediaType } from "#src/modules/store/organizations/upload-commerce-verification-evidence.js";
import type { ApiResponse } from "#src/types/index.js";

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

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = z.object({}).strict().safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return false;
  }
  return true;
}

function respondSellerProfileError(res: Response, error: CommerceSellerProfileError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Seller profile resource not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
    case "SELF_REVIEW_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This seller profile action is not permitted.",
      } satisfies ApiResponse);
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This action requires a platform staff role.",
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That page cursor is not readable. Start from the first page.",
      } satisfies ApiResponse);
      return;
    case "CONFLICT":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "MEDIA_LIMIT_REACHED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: `You can save at most ${String(error.limit)} company photos.`,
        data: { limit: error.limit },
      } satisfies ApiResponse);
      return;
    case "IMAGE_REJECTED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: describeImageRejection(error.imageError),
      } satisfies ApiResponse);
      return;
    case "EVIDENCE_ENCRYPTION_UNAVAILABLE":
    case "EVIDENCE_STORAGE_NOT_CONFIGURED":
      res.status(503).json({
        status: "error",
        statusCode: 503,
        message: "Secure commerce document storage is unavailable.",
      } satisfies ApiResponse);
      return;
    case "IMAGE_STORAGE_FAILED":
    case "EVIDENCE_STORAGE_FAILED":
      res.status(502).json({
        status: "error",
        statusCode: 502,
        message: "Company media storage failed.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled seller profile error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function describeImageRejection(
  imageError: Extract<CommerceSellerProfileError, { type: "IMAGE_REJECTED" }>["imageError"],
): string {
  switch (imageError.type) {
    case "NOT_AN_IMAGE":
      return "The uploaded file is not a readable image.";
    case "UNSUPPORTED_FORMAT":
      return describeUnsupportedImageFormat(imageError.detected);
    case "DIMENSIONS_TOO_SMALL":
      return "The image is too small to display on a storefront.";
    case "DIMENSIONS_TOO_LARGE":
      return "The image exceeds the maximum supported dimensions.";
    default: {
      const exhaustiveCheck: never = imageError;
      throw new Error(`Unhandled image error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function upsertSellerProfile(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = UpsertSellerProfileSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);

  const updated = await commerceSellerProfileService.upsertSellerProfile({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    patch: body.data,
  });
  if (!updated.success) return respondSellerProfileError(res, updated.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Seller profile saved.",
    data: updated.value,
  } satisfies ApiResponse);
}

export async function replaceSiteAccess(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = ReplaceSiteAccessSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);

  const replaced = await commerceSellerProfileService.replaceSiteAccess({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    rows: body.data.rows,
  });
  if (!replaced.success) return respondSellerProfileError(res, replaced.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Site access rows replaced.",
    data: { rows: replaced.value },
  } satisfies ApiResponse);
}

export async function replaceStakeholders(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = ReplaceStakeholdersSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);

  const replaced = await commerceSellerProfileService.replaceStakeholders({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    rows: body.data.rows,
  });
  if (!replaced.success) return respondSellerProfileError(res, replaced.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Stakeholders replaced.",
    data: { rows: replaced.value },
  } satisfies ApiResponse);
}

/**
 * POST /commerce/organizations/:organizationId/stakeholders/:stakeholderId/photo
 *
 * Migration `0091`. Multipart, and the only way a portrait enters: `photoUrl` came off
 * the stakeholder list in the same migration.
 */
export async function replaceStakeholderPhoto(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = StakeholderParamsSchema.safeParse(req.params);
  if (!params.success) return validationError(res, params.error);
  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "An image file is required in the `photo` field.",
    } satisfies ApiResponse);
    return;
  }

  const replaced = await commerceSellerProfileService.replaceStakeholderPhoto({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    stakeholderId: params.data.stakeholderId,
    imageBytes: req.file.buffer,
  });
  if (!replaced.success) return respondSellerProfileError(res, replaced.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Stakeholder photo updated.",
    data: replaced.value,
  } satisfies ApiResponse);
}

export async function replaceCapabilities(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = ReplaceCapabilitiesSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);

  const replaced = await commerceSellerProfileService.replaceCapabilities({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    rows: body.data.rows,
  });
  if (!replaced.success) return respondSellerProfileError(res, replaced.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Capabilities replaced.",
    data: { rows: replaced.value },
  } satisfies ApiResponse);
}

export async function addOrganizationMedia(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = AddOrganizationMediaSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "An image file is required in the `image` field.",
    } satisfies ApiResponse);
    return;
  }

  const added = await commerceSellerProfileService.addOrganizationMedia({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    mediaKind: body.data.mediaKind,
    altText: body.data.altText ?? null,
    imageBytes: req.file.buffer,
  });
  if (!added.success) return respondSellerProfileError(res, added.error);
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Company photo added.",
    data: added.value,
  } satisfies ApiResponse);
}

export async function reorderOrganizationMedia(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = ReorderOrganizationMediaSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);

  const reordered = await commerceSellerProfileService.reorderOrganizationMedia({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    mediaIdsInOrder: body.data.mediaIdsInOrder,
  });
  if (!reordered.success) return respondSellerProfileError(res, reordered.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Company photo order updated.",
    data: { media: reordered.value },
  } satisfies ApiResponse);
}

export async function deleteOrganizationMedia(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = MediaParamsSchema.safeParse(req.params);
  if (!params.success) return validationError(res, params.error);

  const deleted = await commerceSellerProfileService.deleteOrganizationMediaRow({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    mediaId: params.data.mediaId,
  });
  if (!deleted.success) return respondSellerProfileError(res, deleted.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Company photo removed.",
    data: deleted.value,
  } satisfies ApiResponse);
}

export async function submitCertification(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  const body = SubmitCertificationSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);
  /**
   * The magic-byte check is the same one verification evidence uses. The multipart
   * `mimetype` header is a claim by the uploader; the decoded content is the fact.
   */
  if (!req.file || !evidenceBytesMatchMediaType(req.file.buffer, req.file.mimetype)) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Certificate file content does not match an allowed media type.",
    } satisfies ApiResponse);
    return;
  }

  const submitted = await commerceSellerProfileService.submitCertification({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    standardName: body.data.standardName,
    // Absent stays absent — the service writes `null`, and nothing here guesses a code
    // from the free-text name.
    standardCode: body.data.standardCode,
    issuerName: body.data.issuerName,
    certificateNumber: body.data.certificateNumber,
    scopeSummary: body.data.scopeSummary ?? null,
    validFrom: body.data.validFrom,
    validUntil: body.data.validUntil,
    evidenceBytes: req.file.buffer,
    mediaType: req.file.mimetype,
    originalFileName: req.file.originalname,
  });
  if (!submitted.success) return respondSellerProfileError(res, submitted.error);
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Certification submitted for review.",
    data: submitted.value,
  } satisfies ApiResponse);
}

/**
 * `GET /organizations/:organizationId/seller-profile` — the owner's read of its own face.
 *
 * A `null` profile is a 200, never a 404: the organization exists and the caller may edit
 * it, it has simply never saved a profile row. A 404 here would send the editor to an error
 * panel on the one path where it should render empty forms.
 */
export async function getOwnSellerProfile(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  if (!params.success) return validationError(res, params.error);

  const loaded = await commerceSellerProfileService.getOwnSellerProfile({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
  });
  if (!loaded.success) return respondSellerProfileError(res, loaded.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Seller profile loaded.",
    data: { declaredProfile: loaded.value },
  } satisfies ApiResponse);
}

export async function listCertifications(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationIdSchema.safeParse(req.params);
  if (!params.success) return validationError(res, params.error);

  const listed = await commerceSellerProfileService.listCertifications({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
  });
  if (!listed.success) return respondSellerProfileError(res, listed.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Certifications loaded.",
    data: { items: listed.value },
  } satisfies ApiResponse);
}

/**
 * `POST …/certifications/:certificationId/withdraw` — the seller retracts its own claim.
 *
 * A 409 carries the backend's own message naming the state it is in, because "already
 * withdrawn" and "rejected, so there is nothing to withdraw" are different answers and the
 * seller can act on neither if both read as a generic conflict.
 */
export async function withdrawCertification(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = OrganizationCertificationParamsSchema.safeParse(req.params);
  if (!params.success) return validationError(res, params.error);

  const withdrawn = await commerceSellerProfileService.withdrawCertification({
    userId: authContext.userId,
    organizationId: params.data.organizationId,
    certificationId: params.data.certificationId,
  });
  if (!withdrawn.success) return respondSellerProfileError(res, withdrawn.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Certification withdrawn.",
    data: withdrawn.value,
  } satisfies ApiResponse);
}

/**
 * `GET /admin/certifications` — the queue the decision route never had.
 *
 * `state` defaults to `pending` HERE rather than in the schema, so a moderator can still
 * ask for another state explicitly and the default stays visible to a reader of this file.
 */
export async function listCertificationsForModeration(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  const query = ListCertificationsForModerationQuerySchema.safeParse(req.query);
  if (!query.success) return validationError(res, query.error);

  const listed = await commerceSellerProfileService.listCertificationsForModeration(
    authContext.userId,
    {
      state: query.data.state ?? "pending",
      cursor: query.data.cursor,
      limit: query.data.limit,
    },
  );
  if (!listed.success) return respondSellerProfileError(res, listed.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Certifications awaiting a decision.",
    data: listed.value,
  } satisfies ApiResponse);
}

export async function decideCertification(req: Request, res: Response): Promise<void> {
  const authContext = authenticatedRequest(req, res);
  if (!authContext) return;
  if (!parseNoQuery(req, res)) return;
  const params = CertificationParamsSchema.safeParse(req.params);
  const body = DecideCertificationSchema.safeParse(req.body);
  if (!params.success) return validationError(res, params.error);
  if (!body.success) return validationError(res, body.error);

  const decided = await commerceSellerProfileService.decideCertification({
    moderatorUserId: authContext.userId,
    certificationId: params.data.certificationId,
    decision: body.data,
  });
  if (!decided.success) return respondSellerProfileError(res, decided.error);
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Certification decision recorded.",
    data: decided.value,
  } satisfies ApiResponse);
}
