/**
 * The moderator's half of §12: letting a pitch go public, or refusing it.
 *
 * THE GATE IS LIGHT AND IS NEVER ABOUT MERIT. Spam, scams, illegal content, and a pitch
 * pointing somewhere that is not what it claims — that is the whole remit. A moderator does
 * NOT judge whether the venture is good, whether the raise is realistic, or whether the
 * numbers on the third party's page add up. Vetting on quality would read as an
 * endorsement, and an endorsement is a liability this platform is deliberately shaped to
 * avoid: Qatoto holds no funds, takes no fee and promises nothing about any pitch it lists.
 * The disclaimer the frontend renders is only true while this stays true.
 *
 * ALL THREE WRITES OR NONE. The status change, the audit entry and the notification share
 * one transaction, because each failure mode of splitting them is real: an audit row
 * committed separately can outlive a rollback, and a notification sent before the commit
 * announces a verdict that may not exist.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { pitch, researchProject, user } from "#src/db/schema.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import type { PlatformStaffContext } from "#src/modules/platform/roles/platform-role.service.js";
import type { ModeratePitchInput } from "#src/modules/rnd/pitches/pitches.schemas.js";
import type { PitchStatus, PitchView } from "#src/modules/rnd/pitches/pitches.service.js";
import type { Result } from "#src/types/index.js";

export type PitchModerationError =
  | { type: "PITCH_NOT_FOUND" }
  /** Only a `pending` pitch is in front of a moderator. */
  | { type: "PITCH_NOT_PENDING"; status: PitchStatus };

/** One row of the review queue: what a moderator needs to decide, and nothing else. */
export interface PitchReviewQueueEntry {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly pitchVideoId: string | null;
  readonly externalFundingUrl: string | null;
  readonly externalContactUrl: string | null;
  readonly submittedByUserId: string;
  readonly submittedByName: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Everything waiting for a verdict, oldest first.
 *
 * OLDEST FIRST, not newest: a queue that surfaces the newest submission first starves the
 * one that has been waiting longest, which is the person most entitled to an answer.
 *
 * The two URLs are ON this row deliberately — checking where a pitch actually sends people
 * is the single most important thing a moderator does here, and making them open the pitch
 * to see it would be the step that gets skipped.
 */
export async function listPitchReviewQueue(options: {
  readonly page: number;
  readonly limit: number;
}): Promise<{ readonly rows: readonly PitchReviewQueueEntry[]; readonly total: number }> {
  const [rows, [counted]] = await Promise.all([
    db
      .select({
        row: pitch,
        projectSlug: researchProject.slug,
        projectName: researchProject.name,
        founderUserId: researchProject.founderUserId,
        founderName: user.name,
      })
      .from(pitch)
      .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
      .innerJoin(user, eq(user.id, researchProject.founderUserId))
      .where(eq(pitch.status, "pending"))
      .orderBy(pitch.updatedAt, pitch.id)
      .limit(options.limit)
      .offset((options.page - 1) * options.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(pitch)
      .where(eq(pitch.status, "pending")),
  ]);

  return {
    rows: rows.map((entry) => ({
      id: entry.row.id,
      slug: entry.row.slug,
      title: entry.row.title,
      summary: entry.row.summary,
      projectSlug: entry.projectSlug,
      projectName: entry.projectName,
      pitchVideoId: entry.row.pitchVideoId,
      externalFundingUrl: entry.row.externalFundingUrl,
      externalContactUrl: entry.row.externalContactUrl,
      submittedByUserId: entry.founderUserId,
      submittedByName: entry.founderName,
      createdAt: entry.row.createdAt,
      updatedAt: entry.row.updatedAt,
    })),
    total: counted?.total ?? 0,
  };
}

/**
 * Publishes or rejects a pending pitch.
 *
 * `publishedAt` IS STAMPED HERE AND NOWHERE ELSE, and `pitch_published_at_ck` refuses a
 * published row without one — a published pitch with a NULL timestamp sorts as NULL and
 * drops out of every ORDER BY that lists it, which is published-but-invisible with no error
 * anywhere.
 *
 * A REJECTION CLEARS NOTHING. The pitch keeps its links and its text, and becomes editable
 * again, because the point of showing the reason is that the founder can act on it.
 */
export async function moderatePitch(input: {
  readonly pitchId: string;
  readonly staff: PlatformStaffContext;
  readonly decision: ModeratePitchInput;
}): Promise<Result<PitchView, PitchModerationError>> {
  return db.transaction(async (tx) => {
    // FOR UPDATE: two moderators opening the queue at once must not both rule on the same
    // row. The loser waits here and then sees `PITCH_NOT_PENDING`, which is the correct
    // answer rather than a lost write.
    const [existing] = await tx
      .select({
        row: pitch,
        projectSlug: researchProject.slug,
        projectName: researchProject.name,
        founderUserId: researchProject.founderUserId,
      })
      .from(pitch)
      .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
      .where(eq(pitch.id, input.pitchId))
      .for("update", { of: pitch });

    if (!existing) return { success: false, error: { type: "PITCH_NOT_FOUND" } };
    if (existing.row.status !== "pending") {
      return {
        success: false,
        error: { type: "PITCH_NOT_PENDING", status: existing.row.status },
      };
    }

    const decidedAt = new Date();
    const isPublishing = input.decision.decision === "published";

    const [updated] = await tx
      .update(pitch)
      .set({
        status: isPublishing ? "published" : "rejected",
        publishedAt: isPublishing ? decidedAt : null,
        rejectionReason: isPublishing ? null : input.decision.reason,
      })
      .where(and(eq(pitch.id, input.pitchId), eq(pitch.status, "pending")))
      .returning();

    if (!updated) {
      return {
        success: false,
        error: { type: "PITCH_NOT_PENDING", status: existing.row.status },
      };
    }

    await appendPlatformAuditEntry(tx, {
      eventKind: isPublishing ? "pitch_published" : "pitch_rejected",
      actorUserId: input.staff.staffUserId,
      actorRoleSnapshot: input.staff.platformRole,
      actionLabel: isPublishing ? "Published a pitch" : "Rejected a pitch",
      targetLabel: `pitch ${updated.slug}`,
      // The moderator's own sentence, and the only prose in the entry.
      detailNote: isPublishing ? undefined : input.decision.reason,
      // IDS AND KEYS ONLY, never prose beyond the note above — the same contract
      // `notification.payloadJson` follows.
      payload: {
        pitchId: updated.id,
        pitchSlug: updated.slug,
        projectSlug: existing.projectSlug,
        decision: isPublishing ? "published" : "rejected",
      },
      occurredAt: decidedAt,
    });

    // In the SAME transaction as the decision. `enqueueNotifications` drops a
    // self-notification, so a moderator who happens to found the project is not told about
    // their own verdict.
    await enqueueNotifications(tx, input.staff.staffUserId, [
      {
        recipientUserId: existing.founderUserId,
        kind: isPublishing ? "pitch_published" : "pitch_rejected",
        // `projectId` IS set here, unlike the §10 programme notifications: a pitch belongs
        // to a project, which is exactly the case this nullable column exists for.
        projectId: updated.projectId,
        payload: { pitchId: updated.id, pitchSlug: updated.slug },
      },
    ]);

    return {
      success: true,
      value: {
        id: updated.id,
        slug: updated.slug,
        projectId: updated.projectId,
        projectSlug: existing.projectSlug,
        projectName: existing.projectName,
        title: updated.title,
        summary: updated.summary,
        pitchVideoId: updated.pitchVideoId,
        externalFundingUrl: updated.externalFundingUrl,
        externalContactUrl: updated.externalContactUrl,
        status: updated.status,
        rejectionReason: updated.rejectionReason,
        publishedAt: updated.publishedAt,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    };
  });
}

/** Newest decisions first — the "what did staff do here" read, gated on `moderate_content`. */
export async function listRecentPitchDecisions(limit: number): Promise<readonly PitchView[]> {
  const rows = await db
    .select({ row: pitch, projectSlug: researchProject.slug, projectName: researchProject.name })
    .from(pitch)
    .innerJoin(researchProject, eq(researchProject.id, pitch.projectId))
    .where(eq(pitch.status, "published"))
    .orderBy(desc(pitch.publishedAt), desc(pitch.id))
    .limit(limit);

  return rows.map((entry) => ({
    id: entry.row.id,
    slug: entry.row.slug,
    projectId: entry.row.projectId,
    projectSlug: entry.projectSlug,
    projectName: entry.projectName,
    title: entry.row.title,
    summary: entry.row.summary,
    pitchVideoId: entry.row.pitchVideoId,
    externalFundingUrl: entry.row.externalFundingUrl,
    externalContactUrl: entry.row.externalContactUrl,
    status: entry.row.status,
    rejectionReason: entry.row.rejectionReason,
    publishedAt: entry.row.publishedAt,
    createdAt: entry.row.createdAt,
    updatedAt: entry.row.updatedAt,
  }));
}
