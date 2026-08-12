/**
 * Request schemas for platform-roles, extracted from platform-roles.controller.ts.
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

/** The assignable roles, plus `null` to revoke. */
export const ProposePlatformRoleSchema = z
  .object({
    email: z.string().trim().email().max(320),
    /**
     * `null` REVOKES. Nullable rather than a `"none"` sentinel because JSON has a spelling
     * for absence and the column is genuinely nullable — the script's `--role=none` exists
     * only because a shell argument cannot be null.
     */
    role: z.enum(["moderator", "auditor", "admin"]).nullable(),
    note: z.string().trim().max(2_000).default(""),
  })
  .strict();

export const CountersignPlatformRoleSchema = z
  .object({ note: z.string().trim().max(2_000).default("") })
  .strict();

export const LookupUserQuerySchema = z
  .object({ email: z.string().trim().email().max(320) })
  .strict();
