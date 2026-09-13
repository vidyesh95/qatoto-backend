import { and, asc, count, eq, gt, inArray, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  blueprintContentReport,
  caseStudy,
  showcaseLaunch,
  teardown,
  user,
} from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import type { BlueprintModerationArm } from "#src/modules/home/blueprints/blueprint-moderation-transitions.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import type { PlatformStaffContext } from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Reader reports on a published blueprint, and the moderator queue that answers them.
 *
 * ⚠️ FILING A REPORT MOVES NO STATE AND WRITES NO AUDIT ENTRY. Three rules, any one of which would
 * be enough:
 *   1. `flagged` is in EVERY gate on both arms, so an auto-flag changes NOTHING a visitor sees — it
 *      only stamps an unreviewed accusation on somebody's work.
 *   2. `platform_audit_entry.actorUserId` is NOT NULL, and an automatic transition names nobody.
 *   3. §5's inclusion rule for that chain is STAFF action. A reader filing a report is not one,
 *      exactly as "Submitting records nothing."
 *
 * ⚠️ AND NO THRESHOLD, EVER. `user-reports.service.ts` states the reason: "a number that could trip
 * an automatic action would make brigading measurable and then effective." The queue shows an open
 * count as CONTEXT so a moderator can see a pile-up; nothing reads it as a trigger.
 */

export type BlueprintContentReportError =
  | { readonly type: "BLUEPRINT_CONTENT_NOT_FOUND" }
  | { readonly type: "BLUEPRINT_ALREADY_REPORTED" }
  | { readonly type: "BLUEPRINT_SELF_REPORT_FORBIDDEN" }
  | { readonly type: "BLUEPRINT_REPORT_NOT_FOUND" }
  | { readonly type: "BLUEPRINT_REPORT_ALREADY_RESOLVED" }
  | { readonly type: "BLUEPRINT_CURSOR_MALFORMED" };

export type BlueprintContentReportReason =
  | "rights_claim"
  | "fabricated_measurements"
  | "dangerous_procedure"
  | "not_the_stated_product"
  | "spam"
  | "other";

/**
 * ⚠️ RESOLVED UNDER THE **READABLE** GATE, WHICH IS WIDER THAN THE ENGAGEMENT GATE.
 *
 * A quarantined teardown still accepts a report, and `claim-targets` already argues exactly why: "a
 * second rights holder may have an entirely different objection from the first… withhold the
 * payload and that claimant can only say 'the whole teardown', which uses one quarantine to blunt
 * the control that produced it."
 */
const REPORTABLE_TEARDOWN_STATES = ["published", "flagged", "quarantined"] as const;
const REPORTABLE_CASE_STUDY_STATES = ["published", "flagged"] as const;
/**
 * ⚠️ TWO STATES, NOT THREE, BECAUSE THIS ARM HAS ONE GATE. `quarantined` is not in
 * `showcase_launch_moderation_state_ck` at all, so there is no wider READABLE set to resolve
 * against here — a showcase is either reachable or it is not. The teardown arm's third entry
 * exists because a quarantine withholds a payload while keeping the address alive; nothing on this
 * arm does that.
 */
const REPORTABLE_SHOWCASE_STATES = ["published", "flagged"] as const;

interface ReportTarget {
  readonly id: string;
  readonly authorUserId: string | null;
}

async function resolveReportableTarget(
  arm: BlueprintModerationArm,
  slug: string,
): Promise<ReportTarget | null> {
  switch (arm) {
    case "teardown": {
      const [row] = await db
        .select({ id: teardown.id, authorUserId: teardown.authorUserId })
        .from(teardown)
        .where(
          and(
            eq(teardown.slug, slug),
            inArray(teardown.moderationState, [...REPORTABLE_TEARDOWN_STATES]),
          ),
        )
        .limit(1);
      return row ?? null;
    }
    case "case_study": {
      const [row] = await db
        .select({ id: caseStudy.id, authorUserId: caseStudy.authorUserId })
        .from(caseStudy)
        .where(
          and(
            eq(caseStudy.publicSlug, slug),
            inArray(caseStudy.moderationState, [...REPORTABLE_CASE_STUDY_STATES]),
          ),
        )
        .limit(1);
      return row ?? null;
    }
    case "showcase": {
      const [row] = await db
        .select({ id: showcaseLaunch.id, authorUserId: showcaseLaunch.authorUserId })
        .from(showcaseLaunch)
        .where(
          and(
            eq(showcaseLaunch.publicSlug, slug),
            inArray(showcaseLaunch.moderationState, [...REPORTABLE_SHOWCASE_STATES]),
          ),
        )
        .limit(1);
      return row ?? null;
    }
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled report arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The one target column a report sets, and the two it nulls.
 *
 * ⚠️ `blueprint_content_report_target_ck` IS `= 1`, NOT `<= 1` — a report's targets CASCADE, so a
 * targetless report cannot exist. Returning all three keys keeps that arithmetic visible at the
 * insert rather than resting on which properties happened to be omitted.
 */
function reportTargetColumnsForArm(
  arm: BlueprintModerationArm,
  targetId: string,
): { teardownId: string | null; caseStudyId: string | null; showcaseLaunchId: string | null } {
  switch (arm) {
    case "teardown":
      return { teardownId: targetId, caseStudyId: null, showcaseLaunchId: null };
    case "case_study":
      return { teardownId: null, caseStudyId: targetId, showcaseLaunchId: null };
    case "showcase":
      return { teardownId: null, caseStudyId: null, showcaseLaunchId: targetId };
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled report arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createBlueprintContentReport(input: {
  readonly arm: BlueprintModerationArm;
  readonly slug: string;
  readonly reporterUserId: string;
  readonly reason: BlueprintContentReportReason;
  readonly detailText: string | null;
}): Promise<Result<{ readonly reportId: string }, BlueprintContentReportError>> {
  const target = await resolveReportableTarget(input.arm, input.slug);
  // A slug that is not reportable and a slug that never existed are the same bytes.
  if (target === null) return { success: false, error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" } };

  /*
   * ⚠️ SERVICE-ONLY, WITH NO CHECK BEHIND IT, and that is worth saying out loud. `user_report` has
   * `user_report_self_ck` because both ids are on the same row; here the author id lives on the
   * TARGET, so no constraint on this table could express it. The rule is real and the enforcement
   * is one layer up — which is exactly the kind of thing a verify script records as NOT enforced by
   * the database.
   */
  if (target.authorUserId !== null && target.authorUserId === input.reporterUserId) {
    return { success: false, error: { type: "BLUEPRINT_SELF_REPORT_FORBIDDEN" } };
  }

  /*
   * ⚠️ `onConflictDoNothing().returning()` RATHER THAN A PRE-CHECK. The partial unique index is the
   * real control, and a read-then-write would race exactly the double-submit it is meant to stop.
   * An empty `returning()` means the index refused — which is the honest 409.
   */
  const inserted = await db
    .insert(blueprintContentReport)
    .values({
      targetKind: input.arm,
      ...reportTargetColumnsForArm(input.arm, target.id),
      reason: input.reason,
      detailText: input.detailText,
      reporterUserId: input.reporterUserId,
    })
    .onConflictDoNothing()
    .returning({ id: blueprintContentReport.id });

  const reportId = inserted[0]?.id;
  if (reportId === undefined) {
    return { success: false, error: { type: "BLUEPRINT_ALREADY_REPORTED" } };
  }

  return { success: true, value: { reportId } };
}

export interface MyBlueprintReportView {
  readonly reportId: string;
  readonly targetKind: BlueprintModerationArm;
  readonly targetTitle: string;
  readonly reason: BlueprintContentReportReason;
  readonly status: "open" | "actioned" | "dismissed";
  readonly createdAt: Date;
}

/** A hard cap, because this list is unpaginated and a reporter is not a queue. */
const MY_REPORTS_LIMIT = 200;

/**
 * `GET /blueprints/reports/mine`.
 *
 * ⚠️ DELIBERATELY NARROW, AND `listMyProfileReports` STATES EACH OMISSION: no moderator identity,
 * because naming the moderator makes a takedown personal; no resolution note; and no count of who
 * else reported the same target, because that makes brigading measurable. What it does carry is
 * the STATUS — "a report that vanishes is indistinguishable from one nobody read."
 */
export async function listMyBlueprintReports(
  reporterUserId: string,
): Promise<readonly MyBlueprintReportView[]> {
  const rows = await db
    .select({
      reportId: blueprintContentReport.id,
      targetKind: blueprintContentReport.targetKind,
      reason: blueprintContentReport.reason,
      status: blueprintContentReport.status,
      createdAt: blueprintContentReport.createdAt,
      teardownTitle: teardown.title,
      caseStudyTitle: caseStudy.title,
      showcaseLaunchTitle: showcaseLaunch.title,
    })
    .from(blueprintContentReport)
    .leftJoin(teardown, eq(teardown.id, blueprintContentReport.teardownId))
    .leftJoin(caseStudy, eq(caseStudy.id, blueprintContentReport.caseStudyId))
    .leftJoin(showcaseLaunch, eq(showcaseLaunch.id, blueprintContentReport.showcaseLaunchId))
    .where(eq(blueprintContentReport.reporterUserId, reporterUserId))
    .orderBy(asc(blueprintContentReport.createdAt), asc(blueprintContentReport.id))
    .limit(MY_REPORTS_LIMIT);

  return rows.map((row) => ({
    reportId: row.reportId,
    targetKind: row.targetKind,
    // The target cascades away with the blueprint, so a title is always present in practice; the
    // fallback exists because `leftJoin` cannot promise it in the type.
    targetTitle: row.teardownTitle ?? row.caseStudyTitle ?? row.showcaseLaunchTitle ?? "(removed)",
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
  }));
}

export interface BlueprintReportQueueItem {
  readonly reportId: string;
  readonly targetKind: BlueprintModerationArm;
  readonly targetId: string;
  readonly targetSlug: string | null;
  readonly targetTitle: string;
  /** So a moderator can see whether somebody has already acted on this row. */
  readonly targetModerationState: string;
  readonly reason: BlueprintContentReportReason;
  readonly detailText: string | null;
  readonly reporterHandle: string | null;
  /** ⚠️ CONTEXT, NEVER A THRESHOLD. Nothing reads this as a trigger. */
  readonly openReportCount: number;
  readonly createdAt: Date;
}

export interface BlueprintReportQueuePage {
  readonly items: readonly BlueprintReportQueueItem[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * `GET /blueprints/admin/content-reports` — oldest first, keyset-paged.
 *
 * ⚠️ A NEW ROUTE, NOT AN ARM OF THE THREE EXISTING REVIEW QUEUES, and there are three reasons:
 *   1. Those are keyed on `moderation_state = 'pending_review'` and backed by partial indexes on
 *      exactly that predicate. A report is about a row that already PASSED that decision.
 *   2. The verdict vocabularies are disjoint — publish/send-back versus flag/quarantine/restore/
 *      dismiss — so one route would mean two verdict enums and a `never` switch that can no longer
 *      be exhaustive over either.
 *   3. ⚠️ `GET /blueprints/admin/case-studies/review-queue` is the ONE route in the whole router
 *      that serves a withheld company's real name (§6). Widening it to carry reports would widen
 *      that exposure and break the sentence `case-study-withheld-name.test.ts` keeps true.
 */
export async function listBlueprintReportQueue(input: {
  readonly status: "open" | "actioned" | "dismissed";
  readonly targetKind: BlueprintModerationArm | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly staff: PlatformStaffContext;
}): Promise<Result<BlueprintReportQueuePage, BlueprintContentReportError>> {
  void input.staff;

  const cursor = input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && cursor === null) {
    return { success: false, error: { type: "BLUEPRINT_CURSOR_MALFORMED" } };
  }

  const conditions = [eq(blueprintContentReport.status, input.status)];
  if (input.targetKind !== undefined) {
    conditions.push(eq(blueprintContentReport.targetKind, input.targetKind));
  }
  if (cursor !== null) {
    conditions.push(
      gt(
        sql`(${blueprintContentReport.createdAt}, ${blueprintContentReport.id})`,
        sql`(${cursor.instant}, ${cursor.id})`,
      ),
    );
  }

  const rows = await db
    .select({
      reportId: blueprintContentReport.id,
      targetKind: blueprintContentReport.targetKind,
      teardownId: blueprintContentReport.teardownId,
      caseStudyId: blueprintContentReport.caseStudyId,
      showcaseLaunchId: blueprintContentReport.showcaseLaunchId,
      reason: blueprintContentReport.reason,
      detailText: blueprintContentReport.detailText,
      createdAt: blueprintContentReport.createdAt,
      reporterHandle: user.handle,
      teardownSlug: teardown.slug,
      teardownTitle: teardown.title,
      teardownState: teardown.moderationState,
      caseStudySlug: caseStudy.publicSlug,
      caseStudyTitle: caseStudy.title,
      caseStudyState: caseStudy.moderationState,
      showcaseLaunchSlug: showcaseLaunch.publicSlug,
      showcaseLaunchTitle: showcaseLaunch.title,
      showcaseLaunchState: showcaseLaunch.moderationState,
    })
    .from(blueprintContentReport)
    .leftJoin(user, eq(user.id, blueprintContentReport.reporterUserId))
    .leftJoin(teardown, eq(teardown.id, blueprintContentReport.teardownId))
    .leftJoin(caseStudy, eq(caseStudy.id, blueprintContentReport.caseStudyId))
    .leftJoin(showcaseLaunch, eq(showcaseLaunch.id, blueprintContentReport.showcaseLaunchId))
    .where(and(...conditions))
    .orderBy(asc(blueprintContentReport.createdAt), asc(blueprintContentReport.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const lastRow = pageRows.at(-1);

  /*
   * The open count per target, for the WHOLE PAGE in one query rather than one per row.
   *
   * ⚠️ `inArray` RATHER THAN A HAND-WRITTEN `= ANY(${ids})`. The first spelling of this passed the
   * id array straight into a `sql` template, and node-postgres bound it as a scalar — Postgres
   * answered `array_in: unnamed portal parameter`. `inArray` expands it to a parameter list, which
   * is what the driver can actually bind.
   */
  const targetIds = pageRows.map(
    (row) => row.teardownId ?? row.caseStudyId ?? row.showcaseLaunchId ?? "",
  );
  const openCounts = new Map<string, number>();
  if (targetIds.length > 0) {
    const countRows = await db
      .select({
        teardownId: blueprintContentReport.teardownId,
        caseStudyId: blueprintContentReport.caseStudyId,
        showcaseLaunchId: blueprintContentReport.showcaseLaunchId,
        openCount: count(),
      })
      .from(blueprintContentReport)
      .where(
        and(
          eq(blueprintContentReport.status, "open"),
          or(
            inArray(blueprintContentReport.teardownId, targetIds),
            inArray(blueprintContentReport.caseStudyId, targetIds),
            inArray(blueprintContentReport.showcaseLaunchId, targetIds),
          ),
        ),
      )
      /*
       * ⚠️ ALL THREE TARGET COLUMNS IN THE `groupBy`, or the counts collapse. The grouping key has
       * to be the same tuple the map is keyed on below; omit one and every report whose target is
       * that arm folds into a single `(null, null)` bucket.
       */
      .groupBy(
        blueprintContentReport.teardownId,
        blueprintContentReport.caseStudyId,
        blueprintContentReport.showcaseLaunchId,
      );
    for (const row of countRows) {
      openCounts.set(
        row.teardownId ?? row.caseStudyId ?? row.showcaseLaunchId ?? "",
        row.openCount,
      );
    }
  }

  return {
    success: true,
    value: {
      items: pageRows.map((row) => {
        const targetId = row.teardownId ?? row.caseStudyId ?? row.showcaseLaunchId ?? "";
        return {
          reportId: row.reportId,
          targetKind: row.targetKind,
          targetId,
          targetSlug: row.teardownSlug ?? row.caseStudySlug ?? row.showcaseLaunchSlug ?? null,
          targetTitle:
            row.teardownTitle ?? row.caseStudyTitle ?? row.showcaseLaunchTitle ?? "(removed)",
          targetModerationState:
            row.teardownState ?? row.caseStudyState ?? row.showcaseLaunchState ?? "unknown",
          reason: row.reason,
          detailText: row.detailText,
          reporterHandle: row.reporterHandle,
          openReportCount: openCounts.get(targetId) ?? 0,
          createdAt: row.createdAt,
        };
      }),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.reportId })
            : null,
        hasMore,
      },
    },
  };
}

/**
 * `POST /blueprints/admin/content-reports/:reportId/dismiss`.
 *
 * ⚠️ DISMISSING RESTORES NOTHING. Nothing flags a row except a moderator deciding to, so a
 * dismissal has nothing to undo — and quietly un-flagging something a DIFFERENT moderator flagged
 * would overturn their decision as a side effect of answering a reader. That is `decideUserReport`'s
 * stated rule and it transfers exactly. A moderator who wants the row back uses `restore`, which
 * costs its own audit entry and its own note.
 */
export async function dismissBlueprintContentReport(input: {
  readonly reportId: string;
  readonly resolutionNote: string;
  readonly staff: PlatformStaffContext;
}): Promise<Result<{ readonly reportId: string }, BlueprintContentReportError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({
        id: blueprintContentReport.id,
        status: blueprintContentReport.status,
        targetKind: blueprintContentReport.targetKind,
        teardownId: blueprintContentReport.teardownId,
        caseStudyId: blueprintContentReport.caseStudyId,
      })
      .from(blueprintContentReport)
      .where(eq(blueprintContentReport.id, input.reportId))
      .for("update");

    if (!existing) return { kind: "missing" } as const;
    if (existing.status !== "open") return { kind: "already_resolved" } as const;

    const decidedAt = new Date();
    await transaction
      .update(blueprintContentReport)
      .set({
        status: "dismissed",
        resolvedByUserId: input.staff.staffUserId,
        resolvedAt: decidedAt,
        resolutionNote: input.resolutionNote,
      })
      .where(eq(blueprintContentReport.id, input.reportId));

    await appendPlatformAuditEntry(transaction, {
      eventKind: "blueprint_content_report_dismissed",
      actorUserId: input.staff.staffUserId,
      actorRoleSnapshot: input.staff.platformRole,
      actionLabel: "Dismissed a report about a published blueprint",
      targetLabel: `${existing.targetKind} report ${existing.id}`,
      // ⚠️ IDS AND FLAGS ONLY — the resolution note stays on the report row.
      payload: {
        reportId: existing.id,
        targetKind: existing.targetKind,
        targetId: existing.teardownId ?? existing.caseStudyId,
        hasResolutionNote: true,
      },
      occurredAt: decidedAt,
    });

    return { kind: "dismissed" } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "BLUEPRINT_REPORT_NOT_FOUND" } };
    case "already_resolved":
      return { success: false, error: { type: "BLUEPRINT_REPORT_ALREADY_RESOLVED" } };
    case "dismissed":
      return { success: true, value: { reportId: input.reportId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled dismissal outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
