import type { Request, Response } from "express";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import {
  CreateCategorySchema,
  ListCategoriesQuerySchema,
  ListDemandSignalsQuerySchema,
  ListMarketInsightsQuerySchema,
  ListRegionsQuerySchema,
  MarketInsightIdParamSchema,
} from "#src/schemas/discovery-catalog.schemas.js";
import * as catalogService from "#src/services/discovery-catalog.service.js";
import * as categoriesService from "#src/services/research-categories.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

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
 * GET /discovery/market-insights/:insightId — one published insight.
 *
 * The read behind §11k.2's demand-evidence chips. Public, and deliberately indistinguishable
 * for "no such insight" and "that insight is an unpublished draft": both are `404`, because a
 * moderator's work in progress must not be discoverable by id (§11j.4).
 */
export async function getMarketInsight(req: Request, res: Response): Promise<void> {
  const parsedParams = MarketInsightIdParamSchema.safeParse({
    insightId: firstParam(req.params.insightId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const insight = await catalogService.findMarketInsight(parsedParams.data.insightId);

  if (!insight) {
    respondDiscoveryError(res, {
      type: "MARKET_INSIGHT_NOT_FOUND",
      insightId: parsedParams.data.insightId,
    });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Market insight retrieved successfully",
    data: insight,
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
