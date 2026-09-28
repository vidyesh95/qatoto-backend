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

const PROBLEM_CLUSTER_SORTS = ["opportunity", "recent", "reporters", "distance"] as const;

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
    /**
     * The point `sort=distance` orders from — the centre of the reader's map, never their own
     * location. Both halves or neither, only with `sort=distance`, and required by it (below).
     */
    centreLatitudeMicrodegrees: z.coerce
      .number()
      .int()
      .min(-MAXIMUM_LATITUDE_MICRODEGREES)
      .max(MAXIMUM_LATITUDE_MICRODEGREES)
      .optional(),
    centreLongitudeMicrodegrees: z.coerce
      .number()
      .int()
      .min(-MAXIMUM_LONGITUDE_MICRODEGREES)
      .max(MAXIMUM_LONGITUDE_MICRODEGREES)
      .optional(),
    // Deep offsets are a scan amplifier on a public, unauthenticated read, so the page
    // number is capped rather than unbounded.
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine((query, context) => {
    // A centre is a point: half of one is not a latitude with the longitude to follow, it is a
    // point that does not exist (the `CreateProblemReportSchema` pin rule, below).
    const hasCentreLatitude = query.centreLatitudeMicrodegrees !== undefined;
    const hasCentreLongitude = query.centreLongitudeMicrodegrees !== undefined;
    if (hasCentreLatitude !== hasCentreLongitude) {
      context.addIssue({
        code: "custom",
        path: [hasCentreLatitude ? "centreLongitudeMicrodegrees" : "centreLatitudeMicrodegrees"],
        message: "A centre needs both a latitude and a longitude, or neither.",
      });
      return;
    }
    // Distance from nowhere has no order, and a centre with any other sort would be silently
    // ignored — the partial-viewport failure (`VIEWPORT_INCOMPLETE`) in another shape.
    if (query.sort === "distance" && !hasCentreLatitude) {
      context.addIssue({
        code: "custom",
        path: ["centreLatitudeMicrodegrees"],
        message: "Sorting by distance needs a centre.",
      });
    }
    if (query.sort !== "distance" && hasCentreLatitude) {
      context.addIssue({
        code: "custom",
        path: ["sort"],
        message: "A centre is only used with sort=distance.",
      });
    }
  });

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

/** Photos one report may carry. The report sheet enforces the same number. */
export const MAX_PROBLEM_REPORT_PHOTOS = 3;

/**
 * ABSENT BY CONSTRUCTION, each rejected by `.strict()` as a 422: `countryCode`
 * (server-geocoded — CLAUDE.md §0 names client-supplied country as untrustworthy, and here
 * it feeds the opportunity score), `reportCount`, `distinctReporterCount`,
 * `opportunityScore`, `clusterId`, `mapPosition`, `status`, `reporterUserId` (§13 — every
 * actor id is req.user.id and nothing else), and the RESOLVED coordinates
 * `latitudeMicrodegrees` / `longitudeMicrodegrees`.
 *
 * The current report-problem-sheet fabricates four of those in the browser:
 * `countryCode: ""`, `mapPosition: {50,50}`, `reportCount: 1`, `opportunityScore: 40`.
 * All four become server-derived, and there is no field left to forge.
 *
 * ⚠️ **THIS BLOCK USED TO SAY "AND ANY COORDINATE", AND THAT IS NO LONGER TRUE.** The optional
 * `approx*` pair below is the ONE piece of client-supplied geography this body accepts, and the
 * distinction it turns on is worth stating precisely, because §6 forbids client-claimed geography
 * and this does not break that rule:
 *
 * - `countryCode` and the region derived from it are what the OPPORTUNITY SCORE reads. A client
 *   that could assert a country could manufacture a crisis in a place it has never been. Those stay
 *   server-geocoded from `locationText` and nothing here can influence them.
 * - The `approx*` pair only refines WHERE INSIDE that geocoded place the report sits, and the job
 *   discards it when the two disagree by more than the clustering radius. A reporter could already
 *   move their own report anywhere on earth by typing a different `locationText`; this adds no
 *   forgery surface, it adds resolution.
 *
 * ⚠️ **IT ARRIVES COARSE AND IS RE-QUANTIZED ANYWAY.** The browser rounds to 3 decimals (~110 m)
 * before sending, so no precise point reaches this server; the service rounds again on receipt
 * because that rounding is a UX affordance in a hostile client, not a control.
 */
export const CreateProblemReportSchema = z
  .object({
    title: z.string().trim().min(8).max(160),
    categoryId: z.uuid(),
    description: z.string().trim().min(20).max(5_000),
    locationText: z.string().trim().min(2).max(200),
    /**
     * The reporter's optional coarse pin. BOTH OR NEITHER — see the refinement below.
     *
     * `locationText` stays required beside it: the pin cannot produce a country, so a report with
     * a pin and unresolvable text still fails geocoding exactly as it does today.
     */
    approxLatitudeMicrodegrees: z
      .number()
      .int()
      .min(-MAXIMUM_LATITUDE_MICRODEGREES)
      .max(MAXIMUM_LATITUDE_MICRODEGREES)
      .optional(),
    approxLongitudeMicrodegrees: z
      .number()
      .int()
      .min(-MAXIMUM_LONGITUDE_MICRODEGREES)
      .max(MAXIMUM_LONGITUDE_MICRODEGREES)
      .optional(),
    /**
     * Staged uploads from `POST /discovery/problem-reports/photos`, claimed by the submit.
     *
     * ⚠️ DISTINCT, AND REFUSED HERE RATHER THAN DEDUPED IN THE SERVICE. The claim compares the
     * rows it locked with the number of ids sent; `[a, a]` locks one row against two ids and would
     * read as "a photo is unavailable" when the reporter did nothing wrong. Refusing duplicates at
     * the boundary keeps that comparison exact.
     */
    photoIds: z
      .array(z.uuid())
      .max(MAX_PROBLEM_REPORT_PHOTOS)
      .refine((photoIds) => new Set(photoIds).size === photoIds.length, {
        message: "Each photo may be attached once.",
      })
      // Optional, not `.default([])`: absent means "no photos", and a body without the key parses
      // to exactly what it parsed to before photos existed.
      .optional(),
  })
  .strict()
  .superRefine((body, context) => {
    // Mirrors `problem_submission_approx_coordinate_ck` so the refusal is a 422 naming the field
    // rather than a 500 from the database. Half a pin is not "a latitude with the longitude to
    // follow"; it is a point that does not exist, and the only thing that could be done with one is
    // to guess the other half.
    const hasLatitude = body.approxLatitudeMicrodegrees !== undefined;
    const hasLongitude = body.approxLongitudeMicrodegrees !== undefined;
    if (hasLatitude === hasLongitude) return;

    context.addIssue({
      code: "custom",
      path: [hasLatitude ? "approxLongitudeMicrodegrees" : "approxLatitudeMicrodegrees"],
      message: "A map pin needs both a latitude and a longitude, or neither.",
    });
  });

export const ListMyProblemReportsQuerySchema = z
  .object({
    clusteringStatus: z
      .enum(["queued", "clustered", "geocode_failed", "rejected", "failed"])
      .optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
