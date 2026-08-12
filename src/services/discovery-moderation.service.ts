import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  problemCluster,
  problemClusterMergeProposal,
  problemClusterProjectLink,
  problemSubmission,
} from "#src/db/schema.js";
import {
  appendPlatformAuditEntry,
  recordPlatformAction,
} from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import {
  applyCategoryDecision,
  findCategoryStatusById,
  type ResearchCategoryView,
} from "#src/modules/rnd/programs/research-categories.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Platform-staff moderation for §6 (R_AND_D_BACKEND_STRUCTURE.md §11b).
 *
 * THE ORDER OF CHECKS IN EVERY FUNCTION HERE IS LOAD-BEARING: capability FIRST (403),
 * resource SECOND (404). Reversed, `/discovery/admin/categories/:id/decide` becomes an id
 * oracle — anyone with a session could distinguish "that category exists" from "it does
 * not" by the status code, without being staff at all. Checking the capability before any
 * id is read means a non-staff caller gets an identical 403 for a valid id and a garbage
 * one, so nothing about the resource leaks.
 */

export type DiscoveryModerationError =
  | PlatformAccessError
  | { type: "CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "CATEGORY_ALREADY_DECIDED"; status: string }
  | { type: "MERGE_PROPOSAL_NOT_FOUND"; proposalId: string }
  | { type: "MERGE_PROPOSAL_ALREADY_DECIDED"; status: string }
  | { type: "MERGE_TARGET_INVALID"; reason: "self_merge" | "target_already_merged" };

export type CategoryDecisionInput =
  | {
      readonly decision: "approve";
      readonly pinIconKey?: ResearchCategoryView["pinIconKey"];
      readonly note?: string;
    }
  | { readonly decision: "reject"; readonly note: string };

/**
 * Approves or rejects a user-minted category.
 *
 * Re-deciding an already-decided category is REFUSED rather than treated as idempotent: a
 * second approval would stamp a new decision over the original moderator's, silently
 * rewriting who is accountable for letting it into the public taxonomy.
 */
export async function decideCategory(
  actorUserId: string,
  categoryId: string,
  input: CategoryDecisionInput,
): Promise<Result<ResearchCategoryView, DiscoveryModerationError>> {
  // 1. CAPABILITY FIRST — before any id is read. See the module comment.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_taxonomy");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resource second.
  const currentStatus = await findCategoryStatusById(categoryId);
  if (currentStatus === null) {
    return { success: false, error: { type: "CATEGORY_NOT_FOUND", categoryId } };
  }
  if (currentStatus !== "pending") {
    return { success: false, error: { type: "CATEGORY_ALREADY_DECIDED", status: currentStatus } };
  }

  const decidedAt = new Date();
  const updated = await recordPlatformAction(
    async () =>
      applyCategoryDecision({
        categoryId,
        nextStatus: input.decision === "approve" ? "approved" : "rejected",
        // Only set on approval, and only when the moderator chose one — the write skips
        // the column entirely otherwise rather than resetting it to the default.
        pinIconKey: input.decision === "approve" ? input.pinIconKey : undefined,
      }),
    (row) =>
      row === null
        ? // Lost the race with another moderator. Nothing was decided, so nothing is
          // recorded — an audit entry for a write that matched no row is a false trail.
          null
        : {
            eventKind:
              input.decision === "approve"
                ? "taxonomy_category_approved"
                : "taxonomy_category_rejected",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel:
              input.decision === "approve" ? "Approved a category" : "Rejected a category",
            targetLabel: `category ${categoryId}`,
            ...(input.note === undefined ? {} : { detailNote: input.note }),
            payload: {
              categoryId,
              decision: input.decision,
              // Present only on the approve arm of the union — a reject has no pin to set.
              pinIconKey: input.decision === "approve" ? (input.pinIconKey ?? null) : null,
            },
            occurredAt: decidedAt,
          },
  );

  if (!updated) {
    // Lost a race with another moderator between the status read and the write; the
    // conditional UPDATE matched nothing.
    return { success: false, error: { type: "CATEGORY_ALREADY_DECIDED", status: currentStatus } };
  }

  return { success: true, value: updated };
}

export interface MergeProposalView {
  readonly id: string;
  readonly sourceClusterId: string;
  readonly targetClusterId: string;
  readonly status: (typeof problemClusterMergeProposal.$inferSelect)["status"];
  readonly similarityBasisPoints: number;
  readonly centroidDistanceMetres: number;
  readonly decisionNote: string | null;
  readonly decidedAt: string | null;
}

export interface MergeProposalDecisionInput {
  readonly decision: "approve" | "reject";
  readonly note?: string;
}

/**
 * Decides a cluster merge proposal. Approval is IRREVERSIBLE — the source cluster's
 * submissions are repointed and the source is marked `merged`.
 *
 * THE COUNT IS RECOMPUTED, NEVER ADDED. `target.count + source.count` double-counts anyone
 * who reported BOTH clusters — which is the single most likely case, because the two were
 * proposed for merge precisely because they describe the same problem in the same place.
 * DISTINCT means distinct, so it is re-derived from the rows. This is the one place in §6
 * where getting it wrong is unrecoverable: after the merge the source rows are gone.
 */
export async function decideMergeProposal(
  actorUserId: string,
  proposalId: string,
  input: MergeProposalDecisionInput,
): Promise<Result<MergeProposalView, DiscoveryModerationError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_clusters");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const [proposal] = await db
    .select()
    .from(problemClusterMergeProposal)
    .where(eq(problemClusterMergeProposal.id, proposalId));

  if (!proposal) {
    return { success: false, error: { type: "MERGE_PROPOSAL_NOT_FOUND", proposalId } };
  }
  if (proposal.status !== "pending") {
    return {
      success: false,
      error: { type: "MERGE_PROPOSAL_ALREADY_DECIDED", status: proposal.status },
    };
  }
  if (proposal.sourceClusterId === proposal.targetClusterId) {
    return { success: false, error: { type: "MERGE_TARGET_INVALID", reason: "self_merge" } };
  }

  const decidedAt = new Date();

  if (input.decision === "reject") {
    const rejected = await recordPlatformAction(
      async (tx) => {
        const [row] = await tx
          .update(problemClusterMergeProposal)
          .set({
            status: "rejected",
            decidedByUserId: actorUserId,
            decidedAt,
            decisionNote: input.note ?? null,
          })
          .where(
            and(
              eq(problemClusterMergeProposal.id, proposalId),
              eq(problemClusterMergeProposal.status, "pending"),
            ),
          )
          .returning();
        return row ?? null;
      },
      (row) =>
        row === null
          ? null
          : {
              eventKind: "cluster_merge_rejected",
              actorUserId,
              actorRoleSnapshot: capabilityResult.value.platformRole,
              actionLabel: "Rejected a cluster merge proposal",
              targetLabel: `merge proposal ${proposalId}`,
              ...(input.note === undefined ? {} : { detailNote: input.note }),
              payload: {
                proposalId,
                sourceClusterId: proposal.sourceClusterId,
                targetClusterId: proposal.targetClusterId,
              },
              occurredAt: decidedAt,
            },
    );

    if (!rejected) {
      return {
        success: false,
        error: { type: "MERGE_PROPOSAL_ALREADY_DECIDED", status: proposal.status },
      };
    }
    return { success: true, value: toMergeProposalView(rejected) };
  }

  // Chaining merges would make `mergedIntoClusterId` a linked list nobody resolves, so a
  // target that has itself already been absorbed is refused outright.
  const [targetCluster] = await db
    .select({ status: problemCluster.status })
    .from(problemCluster)
    .where(eq(problemCluster.id, proposal.targetClusterId));

  if (!targetCluster || targetCluster.status !== "active") {
    return {
      success: false,
      error: { type: "MERGE_TARGET_INVALID", reason: "target_already_merged" },
    };
  }

  const approved = await db.transaction(async (tx) => {
    // 1. Repoint every submission from source to target.
    await tx
      .update(problemSubmission)
      .set({ clusterId: proposal.targetClusterId })
      .where(eq(problemSubmission.clusterId, proposal.sourceClusterId));

    // 2. Repoint project backlinks, tolerating a link that already exists on the target.
    const sourceLinks = await tx
      .select({
        projectId: problemClusterProjectLink.projectId,
        source: problemClusterProjectLink.source,
        linkedByUserId: problemClusterProjectLink.linkedByUserId,
      })
      .from(problemClusterProjectLink)
      .where(eq(problemClusterProjectLink.clusterId, proposal.sourceClusterId));

    await tx
      .delete(problemClusterProjectLink)
      .where(eq(problemClusterProjectLink.clusterId, proposal.sourceClusterId));

    if (sourceLinks.length > 0) {
      await tx
        .insert(problemClusterProjectLink)
        .values(
          sourceLinks.map((link) => ({
            clusterId: proposal.targetClusterId,
            projectId: link.projectId,
            // Demoted to `founder_declared`: `origin` is unique per project, and the
            // project was born from the SOURCE cluster, which no longer exists as a
            // distinct entity. Claiming it originated from the survivor would rewrite
            // history; the partial unique index would reject it anyway if the target
            // already had an origin.
            source: link.source === "origin" ? ("founder_declared" as const) : link.source,
            linkedByUserId: link.linkedByUserId,
          })),
        )
        .onConflictDoNothing();
    }

    // 3. Mark the source absorbed.
    await tx
      .update(problemCluster)
      .set({ status: "merged", mergedIntoClusterId: proposal.targetClusterId })
      .where(eq(problemCluster.id, proposal.sourceClusterId));

    // 4. RE-DERIVE the target's counts. See the function comment — adding would
    //    double-count every reporter who filed against both clusters.
    const [aggregates] = await tx
      .select({
        distinctReporterCount: sql<number>`count(distinct ${problemSubmission.reporterUserId}) filter (where ${problemSubmission.countsTowardDistinctReporters})::int`,
        submissionCount: sql<number>`count(*)::int`,
        centroidSampleCount: sql<number>`count(*) filter (where ${problemSubmission.latitudeMicrodegrees} is not null)::int`,
        latitudeSum: sql<string>`coalesce(sum(${problemSubmission.latitudeMicrodegrees}), 0)::bigint`,
        longitudeSum: sql<string>`coalesce(sum(${problemSubmission.longitudeMicrodegrees}), 0)::bigint`,
      })
      .from(problemSubmission)
      .where(eq(problemSubmission.clusterId, proposal.targetClusterId));

    if (!aggregates) {
      throw new Error("decideMergeProposal: target aggregate returned no row");
    }

    await tx
      .update(problemCluster)
      .set({
        distinctReporterCount: aggregates.distinctReporterCount,
        submissionCount: aggregates.submissionCount,
        centroidSampleCount: Math.max(aggregates.centroidSampleCount, 1),
        centroidLatitudeSumMicrodegrees: Number(aggregates.latitudeSum),
        centroidLongitudeSumMicrodegrees: Number(aggregates.longitudeSum),
        // The score is INVALIDATED, not blended. A merged cluster's opportunity score is
        // a new question over new inputs; interpolating one would publish a number no job
        // produced, and §6 is explicit that scores are never computed on read.
        currentOpportunityScorePoints: null,
        scoreComputedAt: null,
      })
      .where(eq(problemCluster.id, proposal.targetClusterId));

    // 5. Supersede any other pending proposal touching either cluster — they now refer to
    //    an entity that no longer stands alone.
    await tx
      .update(problemClusterMergeProposal)
      .set({ status: "superseded", decidedAt })
      .where(
        and(
          eq(problemClusterMergeProposal.status, "pending"),
          ne(problemClusterMergeProposal.id, proposalId),
          sql`(${problemClusterMergeProposal.sourceClusterId} IN (${proposal.sourceClusterId}, ${proposal.targetClusterId})
               OR ${problemClusterMergeProposal.targetClusterId} IN (${proposal.sourceClusterId}, ${proposal.targetClusterId}))`,
        ),
      );

    const [decided] = await tx
      .update(problemClusterMergeProposal)
      .set({
        status: "approved",
        decidedByUserId: actorUserId,
        decidedAt,
        decisionNote: input.note ?? null,
      })
      .where(eq(problemClusterMergeProposal.id, proposalId))
      .returning();

    if (!decided) {
      throw new Error("decideMergeProposal: proposal vanished mid-transaction");
    }

    // THE SHARPEST CASE §11l.2 NAMES. This transaction repoints every submission,
    // downgrades `origin` links, marks the source absorbed and invalidates a score — and
    // the function's own comment calls it unrecoverable. Until this line it left no
    // record of who decided it.
    await appendPlatformAuditEntry(tx, {
      eventKind: "cluster_merge_approved",
      actorUserId,
      actorRoleSnapshot: capabilityResult.value.platformRole,
      actionLabel: "Approved a cluster merge",
      targetLabel: `merge proposal ${proposalId}`,
      ...(input.note === undefined ? {} : { detailNote: input.note }),
      payload: {
        proposalId,
        sourceClusterId: proposal.sourceClusterId,
        targetClusterId: proposal.targetClusterId,
        repointedLinkCount: BigInt(sourceLinks.length),
      },
      occurredAt: decidedAt,
    });

    return decided;
  });

  return { success: true, value: toMergeProposalView(approved) };
}

function toMergeProposalView(
  row: typeof problemClusterMergeProposal.$inferSelect,
): MergeProposalView {
  return {
    id: row.id,
    sourceClusterId: row.sourceClusterId,
    targetClusterId: row.targetClusterId,
    status: row.status,
    similarityBasisPoints: row.similarityBasisPoints,
    centroidDistanceMetres: row.centroidDistanceMetres,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/** The moderator queue: pending proposals, oldest first. */
export async function listPendingMergeProposals(
  actorUserId: string,
  filter: { readonly page: number; readonly limit: number },
): Promise<
  Result<
    { readonly rows: readonly MergeProposalView[]; readonly total: number },
    DiscoveryModerationError
  >
> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_clusters");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(problemClusterMergeProposal)
      .where(eq(problemClusterMergeProposal.status, "pending"))
      .orderBy(problemClusterMergeProposal.createdAt, problemClusterMergeProposal.id)
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(problemClusterMergeProposal)
      .where(eq(problemClusterMergeProposal.status, "pending")),
  ]);

  return {
    success: true,
    value: { rows: rows.map(toMergeProposalView), total: totalRow?.total ?? 0 },
  };
}
