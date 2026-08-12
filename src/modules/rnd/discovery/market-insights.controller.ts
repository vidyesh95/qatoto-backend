import type { Request, Response } from "express";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/discovery/discovery-error-response.js";
import {
  CreateMarketInsightSchema,
  ListMarketInsightsAdminQuerySchema,
  UpdateMarketInsightSchema,
} from "#src/modules/rnd/discovery/market-insights.schemas.js";
import * as insightsService from "#src/modules/rnd/discovery/market-insights.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/** GET /discovery/admin/market-insights — moderator; drafts included (§11j.4). */
export async function listMarketInsightsForModerator(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListMarketInsightsAdminQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const { status, region, category, page, limit } = parsedQuery.data;
  const listed = await insightsService.listMarketInsightsForModerator(req.user.id, {
    status,
    ...(region === undefined ? {} : { regionSlug: region }),
    ...(category === undefined ? {} : { categorySlug: category }),
    page,
    limit,
  });

  if (!listed.success) {
    respondDiscoveryError(res, listed.error);
    return;
  }

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Market insights retrieved successfully",
    data: [...listed.value.rows],
    pagination: {
      page,
      limit,
      total: listed.value.total,
      totalPages: Math.ceil(listed.value.total / limit),
    },
  };
  res.status(200).json(response);
}

/**
 * POST /discovery/admin/market-insights — moderator (§11j.4).
 *
 * The write that makes `market_insight` writable at all. Lands as a DRAFT; `/publish` is
 * the only thing that puts it on the knowledge hub.
 */
export async function createMarketInsight(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateMarketInsightSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await insightsService.createMarketInsight(req.user.id, parsedBody.data);
  if (!created.success) {
    respondDiscoveryError(res, created.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Market insight created as a draft. Publish it to put it on the knowledge hub.",
    data: created.value,
  };
  res.status(201).json(response);
}

/** PATCH /discovery/admin/market-insights/:insightId — moderator (§11j.4). */
export async function updateMarketInsight(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = UpdateMarketInsightSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const insightId = firstParam(req.params.insightId ?? "");
  const updated = await insightsService.updateMarketInsight(
    req.user.id,
    insightId,
    parsedBody.data,
  );

  if (!updated.success) {
    respondDiscoveryError(res, updated.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Market insight updated",
    data: updated.value,
  };
  res.status(200).json(response);
}

/**
 * POST …/:insightId/publish and /unpublish — moderator (§11j.4).
 *
 * Curried so the two routes share one handler and cannot drift, the same shape
 * `decideOptimizationSuggestion` uses in the proof-of-effort controller.
 */
export function setMarketInsightPublished(shouldPublish: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      respondUnauthenticated(res);
      return;
    }

    const insightId = firstParam(req.params.insightId ?? "");
    const changed = await insightsService.setMarketInsightPublished(
      req.user.id,
      insightId,
      shouldPublish,
    );

    if (!changed.success) {
      respondDiscoveryError(res, changed.error);
      return;
    }

    const response: ApiResponse = {
      status: "success",
      statusCode: 200,
      message: shouldPublish ? "Market insight published" : "Market insight unpublished",
      data: changed.value,
    };
    res.status(200).json(response);
  };
}

/** DELETE /discovery/admin/market-insights/:insightId — moderator; a hard delete (§11j.4). */
export async function deleteMarketInsight(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const insightId = firstParam(req.params.insightId ?? "");
  const deleted = await insightsService.deleteMarketInsight(req.user.id, insightId);

  if (!deleted.success) {
    respondDiscoveryError(res, deleted.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Market insight deleted",
    data: deleted.value,
  };
  res.status(200).json(response);
}
