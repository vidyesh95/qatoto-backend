/**
 * Request schemas for commerce-messages, extracted from commerce-messages.controller.ts.
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

export const CreateThreadBodySchema = z
  .object({
    resourceKind: z.enum(["rfq", "quote"]),
    resourceId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ThreadParamsSchema = z
  .object({
    threadId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ListMessagesQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/**
 * A38. `resourceKind` narrows the inbox to one conversation family — the frontend's
 * negotiations tab versus its pre-sales tab — and is the four kinds this service can resolve
 * parties for, NOT the seven the column holds. `.strict()` therefore answers 422 for `order`
 * rather than silently returning nothing, which is the difference between "we do not serve
 * that yet" and "you have no order threads".
 */
export const ListThreadsQuerySchema = z
  .object({
    resourceKind: z.enum(["rfq", "quote", "product_inquiry", "manufacturing_inquiry"]).optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const AppendMessageBodySchema = z
  .object({
    bodyText: z.string().min(1).max(10_000),
    encryptedDocumentIds: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .strict();
