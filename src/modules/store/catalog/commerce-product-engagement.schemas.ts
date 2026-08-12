/**
 * Request schemas for commerce-product-engagement, extracted from commerce-product-engagement.controller.ts.
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

import { MAXIMUM_VIEW_DWELL_SECONDS } from "#src/modules/store/commerce-view-clamp.js";

export const EmptyObjectSchema = z.object({}).strict();

/**
 * The view beacon's body (STORE Phase 13).
 *
 * `dwellSeconds` is a CLAIM and is treated as one — `clampViewDwellSeconds` bounds it by
 * wall time before it reaches a column. The ceiling here is only a parse-level sanity
 * bound so an absurd number is a 422 rather than something the clamp has to reason about.
 *
 * `viewSource` is also client-supplied and is safe to accept only because nothing gates on
 * it: it selects no rate, no weight and no eligibility, and exists so an operator triaging
 * a spike can ask which surface it arrived through. Omitting it yields `unknown`, which is
 * an honest answer rather than an error.
 */
export const ProductViewBeaconBodySchema = z
  .object({
    dwellSeconds: z.number().int().min(0).max(MAXIMUM_VIEW_DWELL_SECONDS),
    viewSource: z
      .enum(["product_detail", "search", "rail", "pathway", "companion", "unknown"])
      .default("unknown"),
  })
  .strict();

export const ProductSlugParamsSchema = z
  .object({
    productSlug: z.string().trim().min(1).max(200),
  })
  .strict();
