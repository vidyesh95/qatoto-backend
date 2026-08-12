/**
 * Request schemas for handle, extracted from handle.controller.ts.
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
 * Body for PATCH /users/me/handle. The raw handle is accepted as a loosely
 * bounded string here — the service is the authority that normalizes (trim, strip
 * "@", lowercase) and regex-validates it (CLAUDE.md §1.1). `.strict()` rejects
 * unknown keys; the 100-char ceiling just caps abuse before normalization.
 */
export const UpdateMyHandleSchema = z.object({ handle: z.string().max(100) }).strict();

/** Query for GET /handles/availability. */
export const AvailabilityQuerySchema = z.object({ handle: z.string().max(100) });
