import type { Request, Response } from "express";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/discovery/discovery-error-response.js";
import {
  DecideCategorySchema,
  DecideMergeProposalSchema,
  ListMergeProposalsQuerySchema,
} from "#src/modules/rnd/discovery/discovery-moderation.schemas.js";
import * as moderationService from "#src/modules/rnd/discovery/discovery-moderation.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/** POST /discovery/admin/categories/:categoryId/decide */
export async function decideCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = DecideCategorySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decideResult = await moderationService.decideCategory(
    req.user.id,
    firstParam(req.params.categoryId ?? ""),
    parsedBody.data,
  );
  if (!decideResult.success) {
    respondDiscoveryError(res, decideResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Category decision recorded",
    data: decideResult.value,
  };
  res.status(200).json(response);
}

/** GET /discovery/admin/merge-proposals — the moderator queue. */
export async function listMergeProposals(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListMergeProposalsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const listResult = await moderationService.listPendingMergeProposals(req.user.id, {
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
  });
  if (!listResult.success) {
    respondDiscoveryError(res, listResult.error);
    return;
  }

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Merge proposals retrieved successfully",
    data: [...listResult.value.rows],
    pagination: {
      page: parsedQuery.data.page,
      limit: parsedQuery.data.limit,
      total: listResult.value.total,
      totalPages: Math.ceil(listResult.value.total / parsedQuery.data.limit),
    },
  };
  res.status(200).json(response);
}

/**
 * POST /discovery/admin/merge-proposals/:proposalId/decide.
 *
 * Approval is IRREVERSIBLE: the source cluster's submissions are repointed and the source
 * is marked `merged`. The target's distinct-reporter count is RE-DERIVED rather than
 * added, because the two clusters almost certainly share reporters.
 */
export async function decideMergeProposal(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = DecideMergeProposalSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const decideResult = await moderationService.decideMergeProposal(
    req.user.id,
    firstParam(req.params.proposalId ?? ""),
    parsedBody.data,
  );
  if (!decideResult.success) {
    respondDiscoveryError(res, decideResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Merge proposal decision recorded",
    data: decideResult.value,
  };
  res.status(200).json(response);
}
