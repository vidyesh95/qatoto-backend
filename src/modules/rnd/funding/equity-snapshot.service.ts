import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  equitySnapshot,
  equitySnapshotShare,
  projectOpenRole,
  researchProject,
} from "#src/db/schema.js";
import { apportionLargestRemainder, BASIS_POINTS_TOTAL } from "#src/lib/money.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";
import {
  findLatestLedgerSequenceNumber,
  sumSlicesByMember,
} from "#src/modules/rnd/funding/slice-ledger.service.js";
import { appendAuditEntry } from "#src/modules/rnd/projects/project-audit.service.js";
import { SLICE_DENOMINATOR, timeSliceNumerator } from "#src/modules/rnd/slice-math.js";

/**
 * The cap table (R_AND_D_BACKEND_STRUCTURE.md §9.4, §9.5).
 *
 * A SNAPSHOT IS A PURE FUNCTION OF `(ledger prefix, asOf)`. It reads a ledger PREFIX —
 * every entry through a named `sequenceNumber` — so recomputing "as of sequence 412" a
 * year and four hundred entries later produces byte-identical rows. That is what makes
 * §17 step 2's test ("run it 1,000 times with the rows shuffled") a real claim rather
 * than a hope.
 *
 * APPORTIONMENT IS LARGEST REMAINDER, and the shares sum to EXACTLY 10000. Flooring alone
 * loses up to N−1 basis points with N members, so shares would sum to 9,999 — and a cap
 * table that does not sum to 100% is not a cap table. Per-member half-even is also wrong:
 * it can overshoot to 10,001 with no correction step.
 *
 * TIES BREAK ON `memberUserId` IN BYTE ORDER, compared in TypeScript
 * (`compareUtf8Bytes`), so a Postgres locale change cannot move a basis point.
 *
 * THE DEGENERATE CASE IS ITS OWN STATE, not a zero. A brand-new project where nobody has
 * contributed has no cap table at all, and rendering "0%" per member would present a
 * fabricated number as a computed fact — so `isDegenerate` is set, the sum-to-10000
 * invariant is suspended, and every client is told which it is looking at.
 *
 * THERE IS NO RESERVE POOL (§9.5). `totalSlices` is EMERGENT — a live SUM — and the UI's
 * reserve affordance is {@link projectOpenRoleDilution}, computed on read and never
 * persisted as slices.
 */

export type EquitySnapshotError = { type: "SNAPSHOT_NOT_FOUND"; snapshotId: string };

export interface EquityShareView {
  readonly memberId: string;
  readonly memberUserId: string;
  readonly memberName: string;
  readonly slices: string;
  readonly equityBasisPoints: number;
}

export interface EquitySnapshotView {
  readonly id: string;
  readonly asOf: Date;
  readonly computedAt: Date;
  readonly totalSlices: string;
  readonly memberCount: number;
  readonly apportionmentAlgorithm: string;
  readonly throughLedgerSequenceNumber: number;
  /** True when nobody has contributed yet. Shares are all 0 and do NOT sum to 10000. */
  readonly isDegenerate: boolean;
  readonly isBaked: boolean;
  readonly shares: readonly EquityShareView[];
}

/**
 * Recomputes one project's cap table at `asOf`, and appends the audit entry that records
 * it.
 *
 * IDEMPOTENT BY (project, asOf): the unique index means a second run for the same
 * quantized instant returns the existing snapshot rather than writing a divergent second
 * one. Re-running the nightly job is therefore free, which is the property §4e requires of
 * every job.
 *
 * A BAKED PROJECT IS SKIPPED ENTIRELY. After the bake, dynamic calculation STOPS and
 * percentages freeze permanently (§9.11) — a nightly job that kept recomputing would
 * silently un-bake the pie.
 */
export async function recomputeEquitySnapshot(
  projectId: string,
  asOf: Date,
): Promise<EquitySnapshotView | null> {
  const [existingBaked] = await db
    .select({ id: equitySnapshot.id })
    .from(equitySnapshot)
    .where(and(eq(equitySnapshot.projectId, projectId), eq(equitySnapshot.isBaked, true)));

  if (existingBaked) {
    return null;
  }

  const [alreadyComputed] = await db
    .select({ id: equitySnapshot.id })
    .from(equitySnapshot)
    .where(and(eq(equitySnapshot.projectId, projectId), eq(equitySnapshot.asOf, asOf)));

  if (alreadyComputed) {
    return findSnapshot(projectId, alreadyComputed.id);
  }

  const throughSequenceNumber = await findLatestLedgerSequenceNumber(projectId);
  const totals = await sumSlicesByMember(projectId, throughSequenceNumber);

  // CANONICAL ORDERING FIRST, in TypeScript, so the tie-break never depends on the order
  // Postgres returned groups in (§9.4). The SQL already orders by the same key; doing it
  // again here is what makes the guarantee independent of the database's collation.
  const ordered = [...totals].toSorted((left, right) =>
    compareUtf8Bytes(left.memberUserId, right.memberUserId),
  );

  const totalSlices = ordered.reduce((runningSum, member) => runningSum + member.slices, 0n);
  const isDegenerate = totalSlices === 0n;

  const basisPoints = apportionLargestRemainder(
    ordered.map((member) => member.slices),
    // Degenerate: nothing to apportion, and every share is 0. `apportionLargestRemainder`
    // returns zeroes for an all-zero weight vector, so the total is passed as 0 to keep
    // its sum assertion true rather than suppressing it.
    isDegenerate ? 0 : BASIS_POINTS_TOTAL,
    ordered.map((member) => member.memberUserId),
  );

  const snapshot = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(equitySnapshot)
      .values({
        projectId,
        asOf,
        totalSlices,
        memberCount: ordered.length,
        throughLedgerSequenceNumber: throughSequenceNumber,
        isDegenerate,
      })
      .returning({ id: equitySnapshot.id });

    if (!created) {
      throw new Error("recomputeEquitySnapshot: insert returned no row");
    }

    if (ordered.length > 0) {
      await tx.insert(equitySnapshotShare).values(
        ordered.map((member, index) => ({
          snapshotId: created.id,
          memberId: member.memberId,
          memberUserId: member.memberUserId,
          slices: member.slices,
          // Non-null by construction: apportionLargestRemainder returns one part per
          // weight, in input order.
          equityBasisPoints: basisPoints[index] ?? 0,
        })),
      );
    }

    await appendAuditEntry(tx, {
      projectId,
      eventKind: "equity_snapshot_recomputed",
      actorUserId: null,
      actorRoleSnapshot: "system",
      actionLabel: "Recomputed the equity snapshot",
      targetLabel: `snapshot ${created.id}`,
      payload: {
        snapshotId: created.id,
        asOf,
        totalSlices,
        memberCount: BigInt(ordered.length),
        throughLedgerSequenceNumber: BigInt(throughSequenceNumber),
        isDegenerate,
      },
      occurredAt: asOf,
    });

    return created;
  });

  return findSnapshot(projectId, snapshot.id);
}

/** One snapshot with its shares, ordered canonically so two reads never disagree. */
export async function findSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<EquitySnapshotView | null> {
  const [snapshot] = await db
    .select()
    .from(equitySnapshot)
    .where(and(eq(equitySnapshot.id, snapshotId), eq(equitySnapshot.projectId, projectId)));

  if (!snapshot) return null;

  const shares = await db
    .select()
    .from(equitySnapshotShare)
    .where(eq(equitySnapshotShare.snapshotId, snapshotId))
    .orderBy(desc(equitySnapshotShare.equityBasisPoints), asc(equitySnapshotShare.memberUserId));

  return toSnapshotView(snapshot, shares);
}

/** The project's newest snapshot — what `GET …/equity` renders. */
export async function findLatestSnapshot(projectId: string): Promise<EquitySnapshotView | null> {
  const [snapshot] = await db
    .select()
    .from(equitySnapshot)
    .where(eq(equitySnapshot.projectId, projectId))
    // Ends in a unique column so two snapshots sharing a millisecond never swap.
    .orderBy(desc(equitySnapshot.computedAt), desc(equitySnapshot.id))
    .limit(1);

  if (!snapshot) return null;
  return findSnapshot(projectId, snapshot.id);
}

/** `GET …/equity/snapshots` — the history, newest first. */
export async function listSnapshots(
  projectId: string,
  options: { readonly page?: number | undefined; readonly limit?: number | undefined } = {},
): Promise<readonly Omit<EquitySnapshotView, "shares">[]> {
  const limit = Math.min(options.limit ?? 25, 100);
  const page = Math.max(options.page ?? 1, 1);

  const rows = await db
    .select()
    .from(equitySnapshot)
    .where(eq(equitySnapshot.projectId, projectId))
    .orderBy(desc(equitySnapshot.asOf), desc(equitySnapshot.id))
    .limit(limit)
    .offset((page - 1) * limit);

  return rows.map((snapshot) => {
    const { shares: _shares, ...rest } = toSnapshotView(snapshot, []);
    return rest;
  });
}

function toSnapshotView(
  snapshot: typeof equitySnapshot.$inferSelect,
  shares: readonly (typeof equitySnapshotShare.$inferSelect)[],
): EquitySnapshotView {
  const view: EquitySnapshotView = {
    id: snapshot.id,
    asOf: snapshot.asOf,
    computedAt: snapshot.computedAt,
    // Decimal string: a slice total past 2^53 loses precision in JSON (§4b).
    totalSlices: snapshot.totalSlices.toString(),
    memberCount: snapshot.memberCount,
    apportionmentAlgorithm: snapshot.apportionmentAlgorithm,
    throughLedgerSequenceNumber: snapshot.throughLedgerSequenceNumber,
    isDegenerate: snapshot.isDegenerate,
    isBaked: snapshot.isBaked,
    shares: shares.map((share) => ({
      memberId: share.memberId,
      memberUserId: share.memberUserId,
      // Joined by the caller when a name is wanted; the snapshot itself stores the id,
      // because a name copied into a frozen cap table drifts the moment it changes.
      memberName: "",
      slices: share.slices.toString(),
      equityBasisPoints: share.equityBasisPoints,
    })),
  };

  // The strongest correctness assertion in the domain, checked on every read rather than
  // trusted (§9.4, §11e: "Response invariant asserted").
  if (!snapshot.isDegenerate && shares.length > 0) {
    const total = shares.reduce((runningSum, share) => runningSum + share.equityBasisPoints, 0);
    if (total !== BASIS_POINTS_TOTAL) {
      throw new Error(
        `equity snapshot ${snapshot.id}: shares sum to ${total} basis points, expected ${BASIS_POINTS_TOTAL}`,
      );
    }
  }

  return view;
}

export interface OpenRoleProjection {
  readonly openRoleId: string;
  readonly roleTitle: string;
  readonly projectedSlices: string;
  readonly projectedDilutionBasisPoints: number;
  readonly assumedRateCentsPerHour: string;
  readonly assumedMonthlyMinutes: number;
  readonly basis: "advertised-compensation-band";
}

/** A month of full-time work, as the projection's stated assumption. Never persisted. */
const PROJECTED_MONTHLY_MINUTES: Readonly<Record<string, number>> = {
  full_time: 160 * 60,
  part_time: 60 * 60,
  hobby: 20 * 60,
};

/**
 * `GET …/equity/open-role-projection` — the ghost segment that REPLACES the reserve pool
 * (§9.5).
 *
 * The mock's reserve is a number a founder chose, diluting every real contributor by
 * 19.5% on the strength of that choice — and SPEC §2's pitch ("replaces founder fiat with
 * objective, verifiable math") dies the moment a founder-chosen constant sits in the
 * denominator. Slicing Pie is already self-correcting: when someone joins, they lock a
 * rate and earn at their own pace, and everyone re-normalizes because the denominator is
 * a live SUM.
 *
 * What replaces it is THIS: a projection derived from the compensation band the project
 * already advertises, computed on read, never persisted as slices, and explicitly OUTSIDE
 * the denominator. The client renders it as a dotted ghost segment labelled "projected,
 * not allocated".
 */
export async function projectOpenRoleDilution(
  projectId: string,
): Promise<readonly OpenRoleProjection[]> {
  const [snapshot] = await db
    .select({ totalSlices: equitySnapshot.totalSlices })
    .from(equitySnapshot)
    .where(eq(equitySnapshot.projectId, projectId))
    .orderBy(desc(equitySnapshot.computedAt), desc(equitySnapshot.id))
    .limit(1);

  const [project] = await db
    .select({ currency: researchProject.currency })
    .from(researchProject)
    .where(eq(researchProject.id, projectId));

  if (!project) return [];

  const roles = await db
    .select({
      id: projectOpenRole.id,
      roleTitle: projectOpenRole.roleTitle,
      commitment: projectOpenRole.commitment,
    })
    .from(projectOpenRole)
    .where(and(eq(projectOpenRole.projectId, projectId), eq(projectOpenRole.status, "open")))
    .orderBy(asc(projectOpenRole.id));

  const currentTotalSlices = snapshot?.totalSlices ?? 0n;

  return roles.map((role) => {
    const assumedMonthlyMinutes = PROJECTED_MONTHLY_MINUTES[role.commitment] ?? 0;
    // A placeholder rate, stated in the response rather than hidden: the role has no
    // locked rate yet by definition, and inventing one silently would make the ghost
    // segment look like a measurement.
    const assumedRateCentsPerHour = 5_000n;
    const projectedNumerator = timeSliceNumerator(assumedMonthlyMinutes, assumedRateCentsPerHour);
    const projectedSlices = projectedNumerator / SLICE_DENOMINATOR;

    const projectedTotal = currentTotalSlices + projectedSlices;
    return {
      openRoleId: role.id,
      roleTitle: role.roleTitle,
      projectedSlices: projectedSlices.toString(),
      // Dilution, not share: how much of the pie this hire would take FROM everyone else.
      projectedDilutionBasisPoints:
        projectedTotal === 0n
          ? 0
          : Number((projectedSlices * BigInt(BASIS_POINTS_TOTAL)) / projectedTotal),
      assumedRateCentsPerHour: assumedRateCentsPerHour.toString(),
      assumedMonthlyMinutes,
      basis: "advertised-compensation-band" as const,
    };
  });
}
