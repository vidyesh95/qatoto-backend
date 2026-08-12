import { and, asc, desc, eq, gt, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  researchProgram,
  researchProgramContentReport,
  researchProgramModerationAction,
  researchProgramPaper,
  researchProgramPost,
  user,
} from "#src/db/schema.js";
import { encodeInstantCursor, type InstantCursor } from "#src/lib/instant-cursor.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import { appendPlatformAuditEntry } from "#src/services/platform-audit.service.js";
import type { PlatformStaffContext } from "#src/services/platform-role.service.js";
import type { ResearchPaperModerationStatus } from "#src/services/research-papers.service.js";
import type { ProgramAccessError } from "#src/services/research-program-access.service.js";
import type { Result } from "#src/types/index.js";

/**
 * §10 moderation — publish, reject, hide, restore, dismiss
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * EVERY DECISION IN THIS FILE APPENDS TO THE PLATFORM AUDIT CHAIN, in the same transaction
 * as the row it changes. That is not new machinery: `platform_audit_entry`,
 * `platform_chain_head` and `appendPlatformAuditEntry` already exist, and
 * `discovery-moderation`, `suppliers` and `content-review` already call it. §10 joins that
 * convention rather than inventing a private log.
 *
 * WHY `research_program_moderation_action` EXISTS AS WELL. The chain is the tamper-evident
 * record and is the authority; that table is this domain's queryable view of it. "Show me
 * every decision on this program" is one index scan there and a payload search in the
 * chain. Both rows are written together, so neither can exist without the other, and the
 * unique index on `auditEntryId` proves it.
 *
 * THE CAPABILITY CHECK IS THE CALLER'S JOB, and it must already have happened. Every
 * function here takes a `PlatformStaffContext` — the proof, not the user id — so it is
 * impossible to call one of them without having proven standing first. That also carries
 * the role snapshot: roles are revocable, so a join later would lie about who was allowed
 * to do this at the time.
 *
 * SAME ORDERING RULE AS EVERY OTHER STAFF SURFACE: capability first, resource id second.
 * Reversed, a 403 becomes an id oracle for anyone holding a session
 * (`platform-role.service.ts`).
 */

export type ResearchProgramModerationError =
  | ProgramAccessError
  | { type: "PROGRAM_ALREADY_DECIDED"; status: (typeof researchProgram.$inferSelect)["status"] }
  | { type: "PAPER_NOT_FOUND"; paperId: string }
  | { type: "PAPER_ALREADY_REVIEWED"; status: ResearchPaperModerationStatus }
  | { type: "POST_NOT_FOUND"; postId: string }
  | { type: "POST_ALREADY_IN_STATE"; isHidden: boolean }
  | { type: "REPORT_NOT_FOUND"; reportId: string }
  | { type: "REPORT_ALREADY_RESOLVED" };

/**
 * Publishes or rejects a program.
 *
 * Guards on `status = 'pending'` in the WHERE, so a second decision returns no row rather
 * than overwriting who was accountable for the first — the same guard
 * `applyCategoryDecision` uses.
 *
 * A published program becomes writable (`requireProgramWritable`) and appears on the public
 * index. A rejected one stays visible to its creator with the reviewer's note, which is why
 * the note is required rather than optional: "no" without a reason is not a review.
 */
export async function decideProgramPublication(input: {
  readonly programSlug: string;
  readonly decision: "published" | "rejected";
  readonly reviewerNote: string;
  readonly staff: PlatformStaffContext;
}): Promise<Result<{ readonly programId: string }, ResearchProgramModerationError>> {
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: researchProgram.id,
        status: researchProgram.status,
        title: researchProgram.title,
        createdByUserId: researchProgram.createdByUserId,
      })
      .from(researchProgram)
      .where(eq(researchProgram.slug, input.programSlug))
      .for("update");

    if (!existing) return { kind: "missing" } as const;
    if (existing.status !== "pending") {
      return { kind: "decided", status: existing.status } as const;
    }

    const decidedAt = new Date();

    await tx
      .update(researchProgram)
      .set({
        status: input.decision,
        // The CHECK ties `published_at` to `status = 'published'`, so this cannot drift.
        publishedAt: input.decision === "published" ? decidedAt : null,
        reviewedByUserId: input.staff.staffUserId,
        reviewedAt: decidedAt,
        reviewerNote: input.reviewerNote,
      })
      .where(eq(researchProgram.id, existing.id));

    const auditEntry = await appendPlatformAuditEntry(tx, {
      eventKind:
        input.decision === "published" ? "research_program_published" : "research_program_rejected",
      actorUserId: input.staff.staffUserId,
      actorRoleSnapshot: input.staff.platformRole,
      actionLabel:
        input.decision === "published"
          ? "Published a research program"
          : "Rejected a research program",
      targetLabel: `research program ${input.programSlug}`,
      detailNote: input.reviewerNote,
      // IDS AND KEYS ONLY, never prose beyond the note the moderator typed — the same
      // contract `notification.payloadJson` follows.
      payload: { programId: existing.id, programSlug: input.programSlug, decision: input.decision },
      occurredAt: decidedAt,
    });

    await tx.insert(researchProgramModerationAction).values({
      programId: existing.id,
      actionKind: input.decision === "published" ? "program_published" : "program_rejected",
      moderatorUserId: input.staff.staffUserId,
      moderatorRoleSnapshot: input.staff.platformRole,
      reasonNote: input.reviewerNote,
      auditEntryId: auditEntry.id,
    });

    // In the SAME transaction as the decision (notifications.service.ts rule 1): a
    // fan-out after the commit can announce a state a rollback undid, and one before it
    // can be lost. `enqueueNotifications` drops a self-notification, so a moderator
    // reviewing their own submission is not told about it.
    if (existing.createdByUserId !== null) {
      await enqueueNotifications(tx, input.staff.staffUserId, [
        {
          recipientUserId: existing.createdByUserId,
          kind:
            input.decision === "published"
              ? "research_program_published"
              : "research_program_rejected",
          // `projectId` stays absent — a program is not a project, which is the case
          // `notification.projectId` was left nullable for. The id travels in the payload.
          payload: { programId: existing.id, programSlug: input.programSlug },
        },
      ]);
    }

    return { kind: "decided-now", programId: existing.id } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "NOT_FOUND", programRef: input.programSlug } };
    case "decided":
      return { success: false, error: { type: "PROGRAM_ALREADY_DECIDED", status: outcome.status } };
    case "decided-now":
      return { success: true, value: { programId: outcome.programId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled program decision outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * A moderator's verdict on a paper.
 *
 * `needs_changes` is a request rather than a refusal, and it is deliberately terminal in the
 * same way the other two are: the CHECK ties `reviewed_at` to a non-`queued` status, so a
 * paper cannot cycle back to `queued`. Re-submitting is a new paper, which re-runs the DOI
 * and content-hash checks — the right outcome, because a changed paper is different bytes.
 */
export async function decidePaperModeration(input: {
  readonly programId: string;
  readonly paperId: string;
  readonly decision: Extract<
    ResearchPaperModerationStatus,
    "approved" | "rejected" | "needs_changes"
  >;
  readonly reviewerNote: string;
  readonly flagReasons: readonly string[];
  readonly staff: PlatformStaffContext;
}): Promise<Result<{ readonly paperId: string }, ResearchProgramModerationError>> {
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: researchProgramPaper.id,
        moderationStatus: researchProgramPaper.moderationStatus,
        title: researchProgramPaper.title,
        uploaderUserId: researchProgramPaper.uploaderUserId,
      })
      .from(researchProgramPaper)
      .where(
        and(
          eq(researchProgramPaper.id, input.paperId),
          eq(researchProgramPaper.programId, input.programId),
        ),
      )
      .for("update");

    if (!existing) return { kind: "missing" } as const;
    if (existing.moderationStatus !== "queued") {
      return { kind: "reviewed", status: existing.moderationStatus } as const;
    }

    const decidedAt = new Date();

    await tx
      .update(researchProgramPaper)
      .set({
        moderationStatus: input.decision,
        flagReasons: [...input.flagReasons],
        reviewedByUserId: input.staff.staffUserId,
        reviewedAt: decidedAt,
        reviewerNote: input.reviewerNote,
      })
      .where(eq(researchProgramPaper.id, input.paperId));

    const auditEntry = await appendPlatformAuditEntry(tx, {
      eventKind: PAPER_AUDIT_KIND_BY_DECISION[input.decision],
      actorUserId: input.staff.staffUserId,
      actorRoleSnapshot: input.staff.platformRole,
      actionLabel: `Reviewed a research paper (${input.decision})`,
      targetLabel: `research paper ${input.paperId}`,
      detailNote: input.reviewerNote,
      payload: {
        programId: input.programId,
        paperId: input.paperId,
        decision: input.decision,
        flagReasonCount: BigInt(input.flagReasons.length),
      },
      occurredAt: decidedAt,
    });

    await tx.insert(researchProgramModerationAction).values({
      programId: input.programId,
      actionKind: PAPER_ACTION_KIND_BY_DECISION[input.decision],
      paperId: input.paperId,
      moderatorUserId: input.staff.staffUserId,
      moderatorRoleSnapshot: input.staff.platformRole,
      reasonNote: input.reviewerNote,
      auditEntryId: auditEntry.id,
    });

    if (existing.uploaderUserId !== null) {
      await enqueueNotifications(tx, input.staff.staffUserId, [
        {
          recipientUserId: existing.uploaderUserId,
          kind: "research_program_paper_moderated",
          payload: {
            programId: input.programId,
            paperId: input.paperId,
            decision: input.decision,
          },
        },
      ]);
    }

    return { kind: "decided" } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "PAPER_NOT_FOUND", paperId: input.paperId } };
    case "reviewed":
      return {
        success: false,
        error: { type: "PAPER_ALREADY_REVIEWED", status: outcome.status },
      };
    case "decided":
      return { success: true, value: { paperId: input.paperId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled paper decision outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The decision → audit-kind and decision → action-kind maps, stated once.
 *
 * `Record<…>` rather than a switch, so adding a fourth verdict to the paper enum is a
 * compile error here instead of a silently-unrecorded decision.
 */
const PAPER_AUDIT_KIND_BY_DECISION: Readonly<
  Record<
    "approved" | "rejected" | "needs_changes",
    | "research_program_paper_approved"
    | "research_program_paper_rejected"
    | "research_program_paper_needs_changes"
  >
> = {
  approved: "research_program_paper_approved",
  rejected: "research_program_paper_rejected",
  needs_changes: "research_program_paper_needs_changes",
};

const PAPER_ACTION_KIND_BY_DECISION: Readonly<
  Record<
    "approved" | "rejected" | "needs_changes",
    "paper_approved" | "paper_rejected" | "paper_needs_changes"
  >
> = {
  approved: "paper_approved",
  rejected: "paper_rejected",
  needs_changes: "paper_needs_changes",
};

/**
 * Hides or restores a post.
 *
 * REVERSIBLE BY DESIGN — `post_restored` is a real audit event, which is only possible
 * because hiding keeps the row. A moderator who hides the wrong thing can undo it, and both
 * the mistake and the correction are on the record.
 */
export async function decidePostVisibility(input: {
  readonly programId: string;
  readonly postId: string;
  readonly decision: "hidden" | "restored";
  readonly reasonNote: string;
  readonly staff: PlatformStaffContext;
}): Promise<Result<{ readonly postId: string }, ResearchProgramModerationError>> {
  const shouldHide = input.decision === "hidden";

  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: researchProgramPost.id, isHidden: researchProgramPost.isHidden })
      .from(researchProgramPost)
      .where(
        and(
          eq(researchProgramPost.id, input.postId),
          eq(researchProgramPost.programId, input.programId),
        ),
      )
      .for("update");

    if (!existing) return { kind: "missing" } as const;
    if (existing.isHidden === shouldHide) {
      // Already in the requested state. Reported rather than swallowed, because unlike a
      // reaction this is a decision with an audit trail — silently appending a second
      // identical entry would put two accountable decisions on one action.
      return { kind: "already", isHidden: existing.isHidden } as const;
    }

    const decidedAt = new Date();

    await tx
      .update(researchProgramPost)
      .set({
        isHidden: shouldHide,
        // The CHECK ties all three together: hidden implies a time and a moderator.
        hiddenByUserId: shouldHide ? input.staff.staffUserId : null,
        hiddenAt: shouldHide ? decidedAt : null,
        hiddenReason: shouldHide ? input.reasonNote : null,
      })
      .where(eq(researchProgramPost.id, input.postId));

    const auditEntry = await appendPlatformAuditEntry(tx, {
      eventKind: shouldHide ? "research_program_post_hidden" : "research_program_post_restored",
      actorUserId: input.staff.staffUserId,
      actorRoleSnapshot: input.staff.platformRole,
      actionLabel: shouldHide ? "Hid a research program post" : "Restored a research program post",
      targetLabel: `research program post ${input.postId}`,
      detailNote: input.reasonNote,
      payload: { programId: input.programId, postId: input.postId, decision: input.decision },
      occurredAt: decidedAt,
    });

    await tx.insert(researchProgramModerationAction).values({
      programId: input.programId,
      actionKind: shouldHide ? "post_hidden" : "post_restored",
      postId: input.postId,
      moderatorUserId: input.staff.staffUserId,
      moderatorRoleSnapshot: input.staff.platformRole,
      reasonNote: input.reasonNote,
      auditEntryId: auditEntry.id,
    });

    // Hiding a post ACTIONS every open report against it — the reports are what asked for
    // this, and leaving them open would keep the queue full of things already handled.
    if (shouldHide) {
      await tx
        .update(researchProgramContentReport)
        .set({
          status: "actioned",
          resolvedByUserId: input.staff.staffUserId,
          resolvedAt: decidedAt,
        })
        .where(
          and(
            eq(researchProgramContentReport.postId, input.postId),
            eq(researchProgramContentReport.status, "open"),
          ),
        );
    }

    return { kind: "decided" } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "POST_NOT_FOUND", postId: input.postId } };
    case "already":
      return {
        success: false,
        error: { type: "POST_ALREADY_IN_STATE", isHidden: outcome.isHidden },
      };
    case "decided":
      return { success: true, value: { postId: input.postId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled post visibility outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Dismisses a report without acting on its target — "we looked, this is fine".
 *
 * Recorded as its own audit event, because "a moderator decided this report was unfounded"
 * is exactly as much a decision as hiding the post would have been, and a queue that only
 * records the actions it took cannot answer "was this ever reviewed?".
 */
export async function dismissContentReport(input: {
  readonly programId: string;
  readonly reportId: string;
  readonly reasonNote: string;
  readonly staff: PlatformStaffContext;
}): Promise<Result<{ readonly reportId: string }, ResearchProgramModerationError>> {
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: researchProgramContentReport.id,
        status: researchProgramContentReport.status,
      })
      .from(researchProgramContentReport)
      .where(
        and(
          eq(researchProgramContentReport.id, input.reportId),
          eq(researchProgramContentReport.programId, input.programId),
        ),
      )
      .for("update");

    if (!existing) return { kind: "missing" } as const;
    if (existing.status !== "open") return { kind: "resolved" } as const;

    const decidedAt = new Date();

    await tx
      .update(researchProgramContentReport)
      .set({
        status: "dismissed",
        resolvedByUserId: input.staff.staffUserId,
        resolvedAt: decidedAt,
      })
      .where(eq(researchProgramContentReport.id, input.reportId));

    const auditEntry = await appendPlatformAuditEntry(tx, {
      eventKind: "research_program_report_dismissed",
      actorUserId: input.staff.staffUserId,
      actorRoleSnapshot: input.staff.platformRole,
      actionLabel: "Dismissed a content report",
      targetLabel: `content report ${input.reportId}`,
      detailNote: input.reasonNote,
      payload: { programId: input.programId, reportId: input.reportId },
      occurredAt: decidedAt,
    });

    await tx.insert(researchProgramModerationAction).values({
      programId: input.programId,
      actionKind: "report_dismissed",
      reportId: input.reportId,
      moderatorUserId: input.staff.staffUserId,
      moderatorRoleSnapshot: input.staff.platformRole,
      reasonNote: input.reasonNote,
      auditEntryId: auditEntry.id,
    });

    return { kind: "dismissed" } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "REPORT_NOT_FOUND", reportId: input.reportId } };
    case "resolved":
      return { success: false, error: { type: "REPORT_ALREADY_RESOLVED" } };
    case "dismissed":
      return { success: true, value: { reportId: input.reportId } };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled report dismissal outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** One open report, as the queue renders it. */
export interface ContentReportView {
  readonly reportId: string;
  readonly targetKind: (typeof researchProgramContentReport.$inferSelect)["targetKind"];
  readonly paperId: string | null;
  readonly postId: string | null;
  readonly reason: (typeof researchProgramContentReport.$inferSelect)["reason"];
  readonly detailText: string | null;
  readonly reporterName: string | null;
  readonly status: (typeof researchProgramContentReport.$inferSelect)["status"];
  readonly createdAt: Date;
}

/**
 * The moderation queue: open reports, OLDEST FIRST.
 *
 * Oldest first deliberately — a queue sorted newest-first starves its own tail, and the
 * report that has waited longest is the one owed an answer. Same reasoning as the program
 * review queue.
 */
export async function listOpenContentReports(input: {
  readonly programId: string;
  readonly limit: number;
  readonly cursor?: InstantCursor | undefined;
}): Promise<{ readonly rows: readonly ContentReportView[]; readonly nextCursor: string | null }> {
  const conditions = [
    eq(researchProgramContentReport.programId, input.programId),
    eq(researchProgramContentReport.status, "open"),
  ];

  if (input.cursor !== undefined) {
    const { instant, id } = input.cursor;
    // Ascending, so `>` — see `listPostReplies` for the same shape.
    conditions.push(
      or(
        gt(researchProgramContentReport.createdAt, instant),
        and(
          eq(researchProgramContentReport.createdAt, instant),
          gt(researchProgramContentReport.id, id),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      reportId: researchProgramContentReport.id,
      targetKind: researchProgramContentReport.targetKind,
      paperId: researchProgramContentReport.paperId,
      postId: researchProgramContentReport.postId,
      reason: researchProgramContentReport.reason,
      detailText: researchProgramContentReport.detailText,
      reporterName: user.name,
      status: researchProgramContentReport.status,
      createdAt: researchProgramContentReport.createdAt,
    })
    .from(researchProgramContentReport)
    .leftJoin(user, eq(user.id, researchProgramContentReport.reporterUserId))
    .where(and(...conditions))
    .orderBy(asc(researchProgramContentReport.createdAt), asc(researchProgramContentReport.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    rows: pageRows,
    nextCursor:
      hasMore && lastRow
        ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.reportId })
        : null,
  };
}

/** The decision log for one program — this domain's queryable view of the chain. */
export interface ModerationActionView {
  readonly actionId: string;
  readonly actionKind: (typeof researchProgramModerationAction.$inferSelect)["actionKind"];
  readonly paperId: string | null;
  readonly postId: string | null;
  readonly reportId: string | null;
  readonly moderatorName: string;
  readonly moderatorRoleSnapshot: string;
  readonly reasonNote: string;
  readonly auditEntryId: string;
  readonly createdAt: Date;
}

export async function listProgramModerationActions(input: {
  readonly programId: string;
  readonly limit: number;
}): Promise<readonly ModerationActionView[]> {
  return (
    db
      .select({
        actionId: researchProgramModerationAction.id,
        actionKind: researchProgramModerationAction.actionKind,
        paperId: researchProgramModerationAction.paperId,
        postId: researchProgramModerationAction.postId,
        reportId: researchProgramModerationAction.reportId,
        moderatorName: user.name,
        moderatorRoleSnapshot: researchProgramModerationAction.moderatorRoleSnapshot,
        reasonNote: researchProgramModerationAction.reasonNote,
        auditEntryId: researchProgramModerationAction.auditEntryId,
        createdAt: researchProgramModerationAction.createdAt,
      })
      .from(researchProgramModerationAction)
      // innerJoin: `moderatorUserId` is `restrict`, so the row is guaranteed to be there.
      // That guarantee is the point of the FK — accountability must not become NULL.
      .innerJoin(user, eq(user.id, researchProgramModerationAction.moderatorUserId))
      .where(eq(researchProgramModerationAction.programId, input.programId))
      .orderBy(
        desc(researchProgramModerationAction.createdAt),
        desc(researchProgramModerationAction.id),
      )
      .limit(input.limit)
  );
}
