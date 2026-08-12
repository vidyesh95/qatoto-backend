/**
 * Request schemas for problem-clusters, extracted from problem-clusters.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

export const PROBLEM_CLUSTER_SORTS = ["opportunity", "recent", "reporters"] as const;

export const MAXIMUM_LATITUDE_MICRODEGREES = 90_000_000;

export const MAXIMUM_LONGITUDE_MICRODEGREES = 180_000_000;

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
 * `POST /discovery/problem-clusters/:clusterId/project-links` (§11j.4).
 *
 * THE WIRE ENUM IS THE WHOLE COLUMN ENUM, not the subset the caller is allowed to use. A
 * narrower enum would mean the server silently rewrote a moderator's `origin` into
 * `moderator` — forging provenance quietly, which is worse than refusing loudly. Who may
 * assert which value is decided in the service, and a disallowed one is a typed 422.
 *
 * `linkedByUserId` and `createdAt` are absent: the actor comes from the session.
 */
export const CreateClusterProjectLinkSchema = z
  .object({
    projectId: z.string().trim().min(1).max(64),
    source: z.enum(["origin", "founder_declared", "moderator"]),
  })
  .strict();

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
