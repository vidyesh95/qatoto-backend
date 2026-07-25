import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { milestone, milestoneVariance, researchProject } from "#src/db/schema.js";
import { basisPointsOf } from "#src/lib/money.js";
import type {
  ProjectAccessError,
  ProjectMemberContext,
} from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Milestones and their variance (R_AND_D_BACKEND_STRUCTURE.md §7, §11c, §15).
 *
 * `plannedPayoutInCents` LIVES HERE AND IS SNAPSHOTTED ELSEWHERE. A founder may edit
 * it freely while planning; the moment a release is requested,
 * escrow-releases.service.ts freezes the value onto the release row and the release pays
 * THAT number forever. Editing the milestone afterwards changes nothing about a payout in
 * flight — which is the specific attack §7 describes and the reason the release body
 * carries no amount at all.
 *
 * VARIANCE IS SIX TYPED INTEGERS AND TWO UNIT NOUNS (§15), replacing five pre-rendered
 * labels. `varianceBasisPoints` is SIGNED and SERVER-COMPUTED: negative is behind,
 * positive is ahead, and there is no field for it in any request body. The mock shipped
 * `varianceLabel: "26% behind"` — a string that cannot be sorted, compared, localized, or
 * checked for sign.
 */

export type MilestoneStatus = (typeof milestone.$inferSelect)["status"];

export type MilestoneError =
  | ProjectAccessError
  | { type: "MILESTONE_NOT_FOUND"; milestoneId: string }
  | { type: "MILESTONE_TERMINAL"; status: MilestoneStatus }
  | { type: "MILESTONE_ALREADY_COMPLETE" }
  | { type: "MILESTONE_ORDER_TAKEN"; orderIndex: number };

export interface MilestoneVarianceView {
  readonly plannedDurationDays: number;
  readonly actualDurationDays: number;
  readonly plannedCostInCents: string;
  readonly actualCostInCents: string;
  readonly plannedEffortMinutes: number;
  readonly actualEffortMinutes: number;
  /** The unit the schedule integers ARE IN, so no client hardcodes an English noun. */
  readonly scheduleUnitKey: (typeof milestoneVariance.$inferSelect)["scheduleUnitKey"];
  readonly effortUnitKey: (typeof milestoneVariance.$inferSelect)["effortUnitKey"];
  /** SIGNED. Negative is behind schedule; positive is ahead. Never sent by a client. */
  readonly varianceBasisPoints: number;
  readonly currency: string;
  readonly computedAt: Date;
}

export interface MilestoneView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: MilestoneStatus;
  readonly plannedPayoutInCents: string;
  readonly currency: string;
  readonly dueDate: string | null;
  readonly completedAt: Date | null;
  readonly orderIndex: number;
  readonly variance: MilestoneVarianceView | null;
  readonly createdAt: Date;
}

function toVarianceView(
  row: typeof milestoneVariance.$inferSelect | null,
): MilestoneVarianceView | null {
  if (!row) return null;
  return {
    plannedDurationDays: row.plannedDurationDays,
    actualDurationDays: row.actualDurationDays,
    // Every bigint crosses the wire as a decimal string (§4b).
    plannedCostInCents: row.plannedCostInCents.toString(),
    actualCostInCents: row.actualCostInCents.toString(),
    plannedEffortMinutes: row.plannedEffortMinutes,
    actualEffortMinutes: row.actualEffortMinutes,
    scheduleUnitKey: row.scheduleUnitKey,
    effortUnitKey: row.effortUnitKey,
    varianceBasisPoints: row.varianceBasisPoints,
    currency: row.currency,
    computedAt: row.computedAt,
  };
}

function toMilestoneView(
  row: typeof milestone.$inferSelect,
  variance: typeof milestoneVariance.$inferSelect | null,
): MilestoneView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    plannedPayoutInCents: row.plannedPayoutInCents.toString(),
    currency: row.currency,
    dueDate: row.dueDate,
    completedAt: row.completedAt,
    orderIndex: row.orderIndex,
    variance: toVarianceView(variance),
    createdAt: row.createdAt,
  };
}

/** A milestone with its project, for the routes keyed on `milestoneId` rather than a slug. */
export interface MilestoneWithProject {
  readonly milestone: typeof milestone.$inferSelect;
  readonly projectSlug: string;
}

export async function findMilestoneWithProject(
  milestoneId: string,
): Promise<MilestoneWithProject | null> {
  const [row] = await db
    .select({ milestone, projectSlug: researchProject.slug })
    .from(milestone)
    .innerJoin(researchProject, eq(researchProject.id, milestone.projectId))
    .where(eq(milestone.id, milestoneId));

  return row ?? null;
}

export async function listProjectMilestones(projectId: string): Promise<readonly MilestoneView[]> {
  const rows = await db
    .select({ milestone, variance: milestoneVariance })
    .from(milestone)
    .leftJoin(milestoneVariance, eq(milestoneVariance.milestoneId, milestone.id))
    .where(eq(milestone.projectId, projectId))
    // §4c rule 4: ends in a unique column so two milestones sharing an order index — which
    // the unique index forbids, but a future backfill might not — never swap places.
    .orderBy(asc(milestone.orderIndex), asc(milestone.id));

  return rows.map((row) => toMilestoneView(row.milestone, row.variance));
}

export interface CreateMilestoneInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly plannedPayoutInCents: bigint;
  readonly dueDate?: string | undefined;
}

/**
 * `POST …/milestones` — maintainer and above.
 *
 * `orderIndex` is SERVER-DERIVED as "one past the current maximum", not a body field. A
 * client-chosen index is a uniqueness collision waiting for two people to add a milestone
 * at the same time, and the ordering carries no meaning a client is better placed to
 * decide.
 */
export async function createMilestone(
  context: ProjectMemberContext,
  actorUserId: string,
  input: CreateMilestoneInput,
): Promise<Result<MilestoneView, MilestoneError>> {
  const created = await db.transaction(async (tx) => {
    const [highest] = await tx
      .select({ orderIndex: milestone.orderIndex })
      .from(milestone)
      .where(eq(milestone.projectId, context.projectId))
      .orderBy(sql`${milestone.orderIndex} DESC`)
      .limit(1);

    const [row] = await tx
      .insert(milestone)
      .values({
        projectId: context.projectId,
        title: input.title,
        description: input.description ?? null,
        status: "planned",
        plannedPayoutInCents: input.plannedPayoutInCents,
        // The currency is the PROJECT's (§4b). No body carries one.
        currency: context.currency,
        dueDate: input.dueDate ?? null,
        orderIndex: (highest?.orderIndex ?? -1) + 1,
        createdByUserId: actorUserId,
      })
      .returning();

    if (!row) {
      throw new Error("createMilestone: insert returned no row");
    }
    return row;
  });

  return { success: true, value: toMilestoneView(created, null) };
}

export interface UpdateMilestoneInput {
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly plannedPayoutInCents?: bigint | undefined;
  readonly dueDate?: string | null | undefined;
}

/**
 * `PATCH /milestones/:id`.
 *
 * `status` IS ABSENT from the input and always will be: it moves through `/complete`,
 * which writes `completedAt` in the same statement, and the CHECK constraint requires the
 * two to agree. A general PATCH that could set `done` without a completion instant would
 * produce a milestone an escrow release could be approved against with no record of when
 * it was finished.
 */
export async function updateMilestone(
  projectId: string,
  milestoneId: string,
  input: UpdateMilestoneInput,
): Promise<Result<MilestoneView, MilestoneError>> {
  const [existing] = await db
    .select()
    .from(milestone)
    // BOTH columns: a milestone id belonging to another project must be indistinguishable
    // from a nonexistent one, or this becomes a cross-tenant probe.
    .where(and(eq(milestone.id, milestoneId), eq(milestone.projectId, projectId)));

  if (!existing) {
    return { success: false, error: { type: "MILESTONE_NOT_FOUND", milestoneId } };
  }
  if (existing.status === "cancelled") {
    return { success: false, error: { type: "MILESTONE_TERMINAL", status: existing.status } };
  }

  const [updated] = await db
    .update(milestone)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.plannedPayoutInCents !== undefined
        ? { plannedPayoutInCents: input.plannedPayoutInCents }
        : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    })
    .where(eq(milestone.id, milestoneId))
    .returning();

  if (!updated) {
    return { success: false, error: { type: "MILESTONE_NOT_FOUND", milestoneId } };
  }

  const [variance] = await db
    .select()
    .from(milestoneVariance)
    .where(eq(milestoneVariance.milestoneId, milestoneId));

  return { success: true, value: toMilestoneView(updated, variance ?? null) };
}

/**
 * `POST /milestones/:id/complete` — the state an escrow release is gated on.
 *
 * Sets `status` and `completedAt` in ONE statement, because the CHECK constraint requires
 * them to agree and because "done, but we do not know when" is not a state an auditor can
 * do anything with.
 */
export async function completeMilestone(
  projectId: string,
  milestoneId: string,
): Promise<Result<MilestoneView, MilestoneError>> {
  const [existing] = await db
    .select()
    .from(milestone)
    .where(and(eq(milestone.id, milestoneId), eq(milestone.projectId, projectId)));

  if (!existing) {
    return { success: false, error: { type: "MILESTONE_NOT_FOUND", milestoneId } };
  }
  if (existing.status === "done") {
    return { success: false, error: { type: "MILESTONE_ALREADY_COMPLETE" } };
  }
  if (existing.status === "cancelled") {
    return { success: false, error: { type: "MILESTONE_TERMINAL", status: existing.status } };
  }

  const [completed] = await db
    .update(milestone)
    .set({ status: "done", completedAt: new Date() })
    .where(and(eq(milestone.id, milestoneId), eq(milestone.projectId, projectId)))
    .returning();

  if (!completed) {
    return { success: false, error: { type: "MILESTONE_NOT_FOUND", milestoneId } };
  }

  const [variance] = await db
    .select()
    .from(milestoneVariance)
    .where(eq(milestoneVariance.milestoneId, milestoneId));

  return { success: true, value: toMilestoneView(completed, variance ?? null) };
}

export interface PutVarianceInput {
  readonly plannedDurationDays: number;
  readonly actualDurationDays: number;
  readonly plannedCostInCents: bigint;
  readonly actualCostInCents: bigint;
  readonly plannedEffortMinutes: number;
  readonly actualEffortMinutes: number;
}

/**
 * The bound `milestone_variance_basis_points_ck` enforces: ±10,000%.
 *
 * Declared here rather than inlined so the clamp below and the column can be seen to agree
 * — a clamp that is looser than its constraint is a 500 waiting for a data-entry accident,
 * and a clamp that is tighter silently truncates values the column would have accepted.
 */
export const VARIANCE_BASIS_POINTS_BOUND = 1_000_000;

/**
 * Computes the signed schedule variance in basis points.
 *
 * SIGN: negative is BEHIND (took longer than planned), positive is AHEAD. Expressed as a
 * deviation from plan — `(planned − actual) / planned` — so a milestone that took 126% of
 * its planned time reads `-2667`, which is exactly the `"26% behind"` the mock rendered as
 * prose, now sortable, comparable and localizable.
 *
 * A zero plan has no percentage deviation to express, so the variance is 0 rather than an
 * infinity or a thrown error: "we planned nothing and it took three days" is a real state
 * of a real milestone, and refusing to store its variance would block the whole update.
 *
 * CLAMPED TO THE COLUMN'S BOUND, and this is not defensive padding — it is the difference
 * between a bounded chart and a 500. A one-day milestone that took three years is
 * −10,940,000 basis points, which `milestone_variance_basis_points_ck` rejects outright,
 * so an unclamped value turns an honest (if embarrassing) data entry into a failed request
 * the founder cannot get past. Past ±10,000% the exact figure carries nothing a chart could
 * render anyway; the six raw integers are stored beside it and remain exact.
 */
export function computeVarianceBasisPoints(
  plannedDurationDays: number,
  actualDurationDays: number,
): number {
  if (plannedDurationDays === 0) {
    return 0;
  }
  // Through src/lib/money.ts, like every derived integer in this domain (§4c rule 1).
  // `basisPointsOf` handles the sign correctly on the way through; `Math.round` would
  // round -0.5 to -0 and disagree with Postgres.
  const variance = basisPointsOf(
    BigInt(plannedDurationDays - actualDurationDays),
    BigInt(plannedDurationDays),
  );

  return Math.max(-VARIANCE_BASIS_POINTS_BOUND, Math.min(VARIANCE_BASIS_POINTS_BOUND, variance));
}

/** `PUT /milestones/:id/variance` — six integers in, one signed basis-point figure out. */
export async function putMilestoneVariance(
  projectId: string,
  milestoneId: string,
  currency: string,
  input: PutVarianceInput,
): Promise<Result<MilestoneView, MilestoneError>> {
  const [existing] = await db
    .select()
    .from(milestone)
    .where(and(eq(milestone.id, milestoneId), eq(milestone.projectId, projectId)));

  if (!existing) {
    return { success: false, error: { type: "MILESTONE_NOT_FOUND", milestoneId } };
  }

  const varianceBasisPoints = computeVarianceBasisPoints(
    input.plannedDurationDays,
    input.actualDurationDays,
  );

  const [stored] = await db
    .insert(milestoneVariance)
    .values({
      milestoneId,
      projectId,
      plannedDurationDays: input.plannedDurationDays,
      actualDurationDays: input.actualDurationDays,
      plannedCostInCents: input.plannedCostInCents,
      actualCostInCents: input.actualCostInCents,
      plannedEffortMinutes: input.plannedEffortMinutes,
      actualEffortMinutes: input.actualEffortMinutes,
      varianceBasisPoints,
      currency,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: milestoneVariance.milestoneId,
      set: {
        plannedDurationDays: input.plannedDurationDays,
        actualDurationDays: input.actualDurationDays,
        plannedCostInCents: input.plannedCostInCents,
        actualCostInCents: input.actualCostInCents,
        plannedEffortMinutes: input.plannedEffortMinutes,
        actualEffortMinutes: input.actualEffortMinutes,
        varianceBasisPoints,
        computedAt: new Date(),
      },
    })
    .returning();

  return { success: true, value: toMilestoneView(existing, stored ?? null) };
}
