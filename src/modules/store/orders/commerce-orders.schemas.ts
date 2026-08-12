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

/**
 * The order list filter, for both `/orders` and `/provider/orders`.
 *
 * `state` IS APPLIED IN SQL, and it arrived late for a reason worth recording. Until it existed
 * this schema was `.strict()` over `{ limit, cursor }` alone, so a seller's dispatch queue — "paid,
 * nothing shipped yet" — had no way to ask the server for it. The frontend filtered the fetched
 * page instead and said so in a comment, defending it only on the grounds that no server filter
 * existed. That defence is now spent: filtering a page silently short-pages the result, so a seller
 * with 60 orders would see the dispatchable ones from the newest 20 and nothing more.
 *
 * OMITTING IT MEANS EVERY STATE, not a default. Both lists are already scoped to one side of the
 * order by their own predicate, and there is no state an organization should be prevented from
 * seeing on its own orders — `state` narrows within that scope rather than widening it.
 */
export const ListQuerySchema = z
  .object({
    state: z
      .enum([
        "pending_payment",
        "payment_processing",
        "confirmed",
        "in_fulfillment",
        "partially_completed",
        "completed",
        "cancelled",
        "disputed",
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
