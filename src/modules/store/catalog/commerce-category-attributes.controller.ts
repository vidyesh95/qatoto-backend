/**
 * Handlers for the category-attribute surface (STORE §20).
 *
 * Every handler parses params and body separately with `safeParse` and answers 422 before any
 * service call (CLAUDE.md §3.1). The `moderate_commerce` check is NOT here — it is inside the
 * service, so it returns a `Result` that takes part in the error mapper's exhaustive switch and
 * can be proven to run before any id is read.
 */
import type { Request, Response } from "express";

import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/store/catalog/commerce-categories-error-response.js";
import { respondCategoryAttributeError } from "#src/modules/store/catalog/commerce-category-attributes-error-response.js";
import {
  AttributeIdParamsSchema,
  CategoryIdParamsSchema,
  CreateCategoryAttributeSchema,
  ReplaceProductAttributeValuesSchema,
  UpdateCategoryAttributeSchema,
} from "#src/modules/store/catalog/commerce-category-attributes.schemas.js";
import * as attributesService from "#src/modules/store/catalog/commerce-category-attributes.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * `GET /store/categories/:slug/attributes` — PUBLIC, and it answers the RESOLVED set.
 *
 * Public because the seller wizard and the buyer's filter row both need it before anyone has
 * signed in to anything, and a definition is not a secret: it is the question the category asks,
 * visible on every listing under it.
 */
export async function getPublicCategoryAttributes(req: Request, res: Response): Promise<void> {
  const slug = firstParam(req.params.slug ?? "");
  // Resolved through the service's own slug lookup rather than a second query here, so a draft
  // or retired category answers 404 by the same rule the category page uses.
  const categoryId = await attributesService.findActiveCategoryIdBySlug(slug);
  if (categoryId === null) {
    res
      .status(404)
      .json({ status: "error", statusCode: 404, message: "Store category not found." });
    return;
  }

  const attributes = await attributesService.resolveCategoryAttributes(categoryId);
  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Category attributes retrieved successfully",
    data: {
      // The buyer/seller projection drops the two staff-only fields: `valueCount` is what the
      // delete guard reads, and neither it nor the definition's own id helps a seller fill a form.
      attributes: attributes.map((attribute) => ({
        attributeKey: attribute.attributeKey,
        label: attribute.label,
        groupLabel: attribute.groupLabel,
        valueKind: attribute.valueKind,
        unitLabel: attribute.unitLabel,
        numericScale: attribute.numericScale,
        isFilterable: attribute.isFilterable,
        isRequiredForPublish: attribute.isRequiredForPublish,
        position: attribute.position,
        choices: attribute.choices.map((choice) => ({
          choiceValue: choice.choiceValue,
          label: choice.label,
          position: choice.position,
        })),
      })),
    },
  };
  res.status(200).json(response);
}

/** `GET /commerce/admin/categories/:categoryId/attributes` — the resolved set, with counts. */
export async function listAttributesForStaff(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedParams = CategoryIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const listResult = await attributesService.listCategoryAttributesForStaff(
    req.user.id,
    parsedParams.data.categoryId,
  );
  if (!listResult.success) {
    respondCategoryAttributeError(res, listResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Category attributes retrieved successfully",
    data: { attributes: listResult.value },
  };
  res.status(200).json(response);
}

/** `POST /commerce/admin/categories/:categoryId/attributes` — define one. */
export async function createAttribute(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedParams = CategoryIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }
  const parsedBody = CreateCategoryAttributeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const createResult = await attributesService.createCategoryAttribute(
    req.user.id,
    parsedParams.data.categoryId,
    {
      attributeKey: parsedBody.data.attributeKey,
      label: parsedBody.data.label,
      groupLabel: parsedBody.data.groupLabel ?? null,
      valueKind: parsedBody.data.valueKind,
      unitLabel: parsedBody.data.unitLabel ?? null,
      numericScale: parsedBody.data.numericScale ?? null,
      isFilterable: parsedBody.data.isFilterable ?? false,
      isRequiredForPublish: parsedBody.data.isRequiredForPublish ?? false,
      choices: parsedBody.data.choices ?? [],
    },
  );
  if (!createResult.success) {
    respondCategoryAttributeError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Category attribute created successfully",
    data: { attribute: createResult.value },
  };
  res.status(201).json(response);
}

/** `PATCH /commerce/admin/category-attributes/:attributeId` — label, group, unit, flags, choices. */
export async function updateAttribute(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedParams = AttributeIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }
  const parsedBody = UpdateCategoryAttributeSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updateResult = await attributesService.updateCategoryAttribute(
    req.user.id,
    parsedParams.data.attributeId,
    parsedBody.data,
  );
  if (!updateResult.success) {
    respondCategoryAttributeError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Category attribute updated successfully",
    data: { attribute: updateResult.value },
  };
  res.status(200).json(response);
}

/** `PUT /products/:id/attributes` — the seller's structured answers, as a replace-set. */
export async function replaceProductAttributes(req: Request, res: Response): Promise<void> {
  if (!req.user || !req.commerceOrganization) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = ReplaceProductAttributeValuesSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const replaceResult = await attributesService.replaceProductAttributeValues(
    req.commerceOrganization.organizationId,
    firstParam(req.params.id ?? ""),
    parsedBody.data.values,
  );
  if (!replaceResult.success) {
    respondCategoryAttributeError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Product attributes updated successfully",
    data: { attributeValues: replaceResult.value },
  };
  res.status(200).json(response);
}
