import type { Request, Response } from "express";

import {
  firstParam,
  respondProjectError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";
import { respondWorkshopError } from "#src/controllers/workshop-error-response.js";
import {
  AddFileLinkSchema,
  CreateColumnSchema,
  CreateTaskSchema,
  ListChatQuerySchema,
  MarkChatReadSchema,
  MoveTaskSchema,
  PostChatMessageSchema,
  ReorderColumnsSchema,
  UpdateColumnSchema,
  UpdateFileLinkSchema,
  UpdateTaskSchema,
} from "#src/schemas/workshop.schemas.js";
import * as membershipService from "#src/services/project-membership.service.js";
import * as boardService from "#src/services/workshop-board.service.js";
import * as chatService from "#src/services/workshop-chat.service.js";
import * as filesService from "#src/services/workshop-files.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Proves membership and hands back the caller's context.
 *
 * `contributor` is the minimum for the entire workshop: it is the role that "posts daily
 * logs and reads private project surfaces" (§4a), and every §8 surface is one of those.
 */
interface WorkshopCaller {
  readonly context: membershipService.ProjectMemberContext;
  /**
   * The SESSION's user id, carried alongside the membership row because the two are used
   * for different things and confusing them is a real bug: `createdByUserId` columns are
   * FKs into `user`, while every §8 authorship column (`authorMemberId`,
   * `uploadedByMemberId`) is an FK into `project_member`.
   */
  readonly userId: string;
}

async function requireMemberOrRespond(req: Request, res: Response): Promise<WorkshopCaller | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }

  const projectSlug = firstParam(req.params.projectSlug ?? "");
  const accessResult = await membershipService.requireProjectRole(
    projectSlug,
    req.user.id,
    "contributor",
  );

  if (!accessResult.success) {
    respondProjectError(res, accessResult.error);
    return null;
  }
  return { context: accessResult.value, userId: req.user.id };
}

/**
 * GET /research-projects/:projectSlug/workshop — the whole surface in one read.
 *
 * One request rather than three because the workshop page renders all three panels at
 * once, and three round trips on a mobile connection is three chances to render half a
 * screen. The chat slice is the first PAGE, not the history — the client pages backwards
 * from there with the cursor.
 */
export async function getWorkshop(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const [board, files, chatMessages, readState] = await Promise.all([
    // Seeds "To do / In progress / Done" on first open rather than in the project-create
    // transaction, which would add three writes to every draft nobody works on.
    boardService.ensureDefaultBoard(caller.context.projectId, caller.userId),
    filesService.listFiles(caller.context.projectId),
    chatService.listRecentMessagesOldestFirst(caller.context.projectId),
    chatService.findReadState(caller.context.projectId, caller.context.memberId),
  ]);

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Workshop loaded.",
    data: { board, files, chatMessages, readState },
  };
  res.status(200).json(response);
}

/** GET …/workshop/board */
export async function getBoard(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const board = await boardService.ensureDefaultBoard(caller.context.projectId, caller.userId);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Board loaded.",
    data: board,
  } satisfies ApiResponse);
}

export async function createColumn(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = CreateColumnSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await boardService.createColumn(
    caller.context.projectId,
    // The actor is the SESSION's user, never a body field (§13).
    caller.userId,
    parsedBody.data,
  );
  if (!created.success) {
    respondWorkshopError(res, created.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Column created.",
    data: created.value,
  } satisfies ApiResponse);
}

export async function updateColumn(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = UpdateColumnSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updated = await boardService.renameColumn(
    caller.context.projectId,
    firstParam(req.params.columnId ?? ""),
    parsedBody.data.title,
  );
  if (!updated.success) {
    respondWorkshopError(res, updated.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Column updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

export async function deleteColumn(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const deleted = await boardService.deleteColumn(
    caller.context.projectId,
    firstParam(req.params.columnId ?? ""),
  );
  if (!deleted.success) {
    respondWorkshopError(res, deleted.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Column deleted.",
    data: deleted.value,
  } satisfies ApiResponse);
}

export async function reorderColumns(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = ReorderColumnsSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const reordered = await boardService.reorderColumns(
    caller.context.projectId,
    parsedBody.data.columnIds,
  );
  if (!reordered.success) {
    respondWorkshopError(res, reordered.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Board reordered.",
    data: reordered.value,
  } satisfies ApiResponse);
}

export async function createTask(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = CreateTaskSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const created = await boardService.createTask(
    caller.context.projectId,
    caller.userId,
    parsedBody.data,
  );
  if (!created.success) {
    respondWorkshopError(res, created.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Task created.",
    data: created.value,
  } satisfies ApiResponse);
}

export async function updateTask(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = UpdateTaskSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const updated = await boardService.updateTask(
    caller.context.projectId,
    firstParam(req.params.taskId ?? ""),
    parsedBody.data,
  );
  if (!updated.success) {
    respondWorkshopError(res, updated.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Task updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

export async function deleteTask(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const deleted = await boardService.deleteTask(
    caller.context.projectId,
    firstParam(req.params.taskId ?? ""),
  );
  if (!deleted.success) {
    respondWorkshopError(res, deleted.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Task deleted.",
    data: deleted.value,
  } satisfies ApiResponse);
}

/** POST …/workshop/tasks/:taskId/move — the SERVER derives the new rank (§8). */
export async function moveTask(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = MoveTaskSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const moved = await boardService.moveTask(
    caller.context.projectId,
    firstParam(req.params.taskId ?? ""),
    parsedBody.data,
  );
  if (!moved.success) {
    respondWorkshopError(res, moved.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Task moved.",
    data: moved.value,
  } satisfies ApiResponse);
}

export async function listFiles(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const files = await filesService.listFiles(caller.context.projectId);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Files loaded.",
    data: files,
  } satisfies ApiResponse);
}

/**
 * PATCH /research-projects/:projectSlug/workshop/files/:fileId — any member (§11j.3).
 *
 * Any member, matching the DELETE beside it rather than the POST: creating a link mints §9
 * evidence and must be accountable, whereas renaming an existing one mints nothing. The URL
 * stays immutable — see `UpdateFileLinkSchema`.
 */
export async function updateFileLink(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = UpdateFileLinkSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const fileId = firstParam(req.params.fileId ?? "");
  const updated = await filesService.updateFileLink(
    caller.context.projectId,
    fileId,
    parsedBody.data,
  );

  if (!updated.success) {
    respondWorkshopError(res, updated.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "File updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

/** GET /research-projects/:projectSlug/workshop/files/:fileId — member only (§11j.2). */
export async function getFile(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const fileId = firstParam(req.params.fileId ?? "");
  const fileResult = await filesService.findFile(caller.context.projectId, fileId);

  if (!fileResult.success) {
    respondWorkshopError(res, fileResult.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "File loaded.",
    data: fileResult.value,
  } satisfies ApiResponse);
}

export async function addFileLink(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = AddFileLinkSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const added = await filesService.addFileLink(
    caller.context.projectId,
    caller.context.memberId,
    parsedBody.data,
  );
  if (!added.success) {
    respondWorkshopError(res, added.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "File linked.",
    data: added.value,
  } satisfies ApiResponse);
}

export async function removeFileLink(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const removed = await filesService.removeFileLink(
    caller.context.projectId,
    firstParam(req.params.fileId ?? ""),
    caller.userId,
  );
  if (!removed.success) {
    respondWorkshopError(res, removed.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "File removed.",
    data: removed.value,
  } satisfies ApiResponse);
}

/** GET …/workshop/chat — newest first, keyset by `(sentAt, id)`. */
export async function listChat(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedQuery = ListChatQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const page = await chatService.listMessages(caller.context.projectId, parsedQuery.data);
  if (!page.success) {
    respondWorkshopError(res, page.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Messages loaded.",
    data: page.value,
  } satisfies ApiResponse);
}

export async function postChatMessage(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = PostChatMessageSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const message = await chatService.postMessage(
    caller.context.projectId,
    // The author is the caller's OWN membership row. There is no authorMemberId field to
    // send, which is why nobody can post as somebody else (§13).
    caller.context.memberId,
    parsedBody.data.messageText,
  );

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Message sent.",
    data: message,
  } satisfies ApiResponse);
}

export async function editChatMessage(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = PostChatMessageSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const edited = await chatService.editMessage(
    caller.context.projectId,
    firstParam(req.params.messageId ?? ""),
    caller.context.memberId,
    parsedBody.data.messageText,
  );
  if (!edited.success) {
    respondWorkshopError(res, edited.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Message updated.",
    data: edited.value,
  } satisfies ApiResponse);
}

export async function deleteChatMessage(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const deleted = await chatService.deleteMessage(
    caller.context.projectId,
    firstParam(req.params.messageId ?? ""),
    caller.context.memberId,
  );
  if (!deleted.success) {
    respondWorkshopError(res, deleted.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Message deleted.",
    data: deleted.value,
  } satisfies ApiResponse);
}

export async function markChatRead(req: Request, res: Response): Promise<void> {
  const caller = await requireMemberOrRespond(req, res);
  if (!caller) return;

  const parsedBody = MarkChatReadSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const marked = await chatService.markRead(
    caller.context.projectId,
    caller.context.memberId,
    parsedBody.data.throughMessageId,
  );
  if (!marked.success) {
    respondWorkshopError(res, marked.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Read state updated.",
    data: marked.value,
  } satisfies ApiResponse);
}
