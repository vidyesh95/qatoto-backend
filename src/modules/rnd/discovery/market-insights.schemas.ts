/**
 * Request schemas for market-insights, extracted from market-insights.controller.ts.
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

import {
  ABSOLUTE_COUNT_UNIT_KEYS,
  findStatViolations,
  MARKET_INSIGHT_PERCENT_LEVEL_MAX_MILLI,
  MARKET_INSIGHT_STAT_MAX_MILLI,
} from "#src/lib/market-insight-stat.js";

export const TREND_DIRECTIONS = ["up", "down", "flat"] as const;

/** Date-only, the §1 wire format. Matches `date(mode: "string")` on the column. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

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
export const MarketInsightStatSchema = z
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
    // the REGION_NOT_FOUND / CATEGORY_NOT_FOUND arms verbatim.
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
