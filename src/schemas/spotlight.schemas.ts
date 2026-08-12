/**
 * Request schemas for spotlight, extracted from spotlight.controller.ts.
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

import { MAX_SPOTLIGHT_SLOTS } from "#src/services/spotlight.service.js";

/**
 * The whole ordered set. Empty clears the rail. Max three; uniqueness is enforced in the
 * service so the Zod message stays about shape, not catalogue membership.
 */
export const ReplaceSpotlightSlotsSchema = z
  .object({
    videoIds: z.array(z.string().min(1).max(64)).max(MAX_SPOTLIGHT_SLOTS),
  })
  .strict();
