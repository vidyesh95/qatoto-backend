import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  projectApplication,
  projectInvite,
  projectMember,
  projectMemberInterval,
  projectOpenRole,
  projectStats,
  researchProject,
  user,
} from "#src/db/schema.js";
import { recomputeOpenRoleStatus } from "#src/services/project-roles.service.js";
import type { Result } from "#src/types/index.js";

/**
 * THE single authorization entry point for every project-scoped route
 * (R_AND_D_BACKEND_STRUCTURE.md §4a Layer 2).
 *
 * WHY A SERVICE HELPER AND NOT MIDDLEWARE. Middleware cannot return a `Result`, so it
 * cannot participate in the controller's exhaustive error switch (CLAUDE.md §3.2/§3.3)
 * — it would have to either write a response itself or throw, and both put an
 * authorization decision outside the one place that maps domain errors to statuses.
 * §4a calls this out explicitly.
 *
 * WHY EVERY FAILURE IS THE SAME ERROR. "No such project", "you are not a member", and
 * "your role is below the minimum" all collapse into one `NOT_FOUND`, which the
 * controller renders as 404 — never 403. A stranger must not be able to probe which
 * project slugs exist, and a distinguishable 403 is exactly that probe. This is why the
 * function returns one error variant rather than three.
 */

/** Per-project roles, ordered by authority. Also the shape of a member context. */
export type ProjectMemberRole = (typeof projectMember.$inferSelect)["projectRole"];

/**
 * Explicit rank map. Authorization compares THESE numbers, never `>` on the enum or on
 * a position in the pgEnum array — so reordering the enum declaration (a routine
 * schema edit) can never silently change who is allowed to do what.
 */
const PROJECT_ROLE_RANK: Readonly<Record<ProjectMemberRole, number>> = {
  contributor: 1,
  maintainer: 2,
  admin: 3,
  founder: 4,
};

/**
 * The caller's proven standing on a project. Returned on success so the caller does not
 * re-query what this function already loaded.
 */
export interface ProjectMemberContext {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectStatus: (typeof researchProject.$inferSelect)["status"];
  readonly founderUserId: string;
  readonly currency: string;
  readonly memberId: string;
  readonly memberRole: ProjectMemberRole;
  /** True when this member IS the founder — computed, never stored (§5). */
  readonly isFounder: boolean;
}

/**
 * The ONE access error, declared here and shared by every R&D service union.
 *
 * Two variants that share a `type` literal must share a payload, or the controller's
 * exhaustive switch narrows to a union and cannot read the field — so every service
 * that can fail this way composes THIS type in rather than declaring its own NOT_FOUND.
 */
export type ProjectAccessError = { type: "NOT_FOUND"; projectRef: string };

/** A project row the caller is allowed to see, without any membership requirement. */
export interface ProjectRef {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectStatus: (typeof researchProject.$inferSelect)["status"];
  readonly founderUserId: string;
  readonly currency: string;
}

/**
 * Resolves a project by its PUBLIC slug. Does not check membership — callers that need
 * one use {@link requireProjectRole} instead.
 */
export async function findProjectBySlug(projectSlug: string): Promise<ProjectRef | null> {
  const [row] = await db
    .select({
      projectId: researchProject.id,
      projectSlug: researchProject.slug,
      projectStatus: researchProject.status,
      founderUserId: researchProject.founderUserId,
      currency: researchProject.currency,
    })
    .from(researchProject)
    .where(eq(researchProject.slug, projectSlug));

  return row ?? null;
}

/**
 * Proves the caller is an ACTIVE member of the project at or above `minimumRole`.
 *
 * Returns the SAME `{ type: "NOT_FOUND" }` when the project does not exist, when the
 * caller is not a member, when their membership is `left`/`removed`, and when their
 * role ranks below the minimum. A caller cannot distinguish the four cases.
 *
 * `left` and `removed` members are refused deliberately: membership is never
 * hard-deleted (§4a), so a departed member's row still exists and an equality check on
 * the row alone would keep granting them access forever.
 */
export async function requireProjectRole(
  projectSlug: string,
  userId: string,
  minimumRole: ProjectMemberRole,
): Promise<Result<ProjectMemberContext, ProjectAccessError>> {
  const [row] = await db
    .select({
      projectId: researchProject.id,
      projectSlug: researchProject.slug,
      projectStatus: researchProject.status,
      founderUserId: researchProject.founderUserId,
      currency: researchProject.currency,
      memberId: projectMember.id,
      memberRole: projectMember.projectRole,
    })
    .from(researchProject)
    .innerJoin(
      projectMember,
      and(
        eq(projectMember.projectId, researchProject.id),
        eq(projectMember.userId, userId),
        // Membership must be CURRENT. A `left` or `removed` row still exists by design.
        eq(projectMember.status, "active"),
      ),
    )
    .where(eq(researchProject.slug, projectSlug));

  if (!row) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectSlug } };
  }

  const callerRank = PROJECT_ROLE_RANK[row.memberRole];
  const requiredRank = PROJECT_ROLE_RANK[minimumRole];

  if (callerRank < requiredRank) {
    // Same error as "no such project" — an under-privileged member learns only that
    // the resource is not available to them, not that it exists.
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectSlug } };
  }

  return {
    success: true,
    value: {
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      projectStatus: row.projectStatus,
      founderUserId: row.founderUserId,
      currency: row.currency,
      memberId: row.memberId,
      memberRole: row.memberRole,
      isFounder: row.memberRole === "founder",
    },
  };
}

/** True when the caller is an active member of the project, at any role. */
export async function isActiveProjectMember(projectId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projectMember.id })
    .from(projectMember)
    .where(
      and(
        eq(projectMember.projectId, projectId),
        eq(projectMember.userId, userId),
        eq(projectMember.status, "active"),
      ),
    )
    .limit(1);

  return row !== undefined;
}

/**
 * One roster entry, as read back to a client.
 *
 * `name` and `avatarImageUrl` are JOINED from `user` and never stored on
 * project_member — a copy drifts the moment someone changes their photo (§5).
 * `isFounder` is COMPUTED from projectRole; storing both would permit the
 * contradictory state isFounder:true + projectRole:'contributor'.
 *
 * There is deliberately no `equityBasisPoints` and no `verifiedEffortMinutes` here:
 * both are derived by §9's ledger, which does not exist yet. Returning 0 for them would
 * render a fabricated number as fact.
 */
export interface ProjectTeamMemberView {
  readonly memberId: string;
  readonly userId: string;
  readonly name: string;
  readonly avatarImageUrl: string | null;
  readonly handle: string | null;
  readonly projectRole: ProjectMemberRole;
  readonly roleTitle: string | null;
  readonly skills: readonly string[];
  readonly isFounder: boolean;
  readonly joinedAt: Date;
}

/** The active roster, founder first, then by join order. */
export async function listProjectTeam(
  projectId: string,
): Promise<readonly ProjectTeamMemberView[]> {
  const rows = await db
    .select({
      memberId: projectMember.id,
      userId: projectMember.userId,
      name: user.name,
      avatarImageUrl: user.image,
      handle: user.handle,
      projectRole: projectMember.projectRole,
      roleTitle: projectMember.roleTitle,
      skills: projectMember.skills,
      joinedAt: projectMember.joinedAt,
    })
    .from(projectMember)
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.status, "active")))
    // §4c rule 4: the ordering ends in a unique column so the roster is stable across
    // reads and two members who joined in the same millisecond never swap places.
    .orderBy(projectMember.joinedAt, projectMember.id);

  return rows.map((row) => ({
    ...row,
    isFounder: row.projectRole === "founder",
  }));
}

/** The counter sidecar, as read back with its freshness bound. */
export interface ProjectStatsView {
  readonly watchersCount: number;
  readonly teamMemberCount: number;
  readonly openRoleCount: number;
  readonly projectTimeZone: string;
  /**
   * NULL until the §8/§9 jobs that own these fields exist. Deliberately NOT defaulted
   * to 0: `allocatedEquityBasisPoints: 0` contradicts §9.4's invariant that it must
   * equal 10000 on a non-degenerate project, and rendering it as a fact on a Slicing
   * Pie surface would be a fabricated number.
   */
  readonly dailyLogStreakDays: number | null;
  readonly lastDailyLogDate: string | null;
  readonly verifiedEffortMinutesTotal: number | null;
  readonly allocatedEquityBasisPoints: number | null;
  /** Returned so all three clients can render "as of" and never imply live numbers. */
  readonly statsComputedAt: Date | null;
}

export type ProjectMemberError =
  | ProjectAccessError
  | { type: "MEMBER_NOT_FOUND"; memberId: string }
  | { type: "FOUNDER_ROLE_IMMUTABLE" }
  | { type: "FOUNDER_CANNOT_LEAVE" }
  | { type: "MEMBERSHIP_INACTIVE" };

/**
 * The open role a member currently occupies, derived from their membership provenance.
 *
 * `project_member` deliberately stores no roleId — the role is a property of how they
 * JOINED, not of who they are. Resolving it here keeps `slotsFilledCount` honest when
 * someone leaves: without it, a departing member's seat stays occupied forever and the
 * role can never reopen.
 */
async function findOccupiedRoleId(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  memberRow: {
    readonly sourceApplicationId: string | null;
    readonly sourceInviteId: string | null;
  },
): Promise<string | null> {
  if (memberRow.sourceApplicationId !== null) {
    const [application] = await tx
      .select({ openRoleId: projectApplication.openRoleId })
      .from(projectApplication)
      .where(eq(projectApplication.id, memberRow.sourceApplicationId));
    if (application?.openRoleId) {
      return application.openRoleId;
    }
  }
  if (memberRow.sourceInviteId !== null) {
    const [invite] = await tx
      .select({ openRoleId: projectInvite.openRoleId })
      .from(projectInvite)
      .where(eq(projectInvite.id, memberRow.sourceInviteId));
    if (invite?.openRoleId) {
      return invite.openRoleId;
    }
  }
  return null;
}

/**
 * Ends a member's active stint: flips the row to `left`/`removed`, SEALS the open
 * interval, frees the seat they occupied, and moves the roster counter — all in one
 * transaction.
 *
 * Sealing the interval is what makes §9's accrual window correct: slices accrue over
 * [joinedAt, leftAt) per stint, so an unsealed interval would keep accruing forever for
 * someone who left.
 */
async function endMembership(
  projectId: string,
  memberId: string,
  nextStatus: "left" | "removed",
  actorUserId: string,
): Promise<Result<{ readonly memberId: string; readonly status: string }, ProjectMemberError>> {
  const outcome = await db.transaction(async (tx) => {
    const [memberRow] = await tx
      .select({
        id: projectMember.id,
        userId: projectMember.userId,
        projectRole: projectMember.projectRole,
        status: projectMember.status,
        sourceApplicationId: projectMember.sourceApplicationId,
        sourceInviteId: projectMember.sourceInviteId,
      })
      .from(projectMember)
      // BOTH columns in the WHERE: a memberId belonging to ANOTHER project must be
      // indistinguishable from a nonexistent one, or this becomes a cross-tenant probe.
      .where(and(eq(projectMember.id, memberId), eq(projectMember.projectId, projectId)))
      .for("update");

    if (!memberRow) {
      return { kind: "not-found" } as const;
    }
    if (memberRow.projectRole === "founder") {
      // A project must always have exactly one founder (the partial unique index says
      // so), and there is no founder-transfer endpoint in this phase. Archiving the
      // project is the documented exit.
      return { kind: "founder" } as const;
    }
    if (memberRow.status !== "active") {
      return { kind: "inactive" } as const;
    }

    const departedAt = new Date();

    await tx
      .update(projectMember)
      .set({
        status: nextStatus,
        leftAt: departedAt,
        // Only a removal names a remover; `project_member_removed_by_ck` enforces it.
        removedByUserId: nextStatus === "removed" ? actorUserId : null,
      })
      .where(eq(projectMember.id, memberId));

    // Seal the open stint. The partial unique index guarantees there is exactly one.
    await tx
      .update(projectMemberInterval)
      .set({
        leftAt: departedAt,
        endedReason: nextStatus,
        endedByUserId: nextStatus === "removed" ? actorUserId : null,
      })
      .where(
        and(eq(projectMemberInterval.memberId, memberId), isNull(projectMemberInterval.leftAt)),
      );

    const occupiedRoleId = await findOccupiedRoleId(tx, memberRow);
    if (occupiedRoleId !== null) {
      await tx
        .update(projectOpenRole)
        .set({ slotsFilledCount: sql`GREATEST(${projectOpenRole.slotsFilledCount} - 1, 0)` })
        .where(eq(projectOpenRole.id, occupiedRoleId));
      // Re-derives `filled` → `open`, so the seat is actually re-advertised.
      await recomputeOpenRoleStatus(tx, occupiedRoleId);
    }

    await tx
      .update(projectStats)
      .set({ teamMemberCount: sql`GREATEST(${projectStats.teamMemberCount} - 1, 0)` })
      .where(eq(projectStats.projectId, projectId));

    return { kind: "ended" } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "MEMBER_NOT_FOUND", memberId } };
    case "founder":
      return {
        success: false,
        error:
          nextStatus === "left"
            ? { type: "FOUNDER_CANNOT_LEAVE" }
            : { type: "FOUNDER_ROLE_IMMUTABLE" },
      };
    case "inactive":
      return { success: false, error: { type: "MEMBERSHIP_INACTIVE" } };
    case "ended":
      return { success: true, value: { memberId, status: nextStatus } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled membership outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** DELETE …/members/me — self-departure. Sets `left`, never deletes (§4a). */
export async function leaveProject(
  projectId: string,
  userId: string,
): Promise<Result<{ readonly memberId: string; readonly status: string }, ProjectMemberError>> {
  const [memberRow] = await db
    .select({ id: projectMember.id })
    .from(projectMember)
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, userId)));

  if (!memberRow) {
    return { success: false, error: { type: "MEMBER_NOT_FOUND", memberId: userId } };
  }
  return endMembership(projectId, memberRow.id, "left", userId);
}

/** DELETE …/members/:memberId — founder-driven removal. */
export async function removeProjectMember(
  projectId: string,
  memberId: string,
  actorUserId: string,
): Promise<Result<{ readonly memberId: string; readonly status: string }, ProjectMemberError>> {
  return endMembership(projectId, memberId, "removed", actorUserId);
}

/**
 * PATCH …/members/:memberId — founder only.
 *
 * `founder` and `admin` are absent from the controller's enum, so neither can arrive
 * here. The founder's OWN row is additionally immutable: demoting it would leave the
 * project with no founder, which the partial unique index and
 * `research_project.founderUserId` both assume cannot happen.
 */
export async function updateProjectMember(
  projectId: string,
  memberId: string,
  input: {
    readonly projectRole?: "maintainer" | "contributor" | undefined;
    readonly roleTitle?: string | null | undefined;
  },
): Promise<Result<ProjectTeamMemberView, ProjectMemberError>> {
  const [memberRow] = await db
    .select({ id: projectMember.id, projectRole: projectMember.projectRole })
    .from(projectMember)
    .where(and(eq(projectMember.id, memberId), eq(projectMember.projectId, projectId)));

  if (!memberRow) {
    return { success: false, error: { type: "MEMBER_NOT_FOUND", memberId } };
  }
  if (memberRow.projectRole === "founder") {
    return { success: false, error: { type: "FOUNDER_ROLE_IMMUTABLE" } };
  }

  await db
    .update(projectMember)
    .set({
      ...(input.projectRole !== undefined ? { projectRole: input.projectRole } : {}),
      ...(input.roleTitle !== undefined ? { roleTitle: input.roleTitle } : {}),
    })
    .where(eq(projectMember.id, memberId));

  const team = await listProjectTeam(projectId);
  const updated = team.find((member) => member.memberId === memberId);
  if (!updated) {
    return { success: false, error: { type: "MEMBER_NOT_FOUND", memberId } };
  }
  return { success: true, value: updated };
}

/** Public stats projection. `pendingApplicationCount` is founder-facing and excluded. */
export async function findProjectStats(projectId: string): Promise<ProjectStatsView | null> {
  const [row] = await db
    .select({
      watchersCount: projectStats.watchersCount,
      teamMemberCount: projectStats.teamMemberCount,
      openRoleCount: projectStats.openRoleCount,
      projectTimeZone: projectStats.projectTimeZone,
      dailyLogStreakDays: projectStats.dailyLogStreakDays,
      lastDailyLogDate: projectStats.lastDailyLogDate,
      verifiedEffortMinutesTotal: projectStats.verifiedEffortMinutesTotal,
      allocatedEquityBasisPoints: projectStats.allocatedEquityBasisPoints,
      statsComputedAt: projectStats.statsComputedAt,
    })
    .from(projectStats)
    .where(eq(projectStats.projectId, projectId));

  return row ?? null;
}
