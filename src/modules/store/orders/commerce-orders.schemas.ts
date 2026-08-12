/**
 * Request schemas for commerce-orders, extracted from commerce-orders.controller.ts.
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

import { FreightModeSchema } from "#src/modules/store/fulfillment/commerce-freight-rates.schemas.js";

export const EmptyObjectSchema = z.object({}).strict();

export const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

export const OrderIdParamsSchema = z
  .object({ orderId: z.string().trim().min(1).max(200) })
  .strict();

/**
 * §19.4's mode selection, and the whole of it.
 *
 * OPTIONAL, AND NOTHING IS AUTO-SELECTED WHEN IT IS ABSENT. Omitting it is a legitimate state
 * the projection reports — `freight: unknown / mode_not_selected`, with the covered modes
 * listed — rather than a prompt for the server to guess. Picking the cheapest would publish
 * the slowest window as though the buyer had chosen it.
 */
export const ArrivalWindowQuerySchema = z.object({ mode: FreightModeSchema.optional() }).strict();

export const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
