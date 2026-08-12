import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrganization,
  commerceOrganizationMember,
  communityContentReport,
  communityForumReply,
  communityForumReplyVote,
  communityForumThread,
  communityModerationAction,
  user,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import {
  decodeStoreCursor,
  decodeTimestampStoreCursor,
  encodeStoreCursor,
} from "#src/modules/store/store-cursor.js";
import type { Result } from "#src/types/index.js";

/**
 * The business forum (STORE_BACKEND_STRUCTURE.md §17, Appendix A33).
 *
 * FOUR RULES THIS FILE HOLDS, and each one is a sentence the response body must be unable
 * to support:
 *
 * 1. A NEW THREAD IS `pending_review`, NOT `open`. A10 closed public product comments
 *    because a comment would be "the only public text surface with no purchase proof and no
 *    standing requirement behind it"; a forum inherits that exactly, and moderation is what
 *    lets it exist without reopening the decision. No message here says "posted", "live" or
 *    "published" on a create.
 * 2. `authorOrganizationName` IS NULLABLE AND THAT IS A FACT, not a missing join. It is
 *    derived from the caller's active organization at write time and never read from a body.
 * 3. `helpfulCount` IS A COUNT, NOT A SCORE. No downvote reaches this service and none may
 *    be added: a negative signal against a named organization is a reputational act, and
 *    this surface has no appeal process behind it.
 * 4. THE VIEWER MEMBER IS `null` FOR AN ANONYMOUS READER, never a defaulted `false`. "You
 *    have not endorsed this" and "we do not know who you are" are different facts (A11/A24).
 */

type ThreadRow = typeof communityForumThread.$inferSelect;
type ReplyRow = typeof communityForumReply.$inferSelect;
type ForumBoard = ThreadRow["board"];
type ThreadState = ThreadRow["state"];
type ReportReason = (typeof communityContentReport.$inferSelect)["reason"];
type ReportTargetKind = (typeof communityContentReport.$inferSelect)["targetKind"];

export type CommunityForumError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "INVALID_CURSOR" }
  | { type: "INVALID_STATE"; message: string }
  | { type: "CONFLICT"; message: string }
  | { type: "TITLE_UNUSABLE" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: string };

/**
 * How much of a body a CARD carries.
 *
 * SERVER-TRUNCATED AND NOT STORED. A stored excerpt would go stale the moment a body was
 * edited, and a card showing text the thread no longer contains is worse than a card
 * showing less of it.
 */
const EXCERPT_MAX_CHARACTERS = 240;

function buildExcerpt(body: string): string {
  const collapsed = body.replaceAll(/\s+/gu, " ").trim();
  if (collapsed.length <= EXCERPT_MAX_CHARACTERS) return collapsed;
  /**
   * Cut on a word boundary when there is one in the last quarter, so the card does not end
   * mid-word. An ellipsis is NOT appended: the client decides how to signal truncation, and
   * a server-supplied "…" would be baked into every renderer including a plain-text one.
   */
  const clipped = collapsed.slice(0, EXCERPT_MAX_CHARACTERS);
  const lastSpace = clipped.lastIndexOf(" ");
  return lastSpace > EXCERPT_MAX_CHARACTERS * 0.75 ? clipped.slice(0, lastSpace) : clipped;
}

/**
 * The states a PUBLIC read may return.
 *
 * `pending_review` is absent by construction rather than by a `WHERE` somebody can forget:
 * every public query filters on this list, and the query schema refuses the value outright
 * so asking for it is a 422 rather than an empty page.
 */
const PUBLIC_THREAD_STATES: readonly ThreadState[] = ["open", "answered", "locked"];

const SLUG_ATTEMPTS = 12;

/** `slugifyProgramTitle`'s shape — the closest already-built precedent for user prose. */
function slugifyThreadTitle(title: string): string {
  return title
    .normalize("NFD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 90)
    .replaceAll(/-+$/gu, "");
}

export interface ForumViewerState {
  readonly hasVotedHelpful: boolean;
}

export interface ForumThreadCardProjection {
  readonly id: string;
  readonly slug: string;
  readonly board: ForumBoard;
  readonly title: string;
  readonly excerpt: string;
  readonly authorDisplayName: string;
  readonly authorOrganizationName: string | null;
  readonly state: ThreadState;
  readonly replyCount: number;
  readonly acceptedReplyId: string | null;
  readonly lastActivityAt: Date;
}

export interface ForumReplyProjection {
  readonly id: string;
  readonly authorDisplayName: string;
  readonly authorOrganizationName: string | null;
  readonly body: string;
  readonly createdAt: Date;
  readonly helpfulCount: number;
  /** `null` for an anonymous reader. Never a defaulted `false`. */
  readonly viewer: ForumViewerState | null;
}

/**
 * The reader's standing in THIS thread.
 *
 * `null` for an anonymous reader, never a defaulted `false` — the same rule `ForumViewerState`
 * follows on a reply, and for the same reason: "nobody is reading this" and "somebody who is not
 * the author is reading this" are different facts, and only one of them should ever be inferred.
 */
export interface ForumThreadViewerState {
  /**
   * Whether the reader authored this thread.
   *
   * IT DECIDES WHETHER THE ACCEPT-ANSWER CONTROL RENDERS AT ALL, and it has to come from the
   * server because it cannot be derived from anything else on this payload: the thread carries an
   * `authorDisplayName`, deliberately not an `authorUserId`, so a client has nothing to compare a
   * session against. Without it the control is either shown to everyone — and 403s for all but one
   * of them — or shown to nobody, which is what it does today.
   *
   * It is NOT authorization. `setAcceptedReply` re-proves authorship under the row; this only
   * decides what to offer.
   */
  readonly isThreadAuthor: boolean;
}

export interface ForumThreadDetailProjection {
  readonly thread: ForumThreadCardProjection;
  readonly body: string;
  readonly createdAt: Date;
  readonly viewer: ForumThreadViewerState | null;
  readonly replies: {
    readonly items: readonly ForumReplyProjection[];
    readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
  };
}

export interface ForumThreadListPage {
  readonly items: readonly ForumThreadCardProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * An author's own thread, on `/community/forum/threads/mine`.
 *
 * THE CARD PLUS THE MODERATION VERDICT, and the verdict is the entire reason this list exists as
 * something other than a filtered public read. `reject` does not delete a thread: it leaves the row
 * `pending_review` and writes a `decisionReason`, invisible in every public read and readable by
 * its author HERE. Projecting the card alone — which is what this route did — meant a rejected
 * author saw their thread sitting in "pending" with no reason and no signal that anyone had looked
 * at it, and the only rational response to that is to post it again.
 *
 * `moderatedAt` NULL MEANS NOBODY HAS DECIDED YET, and it is what separates "waiting" from
 * "decided" — `state` cannot, because a rejection leaves the state exactly where it was.
 */
export interface OwnForumThreadProjection extends ForumThreadCardProjection {
  readonly createdAt: Date;
  readonly moderatedAt: Date | null;
  readonly decisionReason: string | null;
}

export interface OwnForumThreadListPage {
  readonly items: readonly OwnForumThreadProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * A deleted author's rows keep their text and lose their name.
 *
 * "Somebody who has since left" is the honest reading of a `set null` author, and it is a
 * different fact from an individual posting without an organization — which is why this
 * constant is not reused for `authorOrganizationName`.
 */
const REMOVED_AUTHOR_DISPLAY_NAME = "Former member";

interface AuthorNames {
  readonly displayNameByUserId: ReadonlyMap<string, string>;
  readonly organizationNameById: ReadonlyMap<string, string>;
}

async function loadAuthorNames(input: {
  readonly userIds: readonly (string | null)[];
  readonly organizationIds: readonly (string | null)[];
}): Promise<AuthorNames> {
  const userIds = [...new Set(input.userIds.filter((id): id is string => id !== null))];
  const organizationIds = [
    ...new Set(input.organizationIds.filter((id): id is string => id !== null)),
  ];

  const [userRows, organizationRows] = await Promise.all([
    userIds.length === 0
      ? Promise.resolve([])
      : db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds)),
    organizationIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: commerceOrganization.id, displayName: commerceOrganization.displayName })
          .from(commerceOrganization)
          .where(inArray(commerceOrganization.id, organizationIds)),
  ]);

  return {
    displayNameByUserId: new Map(userRows.map((row) => [row.id, row.name])),
    organizationNameById: new Map(organizationRows.map((row) => [row.id, row.displayName])),
  };
}

function projectThreadCard(row: ThreadRow, names: AuthorNames): ForumThreadCardProjection {
  return {
    id: row.id,
    slug: row.slug,
    board: row.board,
    title: row.title,
    excerpt: buildExcerpt(row.body),
    authorDisplayName:
      row.authorUserId === null
        ? REMOVED_AUTHOR_DISPLAY_NAME
        : (names.displayNameByUserId.get(row.authorUserId) ?? REMOVED_AUTHOR_DISPLAY_NAME),
    authorOrganizationName:
      row.authorOrganizationId === null
        ? null
        : (names.organizationNameById.get(row.authorOrganizationId) ?? null),
    state: row.state,
    replyCount: row.replyCount,
    acceptedReplyId: row.acceptedReplyId,
    lastActivityAt: row.lastActivityAt,
  };
}

async function projectThreadCards(
  rows: readonly ThreadRow[],
): Promise<ForumThreadCardProjection[]> {
  if (rows.length === 0) return [];
  const names = await loadAuthorNames({
    userIds: rows.map((row) => row.authorUserId),
    organizationIds: rows.map((row) => row.authorOrganizationId),
  });
  return rows.map((row) => projectThreadCard(row, names));
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export interface ListForumThreadsInput {
  readonly board?: ForumBoard;
  /** Only the three public states parse; `pending_review` is a 422 at the boundary. */
  readonly threadState?: ThreadState;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * `GET /store/forum/threads`.
 *
 * NEWEST ACTIVITY FIRST, keyset on `(lastActivityAt, id)` DESCENDING. That is the one
 * ordering a forum can have that is not a ranking, and it is deliberate: nothing on the
 * community surface may read as a platform recommendation.
 */
export async function listForumThreads(
  input: ListForumThreadsInput,
): Promise<Result<ForumThreadListPage, CommunityForumError>> {
  const decodedCursor =
    input.cursor === undefined ? null : decodeTimestampStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters: SQL[] = [
    input.threadState === undefined
      ? inArray(communityForumThread.state, [...PUBLIC_THREAD_STATES])
      : eq(communityForumThread.state, input.threadState),
  ];
  if (input.board !== undefined) {
    filters.push(eq(communityForumThread.board, input.board));
  }
  if (decodedCursor !== null) {
    const keyset = or(
      lt(communityForumThread.lastActivityAt, decodedCursor.sortKey),
      and(
        eq(communityForumThread.lastActivityAt, decodedCursor.sortKey),
        lt(communityForumThread.id, decodedCursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(communityForumThread)
    .where(and(...filters))
    .orderBy(desc(communityForumThread.lastActivityAt), desc(communityForumThread.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.lastActivityAt.toISOString(), id: lastRow.id })
      : null;

  return {
    success: true,
    value: { items: await projectThreadCards(pageRows), page: { nextCursor, hasMore } },
  };
}

async function projectReplies(input: {
  readonly rows: readonly ReplyRow[];
  readonly viewerUserId: string | null;
}): Promise<ForumReplyProjection[]> {
  if (input.rows.length === 0) return [];

  const names = await loadAuthorNames({
    userIds: input.rows.map((row) => row.authorUserId),
    organizationIds: input.rows.map((row) => row.authorOrganizationId),
  });

  /**
   * The vote lookup is SKIPPED ENTIRELY for an anonymous reader, rather than run and
   * discarded — the shape `projectAnswers` uses. It is also why `viewer` can be `null`
   * without a second branch downstream.
   */
  let votedReplyIds: ReadonlySet<string> = new Set();
  if (input.viewerUserId !== null) {
    const voteRows = await db
      .select({ replyId: communityForumReplyVote.replyId })
      .from(communityForumReplyVote)
      .where(
        and(
          eq(communityForumReplyVote.userId, input.viewerUserId),
          inArray(
            communityForumReplyVote.replyId,
            input.rows.map((row) => row.id),
          ),
        ),
      );
    votedReplyIds = new Set(voteRows.map((row) => row.replyId));
  }

  const viewerUserId = input.viewerUserId;
  return input.rows.map((row) => ({
    id: row.id,
    authorDisplayName:
      row.authorUserId === null
        ? REMOVED_AUTHOR_DISPLAY_NAME
        : (names.displayNameByUserId.get(row.authorUserId) ?? REMOVED_AUTHOR_DISPLAY_NAME),
    authorOrganizationName:
      row.authorOrganizationId === null
        ? null
        : (names.organizationNameById.get(row.authorOrganizationId) ?? null),
    body: row.body,
    createdAt: row.createdAt,
    helpfulCount: row.helpfulCount,
    viewer: viewerUserId === null ? null : { hasVotedHelpful: votedReplyIds.has(row.id) },
  }));
}

/**
 * `GET /store/forum/threads/:threadSlug`.
 *
 * A `pending_review` thread 404s here even for its own author. The author reads it through
 * `/community/forum/threads/mine` instead, which is why that route is not optional: without
 * it the create response is the last thing an author ever sees.
 */
export async function getForumThreadBySlug(input: {
  readonly threadSlug: string;
  readonly viewerUserId: string | null;
  readonly replyLimit: number;
  readonly replyCursor?: string;
}): Promise<Result<ForumThreadDetailProjection, CommunityForumError>> {
  const decodedCursor =
    input.replyCursor === undefined ? null : decodeStoreCursor(input.replyCursor);
  if (input.replyCursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const [thread] = await db
    .select()
    .from(communityForumThread)
    .where(
      and(
        eq(communityForumThread.slug, input.threadSlug),
        inArray(communityForumThread.state, [...PUBLIC_THREAD_STATES]),
      ),
    )
    .limit(1);
  if (!thread) return { success: false, error: { type: "NOT_FOUND" } };

  const replyFilters: SQL[] = [
    eq(communityForumReply.threadId, thread.id),
    /** A hidden reply leaves the public read entirely; it is not shown as a tombstone. */
    eq(communityForumReply.state, "visible"),
  ];
  if (decodedCursor !== null) {
    const cursorInstant = new Date(decodedCursor.sortKey);
    if (Number.isNaN(cursorInstant.getTime())) {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    const keyset = or(
      gt(communityForumReply.createdAt, cursorInstant),
      and(
        eq(communityForumReply.createdAt, cursorInstant),
        gt(communityForumReply.id, decodedCursor.id),
      ),
    );
    if (keyset) replyFilters.push(keyset);
  }

  const replyRows = await db
    .select()
    .from(communityForumReply)
    .where(and(...replyFilters))
    /** OLDEST FIRST — a thread is a conversation and reads in the order it happened. */
    .orderBy(asc(communityForumReply.createdAt), asc(communityForumReply.id))
    .limit(input.replyLimit + 1);

  const pageRows = replyRows.slice(0, input.replyLimit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = replyRows.length > input.replyLimit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  const [cards, replies] = await Promise.all([
    projectThreadCards([thread]),
    projectReplies({ rows: pageRows, viewerUserId: input.viewerUserId }),
  ]);
  const card = cards[0];
  if (!card) throw new Error("Forum thread card vanished after its own row was read.");

  return {
    success: true,
    value: {
      thread: card,
      body: thread.body,
      createdAt: thread.createdAt,
      // Compared against the ROW's `authorUserId`, which never leaves the server. A removed author
      // leaves `thread.authorUserId` null, and `null === null` must not read as authorship — hence
      // the explicit guard rather than a bare equality.
      viewer:
        input.viewerUserId === null
          ? null
          : {
              isThreadAuthor:
                thread.authorUserId !== null && thread.authorUserId === input.viewerUserId,
            },
      replies: { items: replies, page: { nextCursor, hasMore } },
    },
  };
}

// ---------------------------------------------------------------------------
// Authenticated writes
// ---------------------------------------------------------------------------

/**
 * Resolves the caller's active organization, if they have one.
 *
 * DESCRIPTIVE, NOT REQUIRED. A forum has no members, only authors — requiring an
 * organization to post would exclude exactly the individuals the nullable
 * `authorOrganizationId` exists to distinguish. Membership is re-checked here rather than
 * trusted from the session's `activeOrganizationId`, which is a server-issued SELECTION and
 * not a proof.
 */
async function resolveAuthorOrganizationId(input: {
  readonly userId: string;
  readonly activeOrganizationId: string | null;
}): Promise<string | null> {
  if (input.activeOrganizationId === null) return null;
  const [membership] = await db
    .select({ organizationId: commerceOrganizationMember.organizationId })
    .from(commerceOrganizationMember)
    .where(
      and(
        eq(commerceOrganizationMember.organizationId, input.activeOrganizationId),
        eq(commerceOrganizationMember.userId, input.userId),
        eq(commerceOrganizationMember.state, "active"),
      ),
    )
    .limit(1);
  return membership?.organizationId ?? null;
}

export interface CreateForumThreadInput {
  readonly authorUserId: string;
  readonly activeOrganizationId: string | null;
  readonly board: ForumBoard;
  readonly title: string;
  readonly body: string;
}

/**
 * Creates a thread. ANSWERS `pending_review`, ALWAYS.
 *
 * The slug is minted by INSERT-AND-CATCH rather than check-then-insert, the shape
 * `createResearchProgram` uses: two people asking the same question at the same moment must
 * not both win the check and then collide on the insert.
 */
export async function createForumThread(
  input: CreateForumThreadInput,
): Promise<Result<ForumThreadCardProjection, CommunityForumError>> {
  const baseSlug = slugifyThreadTitle(input.title);
  if (baseSlug.length < 3) return { success: false, error: { type: "TITLE_UNUSABLE" } };

  const authorOrganizationId = await resolveAuthorOrganizationId({
    userId: input.authorUserId,
    activeOrganizationId: input.activeOrganizationId,
  });

  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = attempt === 1 ? baseSlug : `${baseSlug}-${String(attempt)}`;
    try {
      const [row] = await db
        .insert(communityForumThread)
        .values({
          slug: candidateSlug,
          board: input.board,
          title: input.title,
          body: input.body,
          authorUserId: input.authorUserId,
          authorOrganizationId,
          state: "pending_review",
        })
        .returning();
      if (!row) throw new Error("Forum thread insert returned no row.");
      const cards = await projectThreadCards([row]);
      const card = cards[0];
      if (!card) throw new Error("Forum thread projection returned no row.");
      return { success: true, value: card };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  return {
    success: false,
    error: { type: "CONFLICT", message: "Could not mint a unique slug for this title." },
  };
}

/**
 * `GET /community/forum/threads/mine`. `pending_review` INCLUDED — that is the whole point.
 *
 * Without this an author who posts a thread has no way to learn what happened to it: the
 * create response is the last thing they ever see, and `pending_review` appears in no
 * public read by design.
 */
export async function listMyForumThreads(input: {
  readonly authorUserId: string;
  readonly board?: ThreadRow["board"];
  readonly threadState?: ThreadRow["state"];
  readonly limit: number;
  readonly cursor?: string;
}): Promise<Result<OwnForumThreadListPage, CommunityForumError>> {
  const decodedCursor =
    input.cursor === undefined ? null : decodeTimestampStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters: SQL[] = [eq(communityForumThread.authorUserId, input.authorUserId)];
  // Both narrow within the author scope above, never around it. `pending_review` is filterable
  // here and nowhere else — it is the state an author comes to this list to find.
  if (input.board !== undefined) filters.push(eq(communityForumThread.board, input.board));
  if (input.threadState !== undefined) {
    filters.push(eq(communityForumThread.state, input.threadState));
  }
  if (decodedCursor !== null) {
    const keyset = or(
      lt(communityForumThread.createdAt, decodedCursor.sortKey),
      and(
        eq(communityForumThread.createdAt, decodedCursor.sortKey),
        lt(communityForumThread.id, decodedCursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(communityForumThread)
    .where(and(...filters))
    .orderBy(desc(communityForumThread.createdAt), desc(communityForumThread.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  const cards = await projectThreadCards(pageRows);
  const rowById = new Map(pageRows.map((row) => [row.id, row]));

  return {
    success: true,
    value: {
      // The card carries `lastActivityAt`; the three added here are the author-only facts.
      items: cards.flatMap((card) => {
        const row = rowById.get(card.id);
        return row === undefined
          ? []
          : [
              {
                ...card,
                createdAt: row.createdAt,
                moderatedAt: row.moderatedAt,
                decisionReason: row.decisionReason,
              },
            ];
      }),
      page: { nextCursor, hasMore },
    },
  };
}

/**
 * Appends a reply.
 *
 * REQUIRES THE THREAD IN `open` OR `answered`. A `locked` thread refuses with a tagged
 * error rather than a silent no-op, and a `pending_review` thread is not visible to reply
 * to in the first place.
 *
 * `replyCount` and `lastActivityAt` move IN THE SAME TRANSACTION as the insert. A counter
 * updated afterwards is a counter that drifts on every failed commit.
 */
export async function createForumReply(input: {
  readonly threadId: string;
  readonly authorUserId: string;
  readonly activeOrganizationId: string | null;
  readonly body: string;
}): Promise<Result<ForumReplyProjection, CommunityForumError>> {
  const authorOrganizationId = await resolveAuthorOrganizationId({
    userId: input.authorUserId,
    activeOrganizationId: input.activeOrganizationId,
  });

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [thread] = await transaction
      .select()
      .from(communityForumThread)
      .where(eq(communityForumThread.id, input.threadId))
      .for("update");

    if (!thread || thread.state === "pending_review") return { status: "not_found" as const };
    if (thread.state === "locked") return { status: "locked" as const };

    const [row] = await transaction
      .insert(communityForumReply)
      .values({
        threadId: thread.id,
        authorUserId: input.authorUserId,
        authorOrganizationId,
        body: input.body,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning();
    if (!row) throw new Error("Forum reply insert returned no row.");

    await transaction
      .update(communityForumThread)
      .set({
        replyCount: sql`${communityForumThread.replyCount} + 1`,
        lastActivityAt: occurredAt,
        updatedAt: occurredAt,
      })
      .where(eq(communityForumThread.id, thread.id));

    return { status: "created" as const, row };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "locked") {
    return {
      success: false,
      error: { type: "INVALID_STATE", message: "This thread is locked and takes no new replies." },
    };
  }

  const projected = await projectReplies({
    rows: [outcome.row],
    viewerUserId: input.authorUserId,
  });
  const projection = projected[0];
  if (!projection) throw new Error("Forum reply projection returned no row.");
  return { success: true, value: projection };
}

/**
 * The thread author marks or unmarks the answer.
 *
 * ALLOWED ON A LOCKED THREAD, deliberately: locking stops new text, not bookkeeping. Only
 * the author may do it — a moderator who disagrees has `lock`, not this.
 */
export async function setAcceptedReply(input: {
  readonly threadId: string;
  readonly authorUserId: string;
  readonly replyId: string | null;
}): Promise<Result<ForumThreadCardProjection, CommunityForumError>> {
  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [thread] = await transaction
      .select()
      .from(communityForumThread)
      .where(eq(communityForumThread.id, input.threadId))
      .for("update");

    if (!thread || thread.authorUserId !== input.authorUserId) {
      return { status: "not_found" as const };
    }
    if (thread.state === "pending_review") {
      return { status: "not_reviewed" as const };
    }

    if (input.replyId !== null) {
      const [reply] = await transaction
        .select({ id: communityForumReply.id, state: communityForumReply.state })
        .from(communityForumReply)
        .where(
          and(
            eq(communityForumReply.id, input.replyId),
            eq(communityForumReply.threadId, thread.id),
          ),
        )
        .limit(1);
      /** A hidden reply cannot be the accepted answer: nobody can read it. */
      if (!reply || reply.state !== "visible") return { status: "reply_not_found" as const };
    }

    /**
     * The state follows the pointer, and `locked` outranks both. A locked thread that gains
     * an accepted answer stays locked — the CHECK permits either there precisely so this
     * transition does not have to unlock anything to record a fact.
     */
    const nextState: ThreadState =
      thread.state === "locked" ? "locked" : input.replyId === null ? "open" : "answered";

    const [row] = await transaction
      .update(communityForumThread)
      .set({ acceptedReplyId: input.replyId, state: nextState, updatedAt: occurredAt })
      .where(eq(communityForumThread.id, thread.id))
      .returning();
    if (!row) throw new Error("Accepted-reply update returned no row.");
    return { status: "updated" as const, row };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "not_reviewed") {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: "A thread awaiting review has no replies to accept.",
      },
    };
  }
  if (outcome.status === "reply_not_found") {
    return {
      success: false,
      error: { type: "NOT_FOUND" },
    };
  }

  const cards = await projectThreadCards([outcome.row]);
  const card = cards[0];
  if (!card) throw new Error("Forum thread projection returned no row.");
  return { success: true, value: card };
}

export interface ReplyVoteResult {
  readonly replyId: string;
  readonly isHelpful: boolean;
  readonly helpfulCount: number;
}

/**
 * `PUT` and `DELETE` of the helpful endorsement.
 *
 * IDEMPOTENT BY VERB, which is why neither route carries an `Idempotency-Key`: the primary
 * key makes a second `PUT` a no-op and a second `DELETE` a no-op, and the count is
 * recomputed from the row's own delta inside the same transaction rather than incremented
 * blindly.
 *
 * THERE IS NO DOWNVOTE AND THERE NEVER WILL BE.
 */
export async function setReplyHelpfulVote(input: {
  readonly replyId: string;
  readonly userId: string;
  readonly isHelpful: boolean;
}): Promise<Result<ReplyVoteResult, CommunityForumError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [reply] = await transaction
      .select({ id: communityForumReply.id, state: communityForumReply.state })
      .from(communityForumReply)
      .where(eq(communityForumReply.id, input.replyId))
      .for("update");
    if (!reply || reply.state !== "visible") return { status: "not_found" as const };

    const changed = input.isHelpful
      ? (
          await transaction
            .insert(communityForumReplyVote)
            .values({ replyId: reply.id, userId: input.userId })
            .onConflictDoNothing()
            .returning({ replyId: communityForumReplyVote.replyId })
        ).length
      : (
          await transaction
            .delete(communityForumReplyVote)
            .where(
              and(
                eq(communityForumReplyVote.replyId, reply.id),
                eq(communityForumReplyVote.userId, input.userId),
              ),
            )
            .returning({ replyId: communityForumReplyVote.replyId })
        ).length;

    if (changed === 0) {
      const [current] = await transaction
        .select({ helpfulCount: communityForumReply.helpfulCount })
        .from(communityForumReply)
        .where(eq(communityForumReply.id, reply.id));
      return { status: "unchanged" as const, helpfulCount: current?.helpfulCount ?? 0 };
    }

    const [updated] = await transaction
      .update(communityForumReply)
      .set({
        helpfulCount: input.isHelpful
          ? sql`${communityForumReply.helpfulCount} + 1`
          : sql`greatest(${communityForumReply.helpfulCount} - 1, 0)`,
      })
      .where(eq(communityForumReply.id, reply.id))
      .returning({ helpfulCount: communityForumReply.helpfulCount });

    return { status: "changed" as const, helpfulCount: updated?.helpfulCount ?? 0 };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  return {
    success: true,
    value: {
      replyId: input.replyId,
      isHelpful: input.isHelpful,
      helpfulCount: outcome.helpfulCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting (§17.4)
// ---------------------------------------------------------------------------

export interface CreateCommunityReportInput {
  readonly targetKind: ReportTargetKind;
  readonly targetId: string;
  readonly reason: ReportReason;
  readonly detailText: string | null;
  readonly reporterUserId: string;
}

export async function createCommunityContentReport(
  input: CreateCommunityReportInput,
): Promise<Result<{ reportId: string }, CommunityForumError>> {
  const targetExists =
    input.targetKind === "forum_thread"
      ? (
          await db
            .select({ id: communityForumThread.id })
            .from(communityForumThread)
            .where(eq(communityForumThread.id, input.targetId))
            .limit(1)
        ).length === 1
      : (
          await db
            .select({ id: communityForumReply.id })
            .from(communityForumReply)
            .where(eq(communityForumReply.id, input.targetId))
            .limit(1)
        ).length === 1;
  if (!targetExists) return { success: false, error: { type: "NOT_FOUND" } };

  try {
    const [row] = await db
      .insert(communityContentReport)
      .values({
        targetKind: input.targetKind,
        threadId: input.targetKind === "forum_thread" ? input.targetId : null,
        replyId: input.targetKind === "forum_reply" ? input.targetId : null,
        reason: input.reason,
        detailText: input.detailText,
        reporterUserId: input.reporterUserId,
      })
      .returning({ id: communityContentReport.id });
    if (!row) throw new Error("Community content report insert returned no row.");
    return { success: true, value: { reportId: row.id } };
  } catch (error) {
    /**
     * The partial unique index is the authority on "you already reported this", and a
     * second report is not an error the reporter needs to act on — but it must not read as
     * a fresh report either, so it is a tagged conflict rather than a silent success.
     */
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "CONFLICT", message: "You have already reported this." },
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Moderation (§17.4) — gated on the existing `moderate_content` capability
// ---------------------------------------------------------------------------

/**
 * `moderate_content`, NOT a new community capability.
 *
 * §17.4 is explicit: there is no community equivalent of an organization role here, because
 * a forum has no members, only authors. Minting a capability for one surface is how a
 * permission model stops being readable.
 */
async function requireCommunityModerator(
  userId: string,
): Promise<Result<PlatformStaffContext, CommunityForumError>> {
  const capability = await requirePlatformCapability(userId, "moderate_content");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
    };
  }
  return { success: true, value: capability.value };
}

/**
 * A thread as the MODERATION QUEUE shows it: the card plus the full body.
 *
 * THE BODY IS HERE BECAUSE THERE IS NOWHERE ELSE TO READ IT. A queued thread is
 * `pending_review`, and every public read filters that state out — so `GET /store/forum/threads/:slug`
 * answers 404 for exactly the threads a moderator is being asked to judge. The queue was projecting
 * the card alone, whose `excerpt` is server-truncated to 240 characters, which meant the decision to
 * publish or reject was being made on the first paragraph.
 *
 * `createdAt` comes with it because the queue is worked oldest-first and "how long has this been
 * waiting" is the other thing the row has to answer.
 */
export interface AdminForumThreadProjection extends ForumThreadCardProjection {
  readonly body: string;
  readonly createdAt: Date;
}

export interface ModerationQueuePage {
  readonly items: readonly AdminForumThreadProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * The queue: OLDEST FIRST, because a queue is worked in order.
 *
 * `moderatedAt IS NULL` IS PART OF THE PREDICATE, not decoration. A rejected thread stays
 * `pending_review` — that is what keeps it out of every public read and readable on `/mine`
 * with its reason attached — so filtering on the state alone would put every rejection back
 * in the queue on the next tick, forever. The enum deliberately has no `rejected` member:
 * a fourth state would have to be excluded from the public reads by a second `WHERE` that
 * somebody can forget, and `pending_review` already means exactly "not public".
 */
export async function listForumModerationQueue(input: {
  readonly moderatorUserId: string;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<Result<ModerationQueuePage, CommunityForumError>> {
  const staff = await requireCommunityModerator(input.moderatorUserId);
  if (!staff.success) return staff;

  const decodedCursor =
    input.cursor === undefined ? null : decodeTimestampStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters: SQL[] = [
    eq(communityForumThread.state, "pending_review"),
    sql`${communityForumThread.moderatedAt} IS NULL`,
  ];
  if (decodedCursor !== null) {
    const keyset = or(
      gt(communityForumThread.createdAt, decodedCursor.sortKey),
      and(
        eq(communityForumThread.createdAt, decodedCursor.sortKey),
        gt(communityForumThread.id, decodedCursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(communityForumThread)
    .where(and(...filters))
    .orderBy(asc(communityForumThread.createdAt), asc(communityForumThread.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  const cards = await projectThreadCards(pageRows);
  const rowById = new Map(pageRows.map((row) => [row.id, row]));

  return {
    success: true,
    value: {
      items: cards.flatMap((card) => {
        const row = rowById.get(card.id);
        return row === undefined ? [] : [{ ...card, body: row.body, createdAt: row.createdAt }];
      }),
      page: { nextCursor, hasMore },
    },
  };
}

export type ForumThreadDecision = "publish" | "reject" | "lock" | "unlock";

const DECISION_AUDIT_EVENT = {
  publish: "community_forum_thread_published",
  reject: "community_forum_thread_rejected",
  lock: "community_forum_thread_locked",
  unlock: "community_forum_thread_unlocked",
} as const;

const DECISION_ACTION_KIND = {
  publish: "thread_published",
  reject: "thread_rejected",
  lock: "thread_locked",
  unlock: "thread_unlocked",
} as const;

/**
 * Publishes, rejects, locks or unlocks a thread.
 *
 * A REJECTED THREAD IS NOT DELETED. It stays `pending_review` with its reason recorded, so
 * the author can read the verdict on `/mine` — a rejection nobody can see is
 * indistinguishable from a queue that never moved.
 *
 * The platform audit entry is appended IN THE SAME TRANSACTION and its id stored on the
 * action row, so no decision can exist without an accountable human attached.
 */
export async function moderateForumThread(input: {
  readonly moderatorUserId: string;
  readonly threadId: string;
  readonly decision: ForumThreadDecision;
  readonly reasonNote: string;
  // ANSWERS THE SAME SHAPE THE QUEUE DOES. A decision replaces the row the console is looking at,
  // so returning a narrower projection than the list it came from would make the row lose its body
  // the moment it was acted on.
}): Promise<Result<AdminForumThreadProjection, CommunityForumError>> {
  const staff = await requireCommunityModerator(input.moderatorUserId);
  if (!staff.success) return staff;
  const moderator = staff.value;

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [thread] = await transaction
      .select()
      .from(communityForumThread)
      .where(eq(communityForumThread.id, input.threadId))
      .for("update");
    if (!thread) return { status: "not_found" as const };

    const currentState = thread.state;
    if (input.decision === "publish" && currentState !== "pending_review") {
      return { status: "invalid_state" as const, message: "This thread is already published." };
    }
    if (input.decision === "reject" && currentState !== "pending_review") {
      return {
        status: "invalid_state" as const,
        message: "A published thread is locked, not rejected.",
      };
    }
    /**
     * A thread already decided cannot be decided again through the queue. Republishing one
     * is `publish` by id, which the branch above still allows because a rejected thread is
     * still `pending_review` — the one path by which a moderator can reverse a colleague.
     */
    if (input.decision === "reject" && thread.moderatedAt !== null) {
      return { status: "invalid_state" as const, message: "This thread was already rejected." };
    }
    if (input.decision === "lock" && currentState === "pending_review") {
      return {
        status: "invalid_state" as const,
        message: "A thread awaiting review is not public and cannot be locked.",
      };
    }
    if (input.decision === "lock" && currentState === "locked") {
      return { status: "invalid_state" as const, message: "This thread is already locked." };
    }
    if (input.decision === "unlock" && currentState !== "locked") {
      return { status: "invalid_state" as const, message: "This thread is not locked." };
    }

    const nextState: ThreadState =
      input.decision === "publish"
        ? thread.acceptedReplyId === null
          ? "open"
          : "answered"
        : input.decision === "reject"
          ? "pending_review"
          : input.decision === "lock"
            ? "locked"
            : thread.acceptedReplyId === null
              ? "open"
              : "answered";

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: DECISION_AUDIT_EVENT[input.decision],
      actorUserId: input.moderatorUserId,
      actorRoleSnapshot: moderator.platformRole,
      actionLabel: DECISION_AUDIT_EVENT[input.decision],
      targetLabel: `community_forum_thread:${thread.id}`,
      detailNote: input.reasonNote,
      payload: { threadId: thread.id, board: thread.board },
      occurredAt,
    });

    const [row] = await transaction
      .update(communityForumThread)
      .set({
        state: nextState,
        /**
         * Set on the first publish and NEVER CLEARED afterwards. A locked thread is still
         * published; only `pending_review` has never been seen by anybody.
         */
        publishedAt:
          input.decision === "publish" ? (thread.publishedAt ?? occurredAt) : thread.publishedAt,
        moderatedByUserId: input.moderatorUserId,
        moderatedAt: occurredAt,
        decisionReason: input.reasonNote,
        updatedAt: occurredAt,
      })
      .where(eq(communityForumThread.id, thread.id))
      .returning();
    if (!row) throw new Error("Forum thread moderation returned no row.");

    await transaction.insert(communityModerationAction).values({
      actionKind: DECISION_ACTION_KIND[input.decision],
      threadId: thread.id,
      moderatorUserId: input.moderatorUserId,
      moderatorRoleSnapshot: moderator.platformRole,
      reasonNote: input.reasonNote,
      auditEntryId: auditEntry.id,
      createdAt: occurredAt,
    });

    /** Publishing or rejecting a thread also closes every open report against it. */
    await transaction
      .update(communityContentReport)
      .set({
        status: "actioned",
        resolvedByUserId: input.moderatorUserId,
        resolvedAt: occurredAt,
        resolutionNote: input.reasonNote,
      })
      .where(
        and(
          eq(communityContentReport.threadId, thread.id),
          eq(communityContentReport.status, "open"),
        ),
      );

    return { status: "moderated" as const, row };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "invalid_state") {
    return { success: false, error: { type: "INVALID_STATE", message: outcome.message } };
  }

  const cards = await projectThreadCards([outcome.row]);
  const card = cards[0];
  if (!card) throw new Error("Forum thread projection returned no row.");
  return {
    success: true,
    value: { ...card, body: outcome.row.body, createdAt: outcome.row.createdAt },
  };
}

/** Hides or restores one reply. Same audit discipline as the thread decision above. */
export async function moderateForumReply(input: {
  readonly moderatorUserId: string;
  readonly replyId: string;
  readonly decision: "hidden" | "restored";
  readonly reasonNote: string;
}): Promise<Result<{ replyId: string; state: ReplyRow["state"] }, CommunityForumError>> {
  const staff = await requireCommunityModerator(input.moderatorUserId);
  if (!staff.success) return staff;
  const moderator = staff.value;

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [reply] = await transaction
      .select()
      .from(communityForumReply)
      .where(eq(communityForumReply.id, input.replyId))
      .for("update");
    if (!reply) return { status: "not_found" as const };

    const nextState: ReplyRow["state"] = input.decision === "hidden" ? "hidden" : "visible";
    if (reply.state === nextState) {
      return { status: "invalid_state" as const, message: `This reply is already ${nextState}.` };
    }

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind:
        input.decision === "hidden"
          ? "community_forum_reply_hidden"
          : "community_forum_reply_restored",
      actorUserId: input.moderatorUserId,
      actorRoleSnapshot: moderator.platformRole,
      actionLabel:
        input.decision === "hidden"
          ? "community_forum_reply_hidden"
          : "community_forum_reply_restored",
      targetLabel: `community_forum_reply:${reply.id}`,
      detailNote: input.reasonNote,
      payload: { replyId: reply.id, threadId: reply.threadId },
      occurredAt,
    });

    await transaction
      .update(communityForumReply)
      .set({
        state: nextState,
        hiddenByUserId: input.decision === "hidden" ? input.moderatorUserId : null,
        hiddenAt: input.decision === "hidden" ? occurredAt : null,
        hiddenReason: input.decision === "hidden" ? input.reasonNote : null,
        updatedAt: occurredAt,
      })
      .where(eq(communityForumReply.id, reply.id));

    /**
     * A hidden reply cannot remain a thread's accepted answer: nobody can read it, so the
     * thread would advertise an answer that is not there.
     */
    if (input.decision === "hidden") {
      await transaction
        .update(communityForumThread)
        .set({ acceptedReplyId: null, state: "open", updatedAt: occurredAt })
        .where(
          and(
            eq(communityForumThread.id, reply.threadId),
            eq(communityForumThread.acceptedReplyId, reply.id),
            eq(communityForumThread.state, "answered"),
          ),
        );
    }

    await transaction.insert(communityModerationAction).values({
      actionKind: input.decision === "hidden" ? "reply_hidden" : "reply_restored",
      threadId: reply.threadId,
      replyId: reply.id,
      moderatorUserId: input.moderatorUserId,
      moderatorRoleSnapshot: moderator.platformRole,
      reasonNote: input.reasonNote,
      auditEntryId: auditEntry.id,
      createdAt: occurredAt,
    });

    await transaction
      .update(communityContentReport)
      .set({
        status: "actioned",
        resolvedByUserId: input.moderatorUserId,
        resolvedAt: occurredAt,
        resolutionNote: input.reasonNote,
      })
      .where(
        and(
          eq(communityContentReport.replyId, reply.id),
          eq(communityContentReport.status, "open"),
        ),
      );

    return { status: "moderated" as const, state: nextState };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "invalid_state") {
    return { success: false, error: { type: "INVALID_STATE", message: outcome.message } };
  }
  return { success: true, value: { replyId: input.replyId, state: outcome.state } };
}

export interface CommunityContentReportProjection {
  readonly id: string;
  readonly targetKind: ReportTargetKind;
  readonly targetId: string;
  readonly reason: ReportReason;
  readonly detailText: string | null;
  readonly status: (typeof communityContentReport.$inferSelect)["status"];
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export async function listCommunityContentReports(input: {
  readonly moderatorUserId: string;
  readonly status?: CommunityContentReportProjection["status"];
  readonly limit: number;
  readonly cursor?: string;
}): Promise<
  Result<
    {
      items: readonly CommunityContentReportProjection[];
      page: { nextCursor: string | null; hasMore: boolean };
    },
    CommunityForumError
  >
> {
  const staff = await requireCommunityModerator(input.moderatorUserId);
  if (!staff.success) return staff;

  const decodedCursor =
    input.cursor === undefined ? null : decodeTimestampStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters: SQL[] = [];
  if (input.status !== undefined) {
    filters.push(eq(communityContentReport.status, input.status));
  }
  if (decodedCursor !== null) {
    const keyset = or(
      gt(communityContentReport.createdAt, decodedCursor.sortKey),
      and(
        eq(communityContentReport.createdAt, decodedCursor.sortKey),
        gt(communityContentReport.id, decodedCursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(communityContentReport)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(asc(communityContentReport.createdAt), asc(communityContentReport.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        id: row.id,
        targetKind: row.targetKind,
        /** Two nullable FK columns collapse to one wire id, as A12's projection does. */
        targetId: row.threadId ?? row.replyId ?? "",
        reason: row.reason,
        detailText: row.detailText,
        status: row.status,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
      })),
      page: { nextCursor, hasMore },
    },
  };
}

/** Dismisses a report without touching its target. */
export async function dismissCommunityContentReport(input: {
  readonly moderatorUserId: string;
  readonly reportId: string;
  readonly reasonNote: string;
}): Promise<Result<{ reportId: string }, CommunityForumError>> {
  const staff = await requireCommunityModerator(input.moderatorUserId);
  if (!staff.success) return staff;
  const moderator = staff.value;

  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [report] = await transaction
      .select()
      .from(communityContentReport)
      .where(eq(communityContentReport.id, input.reportId))
      .for("update");
    if (!report) return { status: "not_found" as const };
    if (report.status !== "open") {
      return { status: "invalid_state" as const, message: "This report is already resolved." };
    }

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: "community_content_report_dismissed",
      actorUserId: input.moderatorUserId,
      actorRoleSnapshot: moderator.platformRole,
      actionLabel: "community_content_report_dismissed",
      targetLabel: `community_content_report:${report.id}`,
      detailNote: input.reasonNote,
      payload: { reportId: report.id, targetKind: report.targetKind },
      occurredAt,
    });

    await transaction
      .update(communityContentReport)
      .set({
        status: "dismissed",
        resolvedByUserId: input.moderatorUserId,
        resolvedAt: occurredAt,
        resolutionNote: input.reasonNote,
      })
      .where(eq(communityContentReport.id, report.id));

    await transaction.insert(communityModerationAction).values({
      actionKind: "report_dismissed",
      threadId: report.threadId,
      replyId: report.replyId,
      reportId: report.id,
      moderatorUserId: input.moderatorUserId,
      moderatorRoleSnapshot: moderator.platformRole,
      reasonNote: input.reasonNote,
      auditEntryId: auditEntry.id,
      createdAt: occurredAt,
    });

    return { status: "dismissed" as const };
  });

  if (outcome.status === "not_found") return { success: false, error: { type: "NOT_FOUND" } };
  if (outcome.status === "invalid_state") {
    return { success: false, error: { type: "INVALID_STATE", message: outcome.message } };
  }
  return { success: true, value: { reportId: input.reportId } };
}
