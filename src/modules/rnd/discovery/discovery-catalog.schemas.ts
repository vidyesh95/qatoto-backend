/**
 * Request schemas for discovery-catalog, extracted from discovery-catalog.controller.ts.
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

/**
 * `status` is ABSENT by construction. A user-minted category always lands `pending`, and
 * `.strict()` turns an attempt to self-approve into a 422 rather than letting the spam
 * gate be bypassed by adding one key. `pinIconKey` is absent for the same reason — a
 * minter must not choose their own map iconography.
 */
export const CreateCategorySchema = z.object({ label: z.string().trim().min(1).max(80) }).strict();

export const ListCategoriesQuerySchema = z
  .object({ status: z.enum(["approved", "pending", "rejected"]).default("approved") })
  .strict();

export const ListRegionsQuerySchema = z
  .object({ countryCode: z.string().trim().length(2).toUpperCase().optional() })
  .strict();

export const MARKET_INSIGHT_STAT_KINDS = [
  "percent_change",
  "percent_level",
  "absolute_count",
  "multiplier",
] as const;

export const ListMarketInsightsQuerySchema = z
  .object({
    region: z.string().trim().min(1).max(60).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    statKind: z.enum(MARKET_INSIGHT_STAT_KINDS).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

/**
 * Same precedent as `ClusterIdParamSchema`: a malformed id 422s before any query runs, so a
 * scan is never started on a value that cannot match a row.
 */
export const MarketInsightIdParamSchema = z.object({ insightId: z.uuid() }).strict();

export const ListDemandSignalsQuerySchema = z
  .object({
    region: z.string().trim().min(1).max(60).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
