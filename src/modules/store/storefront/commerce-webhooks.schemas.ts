/**
 * Request schemas for commerce-webhooks, extracted from commerce-webhooks.controller.ts.
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

export const ProviderIdParamsSchema = z
  .object({ providerId: z.string().trim().min(1).max(200) })
  .strict();

export const EmptyObjectSchema = z.object({}).strict();

/**
 * The only part of a Razorpay webhook body this backend reads: which order it concerns.
 * `order.paid` carries the order entity; `payment.*` events carry the payment, whose
 * `order_id` names it. Everything else in the body is ignored — the state is re-fetched from
 * Razorpay, never taken from here. Not `.strict()`: Razorpay adds fields without notice.
 */
export const RazorpayWebhookBodySchema = z.object({
  event: z.string().min(1),
  payload: z.object({
    order: z.object({ entity: z.object({ id: z.string() }) }).optional(),
    payment: z
      .object({ entity: z.object({ order_id: z.string().nullable().optional() }) })
      .optional(),
  }),
});
