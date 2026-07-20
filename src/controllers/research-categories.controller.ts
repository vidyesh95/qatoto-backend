import type { Request, Response } from "express";
import { z } from "zod";

import {
  respondProjectError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import * as categoriesService from "#src/services/research-categories.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The project taxonomy.
 *
 * SCOPE NOTE: §11a lists only the GET, and category creation formally belongs to §11b
 * (discovery). It ships here because §5 is explicit that the wizard's step 1 lets a user
 * mint a category, and the wizard is Phase 1 — without this endpoint the first step of
 * the flow cannot complete. When §6 lands, `POST /discovery/categories` becomes
 * canonical and this becomes a thin alias or is deleted. They must never be two
 * implementations over one table.
 */

/**
 * `status` is ABSENT by construction. A user-minted category always lands `pending`,
 * and `.strict()` turns an attempt to self-approve into a 422 rather than letting the
 * spam gate be bypassed by adding one key to the payload.
 */
export const CreateCategorySchema = z.object({ label: z.string().trim().min(1).max(80) }).strict();

export const ListCategoriesQuerySchema = z
  .object({ status: z.enum(["approved", "pending", "rejected"]).default("approved") })
  .strict();

/**
 * GET /research-categories
 *
 * Defaults to `approved` — a pending, user-minted category must not appear in a public
 * filter facet, or the moderation queue is decorative.
 */
export async function listCategories(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListCategoriesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const categories = await categoriesService.listResearchCategories(parsedQuery.data.status);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Categories retrieved successfully",
    data: categories,
  };
  res.status(200).json(response);
}

/** POST /research-categories — lands `pending`, awaiting moderation. */
export async function createCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateCategorySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const createResult = await categoriesService.createResearchCategory(
    parsedBody.data.label,
    req.user.id,
  );
  if (!createResult.success) {
    respondProjectError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Category submitted for review",
    data: createResult.value,
  };
  res.status(201).json(response);
}
