import { and, asc, count, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { projectSupplierEngagement, supplier } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type {
  ProjectAccessError,
  ProjectMemberContext,
} from "#src/services/project-membership.service.js";
import type { SupplierError } from "#src/services/suppliers.service.js";
import type { Result } from "#src/types/index.js";

/**
 * A project's supplier engagements — its private manufacturing CRM
 * (R_AND_D_BACKEND_STRUCTURE.md §11i, §11j.5).
 *
 * WHY THIS IS A SEPARATE FILE FROM `suppliers.service.ts`. That module declares as a
 * module-wide invariant that its write side is MODERATOR-ONLY and the capability is checked
 * first. These writes are the opposite: project-scoped, maintainer-gated, and reachable by
 * no platform staff at all. Two authorization models in one file is how one quietly becomes
 * the other.
 *
 * THE DEAD END THIS CLOSES (§11j.1). `project_supplier_engagement` shipped with two readers
 * — `launch-readiness.service.ts` and `countProjectSupplierEngagements` — and NO WRITER
 * anywhere in the repo. The `supplier_engaged` gate on the launch-readiness checklist
 * therefore reported `not_met` for every project that would ever exist. Nothing here needs
 * a job to fix that: `computeLaunchReadiness` derives on read, so the gate flips on the very
 * next GET after the first POST.
 *
 * NOTHING HERE MAY TOUCH A SUPPLIER'S `verificationState`, and that is §6's rule rather than
 * a preference. `contracted` means THIS TEAM SAYS IT SIGNED SOMETHING — a self-report, and
 * the only party attesting is the party that benefits. Letting it feed the public
 * directory's trust level would make that directory forgeable one self-report at a time.
 * This service writes exactly one table, and it is not `supplier`.
 */

export type SupplierEngagementStatus = (typeof projectSupplierEngagement.$inferSelect)["status"];

export type SupplierEngagementError =
  | ProjectAccessError
  // The payload is BORROWED from `SupplierError` rather than redeclared: two variants
  // sharing a `type` literal must share a shape, or the mapper's exhaustive switch cannot
  // read the field. `Extract` rather than composing `SupplierError` wholesale, which would
  // drag `PlatformAccessError` into a union that must never produce a 403.
  | Extract<SupplierError, { type: "SUPPLIER_NOT_FOUND" }>
  | { type: "ENGAGEMENT_NOT_FOUND"; engagementId: string }
  | { type: "ENGAGEMENT_ALREADY_EXISTS"; supplierId: string };

export interface SupplierEngagementView {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierSlug: string;
  readonly supplierName: string;
  /**
   * Carried so a CRM row renders without a second call — and READ-ONLY here. It is the
   * platform's judgement about the supplier, never this project's.
   */
  readonly supplierVerificationState: (typeof supplier.$inferSelect)["verificationState"];
  readonly status: SupplierEngagementStatus;
  readonly note: string | null;
  readonly createdByMemberId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateSupplierEngagementInput {
  readonly supplierId: string;
  readonly status: SupplierEngagementStatus;
  readonly note?: string | undefined;
}

export interface UpdateSupplierEngagementInput {
  readonly status?: SupplierEngagementStatus | undefined;
  readonly note?: string | null | undefined;
}

export interface ListSupplierEngagementsFilter {
  readonly status?: SupplierEngagementStatus | undefined;
  readonly page: number;
  readonly limit: number;
}

const ENGAGEMENT_VIEW_COLUMNS = {
  id: projectSupplierEngagement.id,
  supplierId: projectSupplierEngagement.supplierId,
  supplierSlug: supplier.slug,
  supplierName: supplier.name,
  supplierVerificationState: supplier.verificationState,
  status: projectSupplierEngagement.status,
  note: projectSupplierEngagement.note,
  createdByMemberId: projectSupplierEngagement.createdByMemberId,
  createdAt: projectSupplierEngagement.createdAt,
  updatedAt: projectSupplierEngagement.updatedAt,
} as const;

/** One engagement, scoped to the project — a valid id from another project reads as absent. */
async function findEngagement(
  projectId: string,
  engagementId: string,
): Promise<SupplierEngagementView | null> {
  const [row] = await db
    .select(ENGAGEMENT_VIEW_COLUMNS)
    .from(projectSupplierEngagement)
    .innerJoin(supplier, eq(supplier.id, projectSupplierEngagement.supplierId))
    .where(
      and(
        eq(projectSupplierEngagement.id, engagementId),
        eq(projectSupplierEngagement.projectId, projectId),
      ),
    );

  return row ?? null;
}

/** `GET …/supplier-engagements` — the project's own CRM, oldest first. */
export async function listSupplierEngagements(
  context: ProjectMemberContext,
  filter: ListSupplierEngagementsFilter,
): Promise<{ readonly rows: readonly SupplierEngagementView[]; readonly total: number }> {
  const conditions = [eq(projectSupplierEngagement.projectId, context.projectId)];
  if (filter.status !== undefined) {
    conditions.push(eq(projectSupplierEngagement.status, filter.status));
  }
  const predicate = and(...conditions);

  const [rows, [totals]] = await Promise.all([
    db
      .select(ENGAGEMENT_VIEW_COLUMNS)
      .from(projectSupplierEngagement)
      .innerJoin(supplier, eq(supplier.id, projectSupplierEngagement.supplierId))
      .where(predicate)
      // §4c rule 4 — ends in a unique column.
      .orderBy(asc(projectSupplierEngagement.createdAt), asc(projectSupplierEngagement.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db.select({ value: count() }).from(projectSupplierEngagement).where(predicate),
  ]);

  return { rows, total: totals?.value ?? 0 };
}

/**
 * `POST …/supplier-engagements` — records that this team is talking to a supplier.
 *
 * `createdByMemberId` comes from the PROVEN membership context, never a body field. It
 * satisfies the `restrict` FK for free and cannot name someone the caller is not.
 *
 * An INACTIVE supplier answers `SUPPLIER_NOT_FOUND`, matching the directory's own policy
 * that a retired listing reads exactly as one that never existed. The gate is on create
 * only: an existing engagement whose supplier is later retired is untouched, because it
 * records something that actually happened.
 */
export async function createSupplierEngagement(
  context: ProjectMemberContext,
  input: CreateSupplierEngagementInput,
): Promise<Result<SupplierEngagementView, SupplierEngagementError>> {
  const [supplierRow] = await db
    .select({ id: supplier.id })
    .from(supplier)
    .where(and(eq(supplier.id, input.supplierId), eq(supplier.isActive, true)));

  if (!supplierRow) {
    return { success: false, error: { type: "SUPPLIER_NOT_FOUND", supplierRef: input.supplierId } };
  }

  let insertedId: string;
  try {
    const [inserted] = await db
      .insert(projectSupplierEngagement)
      .values({
        projectId: context.projectId,
        supplierId: input.supplierId,
        status: input.status,
        note: input.note ?? null,
        createdByMemberId: context.memberId,
      })
      .returning({ id: projectSupplierEngagement.id });

    if (!inserted) {
      throw new Error("createSupplierEngagement: insert returned no row");
    }
    insertedId = inserted.id;
  } catch (error: unknown) {
    // `project_supplier_engagement_project_supplier_unq`. Re-approaching a supplier MOVES
    // the status of the existing row; it does not file a second one, and silently upserting
    // here would overwrite a note somebody wrote.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "ENGAGEMENT_ALREADY_EXISTS", supplierId: input.supplierId },
      };
    }
    throw error;
  }

  const created = await findEngagement(context.projectId, insertedId);
  if (!created) {
    throw new Error("createSupplierEngagement: inserted row could not be read back");
  }
  return { success: true, value: created };
}

/**
 * `PATCH …/supplier-engagements/:engagementId` — moves the status, or edits the note.
 *
 * `supplierId` is NOT updatable and appears in no input type. The unique `(projectId,
 * supplierId)` makes that pair the row's identity; re-pointing it is a delete plus a create,
 * not an edit, and treating it as an edit would silently rewrite which supplier a note and
 * a `createdAt` belong to.
 */
export async function updateSupplierEngagement(
  context: ProjectMemberContext,
  engagementId: string,
  input: UpdateSupplierEngagementInput,
): Promise<Result<SupplierEngagementView, SupplierEngagementError>> {
  const [updated] = await db
    .update(projectSupplierEngagement)
    .set({
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    .where(
      and(
        eq(projectSupplierEngagement.id, engagementId),
        eq(projectSupplierEngagement.projectId, context.projectId),
      ),
    )
    .returning({ id: projectSupplierEngagement.id });

  if (!updated) {
    return { success: false, error: { type: "ENGAGEMENT_NOT_FOUND", engagementId } };
  }

  const view = await findEngagement(context.projectId, updated.id);
  if (!view) {
    throw new Error("updateSupplierEngagement: updated row could not be read back");
  }
  return { success: true, value: view };
}

/**
 * `DELETE …/supplier-engagements/:engagementId` — a HARD delete, and `ended` is not it.
 *
 * `PATCH { status: "ended" }` is how an engagement ends. If DELETE meant the same thing
 * there would be two verbs for one effect and no way at all to correct a row filed against
 * the wrong supplier.
 *
 * The asymmetry is load-bearing downstream: `computeLaunchReadiness` counts EVERY
 * engagement row with no status filter, so `ended` keeps `supplier_engaged` at `met` — a
 * team that engaged a supplier and ended it did engage one — while this delete correctly
 * flips the gate back to `not_met`, because a mis-filed row was never evidence of anything.
 *
 * Nothing has an FK into this table, and `createdByMemberId` points outward, so nothing
 * blocks the delete.
 */
export async function deleteSupplierEngagement(
  context: ProjectMemberContext,
  engagementId: string,
): Promise<Result<{ readonly deleted: true }, SupplierEngagementError>> {
  const [deleted] = await db
    .delete(projectSupplierEngagement)
    .where(
      and(
        eq(projectSupplierEngagement.id, engagementId),
        eq(projectSupplierEngagement.projectId, context.projectId),
      ),
    )
    .returning({ id: projectSupplierEngagement.id });

  if (!deleted) {
    return { success: false, error: { type: "ENGAGEMENT_NOT_FOUND", engagementId } };
  }
  return { success: true, value: { deleted: true } };
}
