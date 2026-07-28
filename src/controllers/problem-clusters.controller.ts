import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import * as clustersService from "#src/services/problem-clusters.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * The Civic Pulse problem map (R_AND_D_BACKEND_STRUCTURE.md §11b).
 */

const PROBLEM_CLUSTER_SORTS = ["opportunity", "recent", "reporters"] as const;

const MAXIMUM_LATITUDE_MICRODEGREES = 90_000_000;
const MAXIMUM_LONGITUDE_MICRODEGREES = 180_000_000;

export const ListProblemClustersQuerySchema = z
  .object({
    category: z.string().trim().min(1).max(60).optional(),
    region: z.string().trim().min(1).max(60).optional(),
    /**
     * §11b writes `minOpportunityScore`. Renamed to carry its unit (§1): a query param is
     * as much a wire contract as a response field, and a bare "score" tells a native
     * client nothing about its range.
     */
    minOpportunityScorePoints: z.coerce.number().int().min(0).max(100).optional(),
    // The map viewport, so the client fetches pins for what is on screen rather than the
    // planet. Integer microdegrees; all four or none, enforced below.
    minLatitudeMicrodegrees: z.coerce
      .number()
      .int()
      .min(-MAXIMUM_LATITUDE_MICRODEGREES)
      .max(MAXIMUM_LATITUDE_MICRODEGREES)
      .optional(),
    maxLatitudeMicrodegrees: z.coerce
      .number()
      .int()
      .min(-MAXIMUM_LATITUDE_MICRODEGREES)
      .max(MAXIMUM_LATITUDE_MICRODEGREES)
      .optional(),
    minLongitudeMicrodegrees: z.coerce
      .number()
      .int()
      .min(-MAXIMUM_LONGITUDE_MICRODEGREES)
      .max(MAXIMUM_LONGITUDE_MICRODEGREES)
      .optional(),
    maxLongitudeMicrodegrees: z.coerce
      .number()
      .int()
      .min(-MAXIMUM_LONGITUDE_MICRODEGREES)
      .max(MAXIMUM_LONGITUDE_MICRODEGREES)
      .optional(),
    sort: z.enum(PROBLEM_CLUSTER_SORTS).default("opportunity"),
    // Deep offsets are a scan amplifier on a public, unauthenticated read, so the page
    // number is capped rather than unbounded.
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const ClusterIdParamSchema = z.object({ clusterId: z.uuid() }).strict();

/** Same precedent as above: a malformed id 422s before any query runs. */
export const SubmissionIdParamSchema = z.object({ submissionId: z.uuid() }).strict();

/**
 * ABSENT BY CONSTRUCTION, each rejected by `.strict()` as a 422: `countryCode`
 * (server-geocoded — CLAUDE.md §0 names client-supplied country as untrustworthy, and here
 * it feeds the opportunity score), `reportCount`, `distinctReporterCount`,
 * `opportunityScore`, `clusterId`, `mapPosition`, `status`, `reporterUserId` (§13 — every
 * actor id is req.user.id and nothing else), and ANY COORDINATE.
 *
 * The current report-problem-sheet fabricates four of those in the browser:
 * `countryCode: ""`, `mapPosition: {50,50}`, `reportCount: 1`, `opportunityScore: 40`.
 * All four become server-derived, and there is no field left to forge.
 *
 * `locationText` rather than coordinates is a deliberate departure from §11b's body: the
 * sheet has no coordinate capture at all, and §6 forbids client-claimed geography — so the
 * server forward-geocodes, which strengthens the rule rather than bending it.
 */
export const CreateProblemReportSchema = z
  .object({
    title: z.string().trim().min(8).max(160),
    categoryId: z.uuid(),
    description: z.string().trim().min(20).max(5_000),
    locationText: z.string().trim().min(2).max(200),
  })
  .strict();

export const ListMyProblemReportsQuerySchema = z
  .object({
    clusteringStatus: z
      .enum(["queued", "clustered", "geocode_failed", "rejected", "failed"])
      .optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreateProblemReportInput = z.infer<typeof CreateProblemReportSchema>;

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
