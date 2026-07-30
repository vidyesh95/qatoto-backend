import { and, asc, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  researchProgramContentReport,
  researchProgramPost,
  researchProgramPostReaction,
  user,
} from "#src/db/schema.js";
import { encodeInstantCursor, type InstantCursor } from "#src/lib/instant-cursor.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  PROGRAM_AUTHOR_COLUMNS,
  toProgramAuthorView,
  type ProgramAccessError,
  type ProgramAuthorView,
} from "#src/services/research-program-access.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The §10 discussion surface — informal papers, netizen ideas, replies and reactions
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * ONE TABLE SERVES ALL FOUR, distinguished by `track` and by whether `parentPostId` is set.
 * §10 specifies this, and the reason is that they are the same thing — prose by a person,
 * reactable and reportable — so three tables would mean three of every read, every
 * moderation path and every reaction join.
 *
 * REACTIONS ARE IDEMPOTENT BY VERB. `PUT` adds, `DELETE` removes, and the unique index
 * `(post_id, user_id)` makes repeating either harmless. That is why they are not `POST`: a
 * double-tap on a slow connection must not be a second like, and §10 says so in as many
 * words.
 *
 * THE DENORMALIZED COUNTERS ARE MAINTAINED TRANSACTIONALLY, never recomputed on read.
 * `reactionCount` and `replyCount` move inside the same transaction as the child row they
 * count, because a feed of 20 posts otherwise costs 40 `COUNT(*)` queries. The trade is
 * accepted deliberately and the transaction is what keeps it honest.
 *
 * HIDING IS NOT DELETING. A moderated post keeps its row and flips `isHidden`, so a report
 * stays explicable and a wrong call is reversible — `post_restored` is a real audit event,
 * which it could not be if the row were gone.
 */

export type ResearchProgramPostTrack = (typeof researchProgramPost.$inferSelect)["track"];

export type ResearchProgramPostError =
  | ProgramAccessError
  | { type: "POST_NOT_FOUND"; postId: string }
  | { type: "REPLY_DEPTH_EXCEEDED"; maxDepth: number }
  | { type: "POST_HIDDEN"; postId: string }
  | { type: "ALREADY_REPORTED" }
  | { type: "NOT_THE_AUTHOR" }
  | { type: "REPORT_NOT_FOUND"; reportId: string }
  | { type: "REPORT_ALREADY_RESOLVED" };

/**
 * One reply level, and no more. §10 says "depth-capped"; this is the cap.
 *
 * The mock this replaces had exactly two levels — an idea and its replies — and unbounded
 * threading is how a public discussion becomes both unrenderable and unmoderatable. A
 * reply to a reply is expressed by quoting, not by nesting.
 */
export const MAX_REPLY_DEPTH = 1;

/** How many replies travel INLINE with a top-level post before the client must page. */
export const INLINE_REPLY_LIMIT = 3;

export interface ResearchProgramPostView {
  readonly postId: string;
  readonly parentPostId: string | null;
  readonly track: ResearchProgramPostTrack;
  readonly depth: number;
  /** Which branch this thread is about, or null for a program-wide one. */
  readonly branchId: string | null;
  readonly title: string | null;
  readonly bodyText: string;
  readonly author: ProgramAuthorView;
  /** Integers on the wire — "1,203" is a client locale decision (§10). */
  readonly reactionCount: number;
  readonly replyCount: number;
  /** Whether THIS caller has reacted. A property of the viewer, never a column. */
  readonly isReactedByViewer: boolean;
  readonly isAuthoredByViewer: boolean;
  readonly isHidden: boolean;
  /** ISO instants, never "4 hours ago" — `Intl.RelativeTimeFormat` is the client's job. */
  readonly createdAt: Date;
  /** Present only on top-level rows, and only for the `idea` track. */
  readonly replies: readonly ResearchProgramPostView[];
}

const POST_SELECT_COLUMNS = {
  postId: researchProgramPost.id,
  parentPostId: researchProgramPost.parentPostId,
  track: researchProgramPost.track,
  depth: researchProgramPost.depth,
  branchId: researchProgramPost.branchId,
  title: researchProgramPost.title,
  bodyText: researchProgramPost.bodyText,
  authorUserIdRaw: researchProgramPost.authorUserId,
  reactionCount: researchProgramPost.reactionCount,
  replyCount: researchProgramPost.replyCount,
  isHidden: researchProgramPost.isHidden,
  createdAt: researchProgramPost.createdAt,
  ...PROGRAM_AUTHOR_COLUMNS,
} as const;

interface RawPostRow {
  readonly postId: string;
  readonly parentPostId: string | null;
  readonly track: ResearchProgramPostTrack;
  readonly depth: number;
  readonly branchId: string | null;
  readonly title: string | null;
  readonly bodyText: string;
  readonly authorUserIdRaw: string | null;
  readonly reactionCount: number;
  readonly replyCount: number;
  readonly isHidden: boolean;
  readonly createdAt: Date;
  readonly authorUserId: string | null;
  readonly authorName: string | null;
  readonly authorHandle: string | null;
  readonly authorAvatarImageUrl: string | null;
  readonly authorLocationLabel: string | null;
}

/**
 * Body text for a hidden post is replaced, not returned.
 *
 * Returning it and asking the client to respect `isHidden` would mean the moderated text is
 * one DevTools panel away — and this is a thin, untrusted client by policy. The row stays
 * so the decision is reversible and auditable; the words do not travel.
 */
const HIDDEN_BODY_PLACEHOLDER = "This post was hidden by a moderator.";

function toPostView(
  row: RawPostRow,
  viewerUserId: string | null,
  viewerReactedPostIds: ReadonlySet<string>,
  replies: readonly ResearchProgramPostView[] = [],
): ResearchProgramPostView {
  return {
    postId: row.postId,
    parentPostId: row.parentPostId,
    track: row.track,
    depth: row.depth,
    branchId: row.branchId,
    title: row.isHidden ? null : row.title,
    bodyText: row.isHidden ? HIDDEN_BODY_PLACEHOLDER : row.bodyText,
    author: toProgramAuthorView(row),
    reactionCount: row.reactionCount,
    replyCount: row.replyCount,
    isReactedByViewer: viewerReactedPostIds.has(row.postId),
    isAuthoredByViewer:
      viewerUserId !== null && row.authorUserIdRaw !== null
        ? row.authorUserIdRaw === viewerUserId
        : false,
    isHidden: row.isHidden,
    createdAt: row.createdAt,
    replies,
  };
}

export interface ListPostsFilter {
  readonly track: ResearchProgramPostTrack;
  readonly limit: number;
  readonly cursor?: InstantCursor | undefined;
}

/**
 * A track's feed: top-level posts, newest first, with up to three inline replies each.
 *
 * THREE QUERIES TOTAL regardless of page size — the page, its replies, and the viewer's
 * reactions across both. The alternative (a reply query per post, a reaction query per row)
 * is the N+1 that makes a discussion page slow at exactly the moment it becomes popular.
 */
export async function listProgramPosts(input: {
  readonly programId: string;
  readonly viewerUserId: string | null;
  readonly filter: ListPostsFilter;
}): Promise<{
  readonly rows: readonly ResearchProgramPostView[];
  readonly nextCursor: string | null;
}> {
  const conditions = [
    eq(researchProgramPost.programId, input.programId),
    eq(researchProgramPost.track, input.filter.track),
    // Top-level only. `depth = 0` and `parentPostId IS NULL` are the same fact by CHECK;
    // filtering on depth uses the feed index.
    eq(researchProgramPost.depth, 0),
  ];

  if (input.filter.cursor !== undefined) {
    const { instant, id } = input.filter.cursor;
    conditions.push(
      or(
        lt(researchProgramPost.createdAt, instant),
        and(eq(researchProgramPost.createdAt, instant), lt(researchProgramPost.id, id)),
      )!,
    );
  }

  const topLevelRows = (await db
    .select(POST_SELECT_COLUMNS)
    .from(researchProgramPost)
    .leftJoin(user, eq(user.id, researchProgramPost.authorUserId))
    .where(and(...conditions))
    .orderBy(desc(researchProgramPost.createdAt), desc(researchProgramPost.id))
    .limit(input.filter.limit + 1)) as RawPostRow[];

  const hasMore = topLevelRows.length > input.filter.limit;
  const pageRows = hasMore ? topLevelRows.slice(0, input.filter.limit) : topLevelRows;
  const parentIds = pageRows.map((row) => row.postId);

  const replyRows =
    parentIds.length === 0
      ? []
      : ((await db
          .select(POST_SELECT_COLUMNS)
          .from(researchProgramPost)
          .leftJoin(user, eq(user.id, researchProgramPost.authorUserId))
          .where(inArray(researchProgramPost.parentPostId, parentIds))
          .orderBy(
            asc(researchProgramPost.createdAt),
            asc(researchProgramPost.id),
          )) as RawPostRow[]);

  const allPostIds = [...parentIds, ...replyRows.map((row) => row.postId)];
  const viewerReactedPostIds = await listViewerReactedPostIds(input.viewerUserId, allPostIds);

  const repliesByParent = new Map<string, RawPostRow[]>();
  for (const replyRow of replyRows) {
    if (replyRow.parentPostId === null) continue;
    const bucket = repliesByParent.get(replyRow.parentPostId);
    if (bucket) bucket.push(replyRow);
    else repliesByParent.set(replyRow.parentPostId, [replyRow]);
  }

  const lastRow = pageRows.at(-1);

  return {
    rows: pageRows.map((row) =>
      toPostView(
        row,
        input.viewerUserId,
        viewerReactedPostIds,
        (repliesByParent.get(row.postId) ?? [])
          .slice(0, INLINE_REPLY_LIMIT)
          .map((replyRow) => toPostView(replyRow, input.viewerUserId, viewerReactedPostIds)),
      ),
    ),
    nextCursor:
      hasMore && lastRow
        ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.postId })
        : null,
  };
}

/** A thread's replies, oldest first, keyset-paginated — the "show all N replies" read. */
export async function listPostReplies(input: {
  readonly programId: string;
  readonly parentPostId: string;
  readonly viewerUserId: string | null;
  readonly limit: number;
  readonly cursor?: InstantCursor | undefined;
}): Promise<
  Result<
    { readonly rows: readonly ResearchProgramPostView[]; readonly nextCursor: string | null },
    ResearchProgramPostError
  >
> {
  const [parent] = await db
    .select({ id: researchProgramPost.id })
    .from(researchProgramPost)
    .where(
      and(
        eq(researchProgramPost.id, input.parentPostId),
        eq(researchProgramPost.programId, input.programId),
      ),
    );

  if (!parent) {
    return { success: false, error: { type: "POST_NOT_FOUND", postId: input.parentPostId } };
  }

  const conditions = [eq(researchProgramPost.parentPostId, input.parentPostId)];
  if (input.cursor !== undefined) {
    const { instant, id } = input.cursor;
    // Ascending here, so the predicate is `>` — replies read oldest-first, which is the
    // order a conversation happened in.
    conditions.push(
      or(
        sql`${researchProgramPost.createdAt} > ${instant}`,
        and(eq(researchProgramPost.createdAt, instant), sql`${researchProgramPost.id} > ${id}`),
      )!,
    );
  }

  const rows = (await db
    .select(POST_SELECT_COLUMNS)
    .from(researchProgramPost)
    .leftJoin(user, eq(user.id, researchProgramPost.authorUserId))
    .where(and(...conditions))
    .orderBy(asc(researchProgramPost.createdAt), asc(researchProgramPost.id))
    .limit(input.limit + 1)) as RawPostRow[];

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const viewerReactedPostIds = await listViewerReactedPostIds(
    input.viewerUserId,
    pageRows.map((row) => row.postId),
  );
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      rows: pageRows.map((row) => toPostView(row, input.viewerUserId, viewerReactedPostIds)),
      nextCursor:
        hasMore && lastRow
          ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.postId })
          : null,
    },
  };
}

/** Which of these posts the viewer has reacted to. One query for a whole page. */
async function listViewerReactedPostIds(
  viewerUserId: string | null,
  postIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (viewerUserId === null || postIds.length === 0) return new Set();

  const rows = await db
    .select({ postId: researchProgramPostReaction.postId })
    .from(researchProgramPostReaction)
    .where(
      and(
        eq(researchProgramPostReaction.userId, viewerUserId),
        inArray(researchProgramPostReaction.postId, [...postIds]),
      ),
    );

  return new Set(rows.map((row) => row.postId));
}

/** Creates a top-level post. `title` is required for `informal_paper` and forbidden otherwise. */
export async function createProgramPost(input: {
  readonly programId: string;
  readonly track: ResearchProgramPostTrack;
  readonly title: string | null;
  readonly bodyText: string;
  /** NULL for a program-wide thread. Validated against this program by the controller. */
  readonly branchId: string | null;
  readonly authorUserId: string;
}): Promise<Result<{ readonly postId: string }, ResearchProgramPostError>> {
  const [created] = await db
    .insert(researchProgramPost)
    .values({
      programId: input.programId,
      parentPostId: null,
      track: input.track,
      depth: 0,
      // The CHECK requires a title exactly for a top-level informal paper. The controller
      // already refused the other combinations, so this normalization only guards against
      // an empty string arriving where NULL is meant.
      title: input.track === "informal_paper" ? input.title : null,
      bodyText: input.bodyText,
      branchId: input.branchId,
      authorUserId: input.authorUserId,
    })
    .returning({ id: researchProgramPost.id });

  if (!created) throw new Error("createProgramPost: insert returned no row");
  return { success: true, value: { postId: created.id } };
}

/**
 * Replies to a post, in ONE transaction with the parent's `replyCount`.
 *
 * The parent is locked, so two concurrent replies cannot both read the same count and
 * write the same incremented value — the classic lost-update, which here would understate
 * a thread's size forever.
 *
 * A reply to a HIDDEN post is refused. Otherwise a moderated thread keeps growing beneath
 * the decision that closed it.
 */
export async function createPostReply(input: {
  readonly programId: string;
  readonly parentPostId: string;
  readonly bodyText: string;
  readonly authorUserId: string;
}): Promise<Result<{ readonly postId: string }, ResearchProgramPostError>> {
  const outcome = await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({
        id: researchProgramPost.id,
        track: researchProgramPost.track,
        depth: researchProgramPost.depth,
        branchId: researchProgramPost.branchId,
        isHidden: researchProgramPost.isHidden,
      })
      .from(researchProgramPost)
      .where(
        and(
          eq(researchProgramPost.id, input.parentPostId),
          eq(researchProgramPost.programId, input.programId),
        ),
      )
      .for("update");

    if (!parent) return { kind: "missing" } as const;
    if (parent.isHidden) return { kind: "hidden" } as const;
    if (parent.depth >= MAX_REPLY_DEPTH) return { kind: "too-deep" } as const;

    const [created] = await tx
      .insert(researchProgramPost)
      .values({
        programId: input.programId,
        parentPostId: input.parentPostId,
        // BOTH INHERITED, never taken from the body — a thread must not span two tracks, and
        // must not span two branches either. `CreateReplySchema` carries neither field.
        track: parent.track,
        branchId: parent.branchId,
        depth: parent.depth + 1,
        title: null,
        bodyText: input.bodyText,
        authorUserId: input.authorUserId,
      })
      .returning({ id: researchProgramPost.id });

    if (!created) throw new Error("createPostReply: insert returned no row");

    await tx
      .update(researchProgramPost)
      .set({ replyCount: sql`${researchProgramPost.replyCount} + 1` })
      .where(eq(researchProgramPost.id, input.parentPostId));

    return { kind: "created", postId: created.id } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "POST_NOT_FOUND", postId: input.parentPostId } };
    case "hidden":
      return { success: false, error: { type: "POST_HIDDEN", postId: input.parentPostId } };
    case "too-deep":
      return { success: false, error: { type: "REPLY_DEPTH_EXCEEDED", maxDepth: MAX_REPLY_DEPTH } };
    case "created":
      return { success: true, value: { postId: outcome.postId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled reply outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `PUT …/reaction` — adds one. IDEMPOTENT.
 *
 * The insert and the counter move together in one transaction, and a 23505 means the
 * reaction already existed, so the counter must NOT move: incrementing on a swallowed
 * duplicate is how a double-tap inflates a like count. Returns the resulting count so the
 * client renders the server's number rather than guessing at one.
 */
export async function addPostReaction(input: {
  readonly programId: string;
  readonly postId: string;
  readonly userId: string;
}): Promise<Result<{ readonly reactionCount: number }, ResearchProgramPostError>> {
  const outcome = await db.transaction(async (tx) => {
    const [post] = await tx
      .select({
        id: researchProgramPost.id,
        reactionCount: researchProgramPost.reactionCount,
        isHidden: researchProgramPost.isHidden,
      })
      .from(researchProgramPost)
      .where(
        and(
          eq(researchProgramPost.id, input.postId),
          eq(researchProgramPost.programId, input.programId),
        ),
      )
      .for("update");

    if (!post) return { kind: "missing" } as const;
    if (post.isHidden) return { kind: "hidden" } as const;

    try {
      await tx
        .insert(researchProgramPostReaction)
        .values({ postId: input.postId, userId: input.userId });
    } catch (insertError: unknown) {
      if (isUniqueViolation(insertError)) {
        // Already reacted. The end state the caller asked for is already true, and the
        // count must stay where it is.
        return { kind: "unchanged", reactionCount: post.reactionCount } as const;
      }
      throw insertError;
    }

    const [updated] = await tx
      .update(researchProgramPost)
      .set({ reactionCount: sql`${researchProgramPost.reactionCount} + 1` })
      .where(eq(researchProgramPost.id, input.postId))
      .returning({ reactionCount: researchProgramPost.reactionCount });

    return {
      kind: "added",
      reactionCount: updated?.reactionCount ?? post.reactionCount + 1,
    } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "POST_NOT_FOUND", postId: input.postId } };
    case "hidden":
      return { success: false, error: { type: "POST_HIDDEN", postId: input.postId } };
    case "unchanged":
    case "added":
      return { success: true, value: { reactionCount: outcome.reactionCount } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled reaction outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `DELETE …/reaction` — removes one. IDEMPOTENT in the same way: the counter moves only if
 * a row was actually deleted, so repeating the call cannot drive the count negative.
 */
export async function removePostReaction(input: {
  readonly programId: string;
  readonly postId: string;
  readonly userId: string;
}): Promise<Result<{ readonly reactionCount: number }, ResearchProgramPostError>> {
  const outcome = await db.transaction(async (tx) => {
    const [post] = await tx
      .select({
        id: researchProgramPost.id,
        reactionCount: researchProgramPost.reactionCount,
      })
      .from(researchProgramPost)
      .where(
        and(
          eq(researchProgramPost.id, input.postId),
          eq(researchProgramPost.programId, input.programId),
        ),
      )
      .for("update");

    if (!post) return { kind: "missing" } as const;

    const deletedRows = await tx
      .delete(researchProgramPostReaction)
      .where(
        and(
          eq(researchProgramPostReaction.postId, input.postId),
          eq(researchProgramPostReaction.userId, input.userId),
        ),
      )
      .returning({ id: researchProgramPostReaction.id });

    if (deletedRows.length === 0) {
      return { kind: "unchanged", reactionCount: post.reactionCount } as const;
    }

    const [updated] = await tx
      .update(researchProgramPost)
      // GREATEST guards the floor. The transaction should make it unreachable; a count
      // that can go negative is a count a client will eventually render as "-1 likes".
      .set({ reactionCount: sql`GREATEST(${researchProgramPost.reactionCount} - 1, 0)` })
      .where(eq(researchProgramPost.id, input.postId))
      .returning({ reactionCount: researchProgramPost.reactionCount });

    return {
      kind: "removed",
      reactionCount: updated?.reactionCount ?? Math.max(0, post.reactionCount - 1),
    } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "POST_NOT_FOUND", postId: input.postId } };
    case "unchanged":
    case "removed":
      return { success: true, value: { reactionCount: outcome.reactionCount } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled reaction removal outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Reports a post or a paper.
 *
 * ONE REPORT PER USER PER TARGET, enforced by a partial unique index and surfaced as
 * `409 ALREADY_REPORTED`. Without it a brigading loop inflates the queue and the queue
 * stops meaning "several people independently flagged this".
 */
export async function reportProgramContent(input: {
  readonly programId: string;
  readonly targetKind: "paper" | "post";
  readonly paperId: string | null;
  readonly postId: string | null;
  readonly reason: (typeof researchProgramContentReport.$inferSelect)["reason"];
  readonly detailText: string | null;
  readonly reporterUserId: string;
}): Promise<Result<{ readonly reportId: string }, ResearchProgramPostError>> {
  try {
    const [created] = await db
      .insert(researchProgramContentReport)
      .values({
        programId: input.programId,
        targetKind: input.targetKind,
        paperId: input.paperId,
        postId: input.postId,
        reason: input.reason,
        detailText: input.detailText,
        reporterUserId: input.reporterUserId,
        status: "open",
      })
      .returning({ id: researchProgramContentReport.id });

    if (!created) throw new Error("reportProgramContent: insert returned no row");
    return { success: true, value: { reportId: created.id } };
  } catch (insertError: unknown) {
    if (isUniqueViolation(insertError)) {
      return { success: false, error: { type: "ALREADY_REPORTED" } };
    }
    throw insertError;
  }
}

/** Resolves one post within a program. Used to validate a report's or moderation's target. */
export async function findPostInProgram(
  programId: string,
  postId: string,
): Promise<{ readonly postId: string; readonly isHidden: boolean } | null> {
  const [row] = await db
    .select({ postId: researchProgramPost.id, isHidden: researchProgramPost.isHidden })
    .from(researchProgramPost)
    .where(and(eq(researchProgramPost.id, postId), eq(researchProgramPost.programId, programId)));

  return row ?? null;
}

/** Counts open reports, for the moderation badge. */
export async function countOpenReports(programId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(researchProgramContentReport)
    .where(
      and(
        eq(researchProgramContentReport.programId, programId),
        eq(researchProgramContentReport.status, "open"),
      ),
    );

  return row?.total ?? 0;
}
