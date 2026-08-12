/**
 * Request schemas for auth, extracted from auth.controller.ts.
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
 * Body for POST /signup/start. `.strict()` rejects unknown keys.
 */
export const StartSignupSchema = z
  .object({
    // Lowercase so the stored/looked-up address is canonical. citext makes the DB
    // comparison case-insensitive anyway (src/db/schema.ts); this keeps the value
    // itself clean across the credential signup path.
    email: z.email("A valid email is required.").transform((value) => value.toLowerCase()),
  })
  .strict();

/**
 * Body for POST /signup/complete. `.strict()` rejects unknown keys.
 */
export const CompleteSignupSchema = z
  .object({
    email: z.email("A valid email is required.").transform((value) => value.toLowerCase()),
    otp: z.string().min(1, "Verification code is required."),
    password: z.string().min(8, "Password must be at least 8 characters."),
    name: z.string().min(1).optional(),
  })
  .strict();
