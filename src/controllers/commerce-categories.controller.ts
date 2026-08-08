import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondCommerceCategoryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/commerce-categories-error-response.js";
import * as commerceCategoriesService from "#src/services/commerce-categories.service.js";
import { HOME_RAIL_CATEGORY_LIMIT } from "#src/services/commerce-categories.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The store's browse taxonomy — ADMIN WRITES AND SELLER REQUESTS ONLY.
 *
 * THE PUBLIC READS ARE NOT HERE. `GET /store/categories` and `GET /store/categories/:slug`
 * already exist in `store.controller.ts`, where the detail route also assembles the
 * category's facets and its first page of products. Adding a second pair here would be two
 * endpoints answering the same question differently, and the storefront would eventually be
 * reading the poorer one. `listActiveCategories` grew a `limit` for the home rail instead.
 *
 * Every admin route is gated by `moderate_commerce` INSIDE the service, before any id is
 * read (see commerce-categories.service.ts). The controller does not pre-check it: a second
 * check here would be a second place to get the ordering wrong.
 *
 * The seller request route is gated only by `requireAuth` + `requireIdentifiedUser`, because
 * it writes to `commerce_category_request` and mints nothing.
 */

// --- Schemas. Declared and EXPORTED here; the OpenAPI body map imports them.

/**
 * A slug is a PUBLIC URL IDENTITY, so its shape is fixed here and matched to the database's
 * own `commerce_category_slug_ck`. Kebab-case, because that is the one place kebab is a
 * genuine web convention — URL tokenizers treat `-` as a word break and `_` as a joiner.
 */
const CategorySlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase words separated by single hyphens.");

const CategoryNameSchema = z.string().trim().min(1).max(120);

/**
 * The alternative wordings a shopper might search for. Bounded on both axes because the
 * column is a `text[]` with no cap of its own, and an unbounded array is an unbounded body.
 */
const SearchSynonymsSchema = z.array(z.string().trim().min(1).max(120)).max(20);

/** The states an admin may WRITE. `retired` is reachable here and via the retire route. */
const WritableCategoryStateSchema = z.enum(["draft", "active", "retired"]);

/**
 * Multipart text parts arrive as STRINGS — multer does not type them, so the create body's
 * scalars are parsed from text.
 *
 * `searchSynonyms` is therefore a COMMA-SEPARATED string here rather than an array: a
 * multipart part cannot carry JSON without the server agreeing to parse it, and agreeing to
 * that on an untrusted part is how you end up with a JSON parser on a file upload route.
 */
const MultipartSearchSynonymsSchema = z.string().trim().max(2048).optional();

/**
 * A parent id on a multipart part. The empty string is how a form says "no parent" — an
 * absent part and a cleared select look identical otherwise, and the difference between
 * "root" and "unchanged" matters on the patch below.
 */
const MultipartParentCategoryIdSchema = z.string().trim().max(200).optional();

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
const ProductAssignmentsSchema = z
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

/**
 * A comma-separated multipart part into the array the service wants. Empty and absent both
 * mean "no synonyms" — there is no third meaning to preserve here, unlike the parent id.
 */
function parseMultipartSearchSynonyms(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((synonym) => synonym.trim())
    .filter((synonym) => synonym.length > 0)
    .slice(0, 20);
}

// --- Handlers.

/** `GET /commerce/admin/categories` — the whole tree, every state, with usage counts. */
export async function listCategoriesForStaff(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const listResult = await commerceCategoriesService.listCommerceCategoriesForStaff(req.user.id);
  if (!listResult.success) {
    respondCommerceCategoryError(res, listResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Store categories retrieved successfully",
    data: { items: listResult.value, homeRailLimit: HOME_RAIL_CATEGORY_LIMIT },
  };
  res.status(200).json(response);
}

/**
 * `POST /commerce/admin/categories` (multipart/form-data, optional field `image`) — create.
 *
 * ONE ROUND TRIP, image and metadata together, for the same reason the promotional create
 * route is one: a create-then-upload pair leaves a row in the admin list every time the
 * second call fails. The image is OPTIONAL here though — `image_url` is nullable and `misc`
 * ships without art, so demanding a file would be a stricter rule than the schema's.
 */
export async function createCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = CreateCommerceCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const rawParentCategoryId = parsed.data.parentCategoryId;
  const createResult = await commerceCategoriesService.createCommerceCategory(
    req.user.id,
    {
      name: parsed.data.name,
      slug: parsed.data.slug,
      parentCategoryId:
        rawParentCategoryId === undefined || rawParentCategoryId.length === 0
          ? null
          : rawParentCategoryId,
      searchSynonyms: parseMultipartSearchSynonyms(parsed.data.searchSynonyms),
      state: parsed.data.state ?? "draft",
    },
    req.file ? req.file.buffer : null,
  );
  if (!createResult.success) {
    respondCommerceCategoryError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Store category created successfully",
    data: { category: createResult.value },
  };
  res.status(201).json(response);
}

/** `PATCH /commerce/admin/categories/:categoryId` — name, parent, synonyms, state. */
export async function updateCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const categoryId = firstParam(req.params.categoryId);
  if (categoryId === undefined) {
    res
      .status(404)
      .json({ status: "error", statusCode: 404, message: "Store category not found." });
    return;
  }

  const parsed = UpdateCommerceCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const updateResult = await commerceCategoriesService.updateCommerceCategory(
    req.user.id,
    categoryId,
    parsed.data,
  );
  if (!updateResult.success) {
    respondCommerceCategoryError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Store category updated successfully",
    data: { category: updateResult.value },
  };
  res.status(200).json(response);
}

/** `PATCH /commerce/admin/categories/:categoryId/image` (multipart, field `image`). */
export async function replaceCategoryImage(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const categoryId = firstParam(req.params.categoryId);
  if (categoryId === undefined) {
    res
      .status(404)
      .json({ status: "error", statusCode: 404, message: "Store category not found." });
    return;
  }

  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "An image file is required (multipart field 'image').",
    });
    return;
  }

  const replaceResult = await commerceCategoriesService.replaceCommerceCategoryImage(
    req.user.id,
    categoryId,
    req.file.buffer,
  );
  if (!replaceResult.success) {
    respondCommerceCategoryError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Store category image replaced successfully",
    data: { category: replaceResult.value },
  };
  res.status(200).json(response);
}

/** `PATCH /commerce/admin/categories/reorder` — one parent's whole sibling order. */
export async function reorderCategories(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = ReorderCommerceCategoriesSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const reorderResult = await commerceCategoriesService.reorderCommerceCategories(
    req.user.id,
    parsed.data.parentCategoryId,
    parsed.data.categoryIds,
  );
  if (!reorderResult.success) {
    respondCommerceCategoryError(res, reorderResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Store categories reordered successfully",
    data: { items: reorderResult.value },
  };
  res.status(200).json(response);
}

/**
 * `POST /commerce/admin/categories/:categoryId/retire` — takes it out of browse.
 *
 * There is no DELETE route. `product.categoryId` is `ON DELETE RESTRICT` and the demand
 * snapshots cascade, so removal would either fail or take history with it; retiring reaches
 * the end state a moderator wants while staying reversible.
 */
export async function retireCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const categoryId = firstParam(req.params.categoryId);
  if (categoryId === undefined) {
    res
      .status(404)
      .json({ status: "error", statusCode: 404, message: "Store category not found." });
    return;
  }

  const retireResult = await commerceCategoriesService.retireCommerceCategory(
    req.user.id,
    categoryId,
  );
  if (!retireResult.success) {
    respondCommerceCategoryError(res, retireResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Store category retired successfully",
    data: { category: retireResult.value },
  };
  res.status(200).json(response);
}

/**
 * `POST /commerce/category-requests` — a seller asks for a category that does not exist.
 *
 * Requires an identified user and a commerce organization, the same context a listing
 * needs: a request that cannot be traced to a seller is a request nobody can act on.
 */
export async function submitCategoryRequest(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = SubmitCommerceCategoryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const submitResult = await commerceCategoriesService.submitCommerceCategoryRequest(
    {
      userId: req.user.id,
      organizationId: req.commerceOrganization?.organizationId ?? null,
    },
    {
      proposedName: parsed.data.proposedName,
      proposedParentCategoryId: parsed.data.proposedParentCategoryId ?? null,
      justification: parsed.data.justification ?? null,
    },
  );
  if (!submitResult.success) {
    respondCommerceCategoryError(res, submitResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Category request submitted successfully",
    data: { request: submitResult.value },
  };
  res.status(201).json(response);
}

/** `GET /commerce/category-requests/mine` — what this seller asked for, and how it went. */
export async function listOwnCategoryRequests(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const requests = await commerceCategoriesService.listOwnCommerceCategoryRequests(req.user.id);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Category requests retrieved successfully",
    data: { requests },
  };
  res.status(200).json(response);
}

/** `GET /commerce/admin/category-requests` — the moderation queue. */
export async function listCategoryRequestsForStaff(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListCommerceCategoryRequestsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const listResult = await commerceCategoriesService.listCommerceCategoryRequestsForStaff(
    req.user.id,
    { state: parsedQuery.data.state },
  );
  if (!listResult.success) {
    respondCommerceCategoryError(res, listResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Category requests retrieved successfully",
    data: { requests: listResult.value },
  };
  res.status(200).json(response);
}

/**
 * `POST /commerce/admin/category-requests/:requestId/decide` — the verdict.
 *
 * A DECIDED REQUEST IS TERMINAL, and deciding one again answers 409 naming the state it
 * holds. That is another moderator having got there first, which is a finding to read and
 * not an action to retry.
 */
export async function decideCategoryRequest(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const requestId = firstParam(req.params.requestId);
  if (requestId === undefined) {
    res
      .status(404)
      .json({ status: "error", statusCode: 404, message: "That category request does not exist." });
    return;
  }

  const parsed = DecideCommerceCategoryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const decideResult = await commerceCategoriesService.decideCommerceCategoryRequest(
    req.user.id,
    requestId,
    parsed.data,
  );
  if (!decideResult.success) {
    respondCommerceCategoryError(res, decideResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message:
      parsed.data.decision === "approve"
        ? "Category request approved successfully"
        : "Category request rejected successfully",
    data: {
      request: decideResult.value.request,
      category: decideResult.value.category,
    },
  };
  res.status(200).json(response);
}
