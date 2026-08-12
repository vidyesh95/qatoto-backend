import { asc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchProject } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import {
  draftPeriodLines,
  listOpenPeriods,
} from "#src/modules/rnd/compensation/compensation-periods.service.js";

/**
 * The nightly statement redraw (R_AND_D_BACKEND_STRUCTURE.md §7A.5, §4e).
 *
 * REDRAWS EVERY LINE OF EVERY OPEN PERIOD FROM SCRATCH, IDEMPOTENTLY. §17 step 5b runs
 * this 100 times with input rows shuffled and asserts byte-identical lines — that is the
 * test, not an aspiration, and it is what lets a founder trust a number that was computed
 * by a machine at 04:15 while they were asleep.
 *
 * A PURE FUNCTION OF `(rows, asOf)`. The `asOf` arrives in the payload rather than being
 * read from a clock here (§4c rule 3), so replaying a historical `asOf` reproduces the
 * historical draft. Nothing in this file calls `new Date()`.
 *
 * MORE THAN ONE OPEN PERIOD IS NORMAL. §7A.5's close job stops a period accruing without
 * freezing it, so an unfinalized March and an accruing April are both open. Both are
 * redrawn: March's window is in the past, so its numbers are already stable and the redraw
 * is a no-op — but a period nobody redraws is a period whose lines silently predate a
 * correction to its inputs.
 *
 * TWO MODES, one handler: `projectId: null` is the nightly sweep over every active
 * project; a named project is for an operator replaying one statement by hand.
 *
 * ONE PROJECT'S FAILURE MUST NOT STOP THE OTHERS. A nightly run over hundreds of projects
 * that aborts on the first bad row leaves every later project's statement stale, and the
 * staleness is invisible until a founder finalizes a month that is missing a week.
 */
export async function handleRecomputeCompensationDraft(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeCompensationDraft,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeCompensationDraft],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);

  const projectIds =
    payload.projectId === null
      ? (
          await db
            .select({ id: researchProject.id })
            .from(researchProject)
            .where(eq(researchProject.status, "active"))
            // Ends in a unique column, so a re-run visits projects in the same order and
            // a partial failure is reproducible (§4c rule 4).
            .orderBy(asc(researchProject.id))
        ).map((project) => project.id)
      : [payload.projectId];

  const failures: string[] = [];

  for (const projectId of projectIds) {
    try {
      const openPeriods = await listOpenPeriods(projectId);
      for (const period of openPeriods) {
        const drafted = await draftPeriodLines(projectId, period.id, asOf);
        if (!drafted.success) {
          // A period that finalized between the read and the draft is not a failure —
          // finalize recomputes synchronously before it freezes, so the numbers this run
          // would have written are already there.
          if (drafted.error.type !== "PERIOD_ALREADY_FINALIZED") {
            failures.push(`${projectId}/${period.id}: ${drafted.error.type}`);
          }
        }
      }
    } catch (error: unknown) {
      failures.push(`${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    // Rethrown so pg-boss retries and, past the retry limit, dead-letters where an
    // operator can see it. A statement silently stuck a week behind is worse than a loud
    // failure — a founder would finalize it without knowing.
    throw new Error(
      `recompute-compensation-draft: ${failures.length} period(s) failed — ${failures.join("; ")}`,
    );
  }
}
