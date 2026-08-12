import { eq, gt } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { projectStats } from "#src/db/schema.js";
import { calendarDateIn, streakAsOf } from "#src/lib/daily-log-streak.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";

/**
 * The nightly daily-log streak decay (R_AND_D_BACKEND_STRUCTURE.md §5 `project_stats`, §8).
 *
 * WHY THIS JOB EXISTS AT ALL. A streak is the one counter that must change when NOTHING
 * HAPPENS: a project that logged yesterday and not today is no longer on a streak, and no
 * write anywhere would record that. Every other column on `project_stats` moves inside the
 * transaction that causes it; this one decays with the calendar.
 *
 * WHY IT READS `asOf` FROM ITS PAYLOAD (§4c rule 3). The tick quantizes the clock once and
 * hands this job an explicit instant, so a run is a pure function of `(rows, asOf)`: an
 * operator can replay any historical asOf and get byte-identical output, and a double cron
 * fire inside the same UTC day dedups to one job id.
 *
 * WHY EACH PROJECT'S OWN TIME ZONE DECIDES ITS DAY. `project_stats.projectTimeZone` is
 * server-owned precisely so "today" is a single, non-client-settable fact per project. A
 * team in Nairobi and a team in Lima cross midnight nine hours apart, and using the
 * server's UTC day for both would break one of them every night.
 *
 * IDEMPOTENT: re-running the same asOf is a no-op, because `streakAsOf` is a fold that
 * already-decayed rows pass through unchanged.
 */
export async function handleRecomputeDailyLogStreaks(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.recomputeDailyLogStreaks,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.recomputeDailyLogStreaks],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);

  // Only projects with a live streak can decay. A project that has never logged has
  // nothing to lower, and scanning it every night for the rest of its life is the kind of
  // full-table pass that turns a nightly job into an outage at scale.
  const candidates = await db
    .select({
      projectId: projectStats.projectId,
      projectTimeZone: projectStats.projectTimeZone,
      lastDailyLogDate: projectStats.lastDailyLogDate,
      dailyLogStreakDays: projectStats.dailyLogStreakDays,
    })
    .from(projectStats)
    .where(gt(projectStats.dailyLogStreakDays, 0));

  for (const project of candidates) {
    if (project.lastDailyLogDate === null || project.dailyLogStreakDays === null) {
      continue;
    }

    const todayDate = calendarDateIn(asOf, project.projectTimeZone);
    const nextState = streakAsOf(
      {
        lastDailyLogDate: project.lastDailyLogDate,
        dailyLogStreakDays: project.dailyLogStreakDays,
      },
      todayDate,
    );

    if (nextState.dailyLogStreakDays === project.dailyLogStreakDays) {
      // Unchanged: skip the write rather than bump `statsComputedAt` on every project
      // every night, which would make the freshness stamp meaningless.
      continue;
    }

    await db
      .update(projectStats)
      .set({
        dailyLogStreakDays: nextState.dailyLogStreakDays,
        // lastDailyLogDate is deliberately NOT cleared — it is the input tomorrow's run
        // needs, and clearing it would make the decay unreplayable.
        statsComputedAt: asOf,
      })
      .where(eq(projectStats.projectId, project.projectId));
  }

  // A cheap guard against the one shape that would silently break this job: a project row
  // whose streak is positive but whose last log date is null cannot decay and would sit
  // there forever. It should be impossible — submit writes both together — so it is
  // logged rather than repaired, because repairing it here would hide the write path that
  // produced it.
  const inconsistent = candidates.filter(
    (project) => project.lastDailyLogDate === null && (project.dailyLogStreakDays ?? 0) > 0,
  );
  if (inconsistent.length > 0) {
    console.error(
      `recompute-daily-log-streaks: ${inconsistent.length} project(s) have a streak with no last log date`,
      inconsistent.map((project) => project.projectId),
    );
  }
}
