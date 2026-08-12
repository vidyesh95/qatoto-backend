/**
 * Request schemas for notifications, extracted from notifications.controller.ts.
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
 * `limit` is capped in the schema AND again in the service. The duplication is deliberate:
 * the schema protects the HTTP surface and the service protects every other caller of it,
 * including a future job.
 */
export const ListNotificationsQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

/**
 * THROUGH an id, never a list of ids. A client that has scrolled past a row has seen
 * everything above it, and a list grows with the backlog while racing anything that arrived
 * meanwhile. `throughMessageId` is what the workshop chat read state already calls this.
 */
export const MarkNotificationsReadSchema = z.object({ throughNotificationId: z.uuid() }).strict();
