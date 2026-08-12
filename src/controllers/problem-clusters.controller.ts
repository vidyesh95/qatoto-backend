import type { Request, Response } from "express";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import {
  ClusterIdParamSchema,
  CreateClusterProjectLinkSchema,
  CreateProblemReportSchema,
  ListMyProblemReportsQuerySchema,
  ListProblemClustersQuerySchema,
  SubmissionIdParamSchema,
} from "#src/schemas/problem-clusters.schemas.js";
import * as clustersService from "#src/services/problem-clusters.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/** GET /discovery/problem-clusters — the map and the landing teaser. */
export async function listProblemClusters(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListProblemClustersQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const filter = parsedQuery.data;

  // A viewport is all four bounds or none. Zod cannot express the cross-field rule
  // cleanly, and a partial box would silently return the whole planet.
  const viewportBounds = [
    filter.minLatitudeMicrodegrees,
    filter.maxLatitudeMicrodegrees,
    filter.minLongitudeMicrodegrees,
    filter.maxLongitudeMicrodegrees,
  ];
  const suppliedBoundCount = viewportBounds.filter((bound) => bound !== undefined).length;
  if (suppliedBoundCount !== 0 && suppliedBoundCount !== viewportBounds.length) {
    respondDiscoveryError(res, { type: "VIEWPORT_INCOMPLETE" });
    return;
  }

  const page = await clustersService.listProblemClusters({
    categorySlug: filter.category,
    regionSlug: filter.region,
    minOpportunityScorePoints: filter.minOpportunityScorePoints,
    minLatitudeMicrodegrees: filter.minLatitudeMicrodegrees,
    maxLatitudeMicrodegrees: filter.maxLatitudeMicrodegrees,
    minLongitudeMicrodegrees: filter.minLongitudeMicrodegrees,
    maxLongitudeMicrodegrees: filter.maxLongitudeMicrodegrees,
    sort: filter.sort,
    page: filter.page,
    limit: filter.limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Problem clusters retrieved successfully",
    data: [...page.rows],
    pagination: {
      page: filter.page,
      limit: filter.limit,
      total: page.total,
      totalPages: Math.ceil(page.total / filter.limit),
    },
  };
  res.status(200).json(response);
}

/** GET /discovery/problem-clusters/:clusterId */
export async function getProblemCluster(req: Request, res: Response): Promise<void> {
  const parsedParams = ClusterIdParamSchema.safeParse({
    clusterId: firstParam(req.params.clusterId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const cluster = await clustersService.findProblemCluster(
    parsedParams.data.clusterId,
    req.user?.id ?? null,
  );

  if (!cluster) {
    respondDiscoveryError(res, {
      type: "CLUSTER_NOT_FOUND",
      clusterId: parsedParams.data.clusterId,
    });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Problem cluster retrieved successfully",
    data: cluster,
  };
  res.status(200).json(response);
}

/**
 * POST /discovery/problem-reports — 202, because geocoding and clustering are async.
 *
 * Returns a RECEIPT, not a cluster. There is no `opportunityScorePoints`, no
 * `distinctReporterCount` and no `countryCode` in the response because none of them exists
 * yet at 202 time, and returning a placeholder is exactly the fabrication §6 exists to stop.
 */
export async function createProblemReport(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedBody = CreateProblemReportSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  // A `pending` user-minted category is a real row, so the FK alone would accept it —
  // letting a report attach to an unreviewed category makes the moderation queue
  // decorative and lets one request seed the taxonomy AND the map.
  const categoryCheck = await clustersService.checkCategoryUsable(parsedBody.data.categoryId);
  if (!categoryCheck.usable) {
    respondDiscoveryError(res, categoryCheck.error);
    return;
  }

  // The reporter id comes from the SESSION and nowhere else (§13). There is no
  // `reporterUserId` key in the schema, so `.strict()` already 422s an attempt to send
  // one — this line is why there is nothing to send.
  const receipt = await clustersService.createProblemSubmission(req.user.id, parsedBody.data);

  const enqueueResult = await sendJob(
    JOB_NAMES.geocodeAndClusterSubmission,
    { submissionId: receipt.submissionId },
    { idempotencyKey: idempotencyKeyFor.geocodeAndClusterSubmission(receipt.submissionId) },
  );

  if (!enqueueResult.success) {
    // The row is committed but nothing will process it. Surfaced as a 500 through the
    // error handler rather than a cheerful 202, because a 202 would promise processing
    // that is not going to happen — the reporter would poll "queued" forever.
    throw new Error(
      `createProblemReport: submission ${receipt.submissionId} saved but clustering could not be enqueued (${enqueueResult.error.type})`,
    );
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 202,
    message: "Report received. It is being matched to a problem cluster.",
    data: receipt,
  };
  res.status(202).json(response);
}

/** GET /discovery/problem-reports/mine */
export async function listMyProblemReports(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedQuery = ListMyProblemReportsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  // There is no `userId` parameter and there must never be one (§13).
  const page = await clustersService.listMyProblemSubmissions(req.user.id, {
    clusteringStatus: parsedQuery.data.clusteringStatus,
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
  });

  const response: PaginatedResponse = {
    status: "success",
    statusCode: 200,
    message: "Your reports retrieved successfully",
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
 * GET /discovery/problem-reports/:submissionId — the caller's own report (§11j.2).
 *
 * The read half of `/problem-reports/mine`, which returns the list. Someone else's
 * submission answers the same 404 as one that never existed: the scoping is a WHERE
 * predicate in the service, not a check after the row is loaded.
 */
export async function getMyProblemReport(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedParams = SubmissionIdParamSchema.safeParse({
    submissionId: firstParam(req.params.submissionId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const submission = await clustersService.findMyProblemSubmission(
    req.user.id,
    parsedParams.data.submissionId,
  );

  if (!submission) {
    respondDiscoveryError(res, {
      type: "SUBMISSION_NOT_FOUND",
      submissionId: parsedParams.data.submissionId,
    });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Report retrieved successfully",
    data: submission,
  };
  res.status(200).json(response);
}

/**
 * POST /discovery/problem-clusters/:clusterId/project-links (§11j.1, §11j.4).
 *
 * The project's FOUNDER, or a platform moderator. Every refusal is a 404 — see the service
 * for why a 403 cannot be correct on this route.
 */
export async function linkProjectToCluster(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedParams = ClusterIdParamSchema.safeParse({
    clusterId: firstParam(req.params.clusterId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const parsedBody = CreateClusterProjectLinkSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const linked = await clustersService.linkProjectToCluster(
    req.user.id,
    parsedParams.data.clusterId,
    parsedBody.data,
  );

  if (!linked.success) {
    respondDiscoveryError(res, linked.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Project linked to problem cluster",
    data: linked.value,
  };
  res.status(201).json(response);
}

/** DELETE …/project-links/:projectId — retract a link you were entitled to assert (§11j.4). */
export async function unlinkProjectFromCluster(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsedParams = ClusterIdParamSchema.safeParse({
    clusterId: firstParam(req.params.clusterId ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }

  const unlinked = await clustersService.unlinkProjectFromCluster(
    req.user.id,
    parsedParams.data.clusterId,
    firstParam(req.params.projectId ?? ""),
  );

  if (!unlinked.success) {
    respondDiscoveryError(res, unlinked.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Project unlinked from problem cluster",
    data: unlinked.value,
  };
  res.status(200).json(response);
}
