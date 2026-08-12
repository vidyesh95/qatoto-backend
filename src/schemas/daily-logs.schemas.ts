/**
 * Request schemas for daily-logs, extracted from daily-logs.controller.ts.
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

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

/**
 * `youtubeUrl` is NOT wrapped in `z.url()`.
 *
 * src/lib/youtube.ts accepts a bare 11-character id and a schemeless link, both of which
 * the frontend's mirrored parser accepts too — and `z.url()` would reject them here after
 * the browser showed a green checkmark. The parse that matters happens in the service,
 * against a hostname allowlist.
 */
export const YoutubeUrlSchema = z.string().trim().min(1).max(2_048);

export const CreateDailyLogSchema = z
  .object({
    logDate: IsoDateSchema,
    narrative: z.string().trim().max(10_000).optional(),
    youtubeUrl: YoutubeUrlSchema.optional(),
  })
  .strict();

export const UpdateDailyLogSchema = z
  .object({
    logDate: IsoDateSchema.optional(),
    narrative: z.string().trim().max(10_000).optional(),
    // Explicit null detaches the video; absent leaves it alone. The two must stay
    // distinguishable or a narrative-only PATCH silently drops a member's video.
    youtubeUrl: YoutubeUrlSchema.nullable().optional(),
  })
  .strict();

/**
 * The one client-supplied string this endpoint accepts.
 *
 * It is an opaque dedup token, not a value the server owns: a retried submit on a flaky
 * mobile connection must return the first receipt rather than file a second log (§14).
 */
export const SubmitDailyLogSchema = z
  .object({ idempotencyKey: z.string().trim().min(8).max(128) })
  .strict();

export const ListDailyLogsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();

/**
 * The CROSS-PROJECT feed's query (§11h, Appendix B2).
 *
 * THE KEY THAT IS ABSENT IS THE POINT: there is no `projectIds`, no `userId`, and no
 * `includeAllProjects`. `.strict()` refuses all three with a 422 rather than letting one
 * become an authorization input (§0). The membership set is derived from `project_member`
 * inside the service; `projectSlug` can only NARROW the caller's own set.
 *
 * `chipKind` is the four-value `AiSummaryChipKind`, enumerated here so an unknown chip is
 * a 422 rather than an empty page a client would read as "no blockers this week".
 */
export const ListDailyLogFeedQuerySchema = z
  .object({
    projectSlug: z.string().trim().min(1).max(120).optional(),
    chipKind: z.enum(["blocker", "progress", "velocity", "suggestion"]).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
