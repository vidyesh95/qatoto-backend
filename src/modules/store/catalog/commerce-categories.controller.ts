import type { Request, Response } from "express";

import {
  firstParam,
  respondCommerceCategoryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/store/catalog/commerce-categories-error-response.js";
import {
  CreateCommerceCategorySchema,
  DecideCommerceCategoryRequestSchema,
  ListCommerceCategoryRequestsQuerySchema,
  ReorderCommerceCategoriesSchema,
  SubmitCommerceCategoryRequestSchema,
  UpdateCommerceCategorySchema,
} from "#src/modules/store/catalog/commerce-categories.schemas.js";
import * as commerceCategoriesService from "#src/modules/store/catalog/commerce-categories.service.js";
import { HOME_RAIL_CATEGORY_LIMIT } from "#src/modules/store/catalog/commerce-categories.service.js";
import type { ApiResponse } from "#src/types/index.js";

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
