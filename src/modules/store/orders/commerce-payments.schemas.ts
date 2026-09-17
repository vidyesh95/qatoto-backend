/**
 * Request schemas for commerce-payments, extracted from commerce-payments.controller.ts.
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

export const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

export const OrderIdParamsSchema = z
  .object({ orderId: z.string().trim().min(1).max(200) })
  .strict();

export const PaymentIntentIdParamsSchema = z
  .object({ paymentIntentId: z.string().trim().min(1).max(200) })
  .strict();

export const ListRefundsQuerySchema = z
  .object({
    orderId: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const CreateRefundBodySchema = z
  .object({
    amountInCents: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

/**
 * What the Razorpay Checkout success handler hands the browser, forwarded verbatim.
 *
 * camelCase on the wire like every other body here; the frontend renames Razorpay's
 * snake_case keys. The formats are pinned so a malformed value is a 422 at the boundary and
 * never reaches the HMAC comparison.
 */
export const RazorpayCheckoutVerificationBodySchema = z
  .object({
    razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]+$/, "Invalid Razorpay order id"),
    razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]+$/, "Invalid Razorpay payment id"),
    razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/, "Invalid Razorpay signature"),
  })
  .strict();
export type RazorpayCheckoutVerificationBody = z.infer<
  typeof RazorpayCheckoutVerificationBodySchema
>;
