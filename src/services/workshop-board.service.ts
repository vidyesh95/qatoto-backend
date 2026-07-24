import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { projectMember, workshopBoardColumn, workshopTask } from "#src/db/schema.js";
import { initialRanks, rankBetween } from "#src/lib/lexorank.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The workshop kanban board — columns and task cards
 * (R_AND_D_BACKEND_STRUCTURE.md §8, §11d).
 *
 * EVERY FUNCTION HERE TAKES AN ALREADY-PROVEN projectId. The caller reaches it through
 * `requireProjectRole(slug, userId, "contributor")`, which returns 404 for a stranger, a
 * non-member and an under-privileged member alike (§4a). Nothing in this file re-derives
 * authorization, and nothing in it may be called without that proof.
 *
 * CHILD IDS ARE FILTERED BY projectId IN THE `WHERE`, NEVER POST-CHECKED. A columnId or
 * taskId belonging to another project must be indistinguishable from one that does not
 * exist, or every endpoint here becomes a cross-tenant probe. This is the same rule
 * project-membership.service.ts applies to memberId.
 *
 * TWO ORDERING MECHANISMS, DELIBERATELY DIFFERENT (§8):
 *   - Columns use a contiguous integer `position`. A board has a handful of columns,
 *     reordered rarely and by one person, so a re-pack is two rows in a transaction — and
 *     the DEFERRABLE unique constraint lets that transaction pass through a state where
 *     two columns briefly share a position.
 *   - Tasks use a lexicographic `rank` (src/lib/lexorank.ts). Cards are dragged
 *     concurrently, where a re-pack is a write storm and a lost move.
 */

/** A board cannot grow without bound; twelve is past any real workflow. */
const MAX_COLUMNS_PER_BOARD = 12;

/** Bounded retries for a rank collision — two members dropping into the same gap. */
const MOVE_ATTEMPT_LIMIT = 3;

export type WorkshopBoardError =
  | ProjectAccessError
  | { type: "COLUMN_NOT_FOUND"; columnId: string }
  | { type: "TASK_NOT_FOUND"; taskId: string }
  | { type: "COLUMN_LIMIT_REACHED"; limit: number }
  | { type: "COLUMN_NOT_EMPTY"; taskCount: number }
  | { type: "COLUMN_SET_MISMATCH" }
  | { type: "ASSIGNEE_NOT_A_MEMBER"; memberId: string }
  | { type: "MOVE_ANCHOR_INVALID" }
  | { type: "RANK_CONTENDED" };

export type WorkshopTaskPriority = (typeof workshopTask.$inferSelect)["priority"];

export interface WorkshopTaskView {
  readonly id: string;
  readonly columnId: string;
  readonly title: string;
  readonly description: string | null;
  readonly assigneeMemberId: string | null;
  readonly priority: WorkshopTaskPriority;
  readonly labels: readonly string[];
  /** Date-only ISO, the §1 wire format. The client formats it. */
  readonly dueDate: string | null;
  /**
   * Returned so a client can compute a drop's neighbours locally without a round trip.
   * It is READ-ONLY on the wire: no request body accepts a rank (§0).
   */
  readonly rank: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkshopBoardColumnView {
  readonly id: string;
  readonly title: string;
  readonly position: number;
  readonly tasks: readonly WorkshopTaskView[];
}

export interface CreateColumnInput {
  readonly title: string;
}

export interface CreateTaskInput {
  readonly columnId: string;
  readonly title: string;
  // `null` is distinct from absent on every clearable field here: absent leaves the
  // column alone on a PATCH, null clears it. Collapsing them makes a partial update
  // silently erase a description.
  readonly description?: string | null | undefined;
  readonly assigneeMemberId?: string | null | undefined;
  readonly priority?: WorkshopTaskPriority | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly dueDate?: string | null | undefined;
}

export type UpdateTaskInput = Omit<Partial<CreateTaskInput>, "columnId">;

export interface MoveTaskInput {
  readonly columnId: string;
  /** The card this one lands directly BELOW — its neighbour with the lower rank. */
  readonly afterTaskId?: string | undefined;
  /** The card this one lands directly ABOVE — its neighbour with the higher rank. */
  readonly beforeTaskId?: string | undefined;
}

/** The whole board in render order: columns by position, tasks by rank. */
export async function getBoard(projectId: string): Promise<readonly WorkshopBoardColumnView[]> {
  const columns = await db
    .select({
      id: workshopBoardColumn.id,
      title: workshopBoardColumn.title,
      position: workshopBoardColumn.position,
    })
    .from(workshopBoardColumn)
    .where(eq(workshopBoardColumn.projectId, projectId))
    // §4c rule 4: ends in a unique column, so two columns that briefly shared a position
    // mid-reorder can never swap places between two reads.
    .orderBy(asc(workshopBoardColumn.position), asc(workshopBoardColumn.id));

  if (columns.length === 0) {
    return [];
  }

  const tasks = await db
    .select()
    .from(workshopTask)
    .where(eq(workshopTask.projectId, projectId))
    // The rank column is COLLATE "C" (migration 0013), so this ORDER BY is byte order —
    // the same order the client gets from a code-point compare.
    .orderBy(asc(workshopTask.columnId), asc(workshopTask.rank));

  return columns.map((column) => ({
    ...column,
    tasks: tasks.filter((task) => task.columnId === column.id).map(toTaskView),
  }));
}

function toTaskView(row: typeof workshopTask.$inferSelect): WorkshopTaskView {
  return {
    id: row.id,
    columnId: row.columnId,
    title: row.title,
    description: row.description,
    assigneeMemberId: row.assigneeMemberId,
    priority: row.priority,
    labels: row.labels,
    dueDate: row.dueDate,
    rank: row.rank,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Proves an assignee is an ACTIVE member of this project.
 *
 * The FK alone is not enough: it accepts any `project_member` row, including one from
 * another project entirely and one whose member has left. Assigning a card to a stranger
 * is a small thing; being able to confirm that a given member id exists on some other
 * project by watching which assignment succeeds is not.
 */
async function assigneeIsActiveMember(projectId: string, memberId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projectMember.id })
    .from(projectMember)
    .where(
      and(
        eq(projectMember.id, memberId),
        eq(projectMember.projectId, projectId),
        eq(projectMember.status, "active"),
      ),
    )
    .limit(1);

  return row !== undefined;
}

export async function createColumn(
  projectId: string,
  actorUserId: string,
  input: CreateColumnInput,
): Promise<Result<WorkshopBoardColumnView, WorkshopBoardError>> {
  const outcome = await db.transaction(async (tx) => {
    // FOR UPDATE on the project's existing columns: two concurrent creates would
    // otherwise both read the same max position and both insert it, which the DEFERRABLE
    // unique catches at COMMIT — as a 23505 the caller cannot act on rather than a queue.
    const existing = await tx
      .select({ id: workshopBoardColumn.id, position: workshopBoardColumn.position })
      .from(workshopBoardColumn)
      .where(eq(workshopBoardColumn.projectId, projectId))
      .orderBy(asc(workshopBoardColumn.position))
      .for("update");

    if (existing.length >= MAX_COLUMNS_PER_BOARD) {
      return { kind: "limit" } as const;
    }

    const [inserted] = await tx
      .insert(workshopBoardColumn)
      .values({
        projectId,
        title: input.title,
        position: existing.length,
        createdByUserId: actorUserId,
      })
      .returning({
        id: workshopBoardColumn.id,
        title: workshopBoardColumn.title,
        position: workshopBoardColumn.position,
      });

    if (!inserted) {
      throw new Error("createColumn: insert returned no row");
    }
    return { kind: "created", column: inserted } as const;
  });

  if (outcome.kind === "limit") {
    return {
      success: false,
      error: { type: "COLUMN_LIMIT_REACHED", limit: MAX_COLUMNS_PER_BOARD },
    };
  }
  return { success: true, value: { ...outcome.column, tasks: [] } };
}

export async function renameColumn(
  projectId: string,
  columnId: string,
  title: string,
): Promise<Result<WorkshopBoardColumnView, WorkshopBoardError>> {
  const [updated] = await db
    .update(workshopBoardColumn)
    .set({ title })
    // BOTH ids in the WHERE — see the cross-tenant note at the top of this file.
    .where(and(eq(workshopBoardColumn.id, columnId), eq(workshopBoardColumn.projectId, projectId)))
    .returning({
      id: workshopBoardColumn.id,
      title: workshopBoardColumn.title,
      position: workshopBoardColumn.position,
    });

  if (!updated) {
    return { success: false, error: { type: "COLUMN_NOT_FOUND", columnId } };
  }
  return { success: true, value: { ...updated, tasks: [] } };
}

/**
 * Deletes an EMPTY column and re-packs the positions after it.
 *
 * Refuses a column that still holds cards, even though the FK would cascade them. A
 * cascade here would silently delete other members' work on a mis-tap, and "move the
 * cards out first" is one extra action against an irreversible one. The cascade stays in
 * the schema for project archival, which is a different, deliberate operation.
 */
export async function deleteColumn(
  projectId: string,
  columnId: string,
): Promise<Result<{ readonly columnId: string }, WorkshopBoardError>> {
  const outcome = await db.transaction(async (tx) => {
    const [column] = await tx
      .select({ id: workshopBoardColumn.id, position: workshopBoardColumn.position })
      .from(workshopBoardColumn)
      .where(
        and(eq(workshopBoardColumn.id, columnId), eq(workshopBoardColumn.projectId, projectId)),
      )
      .for("update");

    if (!column) {
      return { kind: "not-found" } as const;
    }

    const tasksInColumn = await tx
      .select({ id: workshopTask.id })
      .from(workshopTask)
      .where(eq(workshopTask.columnId, columnId));

    if (tasksInColumn.length > 0) {
      return { kind: "not-empty", taskCount: tasksInColumn.length } as const;
    }

    await tx.delete(workshopBoardColumn).where(eq(workshopBoardColumn.id, columnId));

    // Close the gap, so `position` stays contiguous from 0 and a later create can rely on
    // `count` as the next position.
    await tx
      .update(workshopBoardColumn)
      .set({ position: sql`${workshopBoardColumn.position} - 1` })
      .where(
        and(
          eq(workshopBoardColumn.projectId, projectId),
          sql`${workshopBoardColumn.position} > ${column.position}`,
        ),
      );

    return { kind: "deleted" } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "COLUMN_NOT_FOUND", columnId } };
    case "not-empty":
      return { success: false, error: { type: "COLUMN_NOT_EMPTY", taskCount: outcome.taskCount } };
    case "deleted":
      return { success: true, value: { columnId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled deleteColumn outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Reorders the whole board in one transaction.
 *
 * `columnIds` must be EXACTLY the project's current column set — same members, no
 * duplicates, nothing missing. A partial list would leave the positions non-contiguous,
 * and accepting one would also let a caller learn whether a foreign column id exists by
 * watching which mismatch it gets.
 *
 * The intermediate states here violate `UNIQUE (project_id, position)` — that is why the
 * constraint is DEFERRABLE INITIALLY DEFERRED (migration 0013) and why this needs no
 * negative-position shuffle.
 */
export async function reorderColumns(
  projectId: string,
  columnIds: readonly string[],
): Promise<Result<readonly WorkshopBoardColumnView[], WorkshopBoardError>> {
  const outcome = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: workshopBoardColumn.id })
      .from(workshopBoardColumn)
      .where(eq(workshopBoardColumn.projectId, projectId))
      .for("update");

    const existingIds = new Set(existing.map((column) => column.id));
    const requestedIds = new Set(columnIds);

    if (
      requestedIds.size !== columnIds.length ||
      requestedIds.size !== existingIds.size ||
      columnIds.some((columnId) => !existingIds.has(columnId))
    ) {
      return { kind: "mismatch" } as const;
    }

    for (const [position, columnId] of columnIds.entries()) {
      await tx
        .update(workshopBoardColumn)
        .set({ position })
        .where(eq(workshopBoardColumn.id, columnId));
    }

    return { kind: "reordered" } as const;
  });

  if (outcome.kind === "mismatch") {
    return { success: false, error: { type: "COLUMN_SET_MISMATCH" } };
  }
  return { success: true, value: await getBoard(projectId) };
}

/** Appends a task to the end of its column. */
export async function createTask(
  projectId: string,
  actorUserId: string,
  input: CreateTaskInput,
): Promise<Result<WorkshopTaskView, WorkshopBoardError>> {
  if (
    input.assigneeMemberId != null &&
    !(await assigneeIsActiveMember(projectId, input.assigneeMemberId))
  ) {
    return {
      success: false,
      error: { type: "ASSIGNEE_NOT_A_MEMBER", memberId: input.assigneeMemberId },
    };
  }

  const outcome = await db.transaction(async (tx) => {
    const [column] = await tx
      .select({ id: workshopBoardColumn.id })
      .from(workshopBoardColumn)
      .where(
        and(
          eq(workshopBoardColumn.id, input.columnId),
          eq(workshopBoardColumn.projectId, projectId),
        ),
      );

    if (!column) {
      return { kind: "no-column" } as const;
    }

    // FOR UPDATE on the column's tasks: two concurrent creates must not compute the same
    // "after the last card" rank and collide on UNIQUE (column_id, rank).
    const lastTask = await tx
      .select({ rank: workshopTask.rank })
      .from(workshopTask)
      .where(eq(workshopTask.columnId, input.columnId))
      .orderBy(asc(workshopTask.rank))
      .for("update");

    const lastRank = lastTask.at(-1)?.rank ?? null;

    const [inserted] = await tx
      .insert(workshopTask)
      .values({
        projectId,
        columnId: input.columnId,
        title: input.title,
        description: input.description ?? null,
        assigneeMemberId: input.assigneeMemberId ?? null,
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        labels: [...(input.labels ?? [])],
        dueDate: input.dueDate ?? null,
        rank: rankBetween(lastRank, null),
        createdByUserId: actorUserId,
      })
      .returning();

    if (!inserted) {
      throw new Error("createTask: insert returned no row");
    }
    return { kind: "created", task: inserted } as const;
  });

  if (outcome.kind === "no-column") {
    return { success: false, error: { type: "COLUMN_NOT_FOUND", columnId: input.columnId } };
  }
  return { success: true, value: toTaskView(outcome.task) };
}

export async function updateTask(
  projectId: string,
  taskId: string,
  patch: UpdateTaskInput,
): Promise<Result<WorkshopTaskView, WorkshopBoardError>> {
  if (
    patch.assigneeMemberId != null &&
    !(await assigneeIsActiveMember(projectId, patch.assigneeMemberId))
  ) {
    return {
      success: false,
      error: { type: "ASSIGNEE_NOT_A_MEMBER", memberId: patch.assigneeMemberId },
    };
  }

  // Each key is spread only when PRESENT, so `undefined` (absent) and `null` (explicitly
  // cleared) stay distinguishable — a PATCH that omits `dueDate` must not erase it.
  const [updated] = await db
    .update(workshopTask)
    .set({
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.assigneeMemberId === undefined ? {} : { assigneeMemberId: patch.assigneeMemberId }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.labels === undefined ? {} : { labels: [...patch.labels] }),
      ...(patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
    })
    .where(and(eq(workshopTask.id, taskId), eq(workshopTask.projectId, projectId)))
    .returning();

  if (!updated) {
    return { success: false, error: { type: "TASK_NOT_FOUND", taskId } };
  }
  return { success: true, value: toTaskView(updated) };
}

export async function deleteTask(
  projectId: string,
  taskId: string,
): Promise<Result<{ readonly taskId: string }, WorkshopBoardError>> {
  const [deleted] = await db
    .delete(workshopTask)
    .where(and(eq(workshopTask.id, taskId), eq(workshopTask.projectId, projectId)))
    .returning({ id: workshopTask.id });

  if (!deleted) {
    return { success: false, error: { type: "TASK_NOT_FOUND", taskId } };
  }
  return { success: true, value: { taskId } };
}

/**
 * Moves a task, deriving its new rank SERVER-SIDE from its intended neighbours.
 *
 * The client sends ids and intent — `{ columnId, afterTaskId?, beforeTaskId? }` — and
 * never a rank (§0). A client-supplied rank is a client-supplied sort order, and one that
 * sends the same string for every card corrupts the board for the whole team.
 *
 * Both anchors must live in the TARGET column, and `after` must actually precede
 * `before`. A stale board (a card another member moved away a second ago) therefore fails
 * with MOVE_ANCHOR_INVALID rather than dropping the card in an arbitrary place.
 *
 * Retries a rank collision a bounded number of times: two members dropping into the same
 * gap at the same instant both compute the same midpoint, and the loser's second attempt
 * sees the winner's row and picks a different one.
 */
export async function moveTask(
  projectId: string,
  taskId: string,
  input: MoveTaskInput,
): Promise<Result<WorkshopTaskView, WorkshopBoardError>> {
  for (let attempt = 0; attempt < MOVE_ATTEMPT_LIMIT; attempt += 1) {
    const outcome = await attemptMove(projectId, taskId, input);
    if (outcome.kind !== "contended") {
      return outcome.result;
    }
  }

  // Bounded, because an unbounded retry against a genuinely hot gap is an outage rather
  // than a wait. The client re-reads the board and drops again.
  return { success: false, error: { type: "RANK_CONTENDED" } };
}

async function attemptMove(
  projectId: string,
  taskId: string,
  input: MoveTaskInput,
): Promise<
  | { readonly kind: "settled"; readonly result: Result<WorkshopTaskView, WorkshopBoardError> }
  | { readonly kind: "contended" }
> {
  try {
    const outcome = await db.transaction(async (tx) => {
      const [task] = await tx
        .select({ id: workshopTask.id })
        .from(workshopTask)
        .where(and(eq(workshopTask.id, taskId), eq(workshopTask.projectId, projectId)))
        .for("update");

      if (!task) {
        return { kind: "no-task" } as const;
      }

      const [column] = await tx
        .select({ id: workshopBoardColumn.id })
        .from(workshopBoardColumn)
        .where(
          and(
            eq(workshopBoardColumn.id, input.columnId),
            eq(workshopBoardColumn.projectId, projectId),
          ),
        );

      if (!column) {
        return { kind: "no-column" } as const;
      }

      const anchorIds = [input.afterTaskId, input.beforeTaskId].filter(
        (anchorId): anchorId is string => anchorId !== undefined,
      );

      const anchors =
        anchorIds.length === 0
          ? []
          : await tx
              .select({ id: workshopTask.id, rank: workshopTask.rank })
              .from(workshopTask)
              .where(
                and(
                  inArray(workshopTask.id, anchorIds),
                  // The anchors must be in the TARGET column. A card cannot be dropped
                  // between two neighbours it is not going to sit next to.
                  eq(workshopTask.columnId, input.columnId),
                  eq(workshopTask.projectId, projectId),
                ),
              );

      if (anchors.length !== anchorIds.length) {
        return { kind: "bad-anchor" } as const;
      }
      // Moving a card relative to ITSELF has no meaning and would compute a rank equal to
      // one of its own bounds.
      if (anchorIds.includes(taskId)) {
        return { kind: "bad-anchor" } as const;
      }

      const lowerRank = anchors.find((anchor) => anchor.id === input.afterTaskId)?.rank ?? null;
      const upperRank = anchors.find((anchor) => anchor.id === input.beforeTaskId)?.rank ?? null;

      let nextRank: string;
      try {
        nextRank = rankBetween(lowerRank, upperRank);
      } catch {
        // rankBetween throws on inverted bounds — the caller read the board in one order
        // and is writing it in another, which is a stale client, not a server fault.
        return { kind: "bad-anchor" } as const;
      }

      const [updated] = await tx
        .update(workshopTask)
        .set({ columnId: input.columnId, rank: nextRank })
        .where(eq(workshopTask.id, taskId))
        .returning();

      if (!updated) {
        throw new Error("moveTask: update returned no row");
      }
      return { kind: "moved", task: updated } as const;
    });

    switch (outcome.kind) {
      case "no-task":
        return {
          kind: "settled",
          result: { success: false, error: { type: "TASK_NOT_FOUND", taskId } },
        };
      case "no-column":
        return {
          kind: "settled",
          result: {
            success: false,
            error: { type: "COLUMN_NOT_FOUND", columnId: input.columnId },
          },
        };
      case "bad-anchor":
        return {
          kind: "settled",
          result: { success: false, error: { type: "MOVE_ANCHOR_INVALID" } },
        };
      case "moved":
        return { kind: "settled", result: { success: true, value: toTaskView(outcome.task) } };
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled moveTask outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  } catch (error: unknown) {
    // UNIQUE (column_id, rank): another member won the same gap. Retryable, and only
    // this specific violation is — anything else is a real fault and must surface.
    if (isUniqueViolation(error)) {
      return { kind: "contended" };
    }
    throw error;
  }
}

/**
 * Seeds a board with the three columns every team starts from.
 *
 * Called once, lazily, the first time a project's workshop is opened — not from the
 * project-create transaction, which would add three writes to every draft that is never
 * worked on. Idempotent by construction: it inserts only when the board is empty, inside
 * the transaction that checks.
 */
export async function ensureDefaultBoard(
  projectId: string,
  actorUserId: string,
): Promise<readonly WorkshopBoardColumnView[]> {
  const DEFAULT_COLUMN_TITLES = ["To do", "In progress", "Done"] as const;

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: workshopBoardColumn.id })
      .from(workshopBoardColumn)
      .where(eq(workshopBoardColumn.projectId, projectId))
      .for("update");

    if (existing.length > 0) {
      return;
    }

    await tx.insert(workshopBoardColumn).values(
      DEFAULT_COLUMN_TITLES.map((title, position) => ({
        projectId,
        title,
        position,
        createdByUserId: actorUserId,
      })),
    );
  });

  return getBoard(projectId);
}

/**
 * Exported for the seed path and for tests: `initialRanks` is the only other place a rank
 * is minted, and re-exporting it here keeps every rank in this domain traceable to
 * src/lib/lexorank.ts.
 */
export { initialRanks };
