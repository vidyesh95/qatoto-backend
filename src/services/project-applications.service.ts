import { and, count, desc, eq, sql } from "drizzle-orm";

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
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import { syncOpenRoleCount } from "#src/services/project-roles.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Applications (person → project) and invites (project → person).
 *
 * TTL. The spec never states a number but both status enums contain `expired`, so
 * something must produce it. 30 days, as a service constant rather than a column
 * default, so changing it touches one line and not the schema.
 *
 * EXPIRY IS NOT LAZY. `status` is authoritative and a read never reports "expired" for
 * a row that is physically `pending`. The alternative collides with
 * `project_application_live_role_unq`: the API would tell a user their application
 * expired, they would re-apply, and the INSERT would 23505 against the still-pending
 * row. Instead every write path carries `AND (expires_at IS NULL OR expires_at > now())`
 * and `POST /applications` self-heals by expiring the caller's own stale row first —
 * which makes the cron sweep a bulk optimization rather than a correctness dependency.
 */
const REQUEST_TTL_DAYS = 30;

function expiryInstant(): Date {
  return new Date(Date.now() + REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type ProjectApplicationError =
  | ProjectAccessError
  | { type: "PROJECT_ARCHIVED" }
  | { type: "PROJECT_NOT_ACCEPTING" }
  | { type: "ROLE_NOT_FOUND"; roleId: string }
  | { type: "ROLE_NOT_OPEN" }
  | { type: "ROLE_FULL" }
  | { type: "SKILLS_NOT_SUBSET"; invalidSkills: readonly string[] }
  | { type: "ALREADY_MEMBER" }
  | { type: "MEMBERSHIP_INACTIVE" }
  | { type: "ALREADY_APPLIED" }
  | { type: "APPLICATION_NOT_FOUND"; applicationId: string }
  | { type: "APPLICATION_NOT_PENDING" }
  | { type: "SELF_APPLICATION_FORBIDDEN" }
  | { type: "NOT_THE_APPLICANT" }
  | { type: "INVITEE_NOT_ELIGIBLE" }
  | { type: "SELF_INVITE_FORBIDDEN" }
  | { type: "ALREADY_INVITED" }
  | { type: "INVITE_NOT_FOUND"; inviteId: string }
  | { type: "INVITE_NOT_PENDING" }
  | { type: "NOT_THE_INVITEE" };

export interface CreateApplicationInput {
  readonly openRoleId?: string | undefined;
  readonly shortPitch: string;
  readonly selectedSkills?: readonly string[] | undefined;
  readonly statedCommitment: (typeof projectApplication.$inferSelect)["statedCommitment"];
  readonly expectedCompensationNote?: string | undefined;
}

export interface ApplicationView {
  readonly id: string;
  readonly kind: (typeof projectApplication.$inferSelect)["kind"];
  readonly status: (typeof projectApplication.$inferSelect)["status"];
  readonly applicantUserId: string;
  readonly applicantName: string;
  readonly applicantAvatarImageUrl: string | null;
  readonly openRoleId: string | null;
  readonly roleTitleSnapshot: string | null;
  readonly shortPitch: string;
  readonly selectedSkills: readonly string[];
  readonly statedCommitment: (typeof projectApplication.$inferSelect)["statedCommitment"];
  /** The applicant's OWN stated ask. Never read by the ledger, never a grant input. */
  readonly expectedCompensationNote: string | null;
  readonly reviewNote: string | null;
  readonly decidedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

const APPLICATION_VIEW_COLUMNS = {
  id: projectApplication.id,
  kind: projectApplication.kind,
  status: projectApplication.status,
  applicantUserId: projectApplication.applicantUserId,
  applicantName: user.name,
  applicantAvatarImageUrl: user.image,
  openRoleId: projectApplication.openRoleId,
  roleTitleSnapshot: projectApplication.roleTitleSnapshot,
  shortPitch: projectApplication.shortPitch,
  selectedSkills: projectApplication.selectedSkills,
  statedCommitment: projectApplication.statedCommitment,
  expectedCompensationNote: projectApplication.expectedCompensationNote,
  reviewNote: projectApplication.reviewNote,
  decidedAt: projectApplication.decidedAt,
  expiresAt: projectApplication.expiresAt,
  createdAt: projectApplication.createdAt,
} as const;

/**
 * Submits an application.
 *
 * `kind` is SERVER-DERIVED from whether openRoleId is present — `.strict()` rejects a
 * client-sent `kind`, and the `project_application_kind_role_ck` constraint makes the
 * derivation an invariant of storage so a controller that forgets cannot persist a lie.
 */
export async function createApplication(
  projectId: string,
  applicantUserId: string,
  input: CreateApplicationInput,
): Promise<Result<ApplicationView, ProjectApplicationError>> {
  const [project] = await db
    .select({ status: researchProject.status, founderUserId: researchProject.founderUserId })
    .from(researchProject)
    .where(eq(researchProject.id, projectId));

  if (!project) {
    return { success: false, error: { type: "NOT_FOUND", projectRef: projectId } };
  }
  if (project.status === "archived") {
    return { success: false, error: { type: "PROJECT_ARCHIVED" } };
  }
  if (project.status !== "active") {
    // A draft is not accepting applications; it is not public at all.
    return { success: false, error: { type: "PROJECT_NOT_ACCEPTING" } };
  }
  if (project.founderUserId === applicantUserId) {
    return { success: false, error: { type: "SELF_APPLICATION_FORBIDDEN" } };
  }

  // Existing membership. `left`/`removed` is a DIFFERENT answer from `active` — the
  // former can re-apply (a new interval opens on accept), the latter cannot.
  const [existingMembership] = await db
    .select({ status: projectMember.status })
    .from(projectMember)
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, applicantUserId)));

  if (existingMembership?.status === "active") {
    return { success: false, error: { type: "ALREADY_MEMBER" } };
  }

  let roleTitleSnapshot: string | null = null;

  if (input.openRoleId !== undefined) {
    const [role] = await db
      .select({
        id: projectOpenRole.id,
        roleTitle: projectOpenRole.roleTitle,
        skills: projectOpenRole.skills,
        status: projectOpenRole.status,
        slotsTotal: projectOpenRole.slotsTotal,
        slotsFilledCount: projectOpenRole.slotsFilledCount,
      })
      .from(projectOpenRole)
      // Both columns: a role id from another project must be indistinguishable from a
      // nonexistent one.
      .where(
        and(eq(projectOpenRole.id, input.openRoleId), eq(projectOpenRole.projectId, projectId)),
      );

    if (!role) {
      return { success: false, error: { type: "ROLE_NOT_FOUND", roleId: input.openRoleId } };
    }
    if (role.status !== "open") {
      return { success: false, error: { type: "ROLE_NOT_OPEN" } };
    }
    if (role.slotsFilledCount >= role.slotsTotal) {
      return { success: false, error: { type: "ROLE_FULL" } };
    }

    // The sheet renders its chips FROM the role's own skills array, so anything else is
    // a forged payload (§5).
    const selectedSkills = input.selectedSkills ?? [];
    const invalidSkills = selectedSkills.filter((skill) => !role.skills.includes(skill));
    if (invalidSkills.length > 0) {
      return { success: false, error: { type: "SKILLS_NOT_SUBSET", invalidSkills } };
    }

    // Snapshot so an accepted member's display title survives a later role rename.
    roleTitleSnapshot = role.roleTitle;
  }

  const kind = input.openRoleId === undefined ? "join_request" : "role_interest";

  try {
    const created = await db.transaction(async (tx) => {
      // SELF-HEAL: expire the caller's own stale pending row before inserting, so a
      // long-dead application cannot permanently block a genuine re-apply through the
      // partial unique index.
      await tx
        .update(projectApplication)
        .set({ status: "expired" })
        .where(
          and(
            eq(projectApplication.projectId, projectId),
            eq(projectApplication.applicantUserId, applicantUserId),
            eq(projectApplication.status, "pending"),
            sql`${projectApplication.expiresAt} IS NOT NULL AND ${projectApplication.expiresAt} <= now()`,
          ),
        );

      const [row] = await tx
        .insert(projectApplication)
        .values({
          projectId,
          applicantUserId,
          openRoleId: input.openRoleId ?? null,
          kind,
          shortPitch: input.shortPitch,
          selectedSkills: [...(input.selectedSkills ?? [])],
          statedCommitment: input.statedCommitment,
          roleTitleSnapshot,
          expectedCompensationNote: input.expectedCompensationNote ?? null,
          expiresAt: expiryInstant(),
        })
        .returning({ id: projectApplication.id });

      if (!row) {
        throw new Error("createApplication: insert returned no row");
      }

      await tx
        .update(projectStats)
        .set({ pendingApplicationCount: sql`${projectStats.pendingApplicationCount} + 1` })
        .where(eq(projectStats.projectId, projectId));

      // THE FOUNDER, not every maintainer. A fan-out to the whole maintainer roster is a
      // fan-out whose size a stranger controls — anyone can apply to a public project, and
      // a ten-maintainer team would take ten rows per application. The founder is the one
      // accountable for the inbox; a per-role subscription is a feature to add when
      // somebody asks for it, not a default that scales with an unauthenticated action.
      await enqueueNotifications(tx, applicantUserId, [
        {
          recipientUserId: project.founderUserId,
          kind: "project_application_received",
          projectId,
          payload: { applicationId: row.id, kind },
        },
      ]);

      return row.id;
    });

    const view = await findApplicationById(projectId, created);
    if (!view) {
      throw new Error("createApplication: created application could not be read back");
    }
    return { success: true, value: view };
  } catch (error: unknown) {
    // The partial unique index is the race-safe authority for "one live application".
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "ALREADY_APPLIED" } };
    }
    throw error;
  }
}

export async function findApplicationById(
  projectId: string,
  applicationId: string,
): Promise<ApplicationView | null> {
  const [row] = await db
    .select(APPLICATION_VIEW_COLUMNS)
    .from(projectApplication)
    .innerJoin(user, eq(user.id, projectApplication.applicantUserId))
    .where(
      and(eq(projectApplication.id, applicationId), eq(projectApplication.projectId, projectId)),
    );
  return row ?? null;
}

export interface ListApplicationsFilter {
  readonly status?: (typeof projectApplication.$inferSelect)["status"] | undefined;
  readonly page: number;
  readonly limit: number;
}

/**
 * The project identity every cross-project row has to carry (§11j.2).
 *
 * A `/mine` row is rendered on a screen that spans projects, so it must name its own —
 * slug to link, name and cover to render, stage to badge. `OPEN_ROLE_VIEW_COLUMNS`
 * (`project-roles.service.ts`) is the precedent and the reason: a cross-project card that
 * needs a second call per row to learn where it belongs is an N+1 by construction.
 */
const OWNING_PROJECT_COLUMNS = {
  projectSlug: researchProject.slug,
  projectName: researchProject.name,
  projectStage: researchProject.stage,
  projectCoverImageUrl: researchProject.coverImageUrl,
} as const;

export interface MyApplicationView {
  readonly id: string;
  readonly kind: (typeof projectApplication.$inferSelect)["kind"];
  readonly status: (typeof projectApplication.$inferSelect)["status"];
  readonly projectSlug: string;
  readonly projectName: string;
  readonly projectStage: (typeof researchProject.$inferSelect)["stage"];
  readonly projectCoverImageUrl: string | null;
  readonly openRoleId: string | null;
  readonly roleTitleSnapshot: string | null;
  readonly shortPitch: string;
  readonly selectedSkills: readonly string[];
  readonly statedCommitment: (typeof projectApplication.$inferSelect)["statedCommitment"];
  readonly expectedCompensationNote: string | null;
  /** The founder's note back, which is the whole reason an applicant opens this screen. */
  readonly reviewNote: string | null;
  readonly decidedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface MyInviteView {
  readonly id: string;
  readonly status: (typeof projectInvite.$inferSelect)["status"];
  readonly projectSlug: string;
  readonly projectName: string;
  readonly projectStage: (typeof researchProject.$inferSelect)["stage"];
  readonly projectCoverImageUrl: string | null;
  readonly invitedByUserId: string;
  /** The INVITER, not the invitee: on this screen the caller IS the invitee. */
  readonly invitedByName: string;
  readonly invitedByAvatarImageUrl: string | null;
  readonly openRoleId: string | null;
  readonly roleTitle: string | null;
  readonly message: string | null;
  readonly respondedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/**
 * `GET /applications/mine` — everything the caller applied to (§11j.2).
 *
 * THERE IS NO `userId` PARAMETER AND THERE MUST NEVER BE ONE (§13). The filter is the
 * session id, exactly as on `/pledges/mine` and `/problem-reports/mine`. The project-scoped
 * `…/:projectSlug/applications` is the FOUNDER's inbox and is maintainer-gated; it can
 * never answer this question for the person who applied.
 *
 * NO PROJECT-STATUS FILTER, deliberately. A draft project's application stays visible to
 * the applicant — they are its counterparty, and hiding it would strand the one person
 * entitled to see it. That is the dead end §11j.2 describes, not a leak: they already know
 * the project exists, because they applied to it.
 */
export async function listMyApplications(
  applicantUserId: string,
  filter: ListApplicationsFilter,
): Promise<{ readonly rows: readonly MyApplicationView[]; readonly total: number }> {
  const conditions = [eq(projectApplication.applicantUserId, applicantUserId)];
  if (filter.status) {
    conditions.push(eq(projectApplication.status, filter.status));
  }
  const predicate = and(...conditions);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: projectApplication.id,
        kind: projectApplication.kind,
        status: projectApplication.status,
        ...OWNING_PROJECT_COLUMNS,
        openRoleId: projectApplication.openRoleId,
        roleTitleSnapshot: projectApplication.roleTitleSnapshot,
        shortPitch: projectApplication.shortPitch,
        selectedSkills: projectApplication.selectedSkills,
        statedCommitment: projectApplication.statedCommitment,
        expectedCompensationNote: projectApplication.expectedCompensationNote,
        reviewNote: projectApplication.reviewNote,
        decidedAt: projectApplication.decidedAt,
        expiresAt: projectApplication.expiresAt,
        createdAt: projectApplication.createdAt,
      })
      .from(projectApplication)
      .innerJoin(researchProject, eq(researchProject.id, projectApplication.projectId))
      .where(predicate)
      // §4c rule 4 — ends in a unique column.
      .orderBy(desc(projectApplication.createdAt), desc(projectApplication.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db.select({ value: count() }).from(projectApplication).where(predicate),
  ]);

  return { rows, total: totals?.value ?? 0 };
}

/**
 * `GET /invites/mine` — every invite addressed to the caller (§11j.2).
 *
 * THE ONE THAT MAKES THE INVITE FLOW TERMINATE SOMEWHERE. `/invites/:inviteId/accept` and
 * `/decline` both need an `inviteId`, and until this read existed an invitee had no way to
 * obtain one — the project-scoped list is maintainer-gated, so the only party who can act
 * on an invite was the only party who could not find it.
 *
 * Joined to the INVITER for the display name; the invitee is the caller.
 */
export async function listMyInvites(
  inviteeUserId: string,
  filter: {
    readonly status?: (typeof projectInvite.$inferSelect)["status"] | undefined;
    readonly page: number;
    readonly limit: number;
  },
): Promise<{ readonly rows: readonly MyInviteView[]; readonly total: number }> {
  const conditions = [eq(projectInvite.inviteeUserId, inviteeUserId)];
  if (filter.status) {
    conditions.push(eq(projectInvite.status, filter.status));
  }
  const predicate = and(...conditions);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: projectInvite.id,
        status: projectInvite.status,
        ...OWNING_PROJECT_COLUMNS,
        invitedByUserId: projectInvite.invitedByUserId,
        invitedByName: user.name,
        invitedByAvatarImageUrl: user.image,
        openRoleId: projectInvite.openRoleId,
        roleTitle: projectInvite.roleTitle,
        message: projectInvite.message,
        respondedAt: projectInvite.respondedAt,
        expiresAt: projectInvite.expiresAt,
        createdAt: projectInvite.createdAt,
      })
      .from(projectInvite)
      .innerJoin(researchProject, eq(researchProject.id, projectInvite.projectId))
      .innerJoin(user, eq(user.id, projectInvite.invitedByUserId))
      .where(predicate)
      .orderBy(desc(projectInvite.createdAt), desc(projectInvite.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db.select({ value: count() }).from(projectInvite).where(predicate),
  ]);

  return { rows, total: totals?.value ?? 0 };
}

export async function listApplications(
  projectId: string,
  filter: ListApplicationsFilter,
): Promise<{ readonly rows: readonly ApplicationView[]; readonly total: number }> {
  const conditions = [eq(projectApplication.projectId, projectId)];
  if (filter.status) {
    conditions.push(eq(projectApplication.status, filter.status));
  }
  const predicate = and(...conditions);

  const rows = await db
    .select(APPLICATION_VIEW_COLUMNS)
    .from(projectApplication)
    .innerJoin(user, eq(user.id, projectApplication.applicantUserId))
    .where(predicate)
    .orderBy(desc(projectApplication.createdAt), desc(projectApplication.id))
    .limit(filter.limit)
    .offset((filter.page - 1) * filter.limit);

  const [totals] = await db.select({ value: count() }).from(projectApplication).where(predicate);

  return { rows, total: totals?.value ?? 0 };
}

/**
 * Accepts an application. The most concurrency-sensitive transaction in the domain.
 *
 * Everything happens in ONE transaction with the role row locked FOR UPDATE, because
 * two maintainers accepting the last seat simultaneously must not both succeed:
 *   - re-assert the application is still pending and un-expired (it may have been
 *     withdrawn or declined microseconds ago);
 *   - re-read slot capacity UNDER THE LOCK, not from the earlier read;
 *   - insert or REACTIVATE the membership, open a new interval, bump slotsFilledCount,
 *     recompute the role's derived status, and move both counters.
 *
 * Re-join is why the membership write is an upsert rather than an insert: the
 * `(projectId, userId)` unique index means a returning member already has a row, and
 * reactivating it MUST clear `removedByUserId` or `project_member_removed_by_ck`
 * raises 23514.
 */
export async function acceptApplication(
  projectId: string,
  applicationId: string,
  reviewerUserId: string,
  reviewNote: string | null,
): Promise<Result<ApplicationView, ProjectApplicationError>> {
  const outcome = await db.transaction(async (tx) => {
    const [application] = await tx
      .select({
        id: projectApplication.id,
        status: projectApplication.status,
        applicantUserId: projectApplication.applicantUserId,
        openRoleId: projectApplication.openRoleId,
        roleTitleSnapshot: projectApplication.roleTitleSnapshot,
        selectedSkills: projectApplication.selectedSkills,
        expiresAt: projectApplication.expiresAt,
      })
      .from(projectApplication)
      .where(
        and(eq(projectApplication.id, applicationId), eq(projectApplication.projectId, projectId)),
      )
      .for("update");

    if (!application) {
      return { kind: "not-found" } as const;
    }
    if (application.status !== "pending") {
      return { kind: "not-pending" } as const;
    }
    if (application.expiresAt !== null && application.expiresAt <= new Date()) {
      return { kind: "not-pending" } as const;
    }

    if (application.openRoleId !== null) {
      const [role] = await tx
        .select({
          slotsTotal: projectOpenRole.slotsTotal,
          slotsFilledCount: projectOpenRole.slotsFilledCount,
          status: projectOpenRole.status,
        })
        .from(projectOpenRole)
        .where(eq(projectOpenRole.id, application.openRoleId))
        // THE lock that serializes two concurrent accepts of the last seat.
        .for("update");

      if (!role) {
        return { kind: "role-missing", roleId: application.openRoleId } as const;
      }
      if (role.status === "closed") {
        return { kind: "role-not-open" } as const;
      }
      // Re-checked under the lock, not from the pre-transaction read.
      if (role.slotsFilledCount >= role.slotsTotal) {
        return { kind: "role-full" } as const;
      }

      // BOTH columns in ONE statement. `project_open_role_open_not_full_ck` forbids
      // `status='open' AND slots_filled_count >= slots_total`, and Postgres cannot
      // DEFER a CHECK — so incrementing the count first and fixing the status in a
      // second statement violates the constraint mid-transaction and aborts. The
      // status is derived here from the values already read under the lock.
      const nextFilledCount = role.slotsFilledCount + 1;
      await tx
        .update(projectOpenRole)
        .set({
          slotsFilledCount: nextFilledCount,
          status: nextFilledCount >= role.slotsTotal ? "filled" : "open",
        })
        .where(eq(projectOpenRole.id, application.openRoleId));
    }

    const [existingMember] = await tx
      .select({ id: projectMember.id, status: projectMember.status })
      .from(projectMember)
      .where(
        and(
          eq(projectMember.projectId, projectId),
          eq(projectMember.userId, application.applicantUserId),
        ),
      )
      .for("update");

    if (existingMember?.status === "active") {
      return { kind: "already-member" } as const;
    }

    let memberId: string;

    if (existingMember) {
      // RE-JOIN. Clearing removedByUserId and leftAt is mandatory, not cosmetic:
      // project_member_removed_by_ck and project_member_left_at_ck both fire otherwise.
      await tx
        .update(projectMember)
        .set({
          status: "active",
          leftAt: null,
          removedByUserId: null,
          projectRole: "contributor",
          roleTitle: application.roleTitleSnapshot,
          skills: [...application.selectedSkills],
          sourceApplicationId: applicationId,
        })
        .where(eq(projectMember.id, existingMember.id));
      memberId = existingMember.id;
    } else {
      const [createdMember] = await tx
        .insert(projectMember)
        .values({
          projectId,
          userId: application.applicantUserId,
          // Accepting an application ALWAYS yields `contributor`. `founder` is written
          // exactly once, by the create transaction, and no endpoint assigns it.
          projectRole: "contributor",
          roleTitle: application.roleTitleSnapshot,
          skills: [...application.selectedSkills],
          sourceApplicationId: applicationId,
        })
        .returning({ id: projectMember.id });

      if (!createdMember) {
        throw new Error("acceptApplication: member insert returned no row");
      }
      memberId = createdMember.id;
    }

    // A new stint. The partial unique index guarantees only one is ever open.
    await tx.insert(projectMemberInterval).values({ memberId });

    await tx
      .update(projectApplication)
      .set({
        status: "accepted",
        reviewedByUserId: reviewerUserId,
        reviewNote,
        decidedAt: new Date(),
      })
      .where(eq(projectApplication.id, applicationId));

    // The role's status was already set above, in the same statement as the count.
    // This only reconciles the cached openRoleCount when a seat actually closed.
    if (application.openRoleId !== null) {
      await syncOpenRoleCount(tx, projectId, application.openRoleId);
    }

    await tx
      .update(projectStats)
      .set({
        teamMemberCount: sql`${projectStats.teamMemberCount} + 1`,
        pendingApplicationCount: sql`GREATEST(${projectStats.pendingApplicationCount} - 1, 0)`,
      })
      .where(eq(projectStats.projectId, projectId));

    // IN THE TRANSACTION, not after it (§11l.2). An applicant told they were accepted by a
    // fan-out that ran after a rollback has been told something false.
    await enqueueNotifications(tx, reviewerUserId, [
      {
        recipientUserId: application.applicantUserId,
        kind: "project_application_accepted",
        projectId,
        payload: { applicationId },
      },
    ]);

    return { kind: "accepted" } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "APPLICATION_NOT_FOUND", applicationId } };
    case "not-pending":
      return { success: false, error: { type: "APPLICATION_NOT_PENDING" } };
    case "role-missing":
      return { success: false, error: { type: "ROLE_NOT_FOUND", roleId: outcome.roleId } };
    case "role-not-open":
      return { success: false, error: { type: "ROLE_NOT_OPEN" } };
    case "role-full":
      return { success: false, error: { type: "ROLE_FULL" } };
    case "already-member":
      return { success: false, error: { type: "ALREADY_MEMBER" } };
    case "accepted":
      break;
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled accept outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const view = await findApplicationById(projectId, applicationId);
  if (!view) {
    return { success: false, error: { type: "APPLICATION_NOT_FOUND", applicationId } };
  }
  return { success: true, value: view };
}

/** Declines an application. Reviewer-driven, so it stamps decidedAt. */
export async function declineApplication(
  projectId: string,
  applicationId: string,
  reviewerUserId: string,
  reviewNote: string | null,
): Promise<Result<ApplicationView, ProjectApplicationError>> {
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(projectApplication)
      .set({
        status: "declined",
        reviewedByUserId: reviewerUserId,
        reviewNote,
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(projectApplication.id, applicationId),
          eq(projectApplication.projectId, projectId),
          eq(projectApplication.status, "pending"),
        ),
      )
      .returning({
        id: projectApplication.id,
        applicantUserId: projectApplication.applicantUserId,
      });

    if (rows.length > 0) {
      await tx
        .update(projectStats)
        .set({
          pendingApplicationCount: sql`GREATEST(${projectStats.pendingApplicationCount} - 1, 0)`,
        })
        .where(eq(projectStats.projectId, projectId));

      // A decline that reaches nobody is the same silence as no decision at all — the
      // applicant refreshes `/applications/mine` for weeks (§11l.2).
      await enqueueNotifications(
        tx,
        reviewerUserId,
        rows.map((row) => ({
          recipientUserId: row.applicantUserId,
          kind: "project_application_declined" as const,
          projectId,
          payload: { applicationId },
        })),
      );
    }
    return rows.length;
  });

  if (updated === 0) {
    const existing = await findApplicationById(projectId, applicationId);
    return existing
      ? { success: false, error: { type: "APPLICATION_NOT_PENDING" } }
      : { success: false, error: { type: "APPLICATION_NOT_FOUND", applicationId } };
  }

  const view = await findApplicationById(projectId, applicationId);
  if (!view) {
    return { success: false, error: { type: "APPLICATION_NOT_FOUND", applicationId } };
  }
  return { success: true, value: view };
}

/**
 * Withdraws an application. The APPLICANT only — checked by matching the session id in
 * the WHERE clause, so a maintainer cannot withdraw on someone's behalf and a stranger
 * cannot probe which application ids exist.
 *
 * `withdrawn` is applicant-driven, so it does stamp decidedAt (a human decided).
 */
export async function withdrawApplication(
  projectId: string,
  applicationId: string,
  applicantUserId: string,
): Promise<Result<ApplicationView, ProjectApplicationError>> {
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(projectApplication)
      .set({ status: "withdrawn", decidedAt: new Date() })
      .where(
        and(
          eq(projectApplication.id, applicationId),
          eq(projectApplication.projectId, projectId),
          eq(projectApplication.applicantUserId, applicantUserId),
          eq(projectApplication.status, "pending"),
        ),
      )
      .returning({ id: projectApplication.id });

    if (rows.length > 0) {
      await tx
        .update(projectStats)
        .set({
          pendingApplicationCount: sql`GREATEST(${projectStats.pendingApplicationCount} - 1, 0)`,
        })
        .where(eq(projectStats.projectId, projectId));
    }
    return rows.length;
  });

  if (updated === 0) {
    return { success: false, error: { type: "APPLICATION_NOT_FOUND", applicationId } };
  }

  const view = await findApplicationById(projectId, applicationId);
  if (!view) {
    return { success: false, error: { type: "APPLICATION_NOT_FOUND", applicationId } };
  }
  return { success: true, value: view };
}

// ---------------------------------------------------------------------------
// Invites — the other direction.
// ---------------------------------------------------------------------------

export interface InviteView {
  readonly id: string;
  readonly status: (typeof projectInvite.$inferSelect)["status"];
  readonly inviteeUserId: string;
  readonly inviteeName: string;
  readonly inviteeAvatarImageUrl: string | null;
  readonly invitedByUserId: string;
  readonly openRoleId: string | null;
  readonly roleTitle: string | null;
  readonly message: string | null;
  readonly respondedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

const INVITE_VIEW_COLUMNS = {
  id: projectInvite.id,
  status: projectInvite.status,
  inviteeUserId: projectInvite.inviteeUserId,
  inviteeName: user.name,
  inviteeAvatarImageUrl: user.image,
  invitedByUserId: projectInvite.invitedByUserId,
  openRoleId: projectInvite.openRoleId,
  roleTitle: projectInvite.roleTitle,
  message: projectInvite.message,
  respondedAt: projectInvite.respondedAt,
  expiresAt: projectInvite.expiresAt,
  createdAt: projectInvite.createdAt,
} as const;

/**
 * Invites a person to a project.
 *
 * `INVITEE_NOT_ELIGIBLE` deliberately collapses "no such user" and "already an active
 * member". Splitting them would turn this endpoint into a user-enumeration oracle
 * against the entire user table — a maintainer of any throwaway project could probe
 * which user ids exist.
 */
export async function createInvite(
  projectId: string,
  invitedByUserId: string,
  input: {
    readonly inviteeUserId: string;
    readonly openRoleId?: string | undefined;
    readonly message?: string | undefined;
  },
): Promise<Result<InviteView, ProjectApplicationError>> {
  if (input.inviteeUserId === invitedByUserId) {
    return { success: false, error: { type: "SELF_INVITE_FORBIDDEN" } };
  }

  const [invitee] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, input.inviteeUserId));

  if (!invitee) {
    return { success: false, error: { type: "INVITEE_NOT_ELIGIBLE" } };
  }

  const [existingMembership] = await db
    .select({ status: projectMember.status })
    .from(projectMember)
    .where(
      and(eq(projectMember.projectId, projectId), eq(projectMember.userId, input.inviteeUserId)),
    );

  if (existingMembership?.status === "active") {
    // Same error as "no such user" — see the doc comment.
    return { success: false, error: { type: "INVITEE_NOT_ELIGIBLE" } };
  }

  let roleTitle: string | null = null;
  if (input.openRoleId !== undefined) {
    const [role] = await db
      .select({ roleTitle: projectOpenRole.roleTitle, status: projectOpenRole.status })
      .from(projectOpenRole)
      .where(
        and(eq(projectOpenRole.id, input.openRoleId), eq(projectOpenRole.projectId, projectId)),
      );
    if (!role) {
      return { success: false, error: { type: "ROLE_NOT_FOUND", roleId: input.openRoleId } };
    }
    if (role.status !== "open") {
      return { success: false, error: { type: "ROLE_NOT_OPEN" } };
    }
    roleTitle = role.roleTitle;
  }

  try {
    // THE INSERT AND THE NOTIFICATION ARE ONE TRANSACTION (§11l.2). An invite is the
    // sharpest case in the domain: §11j.2 built `GET /invites/mine` because an invite
    // nobody can find is an invite nobody can accept, and an invite nobody is TOLD about
    // is the same dead end one step earlier. A unique violation still rolls the whole
    // thing back and is caught below.
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(projectInvite)
        .values({
          projectId,
          inviteeUserId: input.inviteeUserId,
          invitedByUserId,
          openRoleId: input.openRoleId ?? null,
          roleTitle,
          message: input.message ?? null,
          expiresAt: expiryInstant(),
        })
        .returning({ id: projectInvite.id });

      if (!row) {
        throw new Error("createInvite: insert returned no row");
      }

      await enqueueNotifications(tx, invitedByUserId, [
        {
          recipientUserId: input.inviteeUserId,
          kind: "project_invite_received",
          projectId,
          payload: { inviteId: row.id, openRoleId: input.openRoleId ?? null, roleTitle },
        },
      ]);

      return row;
    });

    const view = await findInviteById(projectId, created.id);
    if (!view) {
      throw new Error("createInvite: created invite could not be read back");
    }
    return { success: true, value: view };
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "ALREADY_INVITED" } };
    }
    throw error;
  }
}

export async function findInviteById(
  projectId: string,
  inviteId: string,
): Promise<InviteView | null> {
  const [row] = await db
    .select(INVITE_VIEW_COLUMNS)
    .from(projectInvite)
    .innerJoin(user, eq(user.id, projectInvite.inviteeUserId))
    .where(and(eq(projectInvite.id, inviteId), eq(projectInvite.projectId, projectId)));
  return row ?? null;
}

export async function listInvites(
  projectId: string,
  filter: {
    readonly status?: (typeof projectInvite.$inferSelect)["status"] | undefined;
    readonly page: number;
    readonly limit: number;
  },
): Promise<{ readonly rows: readonly InviteView[]; readonly total: number }> {
  const conditions = [eq(projectInvite.projectId, projectId)];
  if (filter.status) {
    conditions.push(eq(projectInvite.status, filter.status));
  }
  const predicate = and(...conditions);

  const rows = await db
    .select(INVITE_VIEW_COLUMNS)
    .from(projectInvite)
    .innerJoin(user, eq(user.id, projectInvite.inviteeUserId))
    .where(predicate)
    .orderBy(desc(projectInvite.createdAt), desc(projectInvite.id))
    .limit(filter.limit)
    .offset((filter.page - 1) * filter.limit);

  const [totals] = await db.select({ value: count() }).from(projectInvite).where(predicate);

  return { rows, total: totals?.value ?? 0 };
}

/**
 * Accepts an invite. Same membership mechanics as accepting an application, and the
 * INVITEE is the actor — so this endpoint carries `requireIdentifiedUser` too. Guarding
 * only the invite CREATE would check the inviter while leaving the endpoint that
 * actually inserts a roster row open to an anonymous session.
 */
export async function acceptInvite(
  projectId: string,
  inviteId: string,
  inviteeUserId: string,
): Promise<Result<InviteView, ProjectApplicationError>> {
  const outcome = await db.transaction(async (tx) => {
    const [invite] = await tx
      .select({
        status: projectInvite.status,
        inviteeUserId: projectInvite.inviteeUserId,
        // Selected for the acceptance notification: the inviter is who it goes to.
        invitedByUserId: projectInvite.invitedByUserId,
        openRoleId: projectInvite.openRoleId,
        roleTitle: projectInvite.roleTitle,
        expiresAt: projectInvite.expiresAt,
      })
      .from(projectInvite)
      .where(and(eq(projectInvite.id, inviteId), eq(projectInvite.projectId, projectId)))
      .for("update");

    if (!invite) {
      return { kind: "not-found" } as const;
    }
    // Identity is checked against the SESSION, never a body field.
    if (invite.inviteeUserId !== inviteeUserId) {
      return { kind: "not-invitee" } as const;
    }
    if (invite.status !== "pending") {
      return { kind: "not-pending" } as const;
    }
    if (invite.expiresAt !== null && invite.expiresAt <= new Date()) {
      return { kind: "not-pending" } as const;
    }

    if (invite.openRoleId !== null) {
      const [role] = await tx
        .select({
          slotsTotal: projectOpenRole.slotsTotal,
          slotsFilledCount: projectOpenRole.slotsFilledCount,
          status: projectOpenRole.status,
        })
        .from(projectOpenRole)
        .where(eq(projectOpenRole.id, invite.openRoleId))
        .for("update");

      if (!role) {
        return { kind: "role-missing", roleId: invite.openRoleId } as const;
      }
      if (role.status === "closed") {
        return { kind: "role-not-open" } as const;
      }
      if (role.slotsFilledCount >= role.slotsTotal) {
        return { kind: "role-full" } as const;
      }

      // One statement, same reason as acceptApplication above.
      const nextFilledCount = role.slotsFilledCount + 1;
      await tx
        .update(projectOpenRole)
        .set({
          slotsFilledCount: nextFilledCount,
          status: nextFilledCount >= role.slotsTotal ? "filled" : "open",
        })
        .where(eq(projectOpenRole.id, invite.openRoleId));
    }

    const [existingMember] = await tx
      .select({ id: projectMember.id, status: projectMember.status })
      .from(projectMember)
      .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, inviteeUserId)))
      .for("update");

    if (existingMember?.status === "active") {
      return { kind: "already-member" } as const;
    }

    let memberId: string;
    if (existingMember) {
      await tx
        .update(projectMember)
        .set({
          status: "active",
          leftAt: null,
          removedByUserId: null,
          projectRole: "contributor",
          roleTitle: invite.roleTitle,
          sourceInviteId: inviteId,
        })
        .where(eq(projectMember.id, existingMember.id));
      memberId = existingMember.id;
    } else {
      const [createdMember] = await tx
        .insert(projectMember)
        .values({
          projectId,
          userId: inviteeUserId,
          projectRole: "contributor",
          roleTitle: invite.roleTitle,
          sourceInviteId: inviteId,
        })
        .returning({ id: projectMember.id });

      if (!createdMember) {
        throw new Error("acceptInvite: member insert returned no row");
      }
      memberId = createdMember.id;
    }

    await tx.insert(projectMemberInterval).values({ memberId });

    await tx
      .update(projectInvite)
      .set({ status: "accepted", respondedAt: new Date() })
      .where(eq(projectInvite.id, inviteId));

    if (invite.openRoleId !== null) {
      await syncOpenRoleCount(tx, projectId, invite.openRoleId);
    }

    await tx
      .update(projectStats)
      .set({ teamMemberCount: sql`${projectStats.teamMemberCount} + 1` })
      .where(eq(projectStats.projectId, projectId));

    // The inviter is the one waiting on the answer. An invite is a two-sided
    // conversation and until now only one side could see it move (§11l.2).
    await enqueueNotifications(tx, inviteeUserId, [
      {
        recipientUserId: invite.invitedByUserId,
        kind: "project_invite_accepted",
        projectId,
        payload: { inviteId },
      },
    ]);

    return { kind: "accepted" } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return { success: false, error: { type: "INVITE_NOT_FOUND", inviteId } };
    case "not-invitee":
      // Same shape as "no such invite": a stranger must not learn the id is real.
      return { success: false, error: { type: "INVITE_NOT_FOUND", inviteId } };
    case "not-pending":
      return { success: false, error: { type: "INVITE_NOT_PENDING" } };
    case "role-missing":
      return { success: false, error: { type: "ROLE_NOT_FOUND", roleId: outcome.roleId } };
    case "role-not-open":
      return { success: false, error: { type: "ROLE_NOT_OPEN" } };
    case "role-full":
      return { success: false, error: { type: "ROLE_FULL" } };
    case "already-member":
      return { success: false, error: { type: "ALREADY_MEMBER" } };
    case "accepted":
      break;
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled invite accept outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }

  const view = await findInviteById(projectId, inviteId);
  if (!view) {
    return { success: false, error: { type: "INVITE_NOT_FOUND", inviteId } };
  }
  return { success: true, value: view };
}

/**
 * Declines an invite. Invitee only, matched in the WHERE clause.
 *
 * WRAPPED IN A TRANSACTION for the notification (§11l.2), which is the only reason it needs
 * one: the update is a single statement and was atomic already. The enqueue has to be
 * inside it, because a fan-out after the commit can announce a decline that was rolled
 * back and one before it can be lost.
 */
export async function declineInvite(
  projectId: string,
  inviteId: string,
  inviteeUserId: string,
): Promise<Result<InviteView, ProjectApplicationError>> {
  const rows = await db.transaction(async (tx) => {
    const declined = await tx
      .update(projectInvite)
      .set({ status: "declined", respondedAt: new Date() })
      .where(
        and(
          eq(projectInvite.id, inviteId),
          eq(projectInvite.projectId, projectId),
          eq(projectInvite.inviteeUserId, inviteeUserId),
          eq(projectInvite.status, "pending"),
        ),
      )
      .returning({ id: projectInvite.id, invitedByUserId: projectInvite.invitedByUserId });

    await enqueueNotifications(
      tx,
      inviteeUserId,
      declined.map((row) => ({
        recipientUserId: row.invitedByUserId,
        kind: "project_invite_declined" as const,
        projectId,
        payload: { inviteId },
      })),
    );

    return declined;
  });

  if (rows.length === 0) {
    return { success: false, error: { type: "INVITE_NOT_FOUND", inviteId } };
  }

  const view = await findInviteById(projectId, inviteId);
  if (!view) {
    return { success: false, error: { type: "INVITE_NOT_FOUND", inviteId } };
  }
  return { success: true, value: view };
}

/** Revokes an invite. Project-side action, so the actor is a maintainer, not the invitee. */
export async function revokeInvite(
  projectId: string,
  inviteId: string,
  revokedByUserId: string,
): Promise<Result<{ readonly revoked: true }, ProjectApplicationError>> {
  const rows = await db.transaction(async (tx) => {
    const revoked = await tx
      .update(projectInvite)
      .set({ status: "revoked", respondedAt: new Date() })
      .where(
        and(
          eq(projectInvite.id, inviteId),
          eq(projectInvite.projectId, projectId),
          eq(projectInvite.status, "pending"),
        ),
      )
      .returning({ id: projectInvite.id, inviteeUserId: projectInvite.inviteeUserId });

    // Told BEFORE they try to accept it. A revoked invite that stays visible in
    // `/invites/mine` ends in an `INVITE_NOT_PENDING` the invitee cannot explain.
    await enqueueNotifications(
      tx,
      revokedByUserId,
      revoked.map((row) => ({
        recipientUserId: row.inviteeUserId,
        kind: "project_invite_revoked" as const,
        projectId,
        payload: { inviteId },
      })),
    );

    return revoked;
  });

  if (rows.length === 0) {
    return { success: false, error: { type: "INVITE_NOT_FOUND", inviteId } };
  }
  return { success: true, value: { revoked: true } };
}

/** Bulk-expires stale pending rows. Used by the cron script, not by any request path. */
export async function expireStaleRequests(): Promise<{
  readonly applications: number;
  readonly invites: number;
}> {
  const expiredApplications = await db
    .update(projectApplication)
    .set({ status: "expired" })
    .where(
      and(
        eq(projectApplication.status, "pending"),
        sql`${projectApplication.expiresAt} IS NOT NULL AND ${projectApplication.expiresAt} <= now()`,
      ),
    )
    .returning({ id: projectApplication.id });

  const expiredInvites = await db
    .update(projectInvite)
    .set({ status: "expired" })
    .where(
      and(
        eq(projectInvite.status, "pending"),
        sql`${projectInvite.expiresAt} IS NOT NULL AND ${projectInvite.expiresAt} <= now()`,
      ),
    )
    .returning({ id: projectInvite.id });

  return { applications: expiredApplications.length, invites: expiredInvites.length };
}
