import { and, count, desc, eq, gte, inArray, lt } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  dispute,
  investorConfidenceSnapshot,
  milestone,
  projectStats,
  researchProject,
} from "#src/db/schema.js";
import { BASIS_POINTS_TOTAL, divRoundHalfAwayFromZero } from "#src/lib/money.js";
import type { Result } from "#src/types/index.js";

/**
 * The investor-confidence signal (R_AND_D_BACKEND_STRUCTURE.md §7, §11c).
 *
 * REPLACES `INVESTOR_CONFIDENCE_PERCENT = 78` — a constant hardcoded in `funding-tab.tsx`
 * and rendered to investors as though it meant something. §7: computed nightly from log
 * streak, verified milestones and dispute rate, and returned WITH ITS `asOf`.
 *
 * FOUR RULES THIS FILE EXISTS TO HOLD:
 *
 *  1. INTEGER ONLY. Every division goes through src/lib/money.ts (§4c rule 1). A
 *     confidence score is a number people make funding decisions on; `0.1 + 0.2` has no
 *     business anywhere near it.
 *  2. PURE FUNCTION OF `(data, asOf)` (§4c rule 3). The job carries a quantized instant and
 *     absolute window bounds, stores both on the row, and re-runs to an identical result.
 *  3. NO SIGNAL, NO SNAPSHOT. A project with no milestones, no logs and no disputes has no
 *     confidence to report, and writing 0 would render "we have no data" as "this project
 *     is worthless" — the same reason §9's `isDegenerate` is a state rather than a zero
 *     and `project_stats.allocatedEquityBasisPoints` is NULL rather than 0.
 *  4. THE SCORE NEVER APPEARS IN A REQUEST BODY. It is job-computed and returned with an
 *     `asOf`, exactly like `opportunityScore` and `demandScore` (§13).
 */

/**
 * The three components and their weights, in basis points of the final score.
 *
 * Declared as data rather than buried in the arithmetic so "what does this number mean"
 * is answerable by reading one table, and so a weight change is one line and one test.
 * They sum to 10000; the assertion below is not decoration.
 */
const COMPONENT_WEIGHTS = {
  /** Consistency of effort. The cheapest signal to fake and the cheapest to check. */
  dailyLogStreak: 3_000,
  /** Delivery. The strongest signal, because a done milestone survived a §9 verdict. */
  milestoneCompletion: 4_000,
  /** Trust. Falls when the team itself disputes its own effort record. */
  disputeCleanliness: 3_000,
} as const;

const WEIGHT_TOTAL = Object.values(COMPONENT_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
if (WEIGHT_TOTAL !== BASIS_POINTS_TOTAL) {
  throw new Error(
    `investor-confidence: component weights sum to ${WEIGHT_TOTAL}, expected ${BASIS_POINTS_TOTAL}`,
  );
}

/**
 * The streak length at which the consistency component saturates.
 *
 * 30 days rather than "the longest streak on the platform": a relative scale means a
 * project's score moves when a DIFFERENT project posts a log, which is not a property
 * anyone would predict from the label "investor confidence".
 */
const STREAK_SATURATION_DAYS = 30;

/** The window every count below is taken over. Absolute bounds, never a day count (§4c). */
export const CONFIDENCE_WINDOW_DAYS = 90;

export interface ConfidenceInputs {
  readonly dailyLogStreakDays: number;
  readonly verifiedMilestoneCount: number;
  readonly totalMilestoneCount: number;
  readonly openDisputeCount: number;
  readonly resolvedDisputeCount: number;
}

/**
 * THE FORMULA. A pure function, exported so it can be tested without a database and
 * re-derived by anyone who wants to check our arithmetic.
 *
 * Each component is a basis-point figure in [0, 10000]; the score is their weighted mean,
 * divided ONCE at the end. Dividing per component and summing would round three times and
 * drift by up to 3 basis points from the same inputs — small, but it is a number that must
 * reproduce exactly across two servers (§4c).
 */
export function computeConfidenceBasisPoints(inputs: ConfidenceInputs): number {
  const streakComponent = Math.min(inputs.dailyLogStreakDays, STREAK_SATURATION_DAYS);
  const streakBasisPoints = Number(
    divRoundHalfAwayFromZero(
      BigInt(streakComponent) * BigInt(BASIS_POINTS_TOTAL),
      BigInt(STREAK_SATURATION_DAYS),
    ),
  );

  // A project with no milestones scores 0 on delivery rather than 100: "has delivered
  // nothing yet" and "has delivered everything promised" are not the same claim, and
  // treating an empty roadmap as perfect is how a shell project outscores a real one.
  const milestoneBasisPoints =
    inputs.totalMilestoneCount === 0
      ? 0
      : Number(
          divRoundHalfAwayFromZero(
            BigInt(inputs.verifiedMilestoneCount) * BigInt(BASIS_POINTS_TOTAL),
            BigInt(inputs.totalMilestoneCount),
          ),
        );

  // A team with NO disputes scores full marks — the common case, and the honest reading:
  // nobody has objected to anybody's effort record. Open disputes cost more than resolved
  // ones because an unresolved objection is an unanswered question.
  const totalDisputes = inputs.openDisputeCount + inputs.resolvedDisputeCount;
  const disputeBasisPoints =
    totalDisputes === 0
      ? BASIS_POINTS_TOTAL
      : Math.max(
          0,
          BASIS_POINTS_TOTAL -
            Number(
              divRoundHalfAwayFromZero(
                BigInt(inputs.openDisputeCount * 2 + inputs.resolvedDisputeCount) *
                  BigInt(BASIS_POINTS_TOTAL),
                BigInt(totalDisputes * 2),
              ),
            ),
        );

  // ONE division, at the end.
  const weightedTotal =
    BigInt(streakBasisPoints) * BigInt(COMPONENT_WEIGHTS.dailyLogStreak) +
    BigInt(milestoneBasisPoints) * BigInt(COMPONENT_WEIGHTS.milestoneCompletion) +
    BigInt(disputeBasisPoints) * BigInt(COMPONENT_WEIGHTS.disputeCleanliness);

  const score = Number(divRoundHalfAwayFromZero(weightedTotal, BigInt(BASIS_POINTS_TOTAL)));

  // The column CHECK says the same thing. Asserting here names the input that broke it.
  if (score < 0 || score > BASIS_POINTS_TOTAL) {
    throw new Error(
      `computeConfidenceBasisPoints: ${score} is outside [0, ${BASIS_POINTS_TOTAL}] for ${JSON.stringify(inputs)}`,
    );
  }
  return score;
}

/** Reads every input for one project over the window. */
async function readConfidenceInputs(
  projectId: string,
  windowStartsAt: Date,
  windowEndsAt: Date,
): Promise<ConfidenceInputs> {
  const [statsRow] = await db
    .select({ dailyLogStreakDays: projectStats.dailyLogStreakDays })
    .from(projectStats)
    .where(eq(projectStats.projectId, projectId));

  const [milestoneTotals] = await db
    .select({
      total: count(),
    })
    .from(milestone)
    .where(
      and(
        eq(milestone.projectId, projectId),
        inArray(milestone.status, ["planned", "in_progress", "done"]),
      ),
    );

  const [milestoneDone] = await db
    .select({ total: count() })
    .from(milestone)
    .where(and(eq(milestone.projectId, projectId), eq(milestone.status, "done")));

  const disputeRows = await db
    .select({ status: dispute.status })
    .from(dispute)
    .where(
      and(
        eq(dispute.projectId, projectId),
        gte(dispute.createdAt, windowStartsAt),
        lt(dispute.createdAt, windowEndsAt),
      ),
    );

  return {
    // NULL streak means the §8 job has never run for this project; treat it as zero
    // consistency rather than skipping the component, because "no logs" IS the signal.
    dailyLogStreakDays: statsRow?.dailyLogStreakDays ?? 0,
    verifiedMilestoneCount: milestoneDone?.total ?? 0,
    totalMilestoneCount: milestoneTotals?.total ?? 0,
    openDisputeCount: disputeRows.filter((row) => row.status === "open").length,
    resolvedDisputeCount: disputeRows.filter((row) => row.status !== "open").length,
  };
}

/**
 * Direction against the PREVIOUS snapshot, not against a threshold.
 *
 * `flat` is a real answer and the most common one — a score that moves every night would be
 * noise, and rendering an arrow for a 1-basis-point change is a chart lying about
 * precision.
 */
function deriveTrend(
  currentBasisPoints: number,
  previousBasisPoints: number | null,
): "up" | "down" | "flat" {
  if (previousBasisPoints === null) {
    return "flat";
  }
  const delta = currentBasisPoints - previousBasisPoints;
  // 50 basis points = half a percentage point. Below that, say nothing.
  if (delta >= 50) return "up";
  if (delta <= -50) return "down";
  return "flat";
}

export interface InvestorConfidenceView {
  readonly projectId: string;
  readonly confidenceBasisPoints: number;
  readonly trend: "up" | "down" | "flat";
  readonly dailyLogStreakDays: number;
  readonly verifiedMilestoneCount: number;
  readonly totalMilestoneCount: number;
  readonly openDisputeCount: number;
  readonly resolvedDisputeCount: number;
  /** Returned so all three clients render "as of" and never imply a live number. */
  readonly asOf: Date;
  readonly windowStartsAt: Date;
  readonly windowEndsAt: Date;
  readonly computedAt: Date;
}

function toConfidenceView(
  row: typeof investorConfidenceSnapshot.$inferSelect,
): InvestorConfidenceView {
  return {
    projectId: row.projectId,
    confidenceBasisPoints: row.confidenceBasisPoints,
    trend: row.trend,
    dailyLogStreakDays: row.dailyLogStreakDays,
    verifiedMilestoneCount: row.verifiedMilestoneCount,
    totalMilestoneCount: row.totalMilestoneCount,
    openDisputeCount: row.openDisputeCount,
    resolvedDisputeCount: row.resolvedDisputeCount,
    asOf: row.asOf,
    windowStartsAt: row.windowStartsAt,
    windowEndsAt: row.windowEndsAt,
    computedAt: row.computedAt,
  };
}

/**
 * Computes and stores one project's snapshot.
 *
 * IDEMPOTENT ON `(projectId, asOf)` — re-running the job for the same quantized instant
 * overwrites nothing and inserts nothing (§4e). Returns `null` when the project has no
 * signal at all, and writes no row: see rule 3 in the header.
 */
export async function recomputeInvestorConfidence(
  projectId: string,
  asOf: Date,
  windowStartsAt: Date,
): Promise<InvestorConfidenceView | null> {
  const inputs = await readConfidenceInputs(projectId, windowStartsAt, asOf);

  const hasAnySignal =
    inputs.totalMilestoneCount > 0 ||
    inputs.dailyLogStreakDays > 0 ||
    inputs.openDisputeCount > 0 ||
    inputs.resolvedDisputeCount > 0;

  if (!hasAnySignal) {
    return null;
  }

  const confidenceBasisPoints = computeConfidenceBasisPoints(inputs);

  const [previous] = await db
    .select({ confidenceBasisPoints: investorConfidenceSnapshot.confidenceBasisPoints })
    .from(investorConfidenceSnapshot)
    .where(
      and(
        eq(investorConfidenceSnapshot.projectId, projectId),
        lt(investorConfidenceSnapshot.asOf, asOf),
      ),
    )
    .orderBy(desc(investorConfidenceSnapshot.asOf))
    .limit(1);

  const [stored] = await db
    .insert(investorConfidenceSnapshot)
    .values({
      projectId,
      asOf,
      windowStartsAt,
      windowEndsAt: asOf,
      confidenceBasisPoints,
      trend: deriveTrend(confidenceBasisPoints, previous?.confidenceBasisPoints ?? null),
      dailyLogStreakDays: inputs.dailyLogStreakDays,
      verifiedMilestoneCount: inputs.verifiedMilestoneCount,
      totalMilestoneCount: inputs.totalMilestoneCount,
      openDisputeCount: inputs.openDisputeCount,
      resolvedDisputeCount: inputs.resolvedDisputeCount,
    })
    // A re-run writes nothing. The row that exists was computed from the same rows at the
    // same asOf and is by construction the same answer.
    .onConflictDoNothing()
    .returning();

  if (stored) {
    return toConfidenceView(stored);
  }

  const [existing] = await db
    .select()
    .from(investorConfidenceSnapshot)
    .where(
      and(
        eq(investorConfidenceSnapshot.projectId, projectId),
        eq(investorConfidenceSnapshot.asOf, asOf),
      ),
    );

  return existing ? toConfidenceView(existing) : null;
}

/** Every project the nightly job should score — `active` only. */
export async function listProjectsForConfidence(): Promise<readonly string[]> {
  const rows = await db
    .select({ id: researchProject.id })
    .from(researchProject)
    .where(eq(researchProject.status, "active"))
    .orderBy(researchProject.id);

  return rows.map((row) => row.id);
}

export type InvestorConfidenceError = { type: "CONFIDENCE_NOT_COMPUTED"; projectId: string };

/**
 * `GET …/investor-confidence` — the latest snapshot, or a 404-shaped failure.
 *
 * NOT a fabricated 0 and not a default: a project the job has never scored has no
 * confidence figure, and inventing one is exactly what the hardcoded 78 was.
 */
export async function getLatestInvestorConfidence(
  projectId: string,
): Promise<Result<InvestorConfidenceView, InvestorConfidenceError>> {
  const [row] = await db
    .select()
    .from(investorConfidenceSnapshot)
    .where(eq(investorConfidenceSnapshot.projectId, projectId))
    // §4c rule 4: ends in a unique column.
    .orderBy(desc(investorConfidenceSnapshot.asOf), desc(investorConfidenceSnapshot.id))
    .limit(1);

  if (!row) {
    return { success: false, error: { type: "CONFIDENCE_NOT_COMPUTED", projectId } };
  }
  return { success: true, value: toConfidenceView(row) };
}
