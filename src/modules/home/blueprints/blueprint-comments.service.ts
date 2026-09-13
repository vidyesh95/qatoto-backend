import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  showcaseLaunchComment,
  showcaseLaunchCommentLike,
  showcaseLaunchStats,
  teardownComment,
  teardownCommentLike,
  teardownStats,
  user,
} from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { resolveEngageableBlueprint } from "#src/modules/home/blueprints/blueprint-engagement-gate.js";
import { decrement, increment } from "#src/modules/home/counter-sql.js";
import type { Result } from "#src/types/index.js";

/**
 * Comments on the two blueprint arms that have them.
 *
 * ⚠️ TWO ARMS, NOT THREE. A case study has no comment table and `case_study_stats` has no
 * `comment_count`: the contract calls that arm "a numbered lesson with no discussion surface". The
 * absence is the decision, so there is no `case_study` branch anywhere in this file to forget.
 *
 * THE TABLE SHAPE IS `video_comment`'s, deliberately and down to the column names: one level of
 * threading discriminated by `depth`, and delete is a TOMBSTONE rather than a row delete, because
 * deleting a parent outright would cascade its replies away and silently remove the conversation
 * under it.
 *
 * ⚠️ THE AUTHOR SHAPE IS THE BLUEPRINTS SURFACE'S, NOT THE VIDEO ONE'S. An earlier draft of this
 * file served `{id, handle, name, imageUrl}` so one frontend component could render video and
 * blueprint comments alike — but the blueprints frontend already spells a person ONE way, as
 * `BlueprintAuthorSchema` (`displayName` / `handle` / `avatarUrl`), and every byline on a teardown,
 * a case study and a launch uses it. A second spelling reachable only from the comment thread would
 * be the third name for one concept on a surface that has already settled on one.
 *
 * ⚠️ `body` IS `null` ON A TOMBSTONE, NEVER `""`. An empty string reads as "they wrote nothing";
 * null reads as "there is nothing to read", which is the true statement. A tombstone also carries
 * NO AUTHOR — naming who wrote a removed comment publishes the very fact the deletion retired.
 *
 * ⚠️ THE GATE IS ENGAGEABLE (`published` alone), not either read gate. A quarantined teardown's
 * page is served and its thread is readable, but nothing new may be written under an unresolved
 * rights claim. `blueprint-engagement-gate.ts` holds all three predicates apart.
 */

export type BlueprintCommentArm = "showcase" | "teardown";

export type BlueprintCommentError =
  | { readonly type: "BLUEPRINT_CONTENT_NOT_FOUND" }
  | { readonly type: "BLUEPRINT_COMMENT_NOT_FOUND"; readonly commentId: string }
  | { readonly type: "BLUEPRINT_REPLY_DEPTH_EXCEEDED"; readonly parentCommentId: string }
  | { readonly type: "BLUEPRINT_PARENT_COMMENT_NOT_ON_TARGET"; readonly parentCommentId: string }
  | { readonly type: "BLUEPRINT_COMMENT_NOT_AUTHOR"; readonly commentId: string }
  | { readonly type: "BLUEPRINT_COMMENT_ALREADY_DELETED"; readonly commentId: string }
  | { readonly type: "BLUEPRINT_CURSOR_MALFORMED" };

/** Matches `BlueprintAuthorSchema` on the frontend — the one spelling of a person on this surface. */
export interface BlueprintCommentAuthorView {
  readonly displayName: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
}

export interface BlueprintCommentView {
  readonly commentId: string;
  readonly parentCommentId: string | null;
  readonly body: string | null;
  readonly isDeleted: boolean;
  readonly author: BlueprintCommentAuthorView | null;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly viewerState: { readonly hasLiked: boolean };
}

export interface BlueprintCommentPage {
  readonly rows: readonly BlueprintCommentView[];
  readonly nextCursor: string | null;
}

/** The shared row shape both comment tables select into. */
interface CommentRow {
  readonly id: string;
  readonly parentCommentId: string | null;
  readonly bodyText: string;
  readonly isDeleted: boolean;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly authorId: string | null;
  readonly authorHandle: string | null;
  readonly authorName: string | null;
  readonly authorImageUrl: string | null;
  readonly hasLiked: boolean;
}

function toCommentView(row: CommentRow): BlueprintCommentView {
  /*
   * ⚠️ THE TOMBSTONE DROPS BOTH THE BODY AND THE AUTHOR, and it is done HERE rather than in each
   * query so the two cannot drift. `*_comment_body_ck` already guarantees the stored text is the
   * empty string once `is_deleted` is true; this turns that into `null`, which is what the
   * contract promises and what reads as "there is nothing to read".
   */
  const author =
    row.isDeleted || row.authorId === null || row.authorName === null
      ? null
      : {
          displayName: row.authorName,
          handle: row.authorHandle,
          avatarUrl: row.authorImageUrl,
        };

  return {
    commentId: row.id,
    parentCommentId: row.parentCommentId,
    body: row.isDeleted ? null : row.bodyText,
    isDeleted: row.isDeleted,
    author,
    likeCount: row.likeCount,
    replyCount: row.replyCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    viewerState: { hasLiked: row.hasLiked },
  };
}

const MAXIMUM_COMMENT_PAGE_SIZE = 50;

export interface ListBlueprintCommentsInput {
  readonly arm: BlueprintCommentArm;
  readonly slug: string;
  readonly parentCommentId: string | null;
  readonly viewerUserId: string | null;
  readonly limit: number;
  readonly cursor: string | undefined;
}

/**
 * One page of a thread, keyset-paginated on `(created_at, id)`, OLDEST FIRST.
 *
 * Oldest first because a discussion reads in the order it happened — unlike the moderation queues,
 * which are oldest-first for a different reason entirely (the submission that has waited longest is
 * the one owed an answer).
 *
 * ⚠️ GATED ON ENGAGEABLE RATHER THAN VIEWABLE, WHICH IS STRICTER THAN THE PAGE AROUND IT. A
 * quarantined teardown still renders, but its thread is withheld along with its files: a rights
 * claim is unresolved, and a discussion of a survey under dispute is part of what is disputed.
 */
export async function listBlueprintComments(
  input: ListBlueprintCommentsInput,
): Promise<Result<BlueprintCommentPage, BlueprintCommentError>> {
  const cursor = input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && cursor === null) {
    return { success: false, error: { type: "BLUEPRINT_CURSOR_MALFORMED" } };
  }

  const targetId = await resolveEngageableBlueprint(input.arm, input.slug);
  if (targetId === null) return { success: false, error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" } };

  const limit = Math.min(Math.max(input.limit, 1), MAXIMUM_COMMENT_PAGE_SIZE);
  const viewerUserId = input.viewerUserId;

  const rows: CommentRow[] =
    input.arm === "showcase"
      ? await db
          .select({
            id: showcaseLaunchComment.id,
            parentCommentId: showcaseLaunchComment.parentCommentId,
            bodyText: showcaseLaunchComment.bodyText,
            isDeleted: showcaseLaunchComment.isDeleted,
            likeCount: showcaseLaunchComment.likeCount,
            replyCount: showcaseLaunchComment.replyCount,
            createdAt: showcaseLaunchComment.createdAt,
            updatedAt: showcaseLaunchComment.updatedAt,
            authorId: user.id,
            authorHandle: user.handle,
            authorName: user.name,
            authorImageUrl: user.image,
            hasLiked:
              viewerUserId === null
                ? sql<boolean>`false`
                : sql<boolean>`EXISTS (SELECT 1 FROM ${showcaseLaunchCommentLike}
                     WHERE ${showcaseLaunchCommentLike.commentId} = ${showcaseLaunchComment.id}
                       AND ${showcaseLaunchCommentLike.userId} = ${viewerUserId})`,
          })
          .from(showcaseLaunchComment)
          .leftJoin(user, eq(user.id, showcaseLaunchComment.authorUserId))
          .where(
            and(
              eq(showcaseLaunchComment.launchId, targetId),
              input.parentCommentId === null
                ? isNull(showcaseLaunchComment.parentCommentId)
                : eq(showcaseLaunchComment.parentCommentId, input.parentCommentId),
              ...(cursor === null
                ? []
                : [
                    gt(
                      sql`(${showcaseLaunchComment.createdAt}, ${showcaseLaunchComment.id})`,
                      sql`(${cursor.instant}, ${cursor.id})`,
                    ),
                  ]),
            ),
          )
          .orderBy(asc(showcaseLaunchComment.createdAt), asc(showcaseLaunchComment.id))
          .limit(limit + 1)
      : await db
          .select({
            id: teardownComment.id,
            parentCommentId: teardownComment.parentCommentId,
            bodyText: teardownComment.bodyText,
            isDeleted: teardownComment.isDeleted,
            likeCount: teardownComment.likeCount,
            replyCount: teardownComment.replyCount,
            createdAt: teardownComment.createdAt,
            updatedAt: teardownComment.updatedAt,
            authorId: user.id,
            authorHandle: user.handle,
            authorName: user.name,
            authorImageUrl: user.image,
            hasLiked:
              viewerUserId === null
                ? sql<boolean>`false`
                : sql<boolean>`EXISTS (SELECT 1 FROM ${teardownCommentLike}
                     WHERE ${teardownCommentLike.commentId} = ${teardownComment.id}
                       AND ${teardownCommentLike.userId} = ${viewerUserId})`,
          })
          .from(teardownComment)
          .leftJoin(user, eq(user.id, teardownComment.authorUserId))
          .where(
            and(
              eq(teardownComment.teardownId, targetId),
              input.parentCommentId === null
                ? isNull(teardownComment.parentCommentId)
                : eq(teardownComment.parentCommentId, input.parentCommentId),
              ...(cursor === null
                ? []
                : [
                    gt(
                      sql`(${teardownComment.createdAt}, ${teardownComment.id})`,
                      sql`(${cursor.instant}, ${cursor.id})`,
                    ),
                  ]),
            ),
          )
          .orderBy(asc(teardownComment.createdAt), asc(teardownComment.id))
          .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page.at(-1);

  return {
    success: true,
    value: {
      rows: page.map(toCommentView),
      nextCursor:
        hasMore && lastRow
          ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.id })
          : null,
    },
  };
}

export interface CreateBlueprintCommentInput {
  readonly arm: BlueprintCommentArm;
  readonly slug: string;
  readonly authorUserId: string;
  readonly bodyText: string;
  readonly parentCommentId: string | null;
}

/**
 * Posts one comment, or one reply to a top-level comment.
 *
 * ⚠️ A REPLY-TO-A-REPLY IS A 409, NOT A 422. Nothing in the body is wrong — the thread shape is.
 * That is `createVideoComment`'s line and it holds here.
 *
 * ⚠️ "NO SUCH COMMENT" AND "THAT COMMENT BELONGS TO ANOTHER BLUEPRINT" COLLAPSE INTO ONE ANSWER,
 * for the reason the video path gives: distinguishing them would let a caller probe which comment
 * ids exist under blueprints they cannot see.
 */
export async function createBlueprintComment(
  input: CreateBlueprintCommentInput,
): Promise<Result<BlueprintCommentView, BlueprintCommentError>> {
  const targetId = await resolveEngageableBlueprint(input.arm, input.slug);
  if (targetId === null) return { success: false, error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" } };

  const outcome = await db.transaction(async (transaction) => {
    let depth = 0;

    if (input.parentCommentId !== null) {
      const parent =
        input.arm === "showcase"
          ? (
              await transaction
                .select({
                  id: showcaseLaunchComment.id,
                  targetId: showcaseLaunchComment.launchId,
                  depth: showcaseLaunchComment.depth,
                  isDeleted: showcaseLaunchComment.isDeleted,
                })
                .from(showcaseLaunchComment)
                .where(eq(showcaseLaunchComment.id, input.parentCommentId))
                .for("update")
            )[0]
          : (
              await transaction
                .select({
                  id: teardownComment.id,
                  targetId: teardownComment.teardownId,
                  depth: teardownComment.depth,
                  isDeleted: teardownComment.isDeleted,
                })
                .from(teardownComment)
                .where(eq(teardownComment.id, input.parentCommentId))
                .for("update")
            )[0];

      if (!parent || parent.targetId !== targetId || parent.isDeleted) {
        return { kind: "parentNotOnTarget" } as const;
      }
      if (parent.depth !== 0) return { kind: "replyTooDeep" } as const;
      depth = 1;
    }

    const inserted =
      input.arm === "showcase"
        ? (
            await transaction
              .insert(showcaseLaunchComment)
              .values({
                launchId: targetId,
                parentCommentId: input.parentCommentId,
                depth,
                authorUserId: input.authorUserId,
                bodyText: input.bodyText,
              })
              .returning()
          )[0]
        : (
            await transaction
              .insert(teardownComment)
              .values({
                teardownId: targetId,
                parentCommentId: input.parentCommentId,
                depth,
                authorUserId: input.authorUserId,
                bodyText: input.bodyText,
              })
              .returning()
          )[0];

    if (!inserted) throw new Error("createBlueprintComment: insert returned no row");

    if (input.parentCommentId !== null) {
      if (input.arm === "showcase") {
        await transaction
          .update(showcaseLaunchComment)
          .set({ replyCount: increment(showcaseLaunchComment.replyCount) })
          .where(eq(showcaseLaunchComment.id, input.parentCommentId));
      } else {
        await transaction
          .update(teardownComment)
          .set({ replyCount: increment(teardownComment.replyCount) })
          .where(eq(teardownComment.id, input.parentCommentId));
      }
    }

    // ⚠️ AN UPSERT, for the reason every counter write on this surface is one: the showcase
    // sidecar is not written on publish, so a bare UPDATE would affect zero rows and lose the count.
    if (input.arm === "showcase") {
      await transaction
        .insert(showcaseLaunchStats)
        .values({ launchId: targetId, commentCount: 1 })
        .onConflictDoUpdate({
          target: showcaseLaunchStats.launchId,
          set: {
            commentCount: increment(showcaseLaunchStats.commentCount),
            updatedAt: sql`now()`,
          },
        });
    } else {
      await transaction
        .insert(teardownStats)
        .values({ teardownId: targetId, commentCount: 1 })
        .onConflictDoUpdate({
          target: teardownStats.teardownId,
          set: { commentCount: increment(teardownStats.commentCount), updatedAt: sql`now()` },
        });
    }

    const [authorRow] = await transaction
      .select({ handle: user.handle, name: user.name, imageUrl: user.image })
      .from(user)
      .where(eq(user.id, input.authorUserId));

    const author: BlueprintCommentAuthorView | null =
      authorRow === undefined
        ? null
        : {
            displayName: authorRow.name,
            handle: authorRow.handle,
            avatarUrl: authorRow.imageUrl,
          };

    return { kind: "created", comment: inserted, author } as const;
  });

  switch (outcome.kind) {
    case "parentNotOnTarget":
      return {
        success: false,
        error: {
          type: "BLUEPRINT_PARENT_COMMENT_NOT_ON_TARGET",
          parentCommentId: input.parentCommentId ?? "",
        },
      };
    case "replyTooDeep":
      return {
        success: false,
        error: {
          type: "BLUEPRINT_REPLY_DEPTH_EXCEEDED",
          parentCommentId: input.parentCommentId ?? "",
        },
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
      throw new Error(`Unhandled blueprint comment outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Finds one comment on either arm by id alone.
 *
 * ⚠️ TWO POINT LOOKUPS RATHER THAN AN ARM PARAMETER, because `/blueprints/comments/:commentId`
 * carries no arm — the frontend addresses a comment by a globally unique id and should not have to
 * know which table holds it. Both are primary-key lookups, so the cost is two index probes.
 */
async function findCommentArm(commentId: string): Promise<
  | {
      readonly arm: "showcase";
      readonly targetId: string;
      readonly authorUserId: string | null;
      readonly isDeleted: boolean;
      readonly parentCommentId: string | null;
    }
  | {
      readonly arm: "teardown";
      readonly targetId: string;
      readonly authorUserId: string | null;
      readonly isDeleted: boolean;
      readonly parentCommentId: string | null;
    }
  | null
> {
  const [showcaseRow] = await db
    .select({
      targetId: showcaseLaunchComment.launchId,
      authorUserId: showcaseLaunchComment.authorUserId,
      isDeleted: showcaseLaunchComment.isDeleted,
      parentCommentId: showcaseLaunchComment.parentCommentId,
    })
    .from(showcaseLaunchComment)
    .where(eq(showcaseLaunchComment.id, commentId));
  if (showcaseRow) return { arm: "showcase", ...showcaseRow };

  const [teardownRow] = await db
    .select({
      targetId: teardownComment.teardownId,
      authorUserId: teardownComment.authorUserId,
      isDeleted: teardownComment.isDeleted,
      parentCommentId: teardownComment.parentCommentId,
    })
    .from(teardownComment)
    .where(eq(teardownComment.id, commentId));
  if (teardownRow) return { arm: "teardown", ...teardownRow };

  return null;
}

/**
 * `PATCH /blueprints/comments/:commentId` — the author's own words, and nobody else's.
 *
 * A 403 rather than a 404, because the caller has already SEEN this comment and its author in the
 * public listing: refusing tells them nothing they did not know.
 */
export async function updateBlueprintComment(input: {
  readonly commentId: string;
  readonly authorUserId: string;
  readonly bodyText: string;
}): Promise<
  Result<
    { readonly commentId: string; readonly body: string; readonly updatedAt: Date },
    BlueprintCommentError
  >
> {
  const existing = await findCommentArm(input.commentId);
  if (!existing || existing.isDeleted) {
    return {
      success: false,
      error: { type: "BLUEPRINT_COMMENT_NOT_FOUND", commentId: input.commentId },
    };
  }
  if (existing.authorUserId !== input.authorUserId) {
    return {
      success: false,
      error: { type: "BLUEPRINT_COMMENT_NOT_AUTHOR", commentId: input.commentId },
    };
  }

  const updated =
    existing.arm === "showcase"
      ? (
          await db
            .update(showcaseLaunchComment)
            .set({ bodyText: input.bodyText })
            .where(eq(showcaseLaunchComment.id, input.commentId))
            .returning({
              id: showcaseLaunchComment.id,
              bodyText: showcaseLaunchComment.bodyText,
              updatedAt: showcaseLaunchComment.updatedAt,
            })
        )[0]
      : (
          await db
            .update(teardownComment)
            .set({ bodyText: input.bodyText })
            .where(eq(teardownComment.id, input.commentId))
            .returning({
              id: teardownComment.id,
              bodyText: teardownComment.bodyText,
              updatedAt: teardownComment.updatedAt,
            })
        )[0];

  if (!updated) {
    return {
      success: false,
      error: { type: "BLUEPRINT_COMMENT_NOT_FOUND", commentId: input.commentId },
    };
  }

  return {
    success: true,
    value: { commentId: updated.id, body: updated.bodyText, updatedAt: updated.updatedAt },
  };
}

/**
 * `DELETE /blueprints/comments/:commentId` — a TOMBSTONE, never a row delete.
 *
 * ⚠️ THE ROW SURVIVES SO ITS REPLIES KEEP THEIR ANCHOR. Hard-deleting a parent would cascade its
 * replies away, silently removing the conversation under it. `*_comment_body_ck` demands the empty
 * string once `is_deleted` is true, so the text genuinely leaves the table rather than being
 * hidden by a rendering convention the next reader can forget.
 *
 * The comment counter decrements because it counts what is RENDERED as a comment, and a tombstone
 * is not one.
 */
export async function deleteBlueprintComment(input: {
  readonly commentId: string;
  readonly authorUserId: string;
}): Promise<Result<{ readonly commentId: string }, BlueprintCommentError>> {
  const existing = await findCommentArm(input.commentId);
  if (!existing) {
    return {
      success: false,
      error: { type: "BLUEPRINT_COMMENT_NOT_FOUND", commentId: input.commentId },
    };
  }
  if (existing.authorUserId !== input.authorUserId) {
    return {
      success: false,
      error: { type: "BLUEPRINT_COMMENT_NOT_AUTHOR", commentId: input.commentId },
    };
  }
  if (existing.isDeleted) {
    return {
      success: false,
      error: { type: "BLUEPRINT_COMMENT_ALREADY_DELETED", commentId: input.commentId },
    };
  }

  await db.transaction(async (transaction) => {
    if (existing.arm === "showcase") {
      await transaction
        .update(showcaseLaunchComment)
        .set({ isDeleted: true, deletedAt: sql`now()`, bodyText: "" })
        .where(eq(showcaseLaunchComment.id, input.commentId));
      if (existing.parentCommentId !== null) {
        await transaction
          .update(showcaseLaunchComment)
          .set({ replyCount: decrement(showcaseLaunchComment.replyCount) })
          .where(eq(showcaseLaunchComment.id, existing.parentCommentId));
      }
      await transaction
        .insert(showcaseLaunchStats)
        .values({ launchId: existing.targetId, commentCount: 0 })
        .onConflictDoUpdate({
          target: showcaseLaunchStats.launchId,
          set: {
            commentCount: decrement(showcaseLaunchStats.commentCount),
            updatedAt: sql`now()`,
          },
        });
      return;
    }

    await transaction
      .update(teardownComment)
      .set({ isDeleted: true, deletedAt: sql`now()`, bodyText: "" })
      .where(eq(teardownComment.id, input.commentId));
    if (existing.parentCommentId !== null) {
      await transaction
        .update(teardownComment)
        .set({ replyCount: decrement(teardownComment.replyCount) })
        .where(eq(teardownComment.id, existing.parentCommentId));
    }
    await transaction
      .insert(teardownStats)
      .values({ teardownId: existing.targetId, commentCount: 0 })
      .onConflictDoUpdate({
        target: teardownStats.teardownId,
        set: { commentCount: decrement(teardownStats.commentCount), updatedAt: sql`now()` },
      });
  });

  return { success: true, value: { commentId: input.commentId } };
}

/** Sets or clears one viewer's like on one comment. Same composite-key idempotence as the arms'. */
export async function setBlueprintCommentLike(input: {
  readonly commentId: string;
  readonly userId: string;
  readonly isSet: boolean;
}): Promise<
  Result<{ readonly isSet: boolean; readonly likeCount: number }, BlueprintCommentError>
> {
  const existing = await findCommentArm(input.commentId);
  if (!existing || existing.isDeleted) {
    return {
      success: false,
      error: { type: "BLUEPRINT_COMMENT_NOT_FOUND", commentId: input.commentId },
    };
  }

  const likeCount = await db.transaction(async (transaction) => {
    if (existing.arm === "showcase") {
      const changed = input.isSet
        ? await transaction
            .insert(showcaseLaunchCommentLike)
            .values({ commentId: input.commentId, userId: input.userId })
            .onConflictDoNothing()
            .returning({ userId: showcaseLaunchCommentLike.userId })
        : await transaction
            .delete(showcaseLaunchCommentLike)
            .where(
              and(
                eq(showcaseLaunchCommentLike.commentId, input.commentId),
                eq(showcaseLaunchCommentLike.userId, input.userId),
              ),
            )
            .returning({ userId: showcaseLaunchCommentLike.userId });
      if (changed.length > 0) {
        await transaction
          .update(showcaseLaunchComment)
          .set({
            likeCount: input.isSet
              ? increment(showcaseLaunchComment.likeCount)
              : decrement(showcaseLaunchComment.likeCount),
          })
          .where(eq(showcaseLaunchComment.id, input.commentId));
      }
      const [row] = await transaction
        .select({ likeCount: showcaseLaunchComment.likeCount })
        .from(showcaseLaunchComment)
        .where(eq(showcaseLaunchComment.id, input.commentId));
      return row?.likeCount ?? 0;
    }

    const changed = input.isSet
      ? await transaction
          .insert(teardownCommentLike)
          .values({ commentId: input.commentId, userId: input.userId })
          .onConflictDoNothing()
          .returning({ userId: teardownCommentLike.userId })
      : await transaction
          .delete(teardownCommentLike)
          .where(
            and(
              eq(teardownCommentLike.commentId, input.commentId),
              eq(teardownCommentLike.userId, input.userId),
            ),
          )
          .returning({ userId: teardownCommentLike.userId });
    if (changed.length > 0) {
      await transaction
        .update(teardownComment)
        .set({
          likeCount: input.isSet
            ? increment(teardownComment.likeCount)
            : decrement(teardownComment.likeCount),
        })
        .where(eq(teardownComment.id, input.commentId));
    }
    const [row] = await transaction
      .select({ likeCount: teardownComment.likeCount })
      .from(teardownComment)
      .where(eq(teardownComment.id, input.commentId));
    return row?.likeCount ?? 0;
  });

  return { success: true, value: { isSet: input.isSet, likeCount } };
}
