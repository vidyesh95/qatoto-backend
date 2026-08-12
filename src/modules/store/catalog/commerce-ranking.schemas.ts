/**
 * Request schemas for commerce-ranking, extracted from commerce-ranking.controller.ts.
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

export const EmptyObjectSchema = z.object({}).strict();

export const ProductIdParamsSchema = z
  .object({ productId: z.string().trim().min(1).max(200) })
  .strict();

/**
 * `none` is a legal action and is how an appeal is GRANTED — it lifts a suppression while
 * leaving the decision, its author and its reason in the event log. Deleting the row instead
 * would erase the fact that a suppression ever happened.
 */
export const ModerateRankingBodySchema = z
  .object({
    action: z.enum(["none", "weight_reduced", "capped", "quarantined", "review_queued"]),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();
