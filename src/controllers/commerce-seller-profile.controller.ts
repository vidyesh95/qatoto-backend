import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import { evidenceBytesMatchMediaType } from "#src/middleware/upload-commerce-verification-evidence.js";
import * as commerceSellerProfileService from "#src/services/commerce-seller-profile.service.js";
import type { CommerceSellerProfileError } from "#src/services/commerce-seller-profile.service.js";
import type { ApiResponse } from "#src/types/index.js";

const OrganizationIdSchema = z
  .object({ organizationId: z.string().trim().min(1).max(200) })
  .strict();
const MediaParamsSchema = OrganizationIdSchema.extend({
  mediaId: z.string().uuid(),
}).strict();
const StakeholderParamsSchema = OrganizationIdSchema.extend({
  stakeholderId: z.string().uuid(),
}).strict();
const CertificationParamsSchema = z.object({ certificationId: z.string().uuid() }).strict();

/**
 * Hand-written mirrors of the pgEnums, and they must be widened WITH the enum. A value
 * added to the database and forgotten here is rejected at the boundary and nobody can ever
 * create one — the failure mode the address-kind schema documents from Phase 11.
 */
const BusinessTypeSchema = z.enum([
  "manufacturer",
  "trading_company",
  "manufacturer_trading",
  "agent",
  "distributor",
]);
const VisitPolicySchema = z.enum(["welcome", "by_appointment", "not_available"]);
const MediaKindSchema = z.enum(["factory", "office", "warehouse", "production_line", "showcase"]);
const SiteAccessModeSchema = z.enum(["road", "sea", "air", "rail"]);
const CapabilityKindSchema = z.enum([
  "oem",
  "odm",
  "customization",
  "in_house_inspection",
  "in_house_rnd",
  "sample_production",
]);

/*
 * `nullableHttpsUrl` lived here for `photoUrl`, the last client-supplied image URL on this
 * surface. Migration `0091` replaced it with an upload, so nothing on this controller
 * accepts an image location from a client any more.
 */

/**
 * `year_founded BETWEEN 1800 AND 2100` in the database stops a typo; THIS stops a claim
 * about the future. The CHECK cannot express it, because `now()` is not IMMUTABLE and
 * Postgres refuses it in a constraint — so the real rule lives here, where a clock is
 * readable.
 */
const YearFoundedSchema = z
  .number()
  .int()
  .min(1800)
  .refine(
    (year) => year <= new Date().getUTCFullYear(),
    "A founding year cannot be in the future.",
  );

const nonNegativeCount = z.number().int().min(0).max(10_000_000);

export const UpsertSellerProfileSchema = z
  .object({
    yearFounded: YearFoundedSchema.nullable().optional(),
    factoryCount: nonNegativeCount.nullable().optional(),
    totalStaffCount: nonNegativeCount.nullable().optional(),
    productionLineCount: nonNegativeCount.nullable().optional(),
    factoryAreaSquareMetres: nonNegativeCount.nullable().optional(),
    businessType: BusinessTypeSchema.nullable().optional(),
    visitPolicy: VisitPolicySchema.nullable().optional(),
    acceptingCustomOrders: z.boolean().optional(),
    publicSummary: z.string().trim().max(4000).nullable().optional(),
    declaredResponseTimeHours: z.number().int().min(0).max(8760).nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.");

export const ReplaceSiteAccessSchema = z
  .object({
    rows: z
      .array(
        z
          .object({
            accessMode: SiteAccessModeSchema,
            facilityName: z.string().trim().min(1).max(200),
            distanceKm: z.number().int().min(0).max(40_000).nullable().optional(),
            notes: z.string().trim().max(1000).nullable().optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const ReplaceStakeholdersSchema = z
  .object({
    rows: z
      .array(
        z
          .object({
            /**
             * Echo back the id of a stakeholder you are keeping so their uploaded
             * portrait survives an edit. A HINT, NOT A GRANT — honoured only when the id
             * already belongs to this organization.
             */
            id: z.string().trim().min(1).max(200).optional(),
            fullName: z.string().trim().min(1).max(200),
            roleTitle: z.string().trim().min(1).max(200),
            /**
             * `photoUrl` was here and migration `0091` removed it. Upload to
             * POST /commerce/organizations/:organizationId/stakeholders/:stakeholderId/photo
             * so the platform holds the bytes — a portrait's EXIF carries the named
             * person's coordinates, and a hotlink can never have them stripped.
             */
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const ReplaceCapabilitiesSchema = z
  .object({
    rows: z
      .array(
        z
          .object({
            capabilityKind: CapabilityKindSchema,
            detail: z.string().trim().max(1000).nullable().optional(),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();

export const ReorderOrganizationMediaSchema = z
  .object({ mediaIdsInOrder: z.array(z.string().uuid()).min(1).max(12) })
  .strict();

/** Multipart text fields arrive as strings, so this schema coerces rather than expects. */
export const AddOrganizationMediaSchema = z
  .object({
    mediaKind: MediaKindSchema,
    altText: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD).");

export const SubmitCertificationSchema = z
  .object({
    standardName: z.string().trim().min(1).max(200),
    issuerName: z.string().trim().min(1).max(200),
    certificateNumber: z.string().trim().min(1).max(120),
    scopeSummary: z.string().trim().min(1).max(2000).optional(),
    validFrom: IsoDateSchema,
    validUntil: IsoDateSchema,
  })
  .strict()
  .refine(
    (certification) => certification.validUntil > certification.validFrom,
    "validUntil must be after validFrom.",
  );

export const DecideCertificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }).strict(),
  z
    .object({
      kind: z.literal("reject"),
      decisionReason: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

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
