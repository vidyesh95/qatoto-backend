import { and, count, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  researchProgramBranch,
  researchProgramBranchClaim,
  researchProgramPaper,
} from "#src/db/schema.js";
import {
  jaccardBasisPoints,
  normalizeToTokenSet,
  TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS,
} from "#src/lib/text-similarity.js";
import type { ResearchProgramBranchStatus } from "#src/services/research-program-branches.service.js";

/**
 * The two DERIVED signals on the §10 research map
 * (R_AND_D_BACKEND_STRUCTURE.md §10, "The derived analytical signals").
 *
 * WHY THIS IS THE ONLY WRITER OF `status` AND `overlapping_group_count`. Those two fields
 * carry the map's entire editorial claim: `missing` says "the crowd wants this answered and
 * nobody is working on it", and `overlapping_group_count >= 2` says "several groups are
 * duplicating effort". They are the reason the surface exists. A contributor who could set
 * either — mark their own branch `active`, or a rival's `missing` — would make every node on
 * the map an assertion by whoever edited last, which is worth nothing to a reader.
 *
 * So they appear in no request body (`CreateBranchSchema` and `UpdateBranchSchema` both omit
 * them), no other service writes them, and this module is called only from a scheduled job.
 * It is the §10 analogue of §9's rule that a verification verdict is never a field.
 *
 * WHY JACCARD OVER TOKEN SETS, AND NOT EMBEDDINGS. There is no vector store, no pgvector and
 * no embedding call anywhere in this backend, and adding one to compute a nightly integer
 * would be a large new dependency for a small job. `src/lib/text-similarity.ts` already
 * exists for §6's problem clustering, is integer-only in basis points, and its header
 * explains at length why a float score from `pg_trgm` was rejected: a Postgres upgrade would
 * silently re-score curated history. The same argument applies here — a branch flipping from
 * `active` to `contested` because a dependency moved would be indistinguishable from a real
 * finding.
 *
 * THE HONEST LIMIT OF THAT CHOICE: Jaccard sees SHARED WORDS, not shared meaning. "Senolytic
 * clearance of senescent cells" and "Removing aged cells pharmacologically" are the same
 * research question and score near zero. So `overlappingGroupCount` UNDER-REPORTS, and it is
 * rendered as a flag to look at rather than a count to trust. Over-reporting would be worse:
 * it would accuse two honest groups of duplicating work.
 */

/**
 * How similar two branches must be, in basis points, to count as overlapping.
 *
 * Reuses §6's clustering threshold (3,000 bp = 30% Jaccard) deliberately rather than picking
 * a §10-specific number: the two are the same question — "are these two short texts about
 * the same thing" — and two thresholds would be two definitions of similar that drift.
 */
export const BRANCH_OVERLAP_THRESHOLD_BASIS_POINTS = TEXT_SIMILARITY_THRESHOLD_BASIS_POINTS;

/**
 * How many overlapping neighbours make a branch `contested`.
 *
 * TWO, not one. One near-identical neighbour is normal — a parent and child often share most
 * of their vocabulary, and two sibling branches phrased similarly are a naming problem rather
 * than duplicated work. Two or more independent groups converging on one question is the
 * pattern worth flagging, and §10 specifies this number.
 */
export const CONTESTED_OVERLAP_THRESHOLD = 2;

/** One branch's inputs, gathered before any signal is decided. */
interface BranchSignalInput {
  readonly branchId: string;
  readonly comparisonTokens: readonly string[];
  readonly claimCount: number;
  readonly approvedPaperCount: number;
}

export interface BranchSignalOutcome {
  readonly branchId: string;
  readonly status: ResearchProgramBranchStatus;
  readonly overlappingGroupCount: number;
}

/**
 * Decides one branch's status from its counts and its overlap.
 *
 * PRECEDENCE IS FIXED AND TOTAL, in this order, and every branch matches exactly one:
 *
 *   `missing`    nobody has claimed it AND no approved paper cites it. A research GAP —
 *                the thing this map exists to point at.
 *   `emerging`   somebody is working on it, but nothing has been published yet.
 *   `contested`  published work exists AND two or more other branches are asking a
 *                near-identical question. Duplicated effort.
 *   `active`     published work exists and the question is uniquely held.
 *
 * Exported and PURE, so the rule can be read, reasoned about and tested without a database.
 * That matters more here than anywhere else in the domain: this function is the map's
 * editorial voice, and a reader should be able to check what it claims.
 */
export function decideBranchStatus(input: {
  readonly claimCount: number;
  readonly approvedPaperCount: number;
  readonly overlappingGroupCount: number;
}): ResearchProgramBranchStatus {
  if (input.claimCount === 0 && input.approvedPaperCount === 0) return "missing";
  if (input.approvedPaperCount === 0) return "emerging";
  if (input.overlappingGroupCount >= CONTESTED_OVERLAP_THRESHOLD) return "contested";
  return "active";
}

/**
 * Counts how many OTHER branches each one overlaps, pairwise.
 *
 * O(n²) in Jaccard comparisons, which is fine at this size: §10 sizes a tree at 12–38 nodes
 * and the column is capped at 500, so the worst case is ~125,000 integer set intersections —
 * milliseconds, once a night. Tokenized once per branch up front rather than per comparison,
 * because that is the part that is not free.
 *
 * Exported and pure for the same reason `decideBranchStatus` is.
 */
export function countOverlappingGroups(
  branches: readonly { readonly branchId: string; readonly comparisonTokens: readonly string[] }[],
): ReadonlyMap<string, number> {
  const overlapCounts = new Map<string, number>(branches.map((branch) => [branch.branchId, 0]));

  // Upper triangle only — similarity is symmetric, so comparing both directions would double
  // the work and, more importantly, invite an off-by-one where a branch counts itself.
  for (let leftIndex = 0; leftIndex < branches.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < branches.length; rightIndex += 1) {
      const left = branches[leftIndex];
      const right = branches[rightIndex];
      if (!left || !right) continue;

      const score = jaccardBasisPoints(left.comparisonTokens, right.comparisonTokens);
      if (score < BRANCH_OVERLAP_THRESHOLD_BASIS_POINTS) continue;

      overlapCounts.set(left.branchId, (overlapCounts.get(left.branchId) ?? 0) + 1);
      overlapCounts.set(right.branchId, (overlapCounts.get(right.branchId) ?? 0) + 1);
    }
  }

  return overlapCounts;
}

/**
 * Recomputes both signals for every branch of one program, and writes them.
 *
 * Reads everything first, decides in memory, then writes — so the decision is made against a
 * single consistent view rather than against a tree somebody is editing mid-pass. The write
 * is one statement per CHANGED branch; an unchanged branch is not touched, which keeps
 * `updated_at` meaningful as "when this branch last actually changed".
 *
 * Returns the outcomes so the job can log what moved, and so the smoke script can assert on
 * them without re-reading.
 */
export async function recomputeBranchSignalsForProgram(
  programId: string,
): Promise<readonly BranchSignalOutcome[]> {
  const inputs = await gatherBranchSignalInputs(programId);
  if (inputs.length === 0) return [];

  const overlapCounts = countOverlappingGroups(inputs);

  const outcomes: BranchSignalOutcome[] = inputs.map((input) => {
    const overlappingGroupCount = overlapCounts.get(input.branchId) ?? 0;
    return {
      branchId: input.branchId,
      status: decideBranchStatus({
        claimCount: input.claimCount,
        approvedPaperCount: input.approvedPaperCount,
        overlappingGroupCount,
      }),
      overlappingGroupCount,
    };
  });

  await db.transaction(async (tx) => {
    for (const outcome of outcomes) {
      await tx
        .update(researchProgramBranch)
        .set({
          status: outcome.status,
          overlappingGroupCount: outcome.overlappingGroupCount,
        })
        .where(
          and(
            eq(researchProgramBranch.id, outcome.branchId),
            // Skip the write when nothing moved. Two reasons: `updated_at` stays honest, and
            // a nightly pass over an unchanged program produces no WAL churn.
            sql`(${researchProgramBranch.status} <> ${outcome.status}
                 OR ${researchProgramBranch.overlappingGroupCount} <> ${outcome.overlappingGroupCount})`,
          ),
        );
    }
  });

  return outcomes;
}

/**
 * Gathers each branch's title, summary, claim count and approved-paper count.
 *
 * THREE QUERIES, not one per branch. The two counts come back as grouped aggregates and are
 * joined in memory — an N+1 here would be N+1 per program across every published program on
 * the platform, every night.
 *
 * `title` and `summary` are concatenated before tokenizing, because a two-word title carries
 * too little signal on its own: "Epigenetic Clocks" and "Epigenetic Reprogramming" share one
 * token out of two and would score 3,333 bp — over the threshold — while being different
 * questions. The summary is what disambiguates them.
 */
async function gatherBranchSignalInputs(programId: string): Promise<readonly BranchSignalInput[]> {
  const branchRows = await db
    .select({
      branchId: researchProgramBranch.id,
      title: researchProgramBranch.title,
      summary: researchProgramBranch.summary,
    })
    .from(researchProgramBranch)
    .where(eq(researchProgramBranch.programId, programId));

  if (branchRows.length === 0) return [];

  const branchIds = branchRows.map((row) => row.branchId);

  const [claimRows, paperRows] = await Promise.all([
    db
      .select({
        branchId: researchProgramBranchClaim.branchId,
        claimCount: sql<number>`COUNT(*)::int`,
      })
      .from(researchProgramBranchClaim)
      .where(inArray(researchProgramBranchClaim.branchId, branchIds))
      .groupBy(researchProgramBranchClaim.branchId),
    db
      .select({
        branchId: researchProgramPaper.branchId,
        paperCount: sql<number>`COUNT(*)::int`,
      })
      .from(researchProgramPaper)
      .where(
        and(
          inArray(researchProgramPaper.branchId, branchIds),
          // Only APPROVED papers count as published work. A queued paper is a submission,
          // and treating it as coverage would let anyone clear a `missing` gap by uploading
          // something nobody has read.
          eq(researchProgramPaper.moderationStatus, "approved"),
        ),
      )
      .groupBy(researchProgramPaper.branchId),
  ]);

  const claimCountByBranch = new Map(claimRows.map((row) => [row.branchId, row.claimCount]));
  const paperCountByBranch = new Map(
    paperRows.flatMap((row) =>
      row.branchId === null ? [] : [[row.branchId, row.paperCount] as const],
    ),
  );

  return branchRows.map((row) => ({
    branchId: row.branchId,
    comparisonTokens: normalizeToTokenSet(`${row.title} ${row.summary}`),
    claimCount: claimCountByBranch.get(row.branchId) ?? 0,
    approvedPaperCount: paperCountByBranch.get(row.branchId) ?? 0,
  }));
}

/** How many branches of a program sit at each derived status. Feeds the stat snapshot. */
export async function countBranchesByStatus(
  programId: string,
  statuses: readonly ResearchProgramBranchStatus[],
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(researchProgramBranch)
    .where(
      and(
        eq(researchProgramBranch.programId, programId),
        inArray(researchProgramBranch.status, [...statuses]),
      ),
    );

  return row?.total ?? 0;
}

/** Branches flagged as overlapping. Feeds `overlapFlagCount` on the stat snapshot. */
export async function countOverlapFlaggedBranches(programId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(researchProgramBranch)
    .where(
      and(
        eq(researchProgramBranch.programId, programId),
        sql`${researchProgramBranch.overlappingGroupCount} >= ${CONTESTED_OVERLAP_THRESHOLD}`,
      ),
    );

  return row?.total ?? 0;
}
