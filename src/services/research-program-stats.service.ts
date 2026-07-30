import { asc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchProgram, researchProgramStatSnapshot } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  countBranchesByStatus,
  countOverlapFlaggedBranches,
} from "#src/services/research-branch-signals.service.js";
import { countProgramPapersByStatus } from "#src/services/research-papers.service.js";
import { countProgramBranches } from "#src/services/research-program-branches.service.js";
import {
  countProgramParticipants,
  sumProgramEffortMinutes,
} from "#src/services/research-program-participants.service.js";
import { countProgramPosts } from "#src/services/research-programs.service.js";

/**
 * The four §10 hero tiles, computed nightly
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f; the `recompute-program-stats` job).
 *
 * WHY A SNAPSHOT AND NOT COUNTERS. Same reason §7's investor confidence is a snapshot: the
 * tiles are a claim about a MOMENT, and a counter that drifts has no `asOf` to explain itself
 * with. `GET …/stats` answers **404 when no row exists** rather than inventing zeroes —
 * because four zeroes render as "this program has nobody and nothing", when the truth is
 * "nobody has counted yet". That distinction is the whole reason this is a table.
 *
 * THERE IS NO MONEY TILE, and its absence is deliberate rather than an omission. The mock
 * this replaces showed "$4.2M compensation pool escrowed". Escrow left this codebase (§7 —
 * nine routes 404 and the tables survive unreachable), no program-scoped money rail exists,
 * and `research_contribution_ledger_entry` holds COMMITMENTS rather than balances. So the
 * fourth tile is `totalEffortMinutes`, which is a number this system can actually defend.
 * Rendering a fabricated escrow figure on a page about research integrity would be the one
 * lie this surface cannot afford.
 */

/**
 * Computes and stores one program's snapshot at `asOf`.
 *
 * MUST RUN AFTER `recompute-branch-signals` for the same day — `openGapCount` and
 * `overlapFlagCount` are read FROM the branch statuses that job derives, so running this
 * first reports yesterday's map. The ordering is enforced by cron time (20:03 then 35:03),
 * the same arrangement §7A's close-then-draft pair relies on.
 *
 * IDEMPOTENT by the unique index on `(programId, asOf)`: a re-run for the same quantized day
 * takes a 23505 and returns the row that already exists, rather than appending a second
 * snapshot that would make "latest" ambiguous.
 */
export async function recomputeProgramStats(
  programId: string,
  asOf: Date,
): Promise<{ readonly wasAlreadyComputed: boolean }> {
  // Every count is independent, so they go out together. Nine queries in one round trip's
  // worth of wall clock rather than nine sequential ones, per program, per night.
  const [
    participantCount,
    paperCount,
    branchCount,
    postCount,
    openGapCount,
    overlapFlagCount,
    totalEffortMinutes,
  ] = await Promise.all([
    countProgramParticipants(programId),
    // APPROVED only — the tile says how large the library is, and a queued submission is not
    // yet in the library.
    countProgramPapersByStatus(programId, ["approved"]),
    countProgramBranches(programId),
    countProgramPosts(programId),
    countBranchesByStatus(programId, ["missing"]),
    countOverlapFlaggedBranches(programId),
    sumProgramEffortMinutes(programId),
  ]);

  try {
    await db.insert(researchProgramStatSnapshot).values({
      programId,
      asOf,
      participantCount,
      paperCount,
      branchCount,
      postCount,
      openGapCount,
      overlapFlagCount,
      totalEffortMinutes,
    });
    return { wasAlreadyComputed: false };
  } catch (insertError: unknown) {
    if (isUniqueViolation(insertError)) {
      // Already computed for this `asOf`. Deliberately NOT overwritten: the snapshot is a
      // record of what was true when it was taken, and rewriting it would make an `asOf`
      // that a client has already rendered mean something different.
      return { wasAlreadyComputed: true };
    }
    throw insertError;
  }
}

/**
 * Every program the nightly jobs should visit.
 *
 * PUBLISHED ONLY. A `pending` program has no public page to put tiles on, a `rejected` one
 * never will, and an `archived` one is frozen history whose last snapshot is the correct
 * one to keep showing.
 *
 * Ordered by id — a unique column — so a partial failure is reproducible: re-running visits
 * the same programs in the same order, which is what makes "it failed on the fourth one"
 * a usable bug report.
 */
export async function listProgramIdsForRecompute(): Promise<readonly string[]> {
  const rows = await db
    .select({ id: researchProgram.id })
    .from(researchProgram)
    .where(eq(researchProgram.status, "published"))
    .orderBy(asc(researchProgram.id));

  return rows.map((row) => row.id);
}
