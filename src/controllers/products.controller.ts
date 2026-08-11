import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import * as productsService from "#src/services/products.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * B2B volume-pricing tier. Prices are integer cents (server-authoritative — the
 * client never sends dollars); `minimumOrderQuantity` is at least 1.
 */
const PricingTierSchema = z.object({
  unitPriceInCents: z.number().int().min(0),
  minimumOrderQuantity: z.number().int().min(1),
  /**
   * A27. This band's own maximum lead time. Optional, and absent means the product's
   * `leadTimeMaxDays` applies — the pre-Phase-15 behaviour, which is what every existing
   * ladder means. Bounds match `leadTimeMinDays`/`leadTimeMaxDays` and the quote lines.
   */
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
});

/**
 * The listing field shapes, declared ONCE and deliberately WITHOUT defaults.
 *
 * WHY THE DEFAULTS LIVE BELOW AND NOT HERE — this is a bug fix, read before "simplifying".
 * `.partial()` does NOT strip `.default()`. A schema built as `Fields.partial()` parses
 * `{ title: "x" }` into `{ title, condition: "new", keyFeatures: [], stockQuantity: 0,
 * pricingTiers: [] }` — every defaulted key arrives DEFINED, so a service guarded with
 * `if (patch.X !== undefined)` applies all of them. That is how a PATCH that touches only
 * the title silently reset the condition, blanked the key features, zeroed the stock and
 * DELETED every pricing tier on the listing.
 *
 * So the create schema adds defaults on top of these shapes and the update schema does
 * not. Never derive a PATCH schema from a schema carrying `.default()`.
 */
const productFieldShapes = {
  title: z.string().trim().min(1).max(200),
  brand: z.string().trim().max(120).optional(),
  category: z
    .enum([
      "electronics",
      "fashion",
      "home_kitchen",
      "anime_collectibles",
      "digital_goods",
      "books_media",
      "sports_outdoors",
      "beauty_personal_care",
    ])
    .optional(),
  categoryId: z.string().trim().min(1).max(200).optional(),
  /**
   * The seller's pending request for a category that does not exist yet. Mutually
   * exclusive with the two above — the listing parks in `misc` and is rehomed when the
   * request is decided. Create only; a PATCH picks a real category.
   */
  categoryRequestId: z.string().trim().min(1).max(200).optional(),
  condition: z.enum(["new", "refurbished", "used"]),
  description: z.string().trim().max(5000).optional(),
  keyFeatures: z.array(z.string().trim().min(1).max(200)).max(20),
  priceInCents: z.number().int().min(0),
  compareAtPriceInCents: z.number().int().min(0).optional(),
  stockQuantity: z.number().int().min(0),
  sku: z.string().trim().max(64).optional(),
  pricingTiers: z.array(PricingTierSchema).max(10),
  modelNumber: z.string().trim().min(1).max(120).optional(),
  countryOfOriginCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  unitOfMeasure: z.string().trim().min(1).max(40).optional(),
  samplePolicy: z.enum(["unavailable", "paid", "refundable"]).optional(),
  samplePriceInCents: z.number().int().positive().optional(),
  leadTimeMinDays: z.number().int().min(0).max(3650).optional(),
  leadTimeMaxDays: z.number().int().min(0).max(3650).optional(),
  /**
   * A5. Millimetres and grams, never a formatted string — a freight rate cannot be
   * computed from "52 × 46 × 12 cm". The all-or-nothing dimension rule is enforced
   * by `packageDimensionsComplete` below and again by a CHECK.
   */
  packageLengthMm: z.number().int().min(1).max(50_000).optional(),
  packageWidthMm: z.number().int().min(1).max(50_000).optional(),
  packageHeightMm: z.number().int().min(1).max(50_000).optional(),
  packageGrossWeightGrams: z.number().int().min(1).max(50_000_000).optional(),
  unitsPerPackage: z.number().int().min(1).max(1_000_000).optional(),
  specifications: z
    .array(
      z
        .object({
          key: z.string().trim().min(1).max(80),
          value: z.string().trim().min(1).max(500),
          /** A3. Free text; the useful groups for a chair and a transformer differ. */
          group: z.string().trim().min(1).max(80).optional(),
        })
        .strict(),
    )
    .max(40)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.key.toLocaleLowerCase("en-US"))).size ===
        entries.length,
      "Specification keys must be unique within a listing.",
    ),
};

/** A1. One variation, with its own price, stock and optional MOQ and ladder. */
const ProductVariantSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    publicSlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "publicSlug must be kebab-case.")
      .max(80),
    sku: z.string().trim().min(1).max(80).optional(),
    priceInCents: z.number().int().min(0),
    stockQuantity: z.number().int().min(0),
    minimumOrderQuantity: z.number().int().min(1).optional(),
    pricingTiers: z.array(PricingTierSchema).max(10).default([]),
  })
  .strict();

/**
 * Replaces the whole variant set. Empty means "this product is not sold by
 * variant" — the same shape `pricingTiers` and `specifications` already use, so a
 * seller removes variants by sending fewer, never by a separate delete route.
 */
export const ReplaceProductVariantsSchema = z
  .object({
    variants: z
      .array(ProductVariantSchema)
      .max(50)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.publicSlug)).size === entries.length,
        "Variant slugs must be unique within a listing.",
      )
      .refine(
        (entries) =>
          new Set(entries.flatMap((entry) => (entry.sku === undefined ? [] : [entry.sku]))).size ===
          entries.filter((entry) => entry.sku !== undefined).length,
        "Variant SKUs must be unique within a listing.",
      ),
  })
  .strict();

/** A6. Richer than `keyFeatures`: title, body, and an image. */
export const ReplaceProductHighlightsSchema = z
  .object({
    highlights: z
      .array(
        z
          .object({
            /**
             * Echo back the id of a highlight you are keeping, so its uploaded image
             * survives an edit to its own title. A HINT, NOT A GRANT: the service honours
             * it only when it already belongs to this product, and otherwise inserts a
             * new row with a server-generated id.
             */
            id: z.string().trim().min(1).max(200).optional(),
            title: z.string().trim().min(1).max(120),
            bodyText: z.string().trim().min(1).max(2000),
            /**
             * `imageUrl` was here and migration `0091` removed it. Upload to
             * POST /products/:productId/highlights/:highlightId/image instead, so the
             * platform holds the bytes the PDP renders.
             */
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

/**
 * The listing fields the client may set on CREATE, where a default is the correct
 * behaviour for an omitted key. `.strict()` rejects unknown keys — in particular a
 * client-sent `sellerId`/`status`/`currency`, all of which are server-owned
 * (CLAUDE.md §1.1). Money is integer cents; a future client posting dollars ("129.99")
 * fails the `.int()` check loudly rather than storing garbage.
 */
const ProductFieldsSchema = z
  .object({
    ...productFieldShapes,
    condition: productFieldShapes.condition.default("new"),
    keyFeatures: productFieldShapes.keyFeatures.default([]),
    stockQuantity: productFieldShapes.stockQuantity.default(0),
    pricingTiers: productFieldShapes.pricingTiers.default([]),
    specifications: productFieldShapes.specifications.default([]),
  })
  .strict();

/**
 * When present, `compareAtPriceInCents` is the struck-out "was" price, so it must
 * exceed `priceInCents`. A display invariant, but still checked server-side.
 * Applied on both create and (against the same-payload values) update.
 */
function compareAtPriceExceedsPrice(data: {
  priceInCents?: number;
  compareAtPriceInCents?: number;
}): boolean {
  if (data.compareAtPriceInCents === undefined || data.priceInCents === undefined) {
    return true;
  }
  return data.compareAtPriceInCents > data.priceInCents;
}

const compareAtRefinement = {
  error: "Compare-at price must be greater than the price.",
  path: ["compareAtPriceInCents"],
};

// Exported so the defaults-vs-partial regression is testable without a request; the
// discovery controllers export their schemas the same way.
function samplePolicyHasPrice(data: {
  samplePolicy?: "unavailable" | "paid" | "refundable";
  samplePriceInCents?: number;
}): boolean {
  if (data.samplePolicy === "paid" || data.samplePolicy === "refundable") {
    return data.samplePriceInCents !== undefined;
  }
  if (data.samplePolicy === "unavailable") {
    return data.samplePriceInCents === undefined;
  }
  return true;
}

/**
 * A5. Two of three dimensions is not a box. Enforced here so the seller gets a 422
 * naming the field, and again by `product_package_dimensions_ck` so a direct write
 * cannot store a half-measured package.
 */
function packageDimensionsComplete(data: {
  packageLengthMm?: number;
  packageWidthMm?: number;
  packageHeightMm?: number;
}): boolean {
  const provided = [data.packageLengthMm, data.packageWidthMm, data.packageHeightMm].filter(
    (dimension) => dimension !== undefined,
  ).length;
  return provided === 0 || provided === 3;
}

function leadTimeRangeValid(data: { leadTimeMinDays?: number; leadTimeMaxDays?: number }): boolean {
  if (data.leadTimeMinDays === undefined && data.leadTimeMaxDays === undefined) {
    return true;
  }
  if (data.leadTimeMinDays === undefined || data.leadTimeMaxDays === undefined) {
    return false;
  }
  return data.leadTimeMaxDays >= data.leadTimeMinDays;
}

export const CreateProductSchema = ProductFieldsSchema.refine(
  (productInput) =>
    productInput.category !== undefined ||
    productInput.categoryId !== undefined ||
    productInput.categoryRequestId !== undefined,
  { error: "One of categoryId, categoryRequestId or category is required.", path: ["categoryId"] },
)
  // Exclusive, not merely preferred. Accepting both would leave the server choosing which
  // one the seller meant, and the two answers differ: one publishes into a category, the
  // other parks the listing in `misc` pending a verdict.
  .refine(
    (productInput) =>
      productInput.categoryRequestId === undefined ||
      (productInput.categoryId === undefined && productInput.category === undefined),
    {
      error: "categoryRequestId cannot be combined with categoryId or category.",
      path: ["categoryRequestId"],
    },
  )
  .refine(compareAtPriceExceedsPrice, compareAtRefinement)
  .refine(samplePolicyHasPrice, {
    error: "Paid or refundable samples require samplePriceInCents.",
    path: ["samplePriceInCents"],
  })
  .refine(leadTimeRangeValid, {
    error: "leadTimeMaxDays must be >= leadTimeMinDays when either is set.",
    path: ["leadTimeMaxDays"],
  })
  .refine(packageDimensionsComplete, {
    error: "Package length, width and height must be provided together.",
    path: ["packageLengthMm"],
  });

/**
 * Every field optional and NONE defaulted — a PATCH may touch any subset, and a key the
 * client did not send must arrive `undefined` so the service leaves that column alone.
 * Sending `pricingTiers` REPLACES the set; omitting it now leaves the set untouched.
 *
 * Built from `productFieldShapes` rather than `ProductFieldsSchema.partial()`, because
 * `.partial()` preserves defaults — see the note on `productFieldShapes`.
 */
export const UpdateProductSchema = z
  .object(productFieldShapes)
  // CREATE ONLY. A PATCH names a category that exists; there is no "move this listing
  // back into the waiting room" transition. Leaving it in would make `.strict()` accept a
  // field the update path silently ignores, which is worse than rejecting it.
  .omit({ categoryRequestId: true })
  .partial()
  .strict()
  .refine(compareAtPriceExceedsPrice, compareAtRefinement)
  .refine(samplePolicyHasPrice, {
    error: "Paid or refundable samples require samplePriceInCents.",
    path: ["samplePriceInCents"],
  })
  .refine(leadTimeRangeValid, {
    error: "leadTimeMaxDays must be >= leadTimeMinDays when either is set.",
    path: ["leadTimeMaxDays"],
  })
  .refine(packageDimensionsComplete, {
    error: "Package length, width and height must be provided together.",
    path: ["packageLengthMm"],
  });

/**
 * A1 + A2. The optional multipart text fields accompanying an image upload.
 * `.strict()` would reject multer's own bookkeeping keys, so this deliberately
 * strips unknown keys instead — the file itself arrives on `req.file`.
 */
const UploadImageFieldsSchema = z.object({
  variantId: z.string().trim().min(1).max(200).optional(),
  // `video` was removed by migration `0090`: every upload is re-encoded to AVIF, so the
  // label could never describe its own bytes. A caller still sending it now gets a loud
  // 422 rather than a row that quietly lies about what it holds.
  mediaKind: z.enum(["photo", "spin_360"]).optional(),
  altText: z.string().trim().min(1).max(300).optional(),
});

const ReorderImagesSchema = z.object({ imageIds: z.array(z.string()).min(1) }).strict();
/**
 * A18. `.strict()` and a whole-plan replace, like variants and highlights: ordering and
 * membership are properties of the plan, not of individual rows.
 *
 * NOTE WHAT IS ABSENT: `state`. Retirement is a consequence of a slot disappearing from
 * the plan, decided by the server — a client that could set it could retire a slot while
 * leaving it in the list.
 */
export const ReplaceProductCustomizationOptionsSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            slotKey: z
              .string()
              .trim()
              .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, "Slot key must be snake_case.")
              .max(60),
            label: z.string().trim().min(1).max(120),
            customizationKind: z.enum(["file_upload", "choice"]),
            acceptedMediaTypes: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
            choiceValues: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
            /** A commercial term the server enforces at cart and checkout (§A18). */
            minimumOrderQuantity: z.number().int().min(1).max(1_000_000).optional(),
            isRequired: z.boolean().optional(),
          })
          .strict()
          .refine(
            (option) =>
              option.customizationKind === "file_upload"
                ? (option.acceptedMediaTypes?.length ?? 0) > 0 &&
                  (option.choiceValues?.length ?? 0) === 0
                : (option.choiceValues?.length ?? 0) > 0 &&
                  (option.acceptedMediaTypes?.length ?? 0) === 0,
            "An upload slot needs accepted media types; a choice slot needs choice values.",
          ),
      )
      .max(12)
      .refine(
        (options) => new Set(options.map((option) => option.slotKey)).size === options.length,
        "A slot key may appear only once.",
      ),
  })
  .strict();

const ProductParamsSchema = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const ProductImageParamsSchema = ProductParamsSchema.extend({
  imageId: z.string().trim().min(1).max(200),
}).strict();
const HighlightParamsSchema = ProductParamsSchema.extend({
  highlightId: z.string().trim().min(1).max(200),
}).strict();
const EmptyQuerySchema = z.object({}).strict();
const EmptyBodySchema = z.union([z.undefined(), z.object({}).strict()]);

const ListProductsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

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
