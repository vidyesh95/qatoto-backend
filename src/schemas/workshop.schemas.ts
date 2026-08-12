/**
 * Request schemas for workshop, extracted from workshop.controller.ts.
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

export const TASK_PRIORITIES = ["high", "medium", "low"] as const;

export const FILE_KINDS = [
  "document",
  "spreadsheet",
  "cad_model",
  "image",
  "video",
  "archive",
  "other",
] as const;

/** Date-only, the §1 wire format. A `Date` here would carry a zone nobody agreed on. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

export const CreateColumnSchema = z.object({ title: z.string().trim().min(1).max(60) }).strict();

export const UpdateColumnSchema = z.object({ title: z.string().trim().min(1).max(60) }).strict();

export const ReorderColumnsSchema = z
  .object({ columnIds: z.array(z.string().min(1)).min(1).max(12) })
  .strict();

/**
 * `rank` is ABSENT, deliberately, and this is the §0 line for this domain: a
 * client-supplied rank is a client-supplied sort order, and one client sending the same
 * string for every card corrupts the board for the whole team. The server derives it from
 * `{ afterTaskId, beforeTaskId }` in the move endpoint.
 */
export const TaskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).nullish(),
  assigneeMemberId: z.string().min(1).nullish(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  dueDate: IsoDateSchema.nullish(),
});

export const CreateTaskSchema = TaskFieldsSchema.extend({
  columnId: z.string().min(1),
}).strict();

export const UpdateTaskSchema = TaskFieldsSchema.strict().partial();

export const MoveTaskSchema = z
  .object({
    columnId: z.string().min(1),
    // Ids and intent, never a position and never a rank.
    afterTaskId: z.string().min(1).optional(),
    beforeTaskId: z.string().min(1).optional(),
  })
  .strict();

/**
 * `sizeBytes` is ABSENT and always will be on this path. With a link there are no bytes
 * to measure, so the honest value is NULL rather than a number the client made up (§8).
 */
export const AddFileLinkSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    fileKind: z.enum(FILE_KINDS),
    externalUrl: z.string().trim().min(1).max(2_048),
  })
  .strict();

/**
 * `PATCH …/workshop/files/:fileId` (§11j.3) — rename, or re-file under another kind.
 *
 * `externalUrl` IS ABSENT, AND `.strict()` IS THE WHOLE ENFORCEMENT. "A changed target is a
 * new file, not an edit": repointing a link would silently move what a §9 effort claim
 * cites, so the URL is immutable and no service branch is needed to say so. `sizeBytes`,
 * `source`, `externalHost`, `uploadedByMemberId`, `removedAt` and `removedByUserId` are
 * absent for the same reason — all server-owned.
 *
 * The `max(200)` matches `workshop_file_fileName_ck` exactly, so an over-long name is a 422
 * rather than a CHECK violation surfacing as a 500.
 */
export const UpdateFileLinkSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200).optional(),
    fileKind: z.enum(FILE_KINDS).optional(),
  })
  .strict();

export const PostChatMessageSchema = z
  .object({ messageText: z.string().trim().min(1).max(4_000) })
  .strict();

export const ListChatQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const MarkChatReadSchema = z.object({ throughMessageId: z.string().min(1) }).strict();
