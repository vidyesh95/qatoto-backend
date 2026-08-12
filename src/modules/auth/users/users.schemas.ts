/**
 * Request schemas for users, extracted from users.controller.ts.
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
 * Display name a user is allowed to set. Trimmed first, then bounded 1–100 and
 * restricted to letters/marks plus spaces, apostrophes, hyphens and periods —
 * the value must START with a letter/mark so it can't be pure punctuation.
 * Unicode-aware (`\p{L}\p{M}`) so non-Latin names are accepted.
 */
export const FullNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(100, "Name must be at most 100 characters.")
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} '.-]*$/u, "Name contains invalid characters.");

/**
 * Body for PATCH /users/me. `.strict()` rejects unknown keys — in particular any
 * client-sent `id`, which is ignored regardless (the id comes from the session).
 */
export const UpdateMyProfileSchema = z.object({ fullName: FullNameSchema }).strict();
