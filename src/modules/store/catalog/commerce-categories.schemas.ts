/**
 * Request schemas for commerce-categories, extracted from commerce-categories.controller.ts.
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
 * A slug is a PUBLIC URL IDENTITY, so its shape is fixed here and matched to the database's
 * own `commerce_category_slug_ck`. Kebab-case, because that is the one place kebab is a
 * genuine web convention — URL tokenizers treat `-` as a word break and `_` as a joiner.
 */
export const CategorySlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase words separated by single hyphens.");

export const CategoryNameSchema = z.string().trim().min(1).max(120);

/**
 * The alternative wordings a shopper might search for. Bounded on both axes because the
 * column is a `text[]` with no cap of its own, and an unbounded array is an unbounded body.
 */
export const SearchSynonymsSchema = z.array(z.string().trim().min(1).max(120)).max(20);

/** The states an admin may WRITE. `retired` is reachable here and via the retire route. */
export const WritableCategoryStateSchema = z.enum(["draft", "active", "retired"]);

/**
 * Multipart text parts arrive as STRINGS — multer does not type them, so the create body's
 * scalars are parsed from text.
 *
 * `searchSynonyms` is therefore a COMMA-SEPARATED string here rather than an array: a
 * multipart part cannot carry JSON without the server agreeing to parse it, and agreeing to
 * that on an untrusted part is how you end up with a JSON parser on a file upload route.
 */
export const MultipartSearchSynonymsSchema = z.string().trim().max(2048).optional();

/**
 * A parent id on a multipart part. The empty string is how a form says "no parent" — an
 * absent part and a cleared select look identical otherwise, and the difference between
 * "root" and "unchanged" matters on the patch below.
 */
export const MultipartParentCategoryIdSchema = z.string().trim().max(200).optional();

export const CreateCommerceCategorySchema = z
  .object({
    name: CategoryNameSchema,
    slug: CategorySlugSchema,
    parentCategoryId: MultipartParentCategoryIdSchema,
    searchSynonyms: MultipartSearchSynonymsSchema,
    state: z.enum(["draft", "active"]).optional(),
  })
  .strict();

/**
 * The metadata patch.
 *
 * `.strict()` is what refuses every server-owned field — `siblingOrder`, `imageUrl`,
 * `createdAt`. They are refused LOUDLY as unrecognized keys rather than silently ignored,
 * which is how an admin (or an attacker) learns the field is not theirs to set.
 *
 * `slug` IS ABSENT, and that is not an oversight. A slug is linked, bookmarked and indexed
 * the moment the category is published; renaming it silently breaks every one of those. A
 * category that needs a different slug is a new category.
 *
 * `parentCategoryId` is NULLABLE but not optional-nullable-collapsed: `null` means "make
 * this a root" and absent means "leave it where it is". Those are different edits.
 */
export const UpdateCommerceCategorySchema = z
  .object({
    name: CategoryNameSchema.optional(),
    parentCategoryId: z.string().trim().min(1).max(200).nullable().optional(),
    searchSynonyms: SearchSynonymsSchema.optional(),
    state: WritableCategoryStateSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Send at least one field to change.",
  });

/**
 * The whole order under ONE parent, as a permutation. Not a per-category order write — see
 * `reorderCommerceCategories` for why a partial order is a mismatch rather than a partial
 * apply.
 *
 * `parentCategoryId: null` reorders the roots, which is what the home rail renders.
 */
export const ReorderCommerceCategoriesSchema = z
  .object({
    parentCategoryId: z.string().trim().min(1).max(200).nullable(),
    // BOTH bounds are load-bearing, not decoration. Without them the largest body this
    // schema can produce is unbounded, and `json-body-budget.test.ts` fails the route for
    // being capped below what its own schema allows. 64 is the per-id cap because a uuid is
    // 36 characters; 200 siblings under one parent is far past any browsable tree.
    categoryIds: z.array(z.string().min(1).max(64)).min(1).max(200),
  })
  .strict();

export const SubmitCommerceCategoryRequestSchema = z
  .object({
    proposedName: CategoryNameSchema,
    proposedParentCategoryId: z.string().trim().min(1).max(200).nullable().optional(),
    justification: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

/**
 * Where each waiting listing should land. Optional on both verdicts and defaulted per arm —
 * see `decideCommerceCategoryRequest`.
 */
export const ProductAssignmentsSchema = z
  .array(
    z
      .object({
        productId: z.string().trim().min(1).max(64),
        categoryId: z.string().trim().min(1).max(64),
      })
      .strict(),
  )
  .max(200)
  .optional();

/**
 * The verdict.
 *
 * A DISCRIMINATED UNION, mirroring the backend's own asymmetry rather than inventing a
 * looser one: a rejection REQUIRES a note, an approval does not, and `slug` exists only on
 * the approve arm. `slug` is required there because a slug is a public URL identity —
 * deriving one from the seller's typed name would let a requester choose it by construction.
 */
export const DecideCommerceCategoryRequestSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approve"),
      name: CategoryNameSchema.optional(),
      slug: CategorySlugSchema,
      parentCategoryId: z.string().trim().min(1).max(200).nullable().optional(),
      note: z.string().trim().min(1).max(2000).optional(),
      productAssignments: ProductAssignmentsSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      note: z.string().trim().min(1).max(2000),
      productAssignments: ProductAssignmentsSchema,
    })
    .strict(),
]);

export const ListCommerceCategoryRequestsQuerySchema = z
  .object({
    state: z.enum(["pending", "approved", "rejected"]).optional(),
  })
  .strict();
