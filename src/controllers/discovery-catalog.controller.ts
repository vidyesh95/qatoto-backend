import type { Request, Response } from "express";
import { z } from "zod";

import {
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import * as catalogService from "#src/services/discovery-catalog.service.js";
import * as categoriesService from "#src/services/research-categories.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * The knowledge hub and the shared taxonomy (R_AND_D_BACKEND_STRUCTURE.md §11b).
 *
 * THIS CONTROLLER IS CANONICAL FOR CATEGORIES. `research-categories.controller.ts` used to
 * own them and carried a scope note saying so: "When §6 lands, POST /discovery/categories
 * becomes canonical and this becomes a thin alias or is deleted. They must never be two
 * implementations over one table." That file is now deleted, and
 * `/research-categories` aliases these handlers at the ROUTE layer — controllers importing
 * controllers would invert the routes → controllers → services layering.
 */

/**
 * `status` is ABSENT by construction. A user-minted category always lands `pending`, and
 * `.strict()` turns an attempt to self-approve into a 422 rather than letting the spam
 * gate be bypassed by adding one key. `pinIconKey` is absent for the same reason — a
 * minter must not choose their own map iconography.
 */
export const CreateCategorySchema = z.object({ label: z.string().trim().min(1).max(80) }).strict();

export const ListCategoriesQuerySchema = z
  .object({ status: z.enum(["approved", "pending", "rejected"]).default("approved") })
  .strict();

export const ListRegionsQuerySchema = z
  .object({ countryCode: z.string().trim().length(2).toUpperCase().optional() })
  .strict();

const MARKET_INSIGHT_STAT_KINDS = [
  "percent_change",
  "percent_level",
  "absolute_count",
  "multiplier",
] as const;

export const ListMarketInsightsQuerySchema = z
  .object({
    region: z.string().trim().min(1).max(60).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    statKind: z.enum(MARKET_INSIGHT_STAT_KINDS).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const ListDemandSignalsQuerySchema = z
  .object({
    region: z.string().trim().min(1).max(60).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * GET /discovery/categories (and its /research-categories alias).
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

/** POST /discovery/categories — lands `pending`, awaiting moderation. */
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
    respondDiscoveryError(res, createResult.error);
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

/**
 * GET /discovery/regions — UNPAGINATED, deliberately.
 *
 * §11b groups regions with insights and demand signals under a shared `?page=`, but that
 * is shorthand for the group: this is a small lookup table whose only job is to source a
 * `<select>`, and paginating a facet list forces every client to loop before it can render
 * a dropdown. Returns an ApiResponse rather than a PaginatedResponse, the same call
 * `listCategories` already makes.
 */
export async function listRegions(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListRegionsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const regions = await catalogService.listDiscoveryRegions(parsedQuery.data.countryCode);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Regions retrieved successfully",
    data: regions,
  };
  res.status(200).json(response);
}

/**
 * GET /discovery/skills — also unpaginated, for the talent filter chips.
 *
 * These slugs are what `?skill=` matches BY EQUALITY, which is the structural fix for the
 * live substring bug where a "Water" chip matched "Water Polo".
 */
export async function listSkills(_req: Request, res: Response): Promise<void> {
  const skills = await catalogService.listDiscoverySkills();

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Skills retrieved successfully",
    data: skills,
  };
  res.status(200).json(response);
}

/** GET /discovery/market-insights */
export async function listMarketInsights(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListMarketInsightsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const page = await catalogService.listMarketInsights({
    regionSlug: parsedQuery.data.region,
    categorySlug: parsedQuery.data.category,
    statKind: parsedQuery.data.statKind,
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Market insights retrieved successfully",
    data: [...page.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: page.total,
      totalPages: Math.ceil(page.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/**
 * GET /discovery/demand-signals — the leaderboard for the most recent completed run.
 *
 * The response carries the run's `asOf` so all three clients render "as of" and never
 * imply live numbers (§13).
 */
export async function listDemandSignals(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListDemandSignalsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const page = await catalogService.listDemandSignals({
    regionSlug: parsedQuery.data.region,
    categorySlug: parsedQuery.data.category,
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
  });

  const response: PaginatedResponse & { readonly asOf: string | null } = {
    status: "success",
    statusCode: 200,
    message: "Demand signals retrieved successfully",
    data: [...page.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: page.total,
      totalPages: Math.ceil(page.total / parsedQuery.data.limit),
    },
    // NULL when no run has ever completed: the leaderboard is EMPTY, not zeroed, and the
    // client must be able to tell those apart.
    asOf: page.asOf,
  };
  res.status(200).json(response);
}
