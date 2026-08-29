/**
 * Request schemas for products, extracted from products.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

/**
 * B2B volume-pricing tier. Prices are integer cents (server-authoritative — the
 * client never sends dollars); `minimumOrderQuantity` is at least 1.
 */
export const PricingTierSchema = z.object({
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
export const productFieldShapes = {
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
  /**
   * §21.2. Optional on the way in: a listing being created is `selling` by the column default,
   * and a seller retires it later. `paused` and `discontinued` are both unpurchasable — the
   * difference is what the buyer is told, not what the cart does.
   */
  sellingState: z.enum(["selling", "paused", "discontinued"]).optional(),
  samplePriceInCents: z.number().int().positive().optional(),
  /**
   * A17. How many samples one line may hold. Bounded at 20 to match
   * `product_maximum_sample_quantity_ck`: a cap large enough to reopen the hole it exists
   * to close is not a cap. Omitted leaves the column default of 1.
   */
  maximumSampleQuantity: z.number().int().min(1).max(20).optional(),
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
export const ProductVariantSchema = z
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
export const ProductFieldsSchema = z
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
export function compareAtPriceExceedsPrice(data: {
  priceInCents?: number;
  compareAtPriceInCents?: number;
}): boolean {
  if (data.compareAtPriceInCents === undefined || data.priceInCents === undefined) {
    return true;
  }
  return data.compareAtPriceInCents > data.priceInCents;
}

export const compareAtRefinement = {
  error: "Compare-at price must be greater than the price.",
  path: ["compareAtPriceInCents"],
};

// Exported so the defaults-vs-partial regression is testable without a request; the
// discovery controllers export their schemas the same way.
export function samplePolicyHasPrice(data: {
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
export function packageDimensionsComplete(data: {
  packageLengthMm?: number;
  packageWidthMm?: number;
  packageHeightMm?: number;
}): boolean {
  const provided = [data.packageLengthMm, data.packageWidthMm, data.packageHeightMm].filter(
    (dimension) => dimension !== undefined,
  ).length;
  return provided === 0 || provided === 3;
}

export function leadTimeRangeValid(data: {
  leadTimeMinDays?: number;
  leadTimeMaxDays?: number;
}): boolean {
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
export const UploadImageFieldsSchema = z.object({
  variantId: z.string().trim().min(1).max(200).optional(),
  // `video` was removed by migration `0090`: every upload is re-encoded to AVIF, so the
  // label could never describe its own bytes. A caller still sending it now gets a loud
  // 422 rather than a row that quietly lies about what it holds.
  mediaKind: z.enum(["photo", "spin_360"]).optional(),
  altText: z.string().trim().min(1).max(300).optional(),
});

export const ReorderImagesSchema = z.object({ imageIds: z.array(z.string()).min(1) }).strict();

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

export const ProductParamsSchema = z.object({ id: z.string().trim().min(1).max(200) }).strict();

export const ProductImageParamsSchema = ProductParamsSchema.extend({
  imageId: z.string().trim().min(1).max(200),
}).strict();

/** §21.3. The multipart TEXT field beside the `document` file part. */
export const UploadProductDocumentFieldsSchema = z
  .object({
    documentKind: z.enum(["datasheet", "manual", "care_guide", "other"]),
  })
  .strict();

export const ProductDocumentParamsSchema = ProductParamsSchema.extend({
  documentId: z.string().trim().min(1).max(200),
}).strict();

export const HighlightParamsSchema = ProductParamsSchema.extend({
  highlightId: z.string().trim().min(1).max(200),
}).strict();

export const EmptyQuerySchema = z.object({}).strict();

export const EmptyBodySchema = z.union([z.undefined(), z.object({}).strict()]);

export const ListProductsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreateProductInput = z.infer<typeof CreateProductSchema>;

export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
