import type { Request, Response } from "express";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  CreateProductSchema,
  EmptyBodySchema,
  EmptyQuerySchema,
  HighlightParamsSchema,
  ListProductsQuerySchema,
  ProductImageParamsSchema,
  ProductParamsSchema,
  ReorderImagesSchema,
  ReplaceProductCustomizationOptionsSchema,
  ReplaceProductHighlightsSchema,
  ReplaceProductVariantsSchema,
  UpdateProductSchema,
  UploadImageFieldsSchema,
} from "#src/schemas/products.schemas.js";
import * as productsService from "#src/services/products.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/** 401 for a missing session — mirrors the users controller's fail-closed guard. */
function respondUnauthenticated(res: Response): void {
  res.status(401).json({ status: "error", statusCode: 401, message: "Please sign in." });
}

function getProductOrganizationContext(
  req: Request,
  res: Response,
): {
  readonly userId: string;
  readonly organizationId: string;
} | null {
  if (!req.user || !req.commerceOrganization) {
    respondUnauthenticated(res);
    return null;
  }
  return {
    userId: req.user.id,
    organizationId: req.commerceOrganization.organizationId,
  };
}

/**
 * Map a product domain failure to its HTTP status + client message (+ optional
 * structured `errors`). Exhaustive over ProductError — a new variant breaks the
 * build at the `never` default (CLAUDE.md §3.2).
 */
function mapProductErrorToResponse(error: productsService.ProductError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    case "NOT_FOUND":
      return { statusCode: 404, message: "Product not found." };
    case "SKU_TAKEN":
      return { statusCode: 409, message: "That SKU is already used by one of your listings." };
    case "CATEGORY_NOT_FOUND":
      return { statusCode: 422, message: "The selected commerce category does not exist." };
    case "CATEGORY_NOT_ACTIVE_LEAF":
      return { statusCode: 422, message: "The selected commerce category must be an active leaf." };
    case "CATEGORY_MISMATCH":
      return {
        statusCode: 422,
        message: "The legacy category does not match the selected commerce category.",
      };
    // 404, not 403: whether a category request id exists is not a stranger's business,
    // so "someone else's" and "no such request" are deliberately indistinguishable.
    case "CATEGORY_REQUEST_NOT_FOUND":
      return { statusCode: 404, message: "That category request does not exist." };
    case "CATEGORY_REQUEST_NOT_PENDING":
      return {
        statusCode: 409,
        message:
          error.state === "approved"
            ? "That category request was approved. List the product under the new category instead."
            : "That category request was rejected. Choose an existing category instead.",
      };
    case "TOO_MANY_IMAGES":
      return {
        statusCode: 409,
        message: `A listing can have at most ${error.limit} images.`,
      };
    case "INCOMPLETE_FOR_PUBLISH":
      return {
        statusCode: 422,
        message: "This listing is not complete enough to publish.",
        errors: { missing: error.missing },
      };
    /**
     * 422, not 409. This is not a state conflict the seller must resolve elsewhere — there are
     * fields on the form in front of them and this response names every one.
     */
    case "ACTIVE_LISTING_MISSING_PACKAGE_DIMENSIONS":
      return {
        statusCode: 422,
        message:
          "A published listing must declare its package size, weight and units per package so " +
          "buyers can get a freight rate. Add them to this edit, or unpublish the listing first.",
        errors: { missing: error.missing },
      };
    case "IMAGE_ORDER_MISMATCH":
      return {
        statusCode: 422,
        message: "Image order must be an exact permutation of the listing's images.",
      };
    case "NOT_AN_IMAGE":
      return { statusCode: 422, message: "The uploaded file is not a valid image." };
    case "UNSUPPORTED_FORMAT":
      // The sentence lives in `image.ts` beside the allowlist it describes — six mappers
      // spelling it out themselves is six copies to update, and the one that got missed
      // would be telling users the wrong thing.
      return { statusCode: 422, message: describeUnsupportedImageFormat(error.detected) };
    case "DIMENSIONS_TOO_SMALL":
      return { statusCode: 422, message: "Image must be at least 64x64 pixels." };
    case "DIMENSIONS_TOO_LARGE":
      return { statusCode: 422, message: "Image dimensions are too large." };
    case "NOT_CONFIGURED":
      return { statusCode: 503, message: "Image uploads are not available right now." };
    case "UPLOAD_FAILED":
      return { statusCode: 502, message: "Could not store the image. Please try again." };
    case "DELETE_FAILED":
      return { statusCode: 502, message: "Could not remove the image. Please try again." };
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled product error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** Send a mapped ProductError as the standard error envelope. */
function respondProductError(res: Response, error: productsService.ProductError): void {
  const { statusCode, message, errors } = mapProductErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}

/**
 * POST /products
 * Create a draft listing. sellerId comes from the session (req.user), never the
 * body — a caller can only ever create their own listing (CLAUDE.md §1.1).
 */
export async function createProduct(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);

  const parsedBody = CreateProductSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const createResult = await productsService.createProduct(commerceContext, parsedBody.data);
  if (!createResult.success) {
    respondProductError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Listing created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

/**
 * GET /products/mine
 * The caller's own listings, paginated, newest-touched first. Declared before
 * `/:id` in the router so "mine" is never swallowed as an id.
 */
export async function getMyProducts(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;

  const parsedQuery = ListProductsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { page, limit } = parsedQuery.data;
  const productsPage = await productsService.listMyProducts(
    commerceContext.organizationId,
    page,
    limit,
  );

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Listings retrieved successfully",
    data: [...productsPage.rows],
    pagination: {
      page,
      limit,
      total: productsPage.total,
      totalPages: Math.ceil(productsPage.total / limit),
    },
  };
  res.status(200).json(response);
}

/**
 * GET /products/:id
 * Full listing (images + tiers) for the edit/detail flow. Owner only → 404.
 */
export async function getProductById(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);

  const getResult = await productsService.getProduct(
    commerceContext.organizationId,
    parsedParams.data.id,
  );
  if (!getResult.success) {
    respondProductError(res, getResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Listing retrieved successfully",
    data: getResult.value,
  };
  res.status(200).json(response);
}

/**
 * PATCH /products/:id
 * Partial update of a listing's mutable fields (+ optional tier replacement).
 */
export async function updateProduct(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;

  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = UpdateProductSchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updateResult = await productsService.updateProduct(
    commerceContext.organizationId,
    parsedParams.data.id,
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondProductError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Listing updated successfully",
    data: updateResult.value,
  };
  res.status(200).json(response);
}

/**
 * POST /products/:id/images  (multipart/form-data, field `image`)
 * Attach one image. `uploadProductImage` middleware has buffered + size-capped
 * the file; the service re-validates the actual bytes server-side (§1.1).
 */
export async function uploadImage(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);

  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "An image file is required (multipart field 'image').",
    });
    return;
  }

  /**
   * A1 + A2. Multipart text fields, so every value arrives as a string; the
   * dimensions are measured from the decoded bytes rather than accepted here.
   */
  const parsedUploadFields = UploadImageFieldsSchema.safeParse(req.body);
  if (!parsedUploadFields.success) return respondValidationFailed(res, parsedUploadFields.error);

  const uploadResult = await productsService.addProductImage(
    commerceContext.organizationId,
    parsedParams.data.id,
    req.file.buffer,
    {
      variantId: parsedUploadFields.data.variantId,
      mediaKind: parsedUploadFields.data.mediaKind,
      altText: parsedUploadFields.data.altText,
    },
  );
  if (!uploadResult.success) {
    respondProductError(res, uploadResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Image added successfully",
    data: uploadResult.value,
  };
  res.status(201).json(response);
}

/**
 * PUT /products/:id/variants
 * Replace the listing's variant set (Appendix A1). Sending an empty array means the
 * listing is not sold by variant; variants left out are retired, never deleted,
 * because order-line snapshots reference them.
 */
export async function replaceVariants(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = ReplaceProductVariantsSchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) return respondValidationFailed(res, parsedBody.error);

  const result = await productsService.replaceVariants(
    commerceContext.organizationId,
    parsedParams.data.id,
    parsedBody.data.variants,
  );
  if (!result.success) {
    respondProductError(res, result.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Variants updated successfully",
    data: result.value,
  };
  res.status(200).json(response);
}

/**
 * PUT /products/:id/highlights
 * Replace the listing's highlight cards (Appendix A6).
 */
export async function replaceHighlights(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = ReplaceProductHighlightsSchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) return respondValidationFailed(res, parsedBody.error);

  const result = await productsService.replaceHighlights(
    commerceContext.organizationId,
    parsedParams.data.id,
    parsedBody.data.highlights,
  );
  if (!result.success) {
    respondProductError(res, result.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Highlights updated successfully",
    data: result.value,
  };
  res.status(200).json(response);
}

/**
 * POST /products/:id/highlights/:highlightId/image
 * Attach platform-hosted bytes to one highlight card (A6, migration `0091`).
 *
 * Multipart, and the only way an image reaches a highlight — `imageUrl` came off the
 * highlight plan in the same migration, so a client still sending it gets a `.strict()`
 * 422 rather than having it silently dropped.
 */
export async function replaceHighlightImage(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = HighlightParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!req.file) {
    const response: ApiResponse = {
      status: "error",
      statusCode: 422,
      message: "An image file is required in the `image` field.",
    };
    res.status(422).json(response);
    return;
  }

  const result = await productsService.replaceHighlightImage(
    commerceContext.organizationId,
    parsedParams.data.id,
    parsedParams.data.highlightId,
    req.file.buffer,
  );
  if (!result.success) {
    respondProductError(res, result.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Highlight image updated successfully",
    data: result.value,
  };
  res.status(200).json(response);
}

/**
 * DELETE /products/:id/images/:imageId
 * Remove one image (Cloudinary asset + row) and re-pack remaining positions.
 */
export async function deleteImage(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductImageParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = EmptyBodySchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) return respondValidationFailed(res, parsedBody.error);

  const deleteResult = await productsService.deleteProductImageById(
    commerceContext.organizationId,
    parsedParams.data.id,
    parsedParams.data.imageId,
  );
  if (!deleteResult.success) {
    respondProductError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Image removed successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}

/**
 * PATCH /products/:id/images/reorder
 * Set the gallery order (index 0 = main image). Body must be a permutation of the
 * product's image ids.
 */
export async function reorderImages(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;

  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = ReorderImagesSchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const reorderResult = await productsService.reorderImages(
    commerceContext.organizationId,
    parsedParams.data.id,
    parsedBody.data.imageIds,
  );
  if (!reorderResult.success) {
    respondProductError(res, reorderResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Images reordered successfully",
    data: reorderResult.value,
  };
  res.status(200).json(response);
}

/**
 * POST /products/:id/publish
 * draft → active. Completeness is re-checked server-side; incomplete → 422.
 */
export async function publishProduct(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = EmptyBodySchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) return respondValidationFailed(res, parsedBody.error);

  const publishResult = await productsService.publishProduct(
    commerceContext.organizationId,
    parsedParams.data.id,
  );
  if (!publishResult.success) {
    respondProductError(res, publishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Listing published successfully",
    data: publishResult.value,
  };
  res.status(200).json(response);
}

/**
 * POST /products/:id/unpublish
 * active → draft.
 */
export async function unpublishProduct(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = EmptyBodySchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) return respondValidationFailed(res, parsedBody.error);

  const unpublishResult = await productsService.unpublishProduct(
    commerceContext.organizationId,
    parsedParams.data.id,
  );
  if (!unpublishResult.success) {
    respondProductError(res, unpublishResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Listing unpublished successfully",
    data: unpublishResult.value,
  };
  res.status(200).json(response);
}

/**
 * DELETE /products/:id
 * Delete the listing; the service destroys all its Cloudinary assets first, then
 * the FK cascade clears image + tier rows.
 */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = EmptyBodySchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) return respondValidationFailed(res, parsedBody.error);

  const deleteResult = await productsService.deleteProduct(
    commerceContext.organizationId,
    parsedParams.data.id,
  );
  if (!deleteResult.success) {
    respondProductError(res, deleteResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Listing deleted successfully",
    data: deleteResult.value,
  };
  res.status(200).json(response);
}

/** PUT /products/:id/customization-options */
export async function replaceCustomizationOptions(req: Request, res: Response): Promise<void> {
  const commerceContext = getProductOrganizationContext(req, res);
  if (!commerceContext) return;
  const parsedParams = ProductParamsSchema.safeParse(req.params);
  const parsedQuery = EmptyQuerySchema.safeParse(req.query);
  const parsedBody = ReplaceProductCustomizationOptionsSchema.safeParse(req.body);
  if (!parsedParams.success) return respondValidationFailed(res, parsedParams.error);
  if (!parsedQuery.success) return respondValidationFailed(res, parsedQuery.error);
  if (!parsedBody.success) return respondValidationFailed(res, parsedBody.error);

  const result = await productsService.replaceCustomizationOptions(
    commerceContext.organizationId,
    parsedParams.data.id,
    parsedBody.data.options,
  );
  if (!result.success) {
    respondProductError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Customization options updated.",
    data: result.value,
  } satisfies ApiResponse);
}
