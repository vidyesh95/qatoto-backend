import type { Request, Response } from "express";
import { z } from "zod";

import { evidenceBytesMatchMediaType } from "#src/middleware/upload-commerce-verification-evidence.js";
import * as commerceOrganizationsService from "#src/services/commerce-organizations.service.js";
import type { CommerceOrganizationsError } from "#src/services/commerce-organizations.service.js";
import type { ApiResponse } from "#src/types/index.js";

export const CommerceOrganizationIdSchema = z.string().trim().min(1).max(200);
const OrganizationIdSchema = z.object({ organizationId: CommerceOrganizationIdSchema }).strict();
const MemberParamsSchema = OrganizationIdSchema.extend({ memberId: z.string().uuid() }).strict();
const AddressParamsSchema = OrganizationIdSchema.extend({ addressId: z.string().uuid() }).strict();
const VerificationParamsSchema = OrganizationIdSchema.extend({
  verificationId: z.string().uuid(),
}).strict();
const DocumentParamsSchema = OrganizationIdSchema.extend({
  documentId: z.string().uuid(),
}).strict();
const EmptyObjectSchema = z.object({}).strict();
const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

const OrganizationTypeSchema = z.enum([
  "company",
  "sole_proprietor",
  "cooperative",
  "government",
  "nonprofit",
]);
const MemberRoleSchema = z.enum([
  "administrator",
  "buyer",
  "seller",
  "provider_operator",
  "finance",
  "support",
  "viewer",
]);
const AddressKindSchema = z.enum(["billing", "registered", "warehouse", "pickup", "return"]);
const nullableHttpsUrl = z
  .url()
  .refine((url) => url.startsWith("https://"))
  .nullable();

export const CreateCommerceOrganizationSchema = z
  .object({
    slug: z
      .string()
      .min(3)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    legalName: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(4000).optional(),
    organizationType: OrganizationTypeSchema,
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    registrationNumber: z.string().trim().min(1).max(200).optional(),
    taxIdentifier: z.string().trim().min(1).max(200).optional(),
    websiteUrl: z
      .url()
      .refine((url) => url.startsWith("https://"))
      .optional(),
  })
  .strict();

export const UpdateCommerceOrganizationSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(4000).nullable().optional(),
    websiteUrl: nullableHttpsUrl.optional(),
    logoUrl: nullableHttpsUrl.optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.");

export const CreateCommerceOrganizationMemberSchema = z
  .object({ userId: z.string().min(1).max(200), role: MemberRoleSchema })
  .strict();

export const UpdateCommerceOrganizationMemberSchema = z
  .object({
    role: MemberRoleSchema.optional(),
    state: z.enum(["active", "suspended", "left"]).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.")
  .refine(
    (patch) => !(patch.role !== undefined && patch.state !== undefined),
    "Change a member role and state in separate requests so each transition is audited.",
  );

const AddressFieldsSchema = z.object({
  addressKind: AddressKindSchema,
  label: z.string().trim().min(1).max(100).nullable().optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  regionCode: z.string().trim().min(1).max(100).nullable().optional(),
  locality: z.string().trim().min(1).max(150),
  postalCode: z.string().trim().min(1).max(32).nullable().optional(),
  recipientName: z.string().trim().min(1).max(200).nullable().optional(),
  addressLineOne: z.string().trim().min(1).max(500),
  addressLineTwo: z.string().trim().min(1).max(500).nullable().optional(),
  phone: z.string().trim().min(1).max(50).nullable().optional(),
  isDefault: z.boolean(),
});

export const CreateCommerceOrganizationAddressSchema = AddressFieldsSchema.strict();
export const UpdateCommerceOrganizationAddressSchema = AddressFieldsSchema.partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.");

export const SubmitCommerceVerificationSchema = z
  .object({
    verificationKind: z.enum([
      "business_registration",
      "tax_registration",
      "identity",
      "address",
      "bank_account",
    ]),
    documentKind: z.enum([
      "business_registration",
      "tax_registration",
      "identity",
      "address_proof",
      "bank_evidence",
      "other",
    ]),
  })
  .strict();

export const DecideCommerceVerificationSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved") }).strict(),
  z
    .object({
      decision: z.literal("rejected"),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

export const RecordCommerceDocumentScannerVerdictSchema = z
  .object({ verdict: z.enum(["available", "quarantined"]) })
  .strict();

function validationError(res: Response, error: z.ZodError): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "Validation failed.",
    data: error.flatten().fieldErrors,
  } satisfies ApiResponse);
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
