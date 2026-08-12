import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { equitySnapshot, pieBakeEvent, sliceAllocationProposal } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  findSnapshot,
  recomputeEquitySnapshot,
  type EquitySnapshotView,
} from "#src/modules/rnd/funding/equity-snapshot.service.js";
import { appendAuditEntry } from "#src/modules/rnd/projects/project-audit.service.js";
import type { ProjectAccessError } from "#src/modules/rnd/projects/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Baking the pie (R_AND_D_BACKEND_STRUCTURE.md §9.11; PROOF_OF_EFFORT_SPEC.md §3.4).
 *
 * At cash-flow breakeven or a priced round, dynamic calculation **stops** and percentages
 * freeze permanently. Everything §9 does — the pipeline, the windows, the nightly
 * apportionment — exists to produce the one number this endpoint freezes.
 *
 * **IRREVERSIBLE, ONCE EVER, AND THERE IS NO UNBAKE ENDPOINT.** Recovery is a manual,
 * audited, out-of-band operation. `pie_bake_event_project_unq` guarantees the "once" even
 * against two concurrent requests, and the append-only trigger guarantees the event cannot
 * be deleted to make room for a second.
 *
 * THREE GATES, and each one exists because of a specific way this goes wrong:
 *
 *  1. A TYPED ACKNOWLEDGEMENT. This is the most consequential button in the product and a
 *     mis-tap must not be able to reach it.
 *  2. `expectedSnapshotId`, or `409 SNAPSHOT_STALE`. **A founder must not bake a cap table
 *     they have not seen.** Without it, a nightly recompute landing between the review and
 *     the click freezes percentages nobody looked at.
 *  3. `409 UNSETTLED_ALLOCATIONS` while any proposal is `open` or `disputed`. Baking over a
 *     live window would strand a member's verified work outside the frozen cap table
 *     permanently — the one loss this domain has no reversal for.
 */

/** The typed phrase, compared byte for byte. */
export const PIE_BAKE_ACKNOWLEDGEMENT = "BAKE THE PIE";

export type PieBakeTrigger = (typeof pieBakeEvent.$inferSelect)["trigger"];

export type PieBakeError =
  | ProjectAccessError
  | { type: "ACKNOWLEDGEMENT_MISMATCH"; expected: string }
  | { type: "SNAPSHOT_STALE"; latestSnapshotId: string }
  | { type: "SNAPSHOT_NOT_FOUND"; snapshotId: string }
  | { type: "UNSETTLED_ALLOCATIONS"; openCount: number; disputedCount: number }
  | { type: "PIE_ALREADY_BAKED" };

export interface BakePieInput {
  readonly trigger: PieBakeTrigger;
  readonly triggerEvidenceNote: string;
  readonly valuationCents?: bigint | undefined;
  readonly acknowledgement: string;
  readonly expectedSnapshotId: string;
}

export interface PieBakeView {
  readonly bakeEventId: string;
  readonly trigger: PieBakeTrigger;
  readonly valuationCents: string | null;
  readonly bakedAt: Date;
  /** The frozen cap table. Every percentage in it is final. */
  readonly snapshot: EquitySnapshotView;
}

/**
 * `POST …/pie-bake` — founder only, and the last thing §9 ever does for a project.
 */
export async function bakePie(
  context: { readonly projectId: string },
  input: BakePieInput,
  actorUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<PieBakeView, PieBakeError>> {
  if (input.acknowledgement !== PIE_BAKE_ACKNOWLEDGEMENT) {
    return {
      success: false,
      error: { type: "ACKNOWLEDGEMENT_MISMATCH", expected: PIE_BAKE_ACKNOWLEDGEMENT },
    };
  }

  const [alreadyBaked] = await db
    .select({ id: pieBakeEvent.id })
    .from(pieBakeEvent)
    .where(eq(pieBakeEvent.projectId, context.projectId));

  if (alreadyBaked) {
    return { success: false, error: { type: "PIE_ALREADY_BAKED" } };
  }

  // GATE 3 first, because it is the one whose failure a founder can actually act on: settle
  // the outstanding windows, then come back.
  const outstanding = await db
    .select({ status: sliceAllocationProposal.status })
    .from(sliceAllocationProposal)
    .where(
      and(
        eq(sliceAllocationProposal.projectId, context.projectId),
        inArray(sliceAllocationProposal.status, ["open", "disputed"]),
      ),
    );

  if (outstanding.length > 0) {
    return {
      success: false,
      error: {
        type: "UNSETTLED_ALLOCATIONS",
        openCount: outstanding.filter((proposal) => proposal.status === "open").length,
        disputedCount: outstanding.filter((proposal) => proposal.status === "disputed").length,
      },
    };
  }

  // GATE 2. Compared against the NEWEST snapshot rather than merely checking the id exists:
  // "the one I reviewed is still the latest" is the actual claim being made.
  const [latest] = await db
    .select({ id: equitySnapshot.id })
    .from(equitySnapshot)
    .where(eq(equitySnapshot.projectId, context.projectId))
    .orderBy(desc(equitySnapshot.computedAt), desc(equitySnapshot.id))
    .limit(1);

  if (!latest) {
    return {
      success: false,
      error: { type: "SNAPSHOT_NOT_FOUND", snapshotId: input.expectedSnapshotId },
    };
  }
  if (latest.id !== input.expectedSnapshotId) {
    return { success: false, error: { type: "SNAPSHOT_STALE", latestSnapshotId: latest.id } };
  }

  // THE FINAL RECOMPUTE. Pure integer arithmetic over rows that are already written, and
  // — because gate 3 just proved nothing is outstanding — it reproduces the numbers the
  // founder reviewed rather than moving them. Running it anyway closes the gap between
  // "the last nightly snapshot" and "the ledger as it stands right now".
  const bakedAt = new Date();
  const finalSnapshot = await recomputeEquitySnapshot(context.projectId, bakedAt);
  const snapshotToFreeze = finalSnapshot ?? (await findSnapshot(context.projectId, latest.id));

  if (!snapshotToFreeze) {
    return {
      success: false,
      error: { type: "SNAPSHOT_NOT_FOUND", snapshotId: input.expectedSnapshotId },
    };
  }

  try {
    const bakeEventId = await db.transaction(async (tx) => {
      const [event] = await tx
        .insert(pieBakeEvent)
        .values({
          projectId: context.projectId,
          snapshotId: snapshotToFreeze.id,
          trigger: input.trigger,
          triggerEvidenceNote: input.triggerEvidenceNote,
          valuationCents: input.valuationCents ?? null,
          acknowledgement: input.acknowledgement,
          bakedByUserId: actorUserId,
          bakedAt,
        })
        .returning({ id: pieBakeEvent.id });

      if (!event) {
        throw new Error("bakePie: insert returned no row");
      }

      // Marking the snapshot is what actually STOPS the nightly job: it skips a project
      // with a baked snapshot entirely, so dynamic calculation ends here rather than
      // needing a flag somewhere else to remember.
      await tx
        .update(equitySnapshot)
        .set({ isBaked: true })
        .where(eq(equitySnapshot.id, snapshotToFreeze.id));

      await appendAuditEntry(tx, {
        projectId: context.projectId,
        eventKind: "pie_baked",
        actorUserId,
        actorRoleSnapshot,
        actionLabel: "Baked the pie",
        targetLabel: `snapshot ${snapshotToFreeze.id}`,
        detailNote: input.triggerEvidenceNote,
        payload: {
          bakeEventId: event.id,
          snapshotId: snapshotToFreeze.id,
          trigger: input.trigger,
          valuationCents: input.valuationCents ?? null,
          totalSlices: BigInt(snapshotToFreeze.totalSlices),
          memberCount: BigInt(snapshotToFreeze.memberCount),
          // The frozen cap table, inside the hash. From here on the chain itself is the
          // record of what every member owns.
          shares: snapshotToFreeze.shares.map((share) => ({
            memberUserId: share.memberUserId,
            equityBasisPoints: BigInt(share.equityBasisPoints),
            slices: BigInt(share.slices),
          })),
          acknowledgement: input.acknowledgement,
        },
        occurredAt: bakedAt,
      });

      return event.id;
    });

    const frozen = await findSnapshot(context.projectId, snapshotToFreeze.id);
    if (!frozen) {
      throw new Error("bakePie: the frozen snapshot could not be read back");
    }

    return {
      success: true,
      value: {
        bakeEventId,
        trigger: input.trigger,
        valuationCents: input.valuationCents?.toString() ?? null,
        bakedAt,
        snapshot: frozen,
      },
    };
  } catch (error: unknown) {
    // `pie_bake_event_project_unq` under a genuine race: two founders, two tabs, one
    // project. The loser gets the same answer as anyone arriving late.
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "PIE_ALREADY_BAKED" } };
    }
    throw error;
  }
}

/** `GET …/pie-bake` — the frozen cap table, or null while the pie is still dynamic. */
export async function findPieBake(projectId: string): Promise<PieBakeView | null> {
  const [event] = await db.select().from(pieBakeEvent).where(eq(pieBakeEvent.projectId, projectId));

  if (!event) return null;

  const snapshot = await findSnapshot(projectId, event.snapshotId);
  if (!snapshot) return null;

  return {
    bakeEventId: event.id,
    trigger: event.trigger,
    valuationCents: event.valuationCents?.toString() ?? null,
    bakedAt: event.bakedAt,
    snapshot,
  };
}
