import type { Request, Response } from "express";
import { z } from "zod";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import { evidenceBytesMatchMediaType } from "#src/middleware/upload-commerce-verification-evidence.js";
import {
  CreatePathwaySchema,
  ModeratePathwaySchema,
  PathwayIdParamsSchema,
  PathwayImageParamsSchema,
  PathwaySlotParamsSchema,
  PathwaySlugParamsSchema,
  ReplacePathwaySlotCandidatesSchema,
  ReplacePathwaySlotsSchema,
  SeedCartFromPathwaySchema,
  UpdatePathwaySchema,
} from "#src/schemas/commerce-merchandising.schemas.js";
import * as commerceCustomizationAssetService from "#src/services/commerce-customization-asset.service.js";
import * as commercePathwaysService from "#src/services/commerce-pathways.service.js";
import type {
  CommercePathwayActor,
  CommercePathwayError,
} from "#src/services/commerce-pathways.service.js";
import type { ApiResponse } from "#src/types/index.js";
import { respondValidationFailed } from "#src/controllers/project-error-response.js";

const EmptyObjectSchema = z.object({}).strict();
const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);
const PageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
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

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return false;
  }
  return true;
}

/**
 * Resolves which of §15.5's two authors is calling.
 *
 * `attachOptionalSellerCommerceOrganization` attaches an organization when the caller
 * has one and passes everyone else through, so a caller with no organization becomes a
 * platform actor whose `moderate_commerce` capability the SERVICE then demands. That
 * keeps staff capability off the route table, where it would be probeable.
 */
function resolvePathwayActor(req: Request, res: Response): CommercePathwayActor | null {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  if (req.commerceOrganization) {
    return {
      kind: "organization",
      organizationId: req.commerceOrganization.organizationId,
      memberId: req.commerceOrganization.memberId,
      memberRole: req.commerceOrganization.memberRole,
      actorUserId: req.user.id,
    };
  }
  return { kind: "platform", actorUserId: req.user.id };
}

function mapPathwayError(res: Response, error: CommercePathwayError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "SLUG_TAKEN":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That pathway slug is already in use.",
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "INVALID_TARGET":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "One or more products are not publicly available.",
        data: { productIds: error.productIds },
      } satisfies ApiResponse);
      return;
    case "VARIANT_REQUIRED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Choose a variant for products that have them.",
        data: { productIds: error.productIds },
      } satisfies ApiResponse);
      return;
    case "VARIANT_NOT_APPLICABLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "These products have no variants to choose from.",
        data: { productIds: error.productIds },
      } satisfies ApiResponse);
      return;
    case "VARIANT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Variant not found.",
        data: { variantIds: error.variantIds },
      } satisfies ApiResponse);
      return;
    case "ANCHOR_NOT_ELIGIBLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "The anchor product is not publicly available.",
      } satisfies ApiResponse);
      return;
    case "ANCHOR_NOT_OWNED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "A set may only be anchored on one of your own products.",
      } satisfies ApiResponse);
      return;
    case "QUANTITY_BELOW_MINIMUM":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "A slot cannot ask for fewer units than its candidate's minimum order quantity.",
        data: {
          productId: error.productId,
          minimumOrderQuantity: error.minimumOrderQuantity,
          quantity: error.quantity,
        },
      } satisfies ApiResponse);
      return;
    case "SELF_MODERATION_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You cannot decide a proposal from your own organization.",
      } satisfies ApiResponse);
      return;
    case "IMAGE_REJECTED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: describePathwayImageRejection(error.imageError),
      } satisfies ApiResponse);
      return;
    case "IMAGE_STORAGE_FAILED":
      res.status(502).json({
        status: "error",
        statusCode: 502,
        message: "Pathway image storage failed.",
      } satisfies ApiResponse);
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      // 403 for a non-probeable staff capability, per §7's HTTP mapping.
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Moderator capability required.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveError: never = error;
      throw new Error(`Unhandled pathway error: ${JSON.stringify(exhaustiveError)}`);
    }
  }
}

function describePathwayImageRejection(
  imageError: Extract<CommercePathwayError, { type: "IMAGE_REJECTED" }>["imageError"],
): string {
  switch (imageError.type) {
    case "NOT_AN_IMAGE":
      return "The uploaded file is not a readable image.";
    case "UNSUPPORTED_FORMAT":
      return describeUnsupportedImageFormat(imageError.detected);
    case "DIMENSIONS_TOO_SMALL":
      return "The image is too small to display as pathway art.";
    case "DIMENSIONS_TOO_LARGE":
      return "The image exceeds the maximum supported dimensions.";
    default: {
      const exhaustiveCheck: never = imageError;
      throw new Error(`Unhandled pathway image error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** POST /commerce/pathways */
export async function createPathway(req: Request, res: Response): Promise<void> {
  const actor = resolvePathwayActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const body = CreatePathwaySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commercePathwaysService.createPathway(actor, body.data);
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Pathway created.",
    data: result.value,
  } satisfies ApiResponse);
}

/** GET /commerce/pathways/mine */
export async function listAuthoredPathways(req: Request, res: Response): Promise<void> {
  const actor = resolvePathwayActor(req, res);
  if (!actor) return;

  const page = PageQuerySchema.safeParse(req.query);
  if (!page.success) {
    sendZodError(res, page.error);
    return;
  }

  const result = await commercePathwaysService.listAuthoredPathways(actor, {
    limit: page.data.limit,
    cursor: page.data.cursor,
  });
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Authored pathways.",
    data: result.value,
  } satisfies ApiResponse);
}

/** PATCH /commerce/pathways/:pathwayId */
export async function updatePathway(req: Request, res: Response): Promise<void> {
  const actor = resolvePathwayActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = PathwayIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = UpdatePathwaySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commercePathwaysService.updatePathway(
    actor,
    params.data.pathwayId,
    body.data,
  );
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathway updated.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * POST /commerce/pathways/:pathwayId/images/:imageSlot (migration `0091`)
 *
 * Multipart, and the only way art enters a pathway — `heroImageUrl`/`cardImageUrl` came
 * off the create and update bodies in the same migration, so a client sending either now
 * gets a `.strict()` 422 rather than having it silently ignored.
 */
export async function replacePathwayImage(req: Request, res: Response): Promise<void> {
  const actor = resolvePathwayActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = PathwayImageParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "An image file is required in the `image` field.",
    } satisfies ApiResponse);
    return;
  }

  const result = await commercePathwaysService.replacePathwayImage(
    actor,
    params.data.pathwayId,
    params.data.imageSlot,
    req.file.buffer,
  );
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathway image updated.",
    data: result.value,
  } satisfies ApiResponse);
}

/** PUT /commerce/pathways/:pathwayId/slots */
export async function replacePathwaySlots(req: Request, res: Response): Promise<void> {
  const actor = resolvePathwayActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = PathwayIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ReplacePathwaySlotsSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commercePathwaysService.replacePathwaySlots(
    actor,
    params.data.pathwayId,
    body.data.slots,
  );
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathway slots replaced.",
    data: result.value,
  } satisfies ApiResponse);
}

/** PUT /commerce/pathways/:pathwayId/slots/:slotId/candidates */
export async function replacePathwaySlotCandidates(req: Request, res: Response): Promise<void> {
  const actor = resolvePathwayActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = PathwaySlotParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ReplacePathwaySlotCandidatesSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commercePathwaysService.replacePathwaySlotCandidates(
    actor,
    params.data.pathwayId,
    params.data.slotId,
    body.data.candidates,
  );
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Slot candidates replaced.",
    data: result.value,
  } satisfies ApiResponse);
}

/** POST /commerce/pathways/:pathwayId/submit */
export async function submitPathway(req: Request, res: Response): Promise<void> {
  const actor = resolvePathwayActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = PathwayIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commercePathwaysService.submitPathway(actor, params.data.pathwayId);
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathway submitted for review.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * POST /commerce/cart/from-pathway/:pathwaySlug
 *
 * Buyer-scoped, unlike everything else in this controller: seeding a cart is a
 * purchase action, not an authoring one, so it runs on the buyer organization guard.
 */
export async function seedCartFromPathway(req: Request, res: Response): Promise<void> {
  if (!req.user || !req.commerceOrganization) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const params = PathwaySlugParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = SeedCartFromPathwaySchema.safeParse(req.body ?? {});
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commercePathwaysService.seedCartFromPathway(
    {
      organizationId: req.commerceOrganization.organizationId,
      memberId: req.commerceOrganization.memberId,
      memberRole: req.commerceOrganization.memberRole,
      actorUserId: req.user.id,
    },
    params.data.pathwaySlug,
    body.data.selections ?? [],
  );
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }

  /**
   * 200, not 201: the cart already existed, and some slots may be unfilled. A 201
   * would tell the client a complete set was created when the body says otherwise.
   */
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message:
      result.value.unfilledSlots.length === 0
        ? "Cart seeded from pathway."
        : "Cart seeded from pathway with unfilled slots.",
    data: result.value,
  } satisfies ApiResponse);
}

/** GET /commerce/admin/pathways */
export async function listPathwayModerationQueue(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const page = PageQuerySchema.safeParse(req.query);
  if (!page.success) {
    sendZodError(res, page.error);
    return;
  }

  const result = await commercePathwaysService.listPathwayModerationQueue(req.user.id, {
    limit: page.data.limit,
    cursor: page.data.cursor,
  });
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathways awaiting review.",
    data: result.value,
  } satisfies ApiResponse);
}

/** POST /commerce/admin/pathways/:pathwayId/moderate */
export async function moderatePathway(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const params = PathwayIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ModeratePathwaySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commercePathwaysService.moderatePathway(
    req.user.id,
    params.data.pathwayId,
    body.data.decision,
    body.data.reviewNote ?? null,
  );
  if (!result.success) {
    mapPathwayError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: body.data.decision === "publish" ? "Pathway published." : "Pathway rejected.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * POST /commerce/customization-assets (A18).
 *
 * Buyer-side. The declared media type is checked against the DECODED BYTES, never
 * trusted — the same posture verification evidence takes, and the reason a `.png`
 * extension on a PDF does not become artwork.
 */
export async function uploadCustomizationAsset(req: Request, res: Response): Promise<void> {
  if (!req.user || !req.commerceOrganization) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const uploadedFile = req.file;
  if (!uploadedFile) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Attach a file in the `evidence` field.",
    } satisfies ApiResponse);
    return;
  }
  if (!evidenceBytesMatchMediaType(uploadedFile.buffer, uploadedFile.mimetype)) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "The file's contents do not match its declared type.",
    } satisfies ApiResponse);
    return;
  }

  const result = await commerceCustomizationAssetService.uploadCustomizationAsset({
    userId: req.user.id,
    buyerOrganizationId: req.commerceOrganization.organizationId,
    assetBytes: uploadedFile.buffer,
    mediaType: uploadedFile.mimetype,
    originalFileName: uploadedFile.originalname,
  });
  if (!result.success) {
    const statusCode = result.error.type === "MEDIA_TYPE_MISMATCH" ? 422 : 503;
    res.status(statusCode).json({
      status: "error",
      statusCode,
      message:
        result.error.type === "MEDIA_TYPE_MISMATCH"
          ? "The file's contents do not match its declared type."
          : "Customization asset storage is unavailable.",
    } satisfies ApiResponse);
    return;
  }

  /**
   * 202, not 201: the bytes are stored but the asset is `pending_scan` and cannot be
   * attached to a cart line until a scanner promotes it. Saying 201 would invite a
   * client to attach it immediately and get a confusing rejection.
   */
  res.status(202).json({
    status: "success",
    statusCode: 202,
    message: "Customization asset uploaded and awaiting scanning.",
    data: result.value,
  } satisfies ApiResponse);
}
