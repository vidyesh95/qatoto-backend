import { asc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchProject } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";
import { ensurePeriodCovering } from "#src/services/compensation-periods.service.js";

/**
 * The month roll-over (R_AND_D_BACKEND_STRUCTURE.md §7A.5, §4e).
 *
 * NOTHING IS FROZEN HERE. The elapsed period keeps `status = 'open'`; it simply stops
 * growing, because a newer period now absorbs the effort. A founder has not looked at it
 * yet, and freezing a statement nobody has seen would make the finalize step ceremonial.
 *
 * A DAILY TICK RATHER THAN A MONTHLY CRON, and that is the whole reason this job is not
 * one line of pg-boss schedule. §7A.3 makes a period one calendar month IN THE PROJECT'S
 * OWN TIME ZONE, so "the month rolled over" lands on a different UTC instant for every
 * project — 1 April begins in Kiritimati fourteen hours before it begins in Honolulu. A
 * monthly cron would have to pick one of those instants and be wrong for everyone else,
 * and the error would be a whole day of somebody's wages in the wrong statement. Running
 * daily and asking each project's own zone is both simpler and correct.
 *
 * IT WALKS RATHER THAN JUMPS. A worker down for a quarter produces three periods, not one
 * three-month period: the month boundaries ARE the product, and merging two months of
 * wages into one statement would be a bug a founder could not see.
 *
 * IDEMPOTENT. A second run of the same tick finds the periods already there and opens
 * nothing — the period is looked up by `(projectId, periodStartDate)` before any sequence
 * number is allocated, so a re-run cannot burn one and leave a gap in a sequence §7A.3
 * requires to be gapless.
 */
export async function handleCloseCompensationPeriod(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.closeCompensationPeriod,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.closeCompensationPeriod],
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
      await ensurePeriodCovering(projectId, asOf);
    } catch (error: unknown) {
      failures.push(`${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    // Rethrown so pg-boss retries and, past the retry limit, dead-letters where an
    // operator can see it. A project with no period covering today is a project silently
    // losing effort out of every statement, which is the failure mode worth paging for.
    throw new Error(
      `close-compensation-period: ${failures.length} project(s) failed — ${failures.join("; ")}`,
    );
  }
}
