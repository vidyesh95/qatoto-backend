import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { user, video, videoComment, videoCommentLike, videoStats } from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { findPublicVideo } from "#src/services/public-video-gate.js";
import type { Result } from "#src/types/index.js";

/**
 * Comments — HOME_BACKEND_STRUCTURE.md §3.1, §5.2, §8.4.
 *
 * WHAT v1 DELIBERATELY DOES NOT HAVE, per §8.4: no reporting flow, no automated
 * moderation, no sort options. `video.commentModeration` and `video.commentSortOrder`
 * stay unbacked preference columns, and this service does not read them — offering a
 * `?sort=top` would imply the second one works.
 *
 * What it DOES have: `areCommentsEnabled` respected, a per-user rate limiter, a
 * 2000-character cap enforced by CHECK, one level of threading, and a tombstone delete
 * available to the comment's author or the video's creator.
 */

export type VideoCommentError =
  | { readonly type: "VIDEO_NOT_FOUND"; readonly videoId: string }
  | { readonly type: "COMMENT_NOT_FOUND"; readonly commentId: string }
  | { readonly type: "COMMENTS_DISABLED"; readonly videoId: string }
  | { readonly type: "REPLY_DEPTH_EXCEEDED"; readonly parentCommentId: string }
  | { readonly type: "PARENT_COMMENT_NOT_ON_VIDEO"; readonly parentCommentId: string }
  | { readonly type: "COMMENT_NOT_AUTHOR"; readonly commentId: string }
  | { readonly type: "COMMENT_DELETE_FORBIDDEN"; readonly commentId: string }
  | { readonly type: "COMMENT_ALREADY_DELETED"; readonly commentId: string }
  | { readonly type: "CURSOR_MALFORMED" };

export interface CommentAuthorView {
  readonly id: string;
  readonly handle: string | null;
  readonly name: string;
  readonly imageUrl: string | null;
}

export interface CommentView {
  readonly commentId: string;
  readonly parentCommentId: string | null;
  /**
   * `null` on a tombstone, never `""`. An empty string reads as "they wrote nothing";
   * null reads as "there is nothing to read", which is the true statement.
   */
  readonly body: string | null;
  readonly isDeleted: boolean;
  /** NULL when the account was closed. The client renders "deleted user". */
  readonly author: CommentAuthorView | null;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly viewerState: { readonly hasLiked: boolean };
}

function increment(column: typeof videoStats.commentCount): ReturnType<typeof sql> {
  return sql`${column} + 1`;
}

function decrement(column: typeof videoStats.commentCount): ReturnType<typeof sql> {
  return sql`GREATEST(${column} - 1, 0)`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListCommentsInput {
  readonly videoId: string;
  readonly viewerUserId: string | null;
  /** Absent → the top-level thread. Present → that comment's replies. */
  readonly parentCommentId: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}

/**
 * `GET /videos/:videoId/comments`.
 *
 * KEYSET, not offset, on `(createdAt, id)` — and unlike the ranked feed this sort key
 * genuinely is stable, so a cursor is straightforwardly correct here. Ends in a unique
 * id because two comments can share a millisecond and a cursor keyed on a non-unique
 * column skips whichever one loses the tie.
 *
 * ## Comments turned off is an EMPTY LIST, not an error
 *
 * The video is public and its comment section is closed. A 409 on a read would make the
 * client render an error where it should render nothing at all. Writes are the ones
 * that get the 409.
 *
 * ## Which tombstones are visible
 *
 * A tombstoned comment with surviving replies IS returned, because dropping it would
 * detach its replies from the thread and the conversation would stop making sense. A
 * tombstoned leaf is dropped — there is nothing left of it to render.
 */
export async function listVideoComments(
  input: ListCommentsInput,
): Promise<Result<{ readonly rows: readonly CommentView[]; readonly nextCursor: string | null }, VideoCommentError>> {
  const publicVideo = await findPublicVideo(db, input.videoId);
  if (publicVideo === null) {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: input.videoId } };
  }

  if (!publicVideo.areCommentsEnabled) {
    return { success: true, value: { rows: [], nextCursor: null } };
  }

  const decodedCursor = input.cursor === null ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== null && decodedCursor === null) {
    return { success: false, error: { type: "CURSOR_MALFORMED" } };
  }

  // Top-level: newest first, because a thread's most recent contribution is the one
  // worth surfacing. Replies: oldest first, because a reply chain is read in order.
  const isReplyListing = input.parentCommentId !== null;

  const cursorCondition =
    decodedCursor === null
      ? undefined
      : isReplyListing
        ? or(
            gt(videoComment.createdAt, decodedCursor.instant),
            and(
              eq(videoComment.createdAt, decodedCursor.instant),
              gt(videoComment.id, decodedCursor.id),
            ),
          )
        : or(
            lt(videoComment.createdAt, decodedCursor.instant),
            and(
              eq(videoComment.createdAt, decodedCursor.instant),
              lt(videoComment.id, decodedCursor.id),
            ),
          );

  const viewerLikeCondition =
    input.viewerUserId === null
      ? sql`false`
      : sql`EXISTS (
            SELECT 1 FROM ${videoCommentLike}
            WHERE ${videoCommentLike.commentId} = ${videoComment.id}
              AND ${videoCommentLike.userId} = ${input.viewerUserId}
          )`;

  // Fetch one extra row: its presence is what tells us a next page exists, without a
  // COUNT over the whole thread.
  const rows = await db
    .select({
      commentId: videoComment.id,
      parentCommentId: videoComment.parentCommentId,
      bodyText: videoComment.bodyText,
      isDeleted: videoComment.isDeleted,
      likeCount: videoComment.likeCount,
      replyCount: videoComment.replyCount,
      createdAt: videoComment.createdAt,
      updatedAt: videoComment.updatedAt,
      authorId: user.id,
      authorHandle: user.handle,
      authorName: user.name,
      authorImageUrl: user.image,
      hasLiked: sql<boolean>`${viewerLikeCondition}`,
    })
    .from(videoComment)
    .leftJoin(user, eq(user.id, videoComment.authorUserId))
    .where(
      and(
        eq(videoComment.videoId, input.videoId),
        input.parentCommentId === null
          ? isNull(videoComment.parentCommentId)
          : eq(videoComment.parentCommentId, input.parentCommentId),
        // A tombstone survives in the listing only while it is holding replies up.
        or(eq(videoComment.isDeleted, false), gt(videoComment.replyCount, 0)),
        cursorCondition,
      ),
    )
    .orderBy(
      ...(isReplyListing
        ? [asc(videoComment.createdAt), asc(videoComment.id)]
        : [desc(videoComment.createdAt), desc(videoComment.id)]),
    )
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor =
    rows.length > input.limit && lastRow !== undefined
      ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.commentId })
      : null;

  return {
    success: true,
    value: {
      rows: pageRows.map((row) => ({
        commentId: row.commentId,
        parentCommentId: row.parentCommentId,
        body: row.isDeleted ? null : row.bodyText,
        isDeleted: row.isDeleted,
        // A TOMBSTONE CARRIES NO AUTHOR. The row only survives so its replies keep an
        // anchor; naming who wrote the removed comment would publish "this person said
        // something that got taken down", which is a fact the deletion was meant to
        // retire. The client renders the same placeholder it already renders for a
        // closed account.
        author:
          row.isDeleted || row.authorId === null
            ? null
            : {
                id: row.authorId,
                handle: row.authorHandle,
                name: row.authorName ?? "",
                imageUrl: row.authorImageUrl,
              },
        likeCount: row.likeCount,
        replyCount: row.replyCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        viewerState: { hasLiked: row.hasLiked },
      })),
      nextCursor,
    },
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * `POST /videos/:videoId/comments`.
 *
 * The one engagement write with no natural unique index, which is why it is the one
 * route carrying `idempotency()` — a double-tapped submit button must not post twice.
 *
 * A reply locks its parent (`FOR UPDATE`) before incrementing `replyCount`, so two
 * simultaneous replies cannot both read the same count and write the same successor.
 */
export async function createVideoComment(input: {
  readonly videoId: string;
  readonly authorUserId: string;
  readonly bodyText: string;
  readonly parentCommentId: string | null;
}): Promise<Result<CommentView, VideoCommentError>> {
  const outcome = await db.transaction(async (tx) => {
    const publicVideo = await findPublicVideo(tx, input.videoId);
    if (publicVideo === null) return { kind: "videoMissing" } as const;
    if (!publicVideo.areCommentsEnabled) return { kind: "commentsDisabled" } as const;

    let depth = 0;

    if (input.parentCommentId !== null) {
      const [parent] = await tx
        .select({
          id: videoComment.id,
          videoId: videoComment.videoId,
          depth: videoComment.depth,
          isDeleted: videoComment.isDeleted,
        })
        .from(videoComment)
        .where(eq(videoComment.id, input.parentCommentId))
        .for("update");

      // "No such comment" and "that comment belongs to another video" collapse into
      // one answer on purpose: distinguishing them would let a caller probe which
      // comment ids exist on videos they cannot see.
      if (!parent || parent.videoId !== input.videoId || parent.isDeleted) {
        return { kind: "parentNotOnVideo" } as const;
      }
      // One level only. A reply-to-a-reply is a 409, not a 422: nothing in the body is
      // wrong, the thread shape is.
      if (parent.depth !== 0) return { kind: "replyTooDeep" } as const;

      depth = 1;
    }

    const [inserted] = await tx
      .insert(videoComment)
      .values({
        videoId: input.videoId,
        parentCommentId: input.parentCommentId,
        depth,
        authorUserId: input.authorUserId,
        bodyText: input.bodyText,
      })
      .returning();

    if (!inserted) throw new Error("createVideoComment: insert returned no row");

    if (input.parentCommentId !== null) {
      await tx
        .update(videoComment)
        .set({ replyCount: sql`${videoComment.replyCount} + 1` })
        .where(eq(videoComment.id, input.parentCommentId));
    }

    await tx
      .update(videoStats)
      .set({ commentCount: increment(videoStats.commentCount), lastEngagementAt: sql`now()` })
      .where(eq(videoStats.videoId, input.videoId));

    const [author] = await tx
      .select({ id: user.id, handle: user.handle, name: user.name, imageUrl: user.image })
      .from(user)
      .where(eq(user.id, input.authorUserId));

    return { kind: "created", comment: inserted, author: author ?? null } as const;
  });

  switch (outcome.kind) {
    case "videoMissing":
      return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: input.videoId } };
    case "commentsDisabled":
      return { success: false, error: { type: "COMMENTS_DISABLED", videoId: input.videoId } };
    case "parentNotOnVideo":
      return {
        success: false,
        error: {
          type: "PARENT_COMMENT_NOT_ON_VIDEO",
          parentCommentId: input.parentCommentId ?? "",
        },
      };
    case "replyTooDeep":
      return {
        success: false,
        error: { type: "REPLY_DEPTH_EXCEEDED", parentCommentId: input.parentCommentId ?? "" },
      };
    case "created":
      return {
        success: true,
        value: {
          commentId: outcome.comment.id,
          parentCommentId: outcome.comment.parentCommentId,
          body: outcome.comment.bodyText,
          isDeleted: false,
          author: outcome.author,
          likeCount: 0,
          replyCount: 0,
          createdAt: outcome.comment.createdAt,
          updatedAt: outcome.comment.updatedAt,
          viewerState: { hasLiked: false },
        },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled comment create outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `PATCH /comments/:commentId` — the author's own words, and nobody else's.
 *
 * A 403 rather than a 404 here, because the caller has already SEEN this comment and
 * its author in the public listing: refusing tells them nothing they did not know. That
 * is the line `project-error-response.ts` draws and it holds.
 */
export async function updateVideoComment(input: {
  readonly commentId: string;
  readonly authorUserId: string;
  readonly bodyText: string;
}): Promise<Result<{ readonly commentId: string; readonly body: string; readonly updatedAt: Date }, VideoCommentError>> {
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: videoComment.id,
        authorUserId: videoComment.authorUserId,
        isDeleted: videoComment.isDeleted,
      })
      .from(videoComment)
      .where(eq(videoComment.id, input.commentId))
      .for("update");

    if (!existing) return { kind: "missing" } as const;
    if (existing.isDeleted) return { kind: "alreadyDeleted" } as const;
    if (existing.authorUserId !== input.authorUserId) return { kind: "notAuthor" } as const;

    const [updated] = await tx
      .update(videoComment)
      .set({ bodyText: input.bodyText })
      .where(eq(videoComment.id, input.commentId))
      .returning({
        id: videoComment.id,
        bodyText: videoComment.bodyText,
        updatedAt: videoComment.updatedAt,
      });

    if (!updated) throw new Error("updateVideoComment: update returned no row");
    return { kind: "updated", row: updated } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "COMMENT_NOT_FOUND", commentId: input.commentId } };
    case "alreadyDeleted":
      return {
        success: false,
        error: { type: "COMMENT_ALREADY_DELETED", commentId: input.commentId },
      };
    case "notAuthor":
      return { success: false, error: { type: "COMMENT_NOT_AUTHOR", commentId: input.commentId } };
    case "updated":
      return {
        success: true,
        value: {
          commentId: outcome.row.id,
          body: outcome.row.bodyText,
          updatedAt: outcome.row.updatedAt,
        },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled comment update outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `DELETE /comments/:commentId` — a TOMBSTONE, not a row delete.
 *
 * WHY A TOMBSTONE. `parent_comment_id` cascades, so deleting a parent outright would
 * take its replies with it: one person removing their own comment would silently erase
 * everybody else's answers to it. The row stays, its text is erased (the
 * `video_comment_body_ck` CHECK is what makes that erasure real rather than a rendering
 * convention), and the replies keep their anchor.
 *
 * WHO MAY DO IT. The author, or the video's creator. A creator moderating their own
 * comment section is the only moderation v1 has (§8.4), so it cannot be author-only.
 *
 * `commentCount` counts what is RENDERED as a comment, so a tombstone decrements it
 * even though the row survives.
 */
export async function deleteVideoComment(input: {
  readonly commentId: string;
  readonly actorUserId: string;
}): Promise<Result<{ readonly commentId: string }, VideoCommentError>> {
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: videoComment.id,
        videoId: videoComment.videoId,
        parentCommentId: videoComment.parentCommentId,
        authorUserId: videoComment.authorUserId,
        isDeleted: videoComment.isDeleted,
      })
      .from(videoComment)
      .where(eq(videoComment.id, input.commentId))
      .for("update");

    if (!existing) return { kind: "missing" } as const;
    if (existing.isDeleted) return { kind: "alreadyDeleted" } as const;

    // The gate is read WITHOUT the public predicate: a creator must still be able to
    // clean up their comment section on a video they have since unpublished.
    const [owningVideo] = await tx
      .select({ creatorId: video.creatorId })
      .from(video)
      .where(eq(video.id, existing.videoId));

    const isAuthor = existing.authorUserId === input.actorUserId;
    const isVideoCreator = owningVideo?.creatorId === input.actorUserId;
    if (!isAuthor && !isVideoCreator) return { kind: "forbidden" } as const;

    await tx
      .update(videoComment)
      .set({ isDeleted: true, deletedAt: sql`now()`, bodyText: "" })
      .where(eq(videoComment.id, input.commentId));

    if (existing.parentCommentId !== null) {
      await tx
        .update(videoComment)
        .set({ replyCount: sql`GREATEST(${videoComment.replyCount} - 1, 0)` })
        .where(eq(videoComment.id, existing.parentCommentId));
    }

    await tx
      .update(videoStats)
      .set({ commentCount: decrement(videoStats.commentCount) })
      .where(eq(videoStats.videoId, existing.videoId));

    return { kind: "deleted" } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "COMMENT_NOT_FOUND", commentId: input.commentId } };
    case "alreadyDeleted":
      return {
        success: false,
        error: { type: "COMMENT_ALREADY_DELETED", commentId: input.commentId },
      };
    case "forbidden":
      return {
        success: false,
        error: { type: "COMMENT_DELETE_FORBIDDEN", commentId: input.commentId },
      };
    case "deleted":
      return { success: true, value: { commentId: input.commentId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled comment delete outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * `PUT`/`DELETE /comments/:commentId/like`. Same idempotent-by-verb shape as the video
 * like: the PK on `(commentId, userId)` is the mechanism, and the counter moves only
 * when a row actually appeared or vanished.
 *
 * A tombstoned comment cannot be liked — there is nothing left to endorse.
 */
export async function setCommentLike(input: {
  readonly commentId: string;
  readonly userId: string;
  readonly shouldBeSet: boolean;
}): Promise<Result<{ readonly isSet: boolean; readonly likeCount: number }, VideoCommentError>> {
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: videoComment.id, likeCount: videoComment.likeCount, isDeleted: videoComment.isDeleted })
      .from(videoComment)
      .where(eq(videoComment.id, input.commentId))
      .for("update");

    if (!existing) return { kind: "missing" } as const;
    if (existing.isDeleted) return { kind: "alreadyDeleted" } as const;

    const affectedRows = input.shouldBeSet
      ? await tx
          .insert(videoCommentLike)
          .values({ commentId: input.commentId, userId: input.userId })
          .onConflictDoNothing()
          .returning({ commentId: videoCommentLike.commentId })
      : await tx
          .delete(videoCommentLike)
          .where(
            and(
              eq(videoCommentLike.commentId, input.commentId),
              eq(videoCommentLike.userId, input.userId),
            ),
          )
          .returning({ commentId: videoCommentLike.commentId });

    if (affectedRows.length === 0) {
      return { kind: "toggled", likeCount: existing.likeCount } as const;
    }

    const [updated] = await tx
      .update(videoComment)
      .set({
        likeCount: input.shouldBeSet
          ? sql`${videoComment.likeCount} + 1`
          : sql`GREATEST(${videoComment.likeCount} - 1, 0)`,
      })
      .where(eq(videoComment.id, input.commentId))
      .returning({ likeCount: videoComment.likeCount });

    return { kind: "toggled", likeCount: updated?.likeCount ?? existing.likeCount } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "COMMENT_NOT_FOUND", commentId: input.commentId } };
    case "alreadyDeleted":
      return {
        success: false,
        error: { type: "COMMENT_ALREADY_DELETED", commentId: input.commentId },
      };
    case "toggled":
      return { success: true, value: { isSet: input.shouldBeSet, likeCount: outcome.likeCount } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled comment like outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
