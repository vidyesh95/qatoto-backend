import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  openRoleCompensation,
  projectOpenRole,
  projectStats,
  researchCategory,
  researchProject,
} from "#src/db/schema.js";
import { isForeignKeyViolation } from "#src/lib/pg-errors.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Open roles and their compensation strands.
 *
 * The strands are a table rather than a jsonb column because each kind has its own
 * numeric range that must be independently QUERYABLE ("roles offering ≥ 3% equity") and
 * independently validated. Two rules are enforced here as well as in the DB, so the
 * caller gets a typed 422 rather than a 500 from a CHECK:
 *
 *   - the equity band is an ADVERTISED OFFER, never a granted share (grants come only
 *     from §9's ledger), and is bounded 0..10000;
 *   - the earnedAsPolicy pairing — equity must vest via slicing pie, cash must pay out
 *     of escrow. A founder cannot advertise a payout mechanism the escrow engine will
 *     not execute (§5).
 */

export type ProjectRoleError =
  | ProjectAccessError
  | { type: "ROLE_NOT_FOUND"; roleId: string }
  | { type: "PROJECT_ARCHIVED" }
  | { type: "DUPLICATE_COMPENSATION_KIND"; kind: string }
  | { type: "COMPENSATION_POLICY_MISMATCH"; kind: string; policy: string }
  | { type: "COMPENSATION_RANGE_INVALID"; kind: string }
  | { type: "SLOTS_BELOW_FILLED"; slotsFilledCount: number }
  | { type: "ROLE_NOT_OPEN" }
  | { type: "ROLE_HAS_REFERENCES" };

export type CompensationKind = (typeof openRoleCompensation.$inferSelect)["kind"];
export type EarnedAsPolicy = (typeof openRoleCompensation.$inferSelect)["earnedAsPolicy"];

export interface CompensationStrandInput {
  readonly kind: CompensationKind;
  readonly salaryMinInCentsPerMonth?: number | undefined;
  readonly salaryMaxInCentsPerMonth?: number | undefined;
  readonly oneTimeMinInCents?: number | undefined;
  readonly oneTimeMaxInCents?: number | undefined;
  readonly equityBasisPointsMin?: number | undefined;
  readonly equityBasisPointsMax?: number | undefined;
  readonly earnedAsPolicy: EarnedAsPolicy;
  readonly earnedAsNote?: string | undefined;
}

export interface CreateOpenRoleInput {
  readonly roleTitle: string;
  readonly skills?: readonly string[] | undefined;
  readonly commitment: (typeof projectOpenRole.$inferSelect)["commitment"];
  readonly slotsTotal?: number | undefined;
  readonly description?: string | undefined;
  readonly compensation?: readonly CompensationStrandInput[] | undefined;
}

export type UpdateOpenRoleInput = Partial<CreateOpenRoleInput>;

export interface OpenRoleView {
  readonly id: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly roleTitle: string;
  readonly skills: readonly string[];
  readonly commitment: (typeof projectOpenRole.$inferSelect)["commitment"];
  readonly status: (typeof projectOpenRole.$inferSelect)["status"];
  readonly slotsTotal: number;
  readonly slotsFilledCount: number;
  readonly description: string | null;
  readonly currency: string;
  readonly compensation: readonly (typeof openRoleCompensation.$inferSelect)[];
  readonly createdAt: Date;
}

export interface OpenRolePage {
  readonly rows: readonly OpenRoleView[];
  readonly total: number;
}

/** Which policies each compensation kind may legitimately advertise (§5). */
/**
 * THE POLICY PAIRING (§4d, §7A).
 *
 * The two escrow values are RETIRED and appear here in NEITHER list. They forced every
 * cash strand through an escrow release — money-in gated data-out for a founder who never
 * ran a round here, and a wage made conditional on a Proof-of-Effort verdict, which §0
 * forbids outright. They remain in the pgEnum so migration 0010's rows stay readable;
 * `open_role_compensation_policy_pairing_ck` (migration 0019) refuses them at the column
 * level, and this map refuses them with a typed 422 before it gets that far.
 */
const VALID_POLICIES_BY_KIND: Readonly<Record<CompensationKind, readonly EarnedAsPolicy[]>> = {
  equity: ["slicing_pie_vesting"],
  salary: ["off_platform_payroll", "direct_transfer"],
  one_time: ["off_platform_payroll", "direct_transfer"],
};

/**
 * Validates one strand: at most one per kind is enforced by a unique index, but the
 * kind↔columns shape, the policy pairing and the numeric ranges are checked here so the
 * client sees a typed 422 rather than a CHECK-constraint 500.
 */
function validateCompensationStrands(
  strands: readonly CompensationStrandInput[],
): ProjectRoleError | null {
  const seenKinds = new Set<CompensationKind>();

  for (const strand of strands) {
    if (seenKinds.has(strand.kind)) {
      return { type: "DUPLICATE_COMPENSATION_KIND", kind: strand.kind };
    }
    seenKinds.add(strand.kind);

    const allowedPolicies = VALID_POLICIES_BY_KIND[strand.kind];
    if (!allowedPolicies.includes(strand.earnedAsPolicy)) {
      return {
        type: "COMPENSATION_POLICY_MISMATCH",
        kind: strand.kind,
        policy: strand.earnedAsPolicy,
      };
    }

    switch (strand.kind) {
      case "salary": {
        const min = strand.salaryMinInCentsPerMonth;
        const max = strand.salaryMaxInCentsPerMonth;
        if (min === undefined || min < 0 || (max !== undefined && max < min)) {
          return { type: "COMPENSATION_RANGE_INVALID", kind: strand.kind };
        }
        break;
      }
      case "one_time": {
        const min = strand.oneTimeMinInCents;
        const max = strand.oneTimeMaxInCents;
        if (min === undefined || min < 0 || (max !== undefined && max < min)) {
          return { type: "COMPENSATION_RANGE_INVALID", kind: strand.kind };
        }
        break;
      }
      case "equity": {
        const min = strand.equityBasisPointsMin;
        const max = strand.equityBasisPointsMax;
        // Bounded at 10000 — an advertised band above 100% is nonsense, and this is the
        // check that stops a founder advertising 150% of the company.
        if (min === undefined || min < 0 || min > 10_000) {
          return { type: "COMPENSATION_RANGE_INVALID", kind: strand.kind };
        }
        if (max !== undefined && (max < min || max > 10_000)) {
          return { type: "COMPENSATION_RANGE_INVALID", kind: strand.kind };
        }
        break;
      }
      default: {
        const exhaustiveCheck: never = strand.kind;
        throw new Error(`Unhandled compensation kind: ${String(exhaustiveCheck)}`);
      }
    }
  }

  return null;
}

/** Only the columns the strand's own kind may populate; the rest stay NULL. */
function toStrandRow(
  openRoleId: string,
  strand: CompensationStrandInput,
): typeof openRoleCompensation.$inferInsert {
  return {
    openRoleId,
    kind: strand.kind,
    salaryMinInCentsPerMonth:
      strand.kind === "salary" ? (strand.salaryMinInCentsPerMonth ?? null) : null,
    salaryMaxInCentsPerMonth:
      strand.kind === "salary" ? (strand.salaryMaxInCentsPerMonth ?? null) : null,
    oneTimeMinInCents: strand.kind === "one_time" ? (strand.oneTimeMinInCents ?? null) : null,
    oneTimeMaxInCents: strand.kind === "one_time" ? (strand.oneTimeMaxInCents ?? null) : null,
    equityBasisPointsMin: strand.kind === "equity" ? (strand.equityBasisPointsMin ?? null) : null,
    equityBasisPointsMax: strand.kind === "equity" ? (strand.equityBasisPointsMax ?? null) : null,
    earnedAsPolicy: strand.earnedAsPolicy,
    earnedAsNote: strand.earnedAsNote ?? null,
  };
}

/**
 * Re-derives an open role's status AND its cached `openRoleCount` in ONE statement.
 *
 * WHY ONE STATEMENT. `project_open_role_open_not_full_ck` forbids
 * `status = 'open' AND slots_filled_count >= slots_total`, and Postgres cannot DEFER a
 * CHECK constraint. So a transaction that increments the count first and fixes the
 * status afterwards violates the constraint on the FIRST statement and aborts — which
 * is exactly what the constraint is for, and exactly why callers that change capacity
 * must write both columns together rather than calling a recompute afterwards.
 *
 * Use this where the status is being re-derived on its own (a seat freed by a
 * departure, or `slotsTotal` widening). Where the count is CHANGING, set both columns
 * in the caller's own UPDATE — see acceptApplication.
 *
 * A `closed` role stays closed: closing is an editorial decision, not a capacity one.
 */
export async function recomputeOpenRoleStatus(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  roleId: string,
): Promise<void> {
  const [role] = await tx
    .select({
      projectId: projectOpenRole.projectId,
      status: projectOpenRole.status,
      slotsTotal: projectOpenRole.slotsTotal,
      slotsFilledCount: projectOpenRole.slotsFilledCount,
    })
    .from(projectOpenRole)
    .where(eq(projectOpenRole.id, roleId));

  if (!role || role.status === "closed") {
    return;
  }

  const nextStatus = role.slotsFilledCount >= role.slotsTotal ? "filled" : "open";
  if (nextStatus === role.status) {
    return;
  }

  await tx
    .update(projectOpenRole)
    .set({ status: nextStatus })
    .where(eq(projectOpenRole.id, roleId));

  await tx
    .update(projectStats)
    .set({
      openRoleCount:
        nextStatus === "open"
          ? sql`${projectStats.openRoleCount} + 1`
          : sql`GREATEST(${projectStats.openRoleCount} - 1, 0)`,
    })
    .where(eq(projectStats.projectId, role.projectId));
}

/**
 * Reconciles the cached `openRoleCount` after a caller has ALREADY written the role's
 * status in its own UPDATE (the accept path). Reads the role's current status and makes
 * the counter agree — it never writes the role itself.
 */
export async function syncOpenRoleCount(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  projectId: string,
  roleId: string,
): Promise<void> {
  const [role] = await tx
    .select({ status: projectOpenRole.status })
    .from(projectOpenRole)
    .where(eq(projectOpenRole.id, roleId));

  if (!role || role.status === "open") {
    return;
  }

  // The seat closed (filled or closed), so the cached open-role count loses one.
  await tx
    .update(projectStats)
    .set({ openRoleCount: sql`GREATEST(${projectStats.openRoleCount} - 1, 0)` })
    .where(eq(projectStats.projectId, projectId));
}

export async function createOpenRole(
  projectId: string,
  input: CreateOpenRoleInput,
): Promise<Result<OpenRoleView, ProjectRoleError>> {
  const strands = input.compensation ?? [];
  const strandError = validateCompensationStrands(strands);
  if (strandError) {
    return { success: false, error: strandError };
  }

  const createdRoleId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(projectOpenRole)
      .values({
        projectId,
        roleTitle: input.roleTitle,
        skills: [...(input.skills ?? [])],
        commitment: input.commitment,
        slotsTotal: input.slotsTotal ?? 1,
        description: input.description ?? null,
      })
      .returning({ id: projectOpenRole.id });

    if (!created) {
      throw new Error("createOpenRole: insert returned no row");
    }

    if (strands.length > 0) {
      await tx
        .insert(openRoleCompensation)
        .values(strands.map((strand) => toStrandRow(created.id, strand)));
    }

    await tx
      .update(projectStats)
      .set({ openRoleCount: sql`${projectStats.openRoleCount} + 1` })
      .where(eq(projectStats.projectId, projectId));

    return created.id;
  });

  const view = await findOpenRoleById(createdRoleId);
  if (!view) {
    throw new Error("createOpenRole: created role could not be read back");
  }
  return { success: true, value: view };
}

export async function updateOpenRole(
  projectId: string,
  roleId: string,
  input: UpdateOpenRoleInput,
): Promise<Result<OpenRoleView, ProjectRoleError>> {
  if (input.compensation !== undefined) {
    const strandError = validateCompensationStrands(input.compensation);
    if (strandError) {
      return { success: false, error: strandError };
    }
  }

  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: projectOpenRole.id,
        slotsFilledCount: projectOpenRole.slotsFilledCount,
      })
      .from(projectOpenRole)
      // Both columns in the WHERE: a role id from ANOTHER project must be
      // indistinguishable from a nonexistent one (§4a).
      .where(and(eq(projectOpenRole.id, roleId), eq(projectOpenRole.projectId, projectId)))
      .for("update");

    if (!current) {
      return { kind: "not-found" } as const;
    }

    if (input.slotsTotal !== undefined && input.slotsTotal < current.slotsFilledCount) {
      // Shrinking below the filled count would leave the role over-subscribed with no
      // way to represent it.
      return { kind: "slots-below-filled", slotsFilledCount: current.slotsFilledCount } as const;
    }

    await tx
      .update(projectOpenRole)
      .set({
        ...(input.roleTitle !== undefined ? { roleTitle: input.roleTitle } : {}),
        ...(input.skills !== undefined ? { skills: [...input.skills] } : {}),
        ...(input.commitment !== undefined ? { commitment: input.commitment } : {}),
        ...(input.slotsTotal !== undefined ? { slotsTotal: input.slotsTotal } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
      .where(eq(projectOpenRole.id, roleId));

    if (input.compensation !== undefined) {
      // Replace wholesale: the strand set is a value object, and a partial merge would
      // make "remove the equity strand" unexpressible.
      await tx.delete(openRoleCompensation).where(eq(openRoleCompensation.openRoleId, roleId));
      if (input.compensation.length > 0) {
        await tx
          .insert(openRoleCompensation)
          .values(input.compensation.map((strand) => toStrandRow(roleId, strand)));
      }
    }

    await recomputeOpenRoleStatus(tx, roleId);
    return { kind: "updated" } as const;
  });

  if (outcome.kind === "not-found") {
    return { success: false, error: { type: "ROLE_NOT_FOUND", roleId } };
  }
  if (outcome.kind === "slots-below-filled") {
    return {
      success: false,
      error: { type: "SLOTS_BELOW_FILLED", slotsFilledCount: outcome.slotsFilledCount },
    };
  }

  const view = await findOpenRoleById(roleId);
  if (!view) {
    return { success: false, error: { type: "ROLE_NOT_FOUND", roleId } };
  }
  return { success: true, value: view };
}

/** Closes a role. Editorial, and independent of capacity — a closed role stays closed. */
export async function setOpenRoleClosed(
  projectId: string,
  roleId: string,
  shouldClose: boolean,
): Promise<Result<OpenRoleView, ProjectRoleError>> {
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: projectOpenRole.status,
        slotsTotal: projectOpenRole.slotsTotal,
        slotsFilledCount: projectOpenRole.slotsFilledCount,
      })
      .from(projectOpenRole)
      .where(and(eq(projectOpenRole.id, roleId), eq(projectOpenRole.projectId, projectId)))
      .for("update");

    if (!current) {
      return { kind: "not-found" } as const;
    }

    const wasOpen = current.status === "open";
    const nextStatus = shouldClose
      ? ("closed" as const)
      : current.slotsFilledCount >= current.slotsTotal
        ? ("filled" as const)
        : ("open" as const);

    if (nextStatus === current.status) {
      return { kind: "unchanged" } as const;
    }

    await tx
      .update(projectOpenRole)
      .set({ status: nextStatus })
      .where(eq(projectOpenRole.id, roleId));

    const willBeOpen = nextStatus === "open";
    if (wasOpen !== willBeOpen) {
      await tx
        .update(projectStats)
        .set({
          openRoleCount: willBeOpen
            ? sql`${projectStats.openRoleCount} + 1`
            : sql`GREATEST(${projectStats.openRoleCount} - 1, 0)`,
        })
        .where(eq(projectStats.projectId, projectId));
    }

    return { kind: "changed" } as const;
  });

  if (outcome.kind === "not-found") {
    return { success: false, error: { type: "ROLE_NOT_FOUND", roleId } };
  }

  const view = await findOpenRoleById(roleId);
  if (!view) {
    return { success: false, error: { type: "ROLE_NOT_FOUND", roleId } };
  }
  return { success: true, value: view };
}

/**
 * Deletes a role. Refused once anything references it — `project_application.openRoleId`
 * and `project_invite.openRoleId` are both `restrict`, so the FK would raise 23503.
 * Catching it here turns the policy working as designed into a typed 409 rather than a
 * 500; closing the role is the intended path.
 */
export async function deleteOpenRole(
  projectId: string,
  roleId: string,
): Promise<Result<{ readonly deleted: true }, ProjectRoleError>> {
  const [current] = await db
    .select({ status: projectOpenRole.status })
    .from(projectOpenRole)
    .where(and(eq(projectOpenRole.id, roleId), eq(projectOpenRole.projectId, projectId)));

  if (!current) {
    return { success: false, error: { type: "ROLE_NOT_FOUND", roleId } };
  }

  try {
    await db.transaction(async (tx) => {
      await tx.delete(projectOpenRole).where(eq(projectOpenRole.id, roleId));
      if (current.status === "open") {
        await tx
          .update(projectStats)
          .set({ openRoleCount: sql`GREATEST(${projectStats.openRoleCount} - 1, 0)` })
          .where(eq(projectStats.projectId, projectId));
      }
    });
  } catch (error: unknown) {
    if (isForeignKeyViolation(error)) {
      return { success: false, error: { type: "ROLE_HAS_REFERENCES" } };
    }
    throw error;
  }

  return { success: true, value: { deleted: true } };
}

const OPEN_ROLE_VIEW_COLUMNS = {
  id: projectOpenRole.id,
  projectSlug: researchProject.slug,
  projectName: researchProject.name,
  roleTitle: projectOpenRole.roleTitle,
  skills: projectOpenRole.skills,
  commitment: projectOpenRole.commitment,
  status: projectOpenRole.status,
  slotsTotal: projectOpenRole.slotsTotal,
  slotsFilledCount: projectOpenRole.slotsFilledCount,
  description: projectOpenRole.description,
  currency: researchProject.currency,
  createdAt: projectOpenRole.createdAt,
} as const;

/** Attaches each role's strands in one extra query rather than N. */
async function attachCompensation(
  roles: ReadonlyArray<Omit<OpenRoleView, "compensation">>,
): Promise<readonly OpenRoleView[]> {
  if (roles.length === 0) {
    return [];
  }

  const strands = await db
    .select()
    .from(openRoleCompensation)
    .where(
      inArray(
        openRoleCompensation.openRoleId,
        roles.map((role) => role.id),
      ),
    )
    .orderBy(openRoleCompensation.kind);

  return roles.map((role) => ({
    ...role,
    compensation: strands.filter((strand) => strand.openRoleId === role.id),
  }));
}

export async function findOpenRoleById(roleId: string): Promise<OpenRoleView | null> {
  const [row] = await db
    .select(OPEN_ROLE_VIEW_COLUMNS)
    .from(projectOpenRole)
    .innerJoin(researchProject, eq(researchProject.id, projectOpenRole.projectId))
    .where(eq(projectOpenRole.id, roleId));

  if (!row) {
    return null;
  }
  const [view] = await attachCompensation([row]);
  return view ?? null;
}

export async function listOpenRolesForProject(projectId: string): Promise<readonly OpenRoleView[]> {
  const rows = await db
    .select(OPEN_ROLE_VIEW_COLUMNS)
    .from(projectOpenRole)
    .innerJoin(researchProject, eq(researchProject.id, projectOpenRole.projectId))
    .where(eq(projectOpenRole.projectId, projectId))
    .orderBy(projectOpenRole.createdAt, projectOpenRole.id);

  return attachCompensation(rows);
}

export interface ListOpenRolesFilter {
  readonly commitment?: (typeof projectOpenRole.$inferSelect)["commitment"] | undefined;
  readonly skill?: string | undefined;
  readonly categorySlug?: string | undefined;
  readonly minEquityBasisPoints?: number | undefined;
  readonly page: number;
  readonly limit: number;
}

/**
 * The cross-project rail behind GET /open-roles and the talent page.
 *
 * Filtering happens in SQL, not on the client: the shipped frontend filters tiny mock
 * arrays in the browser today, which does not survive a real corpus (§6).
 */
export async function listOpenRolesAcrossProjects(
  filter: ListOpenRolesFilter,
): Promise<OpenRolePage> {
  const conditions = [
    eq(projectOpenRole.status, "open"),
    // Roles on unpublished or archived projects must never surface in a public rail.
    eq(researchProject.status, "active"),
  ];

  if (filter.commitment) {
    conditions.push(eq(projectOpenRole.commitment, filter.commitment));
  }
  if (filter.categorySlug) {
    conditions.push(eq(researchCategory.slug, filter.categorySlug));
  }
  if (filter.skill) {
    // Array containment, which uses the GIN index rather than scanning every role.
    conditions.push(sql`${projectOpenRole.skills} @> ARRAY[${filter.skill}]::text[]`);
  }
  if (filter.minEquityBasisPoints !== undefined) {
    const threshold = filter.minEquityBasisPoints;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${openRoleCompensation}
                 WHERE ${openRoleCompensation.openRoleId} = ${projectOpenRole.id}
                   AND ${openRoleCompensation.kind} = 'equity'
                   AND ${openRoleCompensation.equityBasisPointsMax} >= ${threshold})`,
    );
  }

  const predicate = and(...conditions);
  const offset = (filter.page - 1) * filter.limit;

  const rows = await db
    .select(OPEN_ROLE_VIEW_COLUMNS)
    .from(projectOpenRole)
    .innerJoin(researchProject, eq(researchProject.id, projectOpenRole.projectId))
    .innerJoin(researchCategory, eq(researchCategory.id, researchProject.categoryId))
    .where(predicate)
    .orderBy(desc(projectOpenRole.createdAt), desc(projectOpenRole.id))
    .limit(filter.limit)
    .offset(offset);

  const [totals] = await db
    .select({ value: count() })
    .from(projectOpenRole)
    .innerJoin(researchProject, eq(researchProject.id, projectOpenRole.projectId))
    .innerJoin(researchCategory, eq(researchCategory.id, researchProject.categoryId))
    .where(predicate);

  return { rows: await attachCompensation(rows), total: totals?.value ?? 0 };
}

/** Resolves a role that must belong to this project. Used by the apply gate. */
export async function findProjectOpenRole(
  projectId: string,
  roleId: string,
): Promise<typeof projectOpenRole.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(projectOpenRole)
    .where(and(eq(projectOpenRole.id, roleId), eq(projectOpenRole.projectId, projectId)));
  return row ?? null;
}

/** Roles with at least one seat left, for the "still hiring" facet. */
export async function countOpenSeats(projectId: string): Promise<number> {
  const [totals] = await db
    .select({ value: count() })
    .from(projectOpenRole)
    .where(
      and(
        eq(projectOpenRole.projectId, projectId),
        eq(projectOpenRole.status, "open"),
        gte(projectOpenRole.slotsTotal, 1),
      ),
    );
  return totals?.value ?? 0;
}
