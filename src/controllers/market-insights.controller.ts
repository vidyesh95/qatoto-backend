import type { Request, Response } from "express";
import { z } from "zod";

import {
  firstParam,
  respondDiscoveryError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/discovery-error-response.js";
import {
  ABSOLUTE_COUNT_UNIT_KEYS,
  findStatViolations,
  MARKET_INSIGHT_PERCENT_LEVEL_MAX_MILLI,
  MARKET_INSIGHT_STAT_MAX_MILLI,
} from "#src/lib/market-insight-stat.js";
import * as insightsService from "#src/services/market-insights.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

/**
 * Market-insight authoring — the `/discovery/admin/market-insights` surface
 * (R_AND_D_BACKEND_STRUCTURE.md §6, §11j.4).
 *
 * ---------------------------------------------------------------------------
 * THE FIELDS THAT EXIST IN NO SCHEMA HERE, and are therefore 422s rather than silent
 * overwrites (§0, §13):
 *
 *   id · createdAt · updatedAt · createdByUserId · publishedAt
 *
 * `publishedAt` IS THE ONE THAT MATTERS. It is the visibility switch the public read filters
 * on, and it is reachable ONLY through `/publish` and `/unpublish`. If it were a PATCH key,
 * an insight would go live as a side effect of fixing a typo — the same rule
 * `talent_profile` follows, stated at `talentProfileVisibilityEnum`.
 *
 * THE WIRE SHAPE DEPARTS FROM THE READ SHAPE IN EXACTLY ONE PLACE, deliberately: the stat
 * quad is NESTED under `stat` rather than flat. `market_insight_trend_agreement_ck` is
 * cross-field, so a flat `PATCH { trendDirection: "up" }` against a stored
 * `statValueMilli: -22000` is a guaranteed CHECK violation — and `pg-errors.ts` exposes no
 * `isCheckViolation`, so it would surface as a 500 with nothing to tell the caller. Nesting
 * makes the quad all-four-or-none BY TYPE, so the illegal partial is unrepresentable rather
 * than merely refused (CLAUDE.md §3.2).
 *
 * THE DOC'S FIELD LIST IS STALE AND THE SHIPPED SCHEMA WINS. §11j.4 lists
 * `{ title, …, observedAt }`; the table has `headline`, `summary` and `sourcePublishedDate`,
 * and both `regionId` and `categoryId` are NOT NULL. Naming a column that does not exist
 * would be a 500 on every request, so the columns win and the doc is amended.
 * ---------------------------------------------------------------------------
 */

const TREND_DIRECTIONS = ["up", "down", "flat"] as const;

/** Date-only, the §1 wire format. Matches `date(mode: "string")` on the column. */
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

/**
 * The stat quad, as a discriminated union that CARRIES TWO OF THE THREE CHECKS AS TYPES.
 *
 * `market_insight_stat_unit_pairing_ck` becomes the per-branch `statUnitKey` literal, and
 * `market_insight_stat_range_ck` becomes each branch's numeric bounds. Only the sign↔arrow
 * rule is left to a refinement, because no type can express it.
 *
 * The `superRefine` runs `findStatViolations` — the SAME predicate the service asserts with
 * — so the schema and the database cannot drift apart. The union above is not redundant
 * with it: the union produces per-field errors a client can attach to an input, while the
 * refinement produces the cross-field one.
 */
const MarketInsightStatSchema = z
  .discriminatedUnion("statKind", [
    z
      .object({
        statKind: z.literal("percent_change"),
        // The only kind that may be negative — a fall is a real editorial figure.
        statValueMilli: z
          .number()
          .int()
          .min(-MARKET_INSIGHT_STAT_MAX_MILLI)
          .max(MARKET_INSIGHT_STAT_MAX_MILLI),
        statUnitKey: z.literal("percent"),
        trendDirection: z.enum(TREND_DIRECTIONS),
      })
      .strict(),
    z
      .object({
        statKind: z.literal("percent_level"),
        statValueMilli: z.number().int().min(0).max(MARKET_INSIGHT_PERCENT_LEVEL_MAX_MILLI),
        statUnitKey: z.literal("percent"),
        trendDirection: z.enum(TREND_DIRECTIONS),
      })
      .strict(),
    z
      .object({
        statKind: z.literal("multiplier"),
        // Strictly positive: "0× coverage" is not a multiplier.
        statValueMilli: z.number().int().positive().max(MARKET_INSIGHT_STAT_MAX_MILLI),
        statUnitKey: z.literal("multiple"),
        trendDirection: z.enum(TREND_DIRECTIONS),
      })
      .strict(),
    z
      .object({
        statKind: z.literal("absolute_count"),
        statValueMilli: z.number().int().min(0).max(MARKET_INSIGHT_STAT_MAX_MILLI),
        statUnitKey: z.enum(ABSOLUTE_COUNT_UNIT_KEYS),
        trendDirection: z.enum(TREND_DIRECTIONS),
      })
      .strict(),
  ])
  .superRefine((stat, ctx) => {
    for (const violation of findStatViolations(stat)) {
      ctx.addIssue({
        code: "custom",
        path: violation === "trend_agreement" ? ["trendDirection"] : ["statValueMilli"],
        message:
          violation === "trend_agreement"
            ? "The trend direction must agree with the sign of the value."
            : `The stat violates ${violation}.`,
      });
    }
  });

export const CreateMarketInsightSchema = z
  .object({
    // 240 matches `market_insight_headline_ck` exactly, so an over-long headline is a 422
    // rather than a CHECK violation surfacing as a 500.
    headline: z.string().trim().min(1).max(240),
    summary: z.string().trim().max(2_000).optional(),
    stat: MarketInsightStatSchema,
    // Both are NOT NULL on the table. Ids rather than slugs, which lets the service reuse
    // the REGION_NOT_FOUND / CATEGORY_NOT_FOUND / CATEGORY_NOT_APPROVED arms verbatim.
    regionId: z.string().trim().min(1).max(64),
    categoryId: z.string().trim().min(1).max(64),
    sourceName: z.string().trim().min(1).max(200),
    sourceUrl: z.url().max(2_000).optional(),
    sourcePublishedDate: IsoDateSchema,
  })
  .strict();

export const UpdateMarketInsightSchema = z
  .object({
    headline: z.string().trim().min(1).max(240).optional(),
    summary: z.string().trim().max(2_000).nullable().optional(),
    // All four or none — see the note on `MarketInsightStatSchema`.
    stat: MarketInsightStatSchema.optional(),
    regionId: z.string().trim().min(1).max(64).optional(),
    categoryId: z.string().trim().min(1).max(64).optional(),
    sourceName: z.string().trim().min(1).max(200).optional(),
    sourceUrl: z.url().max(2_000).nullable().optional(),
    sourcePublishedDate: IsoDateSchema.optional(),
  })
  .strict();

export const ListMarketInsightsAdminQuerySchema = z
  .object({
    status: z.enum(["draft", "published", "all"]).default("all"),
    region: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

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
