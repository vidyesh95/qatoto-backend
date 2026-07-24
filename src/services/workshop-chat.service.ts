import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { workshopChatMessage, workshopChatReadState } from "#src/db/schema.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Team chat (R_AND_D_BACKEND_STRUCTURE.md §8, "Chat transport").
 *
 * REST + KEYSET PAGINATION, AND NO SSE STREAM IN THIS PHASE. The managed Postgres allows
 * twenty connections for the whole server, shared by the API pool, the worker pool and
 * every `db:*` script (the incident is recorded at the bottom of src/worker.ts). Every
 * open stream either polls or holds a LISTEN session, so a stream would spend connections
 * the request path needs on a surface the frontend does not have yet. The cursor below is
 * `(sentAt, id)` either way, so adding the stream later changes no table and no cursor.
 *
 * WHY THE CURSOR IS A PAIR AND NOT A TIMESTAMP. Two messages can share a microsecond.
 * A cursor on `sentAt` alone then either repeats the tied row or skips it, depending on
 * which side of the comparison it lands — §4c rule 4 exists for exactly this.
 *
 * WHY DELETES ARE SOFT. A hard delete punches a hole in that cursor: a client paging
 * backwards past the gap silently loses a page and never learns it did.
 */

/** One page. Bounded so a client cannot ask for the whole history in one request. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** How long an author may edit their own message. */
const EDIT_WINDOW_MS = 15 * 60 * 1_000;

export type WorkshopChatError =
  | ProjectAccessError
  | { type: "MESSAGE_NOT_FOUND"; messageId: string }
  | { type: "NOT_THE_AUTHOR" }
  | { type: "EDIT_WINDOW_CLOSED"; windowMinutes: number }
  | { type: "CURSOR_MALFORMED" };

export interface WorkshopChatMessageView {
  readonly id: string;
  readonly authorMemberId: string;
  readonly messageText: string;
  /** ISO-8601 on the wire. "Jul 7, 9:42 AM" is a client decision (§1). */
  readonly sentAt: Date;
  readonly editedAt: Date | null;
}

export interface ChatPage {
  readonly messages: readonly WorkshopChatMessageView[];
  /**
   * Opaque to the client, and the ONLY thing it should send back. Null when the page
   * reached the beginning of the history.
   */
  readonly nextCursor: string | null;
}

/**
 * The cursor is `<epochMicroseconds>_<messageId>` — the exact pair the index is built on.
 *
 * Opaque by convention rather than by encryption: it carries no authorization and reveals
 * nothing a member reading the channel cannot already see. Encoding it would only make it
 * harder to debug.
 */
function encodeCursor(message: { readonly sentAt: Date; readonly id: string }): string {
  return `${message.sentAt.getTime()}_${message.id}`;
}

interface DecodedCursor {
  readonly sentAt: Date;
  readonly id: string;
}

function decodeCursor(rawCursor: string): DecodedCursor | null {
  const separatorIndex = rawCursor.indexOf("_");
  if (separatorIndex <= 0) return null;

  const epochMs = Number(rawCursor.slice(0, separatorIndex));
  const id = rawCursor.slice(separatorIndex + 1);

  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || id === "") return null;
  return { sentAt: new Date(epochMs), id };
}

function toMessageView(row: typeof workshopChatMessage.$inferSelect): WorkshopChatMessageView {
  return {
    id: row.id,
    authorMemberId: row.authorMemberId,
    messageText: row.messageText,
    sentAt: row.sentAt,
    editedAt: row.editedAt,
  };
}

/**
 * One page of history, NEWEST FIRST — the order a chat pane renders and pages backwards
 * through.
 *
 * The keyset predicate is the standard row-comparison: strictly older than the cursor's
 * instant, OR the same instant with a smaller id. That is what makes a tie total.
 */
export async function listMessages(
  projectId: string,
  options: { readonly cursor?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<Result<ChatPage, WorkshopChatError>> {
  const pageSize = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  const decodedCursor = options.cursor === undefined ? null : decodeCursor(options.cursor);
  if (options.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "CURSOR_MALFORMED" } };
  }

  const rows = await db
    .select()
    .from(workshopChatMessage)
    .where(
      and(
        eq(workshopChatMessage.projectId, projectId),
        isNull(workshopChatMessage.deletedAt),
        decodedCursor === null
          ? undefined
          : or(
              lt(workshopChatMessage.sentAt, decodedCursor.sentAt),
              and(
                eq(workshopChatMessage.sentAt, decodedCursor.sentAt),
                lt(workshopChatMessage.id, decodedCursor.id),
              ),
            ),
      ),
    )
    .orderBy(desc(workshopChatMessage.sentAt), desc(workshopChatMessage.id))
    // One extra row, purely to answer "is there another page?" without a COUNT.
    .limit(pageSize + 1);

  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      messages: pageRows.map(toMessageView),
      nextCursor: rows.length > pageSize && lastRow !== undefined ? encodeCursor(lastRow) : null,
    },
  };
}

export async function postMessage(
  projectId: string,
  authorMemberId: string,
  messageText: string,
): Promise<WorkshopChatMessageView> {
  const [inserted] = await db
    .insert(workshopChatMessage)
    .values({ projectId, authorMemberId, messageText })
    .returning();

  if (!inserted) {
    throw new Error("postMessage: insert returned no row");
  }
  return toMessageView(inserted);
}

/**
 * Edits a message. The author only, and only inside a short window.
 *
 * The window is not decoration: chat is the informal record a team reasons from, and an
 * unbounded edit lets someone rewrite what they said three weeks ago after a dispute is
 * raised (§9). `sentAt` never moves, so the message keeps its place in the cursor.
 */
export async function editMessage(
  projectId: string,
  messageId: string,
  authorMemberId: string,
  messageText: string,
): Promise<Result<WorkshopChatMessageView, WorkshopChatError>> {
  const [existing] = await db
    .select({
      id: workshopChatMessage.id,
      authorMemberId: workshopChatMessage.authorMemberId,
      sentAt: workshopChatMessage.sentAt,
    })
    .from(workshopChatMessage)
    .where(
      and(
        eq(workshopChatMessage.id, messageId),
        eq(workshopChatMessage.projectId, projectId),
        isNull(workshopChatMessage.deletedAt),
      ),
    );

  if (!existing) {
    return { success: false, error: { type: "MESSAGE_NOT_FOUND", messageId } };
  }
  if (existing.authorMemberId !== authorMemberId) {
    // Membership is already proven, so naming the rule reveals nothing new — the same
    // reasoning project-error-response.ts applies to NOT_THE_APPLICANT.
    return { success: false, error: { type: "NOT_THE_AUTHOR" } };
  }
  if (Date.now() - existing.sentAt.getTime() > EDIT_WINDOW_MS) {
    return {
      success: false,
      error: { type: "EDIT_WINDOW_CLOSED", windowMinutes: EDIT_WINDOW_MS / 60_000 },
    };
  }

  const [updated] = await db
    .update(workshopChatMessage)
    .set({ messageText, editedAt: new Date() })
    .where(eq(workshopChatMessage.id, messageId))
    .returning();

  if (!updated) {
    return { success: false, error: { type: "MESSAGE_NOT_FOUND", messageId } };
  }
  return { success: true, value: toMessageView(updated) };
}

/** Soft-deletes a message. The author only; the row survives so the cursor does. */
export async function deleteMessage(
  projectId: string,
  messageId: string,
  authorMemberId: string,
): Promise<Result<{ readonly messageId: string }, WorkshopChatError>> {
  const [existing] = await db
    .select({
      id: workshopChatMessage.id,
      authorMemberId: workshopChatMessage.authorMemberId,
    })
    .from(workshopChatMessage)
    .where(
      and(
        eq(workshopChatMessage.id, messageId),
        eq(workshopChatMessage.projectId, projectId),
        isNull(workshopChatMessage.deletedAt),
      ),
    );

  if (!existing) {
    return { success: false, error: { type: "MESSAGE_NOT_FOUND", messageId } };
  }
  if (existing.authorMemberId !== authorMemberId) {
    return { success: false, error: { type: "NOT_THE_AUTHOR" } };
  }

  await db
    .update(workshopChatMessage)
    .set({ deletedAt: new Date() })
    .where(eq(workshopChatMessage.id, messageId));

  return { success: true, value: { messageId } };
}

/**
 * Marks the channel read through a message.
 *
 * Upsert on the composite PK, so a double-tap is one row. The cursor only ever moves
 * FORWARD: a client that replays an older "read" request — a retry on a flaky connection,
 * or two devices out of sync — must not un-read messages the member has already seen.
 * `GREATEST` on the message's instant is what enforces that in one statement.
 */
export async function markRead(
  projectId: string,
  memberId: string,
  throughMessageId: string,
): Promise<Result<{ readonly throughMessageId: string }, WorkshopChatError>> {
  const [message] = await db
    .select({ id: workshopChatMessage.id, sentAt: workshopChatMessage.sentAt })
    .from(workshopChatMessage)
    .where(
      and(
        eq(workshopChatMessage.id, throughMessageId),
        eq(workshopChatMessage.projectId, projectId),
      ),
    );

  if (!message) {
    return { success: false, error: { type: "MESSAGE_NOT_FOUND", messageId: throughMessageId } };
  }

  await db
    .insert(workshopChatReadState)
    .values({ projectId, memberId, throughMessageId, readAt: message.sentAt })
    .onConflictDoUpdate({
      target: [workshopChatReadState.projectId, workshopChatReadState.memberId],
      set: {
        throughMessageId: sql`CASE WHEN excluded.read_at > ${workshopChatReadState.readAt}
                                   THEN excluded.through_message_id
                                   ELSE ${workshopChatReadState.throughMessageId} END`,
        readAt: sql`GREATEST(${workshopChatReadState.readAt}, excluded.read_at)`,
      },
    });

  return { success: true, value: { throughMessageId } };
}

/** The member's read cursor, for rendering an unread divider. Null before first read. */
export async function findReadState(
  projectId: string,
  memberId: string,
): Promise<{ readonly throughMessageId: string | null; readonly readAt: Date } | null> {
  const [row] = await db
    .select({
      throughMessageId: workshopChatReadState.throughMessageId,
      readAt: workshopChatReadState.readAt,
    })
    .from(workshopChatReadState)
    .where(
      and(
        eq(workshopChatReadState.projectId, projectId),
        eq(workshopChatReadState.memberId, memberId),
      ),
    );

  return row ?? null;
}

/**
 * Exported for the workshop landing read, which needs the OLDEST-first slice a chat pane
 * renders on open rather than the newest-first page `listMessages` returns.
 *
 * Sorted in application code by `(sentAt, id)` — the same total order the index uses, via
 * `compareUtf8Bytes` on the id so a tie breaks identically to Postgres under `COLLATE
 * "C"` (§4c rule 4).
 */
export async function listRecentMessagesOldestFirst(
  projectId: string,
  limit = DEFAULT_PAGE_SIZE,
): Promise<readonly WorkshopChatMessageView[]> {
  const rows = await db
    .select()
    .from(workshopChatMessage)
    .where(and(eq(workshopChatMessage.projectId, projectId), isNull(workshopChatMessage.deletedAt)))
    .orderBy(desc(workshopChatMessage.sentAt), desc(workshopChatMessage.id))
    .limit(Math.min(Math.max(limit, 1), MAX_PAGE_SIZE));

  return rows
    .map(toMessageView)
    .toSorted(
      (left, right) =>
        left.sentAt.getTime() - right.sentAt.getTime() || compareUtf8Bytes(left.id, right.id),
    );
}

/** Exported so the controller and the tests share one page-size contract. */
export const CHAT_PAGE_SIZE = { default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE } as const;
