import { randomUUID } from "node:crypto";

import { and, asc, count, eq, like, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
// `research_program_paper` is deliberately absent: it appears only inside the raw-SQL count
// subquery below, by name — see the note there, which explains why interpolating column
// objects into a correlated subquery produced a silently-wrong predicate.
import { researchProgramBranch, researchProgramBranchClaim } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { escapeLikePattern } from "#src/lib/sql-pattern.js";
import type { ProgramAccessError } from "#src/services/research-program-access.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The §10 research branch tree (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * TWO THINGS THIS SERVICE WILL NOT DO, and both are the point of the surface:
 *
 *  1. **It never writes `status` or `overlappingGroupCount`.** Those are derived by
 *     `recompute-branch-signals` from claims, paper coverage and inter-branch similarity.
 *     A contributor who could mark their own branch `active`, or a rival's `missing`,
 *     would make the map worthless — and the map's two claims ("nobody is working on
 *     this" and "several groups are duplicating work") are the whole reason the surface
 *     exists. There is deliberately no exported function here that sets either, only the
 *     one the job calls.
 *  2. **It never accepts a canvas position.** Layout is the client's job (§6's same ruling
 *     for `mapPosition`); `pinnedLeftPermille`/`pinnedTopPermille` are a curator override,
 *     not a coordinate a contributor supplies.
 *
 * `ancestorPath` IS MAINTAINED HERE AND NOWHERE ELSE. It is a materialized prefix path so
 * a subtree query is a `LIKE 'prefix%'` rather than a recursive CTE, and it is
 * `COLLATE "C"` (migration 0029) so Postgres's ordering and a client's string compare
 * agree. Every function that can move a node rewrites the affected subtree in the SAME
 * transaction — a half-rewritten tree is a tree with two roots and an unrenderable graph.
 */

export type ResearchProgramBranchStatus = (typeof researchProgramBranch.$inferSelect)["status"];

export type ResearchProgramBranchError =
  | ProgramAccessError
  | { type: "BRANCH_NOT_FOUND"; branchId: string }
  | { type: "PARENT_BRANCH_NOT_FOUND"; branchId: string }
  | { type: "BRANCH_CYCLE"; branchId: string }
  | { type: "BRANCH_DEPTH_EXCEEDED"; maxDepth: number }
  | { type: "BRANCH_HAS_CHILDREN"; childCount: number };

/**
 * How deep the tree may go.
 *
 * Not an arbitrary bound: `ancestor_path` is capped at 800 characters by its CHECK, and
 * each level costs a 36-character uuid plus a separator. Eight levels is ~300 characters,
 * comfortably inside it, and is already deeper than any research taxonomy a human will
 * navigate on one canvas. Bounding it here means the CHECK is never the thing a user
 * meets.
 */
export const MAX_BRANCH_DEPTH = 8;

/** How many nodes one program's tree may hold, and therefore one read may return. */
export const MAX_BRANCH_TREE_SIZE = 500;

/**
 * One branch as read back to a client.
 *
 * `contributorCount` is a COUNT over `research_program_branch_claim`, never a column —
 * a counter that can disagree with its rows eventually does, and this one is cheap
 * because the claim table's unique index leads with `branch_id`.
 *
 * There is no `canvasPosition`. `parentBranchId` + `siblingOrder` is what the client lays
 * out from; the two pinned per-mille values are present and normally null.
 */
export interface ResearchProgramBranchView {
  readonly branchId: string;
  readonly parentBranchId: string | null;
  readonly title: string;
  readonly summary: string;
  readonly ancestorPath: string;
  readonly siblingOrder: number;
  readonly depth: number;
  readonly status: ResearchProgramBranchStatus;
  readonly overlappingGroupCount: number;
  readonly contributorCount: number;
  readonly approvedPaperCount: number;
  /**
   * How many non-hidden threads are filed against this branch, and the newest few titles.
   *
   * Both come from `research_program_post.branchId`. A hidden post is excluded — the count says
   * how much public discussion there is, and a moderated-away thread is not public discussion.
   * An `idea` has no title, so the list falls back to a truncated body: the panel needs
   * something to render, and a blank line reads as a bug.
   */
  readonly discussionCount: number;
  readonly recentThreadTitles: readonly string[];
  readonly pinnedLeftPermille: number | null;
  readonly pinnedTopPermille: number | null;
  /** Whether THIS caller has claimed it. A property of the viewer, never a column. */
  readonly isClaimedByViewer: boolean;
  readonly createdAt: Date;
}

/**
 * A NOTE THAT APPLIES TO EVERY CORRELATED SUBQUERY IN THIS FILE, and to the four others
 * like it in the §10 services.
 *
 * The inner table is ALIASED and the outer reference is FULLY QUALIFIED, in raw SQL text
 * rather than by interpolating column objects. That is not stylistic. Interpolating
 * `${table.column}` into a `sql` template makes drizzle emit an UNQUALIFIED name — the
 * generated SQL reads `WHERE "branch_id" = "id"` — and inside a subquery the bare `"id"`
 * resolves against the INNER table, not the outer one. So the predicate becomes
 * `claim.branch_id = claim.id`, which is never true, and the count is silently always
 * zero. No error, no warning, just a wrong number on a public page.
 *
 * `pnpm db:smoke-research-programs` is what caught it, by asserting that claiming a branch
 * twice leaves `contributorCount` at 1 and finding 0.
 */
const CLAIM_COUNT_SUBQUERY = sql<number>`(
  SELECT COUNT(*)::int FROM research_program_branch_claim AS branch_claim_count
  WHERE branch_claim_count.branch_id = research_program_branch.id
)`;

const APPROVED_PAPER_COUNT_SUBQUERY = sql<number>`(
  SELECT COUNT(*)::int FROM research_program_paper AS branch_paper_count
  WHERE branch_paper_count.branch_id = research_program_branch.id
    AND branch_paper_count.moderation_status = 'approved'
)`;

/**
 * THREADS, not posts — `depth = 0` only.
 *
 * The branch panel labels this "N discussion threads", so it has to count threads. A reply
 * inherits its parent's `branchId`, so counting every row would report a five-reply conversation
 * as six threads, and the number beside the recent-title list (which is already `depth = 0`)
 * would disagree with the list itself.
 *
 * DELIBERATELY A DIFFERENT DEFINITION FROM the program-level `postCount` on the stat snapshot,
 * which DOES count replies: that tile measures how much discussion a program carries, and a
 * substantial reply is discussion. Two counts, two labels, two definitions — stated here so the
 * difference reads as a decision rather than an inconsistency.
 */
const DISCUSSION_COUNT_SUBQUERY = sql<number>`(
  SELECT COUNT(*)::int FROM research_program_post AS branch_post_count
  WHERE branch_post_count.branch_id = research_program_branch.id
    AND branch_post_count.is_hidden = false
    AND branch_post_count.depth = 0
)`;

/** `ancestor_path` separator. Excluded from every id, so a split is unambiguous. */
const PATH_SEPARATOR = "/";

/** Depth is derivable from the path, so it is not a second column that can disagree. */
function depthFromPath(ancestorPath: string): number {
  return ancestorPath.split(PATH_SEPARATOR).length - 1;
}

/**
 * The whole tree for one program, in one query.
 *
 * ORDERED BY `ancestorPath` — which is depth-first order, for free, because a child's path
 * is its parent's path plus a segment. That is the property `COLLATE "C"` protects: under
 * a locale collation the separator sorts unpredictably against alphanumerics and the
 * depth-first guarantee quietly stops holding.
 *
 * `viewerUserId` drives `isClaimedByViewer` with ONE extra query rather than N — a
 * per-node "have I claimed this" would be 38 round trips for a 38-node tree.
 */
export async function listProgramBranches(
  programId: string,
  viewerUserId: string | null,
): Promise<readonly ResearchProgramBranchView[]> {
  const [rows, viewerClaimedBranchIds, recentTitlesByBranch] = await Promise.all([
    db
      .select({
        branchId: researchProgramBranch.id,
        parentBranchId: researchProgramBranch.parentBranchId,
        title: researchProgramBranch.title,
        summary: researchProgramBranch.summary,
        ancestorPath: researchProgramBranch.ancestorPath,
        siblingOrder: researchProgramBranch.siblingOrder,
        status: researchProgramBranch.status,
        overlappingGroupCount: researchProgramBranch.overlappingGroupCount,
        pinnedLeftPermille: researchProgramBranch.pinnedLeftPermille,
        pinnedTopPermille: researchProgramBranch.pinnedTopPermille,
        createdAt: researchProgramBranch.createdAt,
        contributorCount: CLAIM_COUNT_SUBQUERY,
        approvedPaperCount: APPROVED_PAPER_COUNT_SUBQUERY,
        discussionCount: DISCUSSION_COUNT_SUBQUERY,
      })
      .from(researchProgramBranch)
      .where(eq(researchProgramBranch.programId, programId))
      .orderBy(asc(researchProgramBranch.ancestorPath))
      .limit(MAX_BRANCH_TREE_SIZE),
    viewerUserId === null
      ? Promise.resolve([])
      : listViewerClaimedBranchIds(programId, viewerUserId),
    listRecentThreadTitlesByBranch(programId),
  ]);

  const claimedSet = new Set(viewerClaimedBranchIds);

  return rows.map((row) => ({
    ...row,
    depth: depthFromPath(row.ancestorPath),
    isClaimedByViewer: claimedSet.has(row.branchId),
    recentThreadTitles: recentTitlesByBranch.get(row.branchId) ?? [],
  }));
}

/** How many recent thread titles the branch panel shows per node. */
const RECENT_THREAD_TITLE_LIMIT = 3;

/**
 * The newest few thread titles per branch, for the whole tree in ONE query.
 *
 * A `ROW_NUMBER()` window partitioned by branch, rather than one query per node: the map draws up
 * to 500 branches, and per-node reads would be 500 round trips for a panel that shows three lines.
 *
 * An `idea` carries no title by construction, so its body is truncated instead — the panel needs
 * a line to render, and an empty one reads as a bug rather than as an untitled post.
 *
 * `depth = 0` only: a reply is part of a thread, not a thread of its own.
 */
async function listRecentThreadTitlesByBranch(
  programId: string,
): Promise<ReadonlyMap<string, string[]>> {
  const result = await db.execute<{ branch_id: string; thread_title: string }>(sql`
    SELECT branch_id, thread_title FROM (
      SELECT
        p.branch_id,
        COALESCE(NULLIF(p.title, ''), LEFT(p.body_text, 80)) AS thread_title,
        ROW_NUMBER() OVER (
          PARTITION BY p.branch_id ORDER BY p.created_at DESC, p.id DESC
        ) AS row_position
      FROM research_program_post AS p
      WHERE p.program_id = ${programId}
        AND p.branch_id IS NOT NULL
        AND p.is_hidden = false
        AND p.depth = 0
    ) AS ranked
    WHERE ranked.row_position <= ${RECENT_THREAD_TITLE_LIMIT}
  `);

  const titlesByBranch = new Map<string, string[]>();
  for (const row of result.rows) {
    const existing = titlesByBranch.get(row.branch_id);
    if (existing) existing.push(row.thread_title);
    else titlesByBranch.set(row.branch_id, [row.thread_title]);
  }
  return titlesByBranch;
}

/** Which branches in this program the viewer has claimed. One query for the whole tree. */
async function listViewerClaimedBranchIds(
  programId: string,
  viewerUserId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ branchId: researchProgramBranchClaim.branchId })
    .from(researchProgramBranchClaim)
    .innerJoin(
      researchProgramBranch,
      eq(researchProgramBranch.id, researchProgramBranchClaim.branchId),
    )
    .where(
      and(
        eq(researchProgramBranchClaim.userId, viewerUserId),
        eq(researchProgramBranch.programId, programId),
      ),
    );

  return rows.map((row) => row.branchId);
}

/**
 * Creates a branch, deriving its `ancestorPath` from its parent's.
 *
 * `siblingOrder` is SERVER-DERIVED as "one past the current maximum among siblings",
 * never taken from the body: a client choosing its own ordinal races every other client
 * doing the same and the tree renders in a different order than it was authored in.
 * Reordering is a separate, explicit operation.
 *
 * Runs in a transaction and locks the parent, so two concurrent children cannot compute
 * the same `siblingOrder` from the same stale maximum.
 */
export async function createProgramBranch(input: {
  readonly programId: string;
  readonly title: string;
  readonly summary: string;
  readonly parentBranchId: string | null;
  readonly createdByUserId: string;
}): Promise<Result<{ readonly branchId: string }, ResearchProgramBranchError>> {
  const outcome = await db.transaction(async (tx) => {
    let parentPath: string | null = null;

    if (input.parentBranchId !== null) {
      const [parent] = await tx
        .select({
          id: researchProgramBranch.id,
          ancestorPath: researchProgramBranch.ancestorPath,
        })
        .from(researchProgramBranch)
        // BOTH columns in the WHERE: a branch id belonging to ANOTHER program must be
        // indistinguishable from a nonexistent one, or this is a cross-program probe.
        .where(
          and(
            eq(researchProgramBranch.id, input.parentBranchId),
            eq(researchProgramBranch.programId, input.programId),
          ),
        )
        .for("update");

      if (!parent) return { kind: "parent-missing" } as const;

      if (depthFromPath(parent.ancestorPath) + 1 >= MAX_BRANCH_DEPTH) {
        return { kind: "too-deep" } as const;
      }
      parentPath = parent.ancestorPath;
    }

    const [maxOrderRow] = await tx
      .select({
        // COALESCE, not a JS `?? -1`: an empty aggregate returns one row containing NULL,
        // not zero rows, so the fallback has to happen in SQL to be reachable.
        maxSiblingOrder: sql<number>`COALESCE(MAX(${researchProgramBranch.siblingOrder}), -1)::int`,
      })
      .from(researchProgramBranch)
      .where(
        and(
          eq(researchProgramBranch.programId, input.programId),
          input.parentBranchId === null
            ? sql`${researchProgramBranch.parentBranchId} IS NULL`
            : eq(researchProgramBranch.parentBranchId, input.parentBranchId),
        ),
      );

    const [inserted] = await tx
      .insert(researchProgramBranch)
      .values({
        programId: input.programId,
        parentBranchId: input.parentBranchId,
        title: input.title,
        summary: input.summary,
        // A placeholder the UPDATE below replaces. The path contains the row's own id, so
        // it cannot be computed before the id exists, and the column is NOT NULL. Unique
        // per row so two concurrent inserts cannot collide on the placeholder itself.
        ancestorPath: `pending-${randomUUID()}`,
        siblingOrder: (maxOrderRow?.maxSiblingOrder ?? -1) + 1,
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: researchProgramBranch.id });

    if (!inserted) throw new Error("createProgramBranch: insert returned no row");

    const ancestorPath =
      parentPath === null ? inserted.id : `${parentPath}${PATH_SEPARATOR}${inserted.id}`;

    await tx
      .update(researchProgramBranch)
      .set({ ancestorPath })
      .where(eq(researchProgramBranch.id, inserted.id));

    return { kind: "created", branchId: inserted.id } as const;
  });

  switch (outcome.kind) {
    case "parent-missing":
      return {
        success: false,
        error: { type: "PARENT_BRANCH_NOT_FOUND", branchId: input.parentBranchId ?? "" },
      };
    case "too-deep":
      return {
        success: false,
        error: { type: "BRANCH_DEPTH_EXCEEDED", maxDepth: MAX_BRANCH_DEPTH },
      };
    case "created":
      return { success: true, value: { branchId: outcome.branchId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled branch create outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Edits a branch, optionally RE-PARENTING it.
 *
 * Re-parenting is the hard case and is why this is one function rather than two. Moving a
 * node rewrites `ancestorPath` for the node AND every descendant, in one transaction,
 * because a subtree whose paths half-agree with their parents is a tree with two roots.
 *
 * THE CYCLE CHECK IS A PREFIX TEST, not a walk: a node cannot be re-parented under its own
 * descendant, and "is the proposed parent inside my subtree" is exactly
 * `newParent.ancestorPath` starting with `mine`. That is the property the materialized
 * path buys — a recursive walk here would be one query per level, racing anyone else's
 * move.
 */
export async function updateProgramBranch(input: {
  readonly programId: string;
  readonly branchId: string;
  readonly title?: string | undefined;
  readonly summary?: string | undefined;
  readonly siblingOrder?: number | undefined;
  readonly pinnedLeftPermille?: number | null | undefined;
  readonly pinnedTopPermille?: number | null | undefined;
  /** `undefined` leaves the parent alone; `null` makes it a root. */
  readonly parentBranchId?: string | null | undefined;
}): Promise<Result<{ readonly branchId: string }, ResearchProgramBranchError>> {
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: researchProgramBranch.id,
        ancestorPath: researchProgramBranch.ancestorPath,
        parentBranchId: researchProgramBranch.parentBranchId,
      })
      .from(researchProgramBranch)
      .where(
        and(
          eq(researchProgramBranch.id, input.branchId),
          eq(researchProgramBranch.programId, input.programId),
        ),
      )
      .for("update");

    if (!existing) return { kind: "missing" } as const;

    const isReparenting =
      input.parentBranchId !== undefined && input.parentBranchId !== existing.parentBranchId;

    let nextPath: string | null = null;

    if (isReparenting) {
      // Re-parenting to null makes it a root; its own id becomes the whole path.
      if (input.parentBranchId === null) {
        nextPath = existing.id;
      } else {
        if (input.parentBranchId === existing.id) return { kind: "cycle" } as const;

        const [newParent] = await tx
          .select({
            id: researchProgramBranch.id,
            ancestorPath: researchProgramBranch.ancestorPath,
          })
          .from(researchProgramBranch)
          .where(
            and(
              eq(researchProgramBranch.id, input.parentBranchId),
              eq(researchProgramBranch.programId, input.programId),
            ),
          )
          .for("update");

        if (!newParent) return { kind: "parent-missing" } as const;

        // The prefix test. `${mine}/` rather than `${mine}` so a sibling whose id merely
        // starts with the same characters is not mistaken for a descendant.
        if (newParent.ancestorPath.startsWith(`${existing.ancestorPath}${PATH_SEPARATOR}`)) {
          return { kind: "cycle" } as const;
        }

        const subtreeDepth = await measureSubtreeDepth(tx, input.programId, existing.ancestorPath);
        if (depthFromPath(newParent.ancestorPath) + 1 + subtreeDepth >= MAX_BRANCH_DEPTH) {
          return { kind: "too-deep" } as const;
        }

        nextPath = `${newParent.ancestorPath}${PATH_SEPARATOR}${existing.id}`;
      }
    }

    await tx
      .update(researchProgramBranch)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.siblingOrder === undefined ? {} : { siblingOrder: input.siblingOrder }),
        ...(input.pinnedLeftPermille === undefined
          ? {}
          : { pinnedLeftPermille: input.pinnedLeftPermille }),
        ...(input.pinnedTopPermille === undefined
          ? {}
          : { pinnedTopPermille: input.pinnedTopPermille }),
        // `nextPath !== null` rather than `isReparenting`: the two are equivalent by
        // construction, but only the null check narrows the type, and a NOT NULL column
        // must not be handed a nullable value even on an unreachable branch.
        ...(nextPath === null
          ? {}
          : { parentBranchId: input.parentBranchId ?? null, ancestorPath: nextPath }),
        // `status` and `overlappingGroupCount` are absent. See the header note — they are
        // the job's, and there is no code path here that can set them.
      })
      .where(eq(researchProgramBranch.id, input.branchId));

    if (isReparenting && nextPath !== null) {
      // Rewrite every descendant's path by swapping the old prefix for the new one.
      // Done in SQL over the subtree rather than row by row, so the whole move is one
      // statement and cannot be observed half-applied.
      const oldPrefix = `${existing.ancestorPath}${PATH_SEPARATOR}`;
      await tx
        .update(researchProgramBranch)
        .set({
          /**
           * `RIGHT(path, LENGTH(path) - oldLength)` keeps the tail INCLUDING its leading
           * separator, so the new path is `nextPath || "/descendant..."`.
           *
           * NOT `SUBSTRING(path FROM n)`. With `n` arriving as a bound parameter of unknown
           * type, Postgres resolves that call to the REGEX overload
           * `substring(text FROM pattern)` rather than the positional one — so it matches the
           * number as a pattern and returns a fragment or NULL. `RIGHT(text, integer)` has no
           * ambiguous overload. `pnpm db:smoke-research-programs` caught the original by
           * asserting a re-parented subtree's path.
           */
          ancestorPath: sql`${nextPath} || RIGHT(${researchProgramBranch.ancestorPath}, LENGTH(${researchProgramBranch.ancestorPath}) - ${existing.ancestorPath.length})`,
        })
        .where(
          and(
            eq(researchProgramBranch.programId, input.programId),
            like(researchProgramBranch.ancestorPath, `${escapeLikePattern(oldPrefix)}%`),
          ),
        );
    }

    return { kind: "updated" } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "BRANCH_NOT_FOUND", branchId: input.branchId } };
    case "parent-missing":
      return {
        success: false,
        error: { type: "PARENT_BRANCH_NOT_FOUND", branchId: input.parentBranchId ?? "" },
      };
    case "cycle":
      return { success: false, error: { type: "BRANCH_CYCLE", branchId: input.branchId } };
    case "too-deep":
      return {
        success: false,
        error: { type: "BRANCH_DEPTH_EXCEEDED", maxDepth: MAX_BRANCH_DEPTH },
      };
    case "updated":
      return { success: true, value: { branchId: input.branchId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled branch update outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** How many levels hang below this path. Bounds a move before it makes the tree too deep. */
async function measureSubtreeDepth(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  programId: string,
  ancestorPath: string,
): Promise<number> {
  const [row] = await tx
    .select({
      maxPathLength: sql<number>`COALESCE(MAX(LENGTH(${researchProgramBranch.ancestorPath}) - LENGTH(REPLACE(${researchProgramBranch.ancestorPath}, ${PATH_SEPARATOR}, ''))), 0)::int`,
    })
    .from(researchProgramBranch)
    .where(
      and(
        eq(researchProgramBranch.programId, programId),
        like(researchProgramBranch.ancestorPath, `${escapeLikePattern(ancestorPath)}%`),
      ),
    );

  return Math.max(0, (row?.maxPathLength ?? 0) - depthFromPath(ancestorPath));
}

/**
 * Claims a branch. IDEMPOTENT.
 *
 * The unique index `(branch_id, user_id)` is the entire mechanism: insert, and treat 23505
 * as success because the caller's desired end state — "I am on this branch" — is already
 * true. That is what makes a double-tap on a slow connection harmless, and it is why the
 * route is a plain POST rather than needing an idempotency key.
 */
export async function claimProgramBranch(input: {
  readonly programId: string;
  readonly branchId: string;
  readonly userId: string;
}): Promise<Result<{ readonly claimed: true }, ResearchProgramBranchError>> {
  const [branch] = await db
    .select({ id: researchProgramBranch.id })
    .from(researchProgramBranch)
    .where(
      and(
        eq(researchProgramBranch.id, input.branchId),
        eq(researchProgramBranch.programId, input.programId),
      ),
    );

  if (!branch) {
    return { success: false, error: { type: "BRANCH_NOT_FOUND", branchId: input.branchId } };
  }

  try {
    await db
      .insert(researchProgramBranchClaim)
      .values({ branchId: input.branchId, userId: input.userId });
  } catch (insertError: unknown) {
    // Already claimed by this user — the end state is what was asked for.
    if (!isUniqueViolation(insertError)) throw insertError;
  }

  return { success: true, value: { claimed: true } };
}

/**
 * Releases a claim. IDEMPOTENT in the same way — deleting an absent row reaches the same
 * end state, so it is a success rather than a 404.
 */
export async function releaseProgramBranchClaim(input: {
  readonly programId: string;
  readonly branchId: string;
  readonly userId: string;
}): Promise<Result<{ readonly released: true }, ResearchProgramBranchError>> {
  const [branch] = await db
    .select({ id: researchProgramBranch.id })
    .from(researchProgramBranch)
    .where(
      and(
        eq(researchProgramBranch.id, input.branchId),
        eq(researchProgramBranch.programId, input.programId),
      ),
    );

  if (!branch) {
    return { success: false, error: { type: "BRANCH_NOT_FOUND", branchId: input.branchId } };
  }

  await db
    .delete(researchProgramBranchClaim)
    .where(
      and(
        eq(researchProgramBranchClaim.branchId, input.branchId),
        eq(researchProgramBranchClaim.userId, input.userId),
      ),
    );

  return { success: true, value: { released: true } };
}

/** Resolves one branch within a program. Used to validate a paper's or opportunity's `branchId`. */
export async function findBranchInProgram(
  programId: string,
  branchId: string,
): Promise<{ readonly branchId: string; readonly title: string } | null> {
  const [row] = await db
    .select({ branchId: researchProgramBranch.id, title: researchProgramBranch.title })
    .from(researchProgramBranch)
    .where(
      and(eq(researchProgramBranch.id, branchId), eq(researchProgramBranch.programId, programId)),
    );

  return row ?? null;
}

/** Counts a program's branches, for the stats job. */
export async function countProgramBranches(programId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(researchProgramBranch)
    .where(eq(researchProgramBranch.programId, programId));

  return row?.total ?? 0;
}
