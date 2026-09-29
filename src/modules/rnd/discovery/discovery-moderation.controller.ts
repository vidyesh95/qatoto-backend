import type { Request, Response } from "express";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/discovery/discovery-error-response.js";
import {
  ClassifyCategorySchema,
  DecideCategorySchema,
  DecideMergeProposalSchema,
  ListMergeProposalsQuerySchema,
  ReopenProblemClusterSchema,
  ResolveProblemClusterSchema,
} from "#src/modules/rnd/discovery/discovery-moderation.schemas.js";
import * as moderationService from "#src/modules/rnd/discovery/discovery-moderation.service.js";
import { optionalBody } from "#src/modules/rnd/projects/project-error-response.js";
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

/** POST /discovery/admin/categories/:categoryId/classification */
export async function classifyCategory(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ClassifyCategorySchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const classifyResult = await moderationService.classifyCategory(
    req.user.id,
    firstParam(req.params.categoryId ?? ""),
    parsedBody.data,
  );
  if (!classifyResult.success) {
    respondDiscoveryError(res, classifyResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Category classification recorded",
    data: classifyResult.value,
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

/**
 * POST /discovery/admin/problem-clusters/:clusterId/resolve — `moderate_clusters`.
 *
 * The cluster leaves the map and the list, its page shows the public note, and its photos are
 * purged 90 days later. 409 if it is not `active`, carrying the state it is in.
 */
export async function resolveProblemCluster(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = ResolveProblemClusterSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const resolveResult = await moderationService.resolveProblemCluster(
    req.user.id,
    firstParam(req.params.clusterId ?? ""),
    parsedBody.data,
  );
  if (!resolveResult.success) {
    respondDiscoveryError(res, resolveResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Problem cluster marked resolved",
    data: resolveResult.value,
  };
  res.status(200).json(response);
}

/**
 * POST /discovery/admin/problem-clusters/:clusterId/reopen — `moderate_clusters`.
 *
 * Back to `active` and onto the map. 409 if it is not `resolved`. Photos already purged stay
 * purged, and the page keeps saying so.
 */
export async function reopenProblemCluster(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  // The note is optional, so a bodyless POST is valid — Express 5 leaves `req.body` undefined.
  const parsedBody = ReopenProblemClusterSchema.safeParse(optionalBody(req));
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const reopenResult = await moderationService.reopenProblemCluster(
    req.user.id,
    firstParam(req.params.clusterId ?? ""),
    parsedBody.data,
  );
  if (!reopenResult.success) {
    respondDiscoveryError(res, reopenResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Problem cluster reopened",
    data: reopenResult.value,
  };
  res.status(200).json(response);
}
