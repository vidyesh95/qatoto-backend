import { and, asc, eq, gt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceContentReport,
  commerceModerationAction,
  commerceOrganization,
  commerceOrganizationMember,
  commerceProductAnswer,
  commerceProductQuestion,
  commerceReview,
  product,
} from "#src/db/schema.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import { enqueueProductSearchDocumentRefresh } from "#src/modules/store/catalog/store-search.service.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import type {
  CreateContentReportInput,
  DecideContentReportInput,
  ListContentReportsQuery,
  RestoreContentInput,
} from "#src/modules/store/trust/commerce-content-reports.schemas.js";
import {
  refreshProductQuestionCounters,
  refreshQuestionAnswerSummary,
} from "#src/modules/store/trust/commerce-product-qa.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CommerceContentTargetKind = (typeof commerceContentReport.$inferSelect)["targetKind"];

export type CommerceContentReportsError =
  | { type: "NOT_FOUND" }
  | { type: "ALREADY_REPORTED" }
  | { type: "REPORT_ALREADY_RESOLVED" }
  | { type: "SELF_REPORT_FORBIDDEN" }
  /** §4.11: a party to the content cannot be the one who rules on it. */
  | { type: "MODERATOR_IS_PARTY" }
  | { type: "INVALID_CURSOR" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: "moderate_commerce" };

/**
 * How many DISTINCT open reporters auto-hide a piece of user-authored content.
 *
 * Three, not one. "Publishes immediately, pulled on report" has a griefing reading
 * where a single click takes down a competitor's answer, and that is not acceptable
 * for a surface whose whole value is that honest content stays up.
 */
const AUTOMATIC_HIDE_REPORTER_THRESHOLD = 3;

/**
 * Only USER-AUTHORED content auto-hides. A product or an organization never does:
 * delisting a seller's listing is a commercial action against their livelihood and
 * requires a human to take it.
 */
const AUTO_HIDEABLE_TARGET_KINDS: readonly CommerceContentTargetKind[] = [
  "review",
  "question",
  "answer",
];

export interface ContentReportProjection {
  readonly id: string;
  readonly targetKind: CommerceContentTargetKind;
  readonly targetId: string;
  readonly reason: (typeof commerceContentReport.$inferSelect)["reason"];
  readonly detailText: string | null;
  readonly status: (typeof commerceContentReport.$inferSelect)["status"];
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface ModerationActionProjection {
  readonly id: string;
  readonly actionKind: (typeof commerceModerationAction.$inferSelect)["actionKind"];
  readonly targetKind: CommerceContentTargetKind;
  readonly targetId: string | null;
  readonly actionSource: (typeof commerceModerationAction.$inferSelect)["actionSource"];
  readonly reasonNote: string;
  readonly createdAt: Date;
}

/**
 * The XOR target columns, as one object per kind.
 *
 * Storage is five nullable foreign keys; the WIRE is a single `targetId`. This is the
 * one place the two representations meet, so a new target kind fails to compile here
 * rather than silently writing a row with no target.
 */
function buildTargetColumns(
  targetKind: CommerceContentTargetKind,
  targetId: string,
): {
  productId: string | null;
  reviewId: string | null;
  questionId: string | null;
  answerId: string | null;
  organizationId: string | null;
} {
  const empty = {
    productId: null,
    reviewId: null,
    questionId: null,
    answerId: null,
    organizationId: null,
  };
  switch (targetKind) {
    case "product":
      return { ...empty, productId: targetId };
    case "review":
      return { ...empty, reviewId: targetId };
    case "question":
      return { ...empty, questionId: targetId };
    case "answer":
      return { ...empty, answerId: targetId };
    case "organization":
      return { ...empty, organizationId: targetId };
    default: {
      const exhaustiveCheck: never = targetKind;
      throw new Error(`Unhandled content target kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function readTargetId(
  row: Pick<
    typeof commerceContentReport.$inferSelect,
    "productId" | "reviewId" | "questionId" | "answerId" | "organizationId"
  >,
): string | null {
  return row.productId ?? row.reviewId ?? row.questionId ?? row.answerId ?? row.organizationId;
}

function buildTargetPredicate(
  targetKind: CommerceContentTargetKind,
  targetId: string,
): SQL | undefined {
  switch (targetKind) {
    case "product":
      return eq(commerceContentReport.productId, targetId);
    case "review":
      return eq(commerceContentReport.reviewId, targetId);
    case "question":
      return eq(commerceContentReport.questionId, targetId);
    case "answer":
      return eq(commerceContentReport.answerId, targetId);
    case "organization":
      return eq(commerceContentReport.organizationId, targetId);
    default: {
      const exhaustiveCheck: never = targetKind;
      throw new Error(`Unhandled content target kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Confirms the target row exists and reports who owns it.
 *
 * The owner is what makes the self-report and moderator-conflict checks possible.
 * Returns `null` for a target that does not exist, which the caller turns into a 404 —
 * never a distinguishable "that id is not a review", which would be an oracle.
 */
async function loadTargetOwner(
  executor: DatabaseTransaction | typeof db,
  targetKind: CommerceContentTargetKind,
  targetId: string,
): Promise<{ readonly ownerOrganizationId: string | null } | null> {
  switch (targetKind) {
    case "product": {
      const [row] = await executor
        .select({ ownerOrganizationId: product.sellerOrganizationId })
        .from(product)
        .where(eq(product.id, targetId))
        .limit(1);
      return row ?? null;
    }
    case "review": {
      const [row] = await executor
        .select({ ownerOrganizationId: commerceReview.reviewerOrganizationId })
        .from(commerceReview)
        .where(eq(commerceReview.id, targetId))
        .limit(1);
      return row ?? null;
    }
    case "question": {
      const [row] = await executor
        .select({ id: commerceProductQuestion.id })
        .from(commerceProductQuestion)
        .where(eq(commerceProductQuestion.id, targetId))
        .limit(1);
      // A question has no owning ORGANIZATION by design — it is asked by a person.
      return row ? { ownerOrganizationId: null } : null;
    }
    case "answer": {
      const [row] = await executor
        .select({ ownerOrganizationId: commerceProductAnswer.authorOrganizationId })
        .from(commerceProductAnswer)
        .where(eq(commerceProductAnswer.id, targetId))
        .limit(1);
      return row ?? null;
    }
    case "organization": {
      const [row] = await executor
        .select({ ownerOrganizationId: commerceOrganization.id })
        .from(commerceOrganization)
        .where(eq(commerceOrganization.id, targetId))
        .limit(1);
      return row ?? null;
    }
    default: {
      const exhaustiveCheck: never = targetKind;
      throw new Error(`Unhandled content target kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Re-derives the search document after a moderation decision that moved a product.
 *
 * CALLED AFTER THE TRANSACTION COMMITS, at every site that calls `setTargetVisibility`. The
 * refresh reads the product row back and recomputes `is_eligible`; running it inside the
 * transaction would read the pre-moderation state and write the eligibility the decision was
 * meant to change.
 *
 * A NO-OP FOR EVERY OTHER TARGET KIND, and deliberately not a `switch` with four empty arms:
 * reviews, questions, answers and organizations are not search documents of their own. An
 * organization's own hide path lives in `commerce-organizations.service`, which already calls
 * `refreshOrganizationSearchEligibility` — see the `case "organization"` note below for why
 * this service does not write that row at all.
 */
async function enqueueModeratedTargetSearchRefresh(
  targetKind: CommerceContentTargetKind,
  targetId: string,
): Promise<void> {
  if (targetKind !== "product") return;
  await enqueueProductSearchDocumentRefresh(targetId);
}

/** Applies or lifts the visibility flag that actually removes content from the wire. */
async function setTargetVisibility(
  transaction: DatabaseTransaction,
  targetKind: CommerceContentTargetKind,
  targetId: string,
  hidden: boolean,
  moderatorUserId: string | null,
): Promise<void> {
  const hiddenAt = hidden ? new Date() : null;

  switch (targetKind) {
    case "review":
      // `commerce_review` predates the four-value UGC enum and keeps its own two-value
      // one. Hiding here ALSO corrects the rating with no recomputation step, because
      // every aggregate in commerce-trust-metrics already filters on it.
      await transaction
        .update(commerceReview)
        .set({ visibility: hidden ? "hidden" : "visible" })
        .where(eq(commerceReview.id, targetId));
      return;
    case "question": {
      const [question] = await transaction
        .update(commerceProductQuestion)
        .set({
          visibilityState: hidden
            ? moderatorUserId === null
              ? "hidden_pending_review"
              : "hidden_by_moderator"
            : "visible",
          hiddenAt,
          hiddenByUserId: hidden ? moderatorUserId : null,
        })
        .where(eq(commerceProductQuestion.id, targetId))
        .returning({ productId: commerceProductQuestion.productId });
      if (question) await refreshProductQuestionCounters(transaction, question.productId);
      return;
    }
    case "answer": {
      const [answer] = await transaction
        .update(commerceProductAnswer)
        .set({
          visibilityState: hidden
            ? moderatorUserId === null
              ? "hidden_pending_review"
              : "hidden_by_moderator"
            : "visible",
          hiddenAt,
          hiddenByUserId: hidden ? moderatorUserId : null,
        })
        .where(eq(commerceProductAnswer.id, targetId))
        .returning({ questionId: commerceProductAnswer.questionId });
      if (answer) {
        await refreshQuestionAnswerSummary(transaction, answer.questionId);
        const [question] = await transaction
          .select({ productId: commerceProductQuestion.productId })
          .from(commerceProductQuestion)
          .where(eq(commerceProductQuestion.id, answer.questionId))
          .limit(1);
        if (question) await refreshProductQuestionCounters(transaction, question.productId);
      }
      return;
    }
    case "product":
      /**
       * `suspended` is excluded by `publicProductEligibility`, so this removes the listing
       * from every read that evaluates that predicate LIVE — the catalog, the storefront,
       * the facets.
       *
       * IT IS NOT ENOUGH ON ITS OWN, and this comment used to say it was. `/store/search`
       * reads `store_search_document`, whose `is_eligible` is a boolean FROZEN AT WRITE
       * TIME (`store-search.service.ts:677-683`) — nothing re-evaluates it when a product
       * row changes underneath. So a moderator-hidden listing stayed findable in search
       * indefinitely, which is the one place a hidden listing most obviously must not be.
       *
       * The refresh is enqueued by `enqueueModeratedTargetSearchRefresh` AFTER the caller's
       * transaction commits, not here: a job that reads the row before this transaction
       * lands would recompute eligibility from the pre-moderation state and helpfully undo
       * the hide.
       */
      await transaction
        .update(product)
        .set({ moderationState: hidden ? "suspended" : "approved" })
        .where(eq(product.id, targetId));
      return;
    case "organization":
      /**
       * DELIBERATELY A NO-OP on the row itself. Organization visibility and trade state
       * are owned by `commerce-organizations.service`, which has its own audit stream
       * and its own transition rules. Two services writing one column is how those
       * rules stop being true. The moderation action is still recorded, and a
       * moderator acts on the organization through the organization surface.
       */
      return;
    default: {
      const exhaustiveCheck: never = targetKind;
      throw new Error(`Unhandled content target kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * File a report (Appendix A12).
 *
 * Under post-moderation this is the mechanism that takes content down, so the
 * threshold check runs in the SAME TRANSACTION as the insert — counting reporters in a
 * second round trip would let three concurrent reports each see two and none of them
 * hide anything.
 */
export async function createContentReport(
  input: {
    readonly reporterUserId: string;
    readonly reporterOrganizationId: string | null;
  },
  body: CreateContentReportInput,
): Promise<Result<ContentReportProjection, CommerceContentReportsError>> {
  const outcome = await db.transaction(async (transaction) => {
    const target = await loadTargetOwner(transaction, body.targetKind, body.targetId);
    if (!target) return { status: "not_found" as const };

    if (
      input.reporterOrganizationId !== null &&
      target.ownerOrganizationId === input.reporterOrganizationId
    ) {
      return { status: "self_report" as const };
    }

    const inserted = await transaction
      .insert(commerceContentReport)
      .values({
        targetKind: body.targetKind,
        ...buildTargetColumns(body.targetKind, body.targetId),
        reason: body.reason,
        detailText: body.detailText ?? null,
        reporterUserId: input.reporterUserId,
        reporterOrganizationId: input.reporterOrganizationId,
      })
      // The partial unique index is (targetColumn, reporter_user_id): one report per
      // person per target, so a single reporter cannot reach the threshold alone.
      .onConflictDoNothing()
      .returning();

    const report = inserted[0];
    if (!report) return { status: "already_reported" as const };

    // Carried out of the transaction so the search refresh below runs only when the
    // threshold actually fired, and only after this commit lands.
    let autoHidden = false;

    if (AUTO_HIDEABLE_TARGET_KINDS.includes(body.targetKind)) {
      const targetPredicate = buildTargetPredicate(body.targetKind, body.targetId);
      const [distinctReporters] = await transaction
        .select({
          reporterCount: sql<number>`count(distinct ${commerceContentReport.reporterUserId})::int`,
        })
        .from(commerceContentReport)
        .where(and(targetPredicate, eq(commerceContentReport.status, "open")));

      if ((distinctReporters?.reporterCount ?? 0) >= AUTOMATIC_HIDE_REPORTER_THRESHOLD) {
        await setTargetVisibility(transaction, body.targetKind, body.targetId, true, null);
        await transaction.insert(commerceModerationAction).values({
          actionKind: "content_hidden",
          targetKind: body.targetKind,
          ...buildTargetColumns(body.targetKind, body.targetId),
          reportId: report.id,
          // No moderator, no audit entry: `platform_audit_entry.actorUserId` is NOT
          // NULL and this action names no human. See the enum's doc comment.
          actionSource: "automatic",
          reasonNote: `Automatically hidden after ${String(AUTOMATIC_HIDE_REPORTER_THRESHOLD)} distinct open reports.`,
        });
        autoHidden = true;
      }
    }

    return { status: "reported" as const, report, autoHidden };
  });

  /**
   * AFTER COMMIT, and only when the threshold actually fired. The automatic hide is the one
   * moderation path with no human in it, so it is also the one most likely to leave a hidden
   * listing in search unnoticed.
   */
  if (outcome.status === "reported" && outcome.autoHidden) {
    await enqueueModeratedTargetSearchRefresh(body.targetKind, body.targetId);
  }

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "self_report":
      return { success: false, error: { type: "SELF_REPORT_FORBIDDEN" } };
    case "already_reported":
      return { success: false, error: { type: "ALREADY_REPORTED" } };
    case "reported":
      return { success: true, value: projectReport(outcome.report) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled createContentReport outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function projectReport(report: typeof commerceContentReport.$inferSelect): ContentReportProjection {
  return {
    id: report.id,
    targetKind: report.targetKind,
    targetId: readTargetId(report) ?? "",
    reason: report.reason,
    detailText: report.detailText,
    status: report.status,
    createdAt: report.createdAt,
    resolvedAt: report.resolvedAt,
  };
}

/** Is this moderator a member of the organization that owns the reported content? */
async function isModeratorPartyToTarget(
  executor: DatabaseTransaction | typeof db,
  moderatorUserId: string,
  ownerOrganizationId: string | null,
): Promise<boolean> {
  if (ownerOrganizationId === null) return false;
  const [membership] = await executor
    .select({ id: commerceOrganizationMember.id })
    .from(commerceOrganizationMember)
    .where(
      and(
        eq(commerceOrganizationMember.userId, moderatorUserId),
        eq(commerceOrganizationMember.organizationId, ownerOrganizationId),
        eq(commerceOrganizationMember.state, "active"),
      ),
    )
    .limit(1);
  return membership !== undefined;
}

/** The staff queue, oldest first (Appendix A12). */
export async function listContentReports(
  moderatorUserId: string,
  query: ListContentReportsQuery,
): Promise<
  Result<
    {
      readonly items: readonly ContentReportProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceContentReportsError
  >
> {
  // Capability BEFORE any id is read — otherwise the route is an existence oracle for
  // whoever is not staff.
  const capability = await requirePlatformCapability(moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const filters: SQL[] = [];
  if (query.status !== undefined) filters.push(eq(commerceContentReport.status, query.status));
  if (query.targetKind !== undefined) {
    filters.push(eq(commerceContentReport.targetKind, query.targetKind));
  }

  if (query.cursor !== undefined) {
    const cursor = decodeTimestampStoreCursor(query.cursor);
    if (!cursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    const keyset = or(
      gt(commerceContentReport.createdAt, cursor.sortKey),
      and(
        eq(commerceContentReport.createdAt, cursor.sortKey),
        gt(commerceContentReport.id, cursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(commerceContentReport)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(commerceContentReport.createdAt), asc(commerceContentReport.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: pageRows.map(projectReport),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
            : null,
        hasMore: hasMore && lastRow !== undefined,
      },
    },
  };
}

/**
 * Rule on a report (Appendix A12).
 *
 * ACTIONING CLOSES EVERY OPEN REPORT ON THAT TARGET, not just the one clicked — the
 * precedent research-program moderation set. Leaving siblings open means the next
 * reviewer re-decides a settled case, and the queue never drains.
 *
 * DISMISSING RESTORES AN AUTOMATIC HIDE. Easy to forget, and forgetting it means three
 * griefers permanently silence content a moderator just declared fine.
 */
export async function decideContentReport(
  moderatorUserId: string,
  reportId: string,
  input: DecideContentReportInput,
): Promise<Result<ContentReportProjection, CommerceContentReportsError>> {
  const capability = await requirePlatformCapability(moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }
  const moderatorRole = capability.value.platformRole;

  const outcome = await db.transaction(async (transaction) => {
    const [report] = await transaction
      .select()
      .from(commerceContentReport)
      .where(eq(commerceContentReport.id, reportId))
      .limit(1)
      .for("update");
    if (!report) return { status: "not_found" as const };
    if (report.status !== "open") return { status: "already_resolved" as const };

    const targetId = readTargetId(report);
    if (targetId === null) return { status: "not_found" as const };

    const target = await loadTargetOwner(transaction, report.targetKind, targetId);
    if (!target) return { status: "not_found" as const };

    if (await isModeratorPartyToTarget(transaction, moderatorUserId, target.ownerOrganizationId)) {
      return { status: "moderator_is_party" as const };
    }

    const now = new Date();
    const hide = input.decision === "actioned";

    await setTargetVisibility(
      transaction,
      report.targetKind,
      targetId,
      hide,
      hide ? moderatorUserId : null,
    );

    // Close every open report on this target, not only the one being decided.
    const targetPredicate = buildTargetPredicate(report.targetKind, targetId);
    await transaction
      .update(commerceContentReport)
      .set({
        status: input.decision,
        resolvedByUserId: moderatorUserId,
        resolvedAt: now,
        resolutionNote: input.note ?? null,
      })
      .where(and(targetPredicate, eq(commerceContentReport.status, "open")));

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: hide ? "commerce_content_hidden" : "commerce_content_report_dismissed",
      actorUserId: moderatorUserId,
      actorRoleSnapshot: moderatorRole,
      actionLabel: hide ? "commerce_content_hidden" : "commerce_content_report_dismissed",
      targetLabel: `${report.targetKind}:${targetId}`,
      detailNote: input.note ?? "",
      payload: { reportId: report.id, targetKind: report.targetKind, targetId },
      occurredAt: now,
    });

    await transaction.insert(commerceModerationAction).values({
      actionKind: hide ? "content_hidden" : "report_dismissed",
      targetKind: report.targetKind,
      ...buildTargetColumns(report.targetKind, targetId),
      reportId: report.id,
      actionSource: "moderator",
      moderatorUserId,
      moderatorRoleSnapshot: moderatorRole,
      reasonNote: input.note ?? `Report ${input.decision} by moderator.`,
      auditEntryId: auditEntry.id,
    });

    const [updated] = await transaction
      .select()
      .from(commerceContentReport)
      .where(eq(commerceContentReport.id, report.id))
      .limit(1);
    return {
      status: "decided" as const,
      report: updated ?? report,
      targetKind: report.targetKind,
      targetId,
    };
  });

  /**
   * AFTER COMMIT, on BOTH decisions. A dismissal un-suspends a product that an automatic hide
   * had already taken down, so the restoring half needs the refresh every bit as much as the
   * hiding half — a listing stuck out of search after it was cleared is the same defect
   * pointing the other way.
   */
  if (outcome.status === "decided") {
    await enqueueModeratedTargetSearchRefresh(outcome.targetKind, outcome.targetId);
  }

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "already_resolved":
      return { success: false, error: { type: "REPORT_ALREADY_RESOLVED" } };
    case "moderator_is_party":
      return { success: false, error: { type: "MODERATOR_IS_PARTY" } };
    case "decided":
      return { success: true, value: projectReport(outcome.report) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled decideContentReport outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Restore hidden content directly (Appendix A12).
 *
 * Separate from dismissing a report because content can be hidden with no open report
 * left to dismiss — the automatic threshold hides, then the reports are actioned, and
 * later the decision is reconsidered. Without this route that content is stuck.
 */
export async function restoreContent(
  moderatorUserId: string,
  input: RestoreContentInput,
): Promise<Result<ModerationActionProjection, CommerceContentReportsError>> {
  const capability = await requirePlatformCapability(moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }
  const moderatorRole = capability.value.platformRole;

  const outcome = await db.transaction(async (transaction) => {
    const target = await loadTargetOwner(transaction, input.targetKind, input.targetId);
    if (!target) return { status: "not_found" as const };
    if (await isModeratorPartyToTarget(transaction, moderatorUserId, target.ownerOrganizationId)) {
      return { status: "moderator_is_party" as const };
    }

    const now = new Date();
    await setTargetVisibility(transaction, input.targetKind, input.targetId, false, null);

    const auditEntry = await appendPlatformAuditEntry(transaction, {
      eventKind: "commerce_content_restored",
      actorUserId: moderatorUserId,
      actorRoleSnapshot: moderatorRole,
      actionLabel: "commerce_content_restored",
      targetLabel: `${input.targetKind}:${input.targetId}`,
      detailNote: input.reasonNote,
      payload: { targetKind: input.targetKind, targetId: input.targetId },
      occurredAt: now,
    });

    const [action] = await transaction
      .insert(commerceModerationAction)
      .values({
        actionKind: "content_restored",
        targetKind: input.targetKind,
        ...buildTargetColumns(input.targetKind, input.targetId),
        actionSource: "moderator",
        moderatorUserId,
        moderatorRoleSnapshot: moderatorRole,
        reasonNote: input.reasonNote,
        auditEntryId: auditEntry.id,
      })
      .returning();
    if (!action) return { status: "not_found" as const };
    return { status: "restored" as const, action };
  });

  // AFTER COMMIT. A restore that never reaches the search document leaves a cleared listing
  // invisible to search while the catalog shows it — the hide bug, inverted.
  if (outcome.status === "restored") {
    await enqueueModeratedTargetSearchRefresh(input.targetKind, input.targetId);
  }

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "moderator_is_party":
      return { success: false, error: { type: "MODERATOR_IS_PARTY" } };
    case "restored":
      return {
        success: true,
        value: {
          id: outcome.action.id,
          actionKind: outcome.action.actionKind,
          targetKind: outcome.action.targetKind,
          targetId: readTargetId(outcome.action),
          actionSource: outcome.action.actionSource,
          reasonNote: outcome.action.reasonNote,
          createdAt: outcome.action.createdAt,
        },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled restoreContent outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** The moderation-action log, newest last, for staff review (Appendix A12). */
export async function listModerationActions(
  moderatorUserId: string,
  query: ListContentReportsQuery,
): Promise<
  Result<
    {
      readonly items: readonly ModerationActionProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceContentReportsError
  >
> {
  const capability = await requirePlatformCapability(moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const filters: SQL[] = [];
  if (query.targetKind !== undefined) {
    filters.push(eq(commerceModerationAction.targetKind, query.targetKind));
  }
  if (query.cursor !== undefined) {
    const cursor = decodeTimestampStoreCursor(query.cursor);
    if (!cursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    const keyset = or(
      gt(commerceModerationAction.createdAt, cursor.sortKey),
      and(
        eq(commerceModerationAction.createdAt, cursor.sortKey),
        gt(commerceModerationAction.id, cursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(commerceModerationAction)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(commerceModerationAction.createdAt), asc(commerceModerationAction.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        id: row.id,
        actionKind: row.actionKind,
        targetKind: row.targetKind,
        targetId: readTargetId(row),
        actionSource: row.actionSource,
        reasonNote: row.reasonNote,
        createdAt: row.createdAt,
      })),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
            : null,
        hasMore: hasMore && lastRow !== undefined,
      },
    },
  };
}
