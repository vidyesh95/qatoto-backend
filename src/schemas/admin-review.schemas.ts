/**
 * Request schemas for admin-review, extracted from admin-review.controller.ts.
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

export const ReviewQueueQuerySchema = z
  .object({
    status: z.enum(["not_required", "pending", "approved", "rejected"]).default("pending"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * `reason` is REQUIRED and non-empty. A rejection with no reason is unactionable for the
 * creator and unauditable for the next moderator; the `content_review_action_reason_ck`
 * CHECK enforces the same rule one layer down.
 */
export const RejectReviewSchema = z
  .object({ reason: z.string().trim().min(1).max(2_000) })
  .strict();
