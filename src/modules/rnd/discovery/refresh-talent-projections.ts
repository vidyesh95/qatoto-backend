import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { projectMember, researchProject, talentProfile } from "#src/db/schema.js";
import { JOB_NAMES, JOB_PAYLOAD_SCHEMAS, parseJobPayload } from "#src/lib/jobs.js";

/**
 * The hourly talent-directory denormalization (R_AND_D_BACKEND_STRUCTURE.md §6, §4e).
 *
 * `talent_profile.cachedEffortMinutesLogged` and `cachedProjectsCompletedCount` are a
 * REBUILDABLE CACHE, exactly like `project_stats` — so this writes with a plain UPDATE
 * rather than appending, and carries a `projectionComputedAt` so all three clients render
 * "as of" and never imply a live number.
 *
 * VERIFIED EFFORT MINUTES STAY NULL UNTIL §9 EXISTS. There is no ledger to sum yet, and
 * writing 0 would assert "this person has logged no verified effort" as a computed fact
 * when the truth is "nothing has been computed". The column is nullable with no default
 * for exactly this reason, and `talent_profile_cached_ck` ties it to
 * `projectionComputedAt` so the pair cannot drift apart.
 *
 * The project count IS computable today, from active memberships on published projects.
 */
export async function handleRefreshTalentProjections(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.refreshTalentProjections,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.refreshTalentProjections],
    rawPayload,
  );

  const asOf = new Date(payload.asOf);

  const profiles = await db
    .select({ userId: talentProfile.userId })
    .from(talentProfile)
    .where(
      // The monotonic guard, same as the scoring job: replaying an older asOf must not
      // overwrite a newer projection with staler numbers.
      or(isNull(talentProfile.projectionComputedAt), lt(talentProfile.projectionComputedAt, asOf)),
    );

  for (const profile of profiles) {
    const [counts] = await db
      .select({
        // Bounded `joined_at < asOf` so a replay of this asOf sees the same memberships
        // the original run saw (§4c rule 3).
        projectsCompletedCount: sql<number>`count(distinct ${projectMember.projectId})::int`,
      })
      .from(projectMember)
      .innerJoin(researchProject, eq(projectMember.projectId, researchProject.id))
      .where(
        and(
          eq(projectMember.userId, profile.userId),
          eq(projectMember.status, "active"),
          eq(researchProject.status, "active"),
          lt(projectMember.joinedAt, asOf),
        ),
      );

    await db
      .update(talentProfile)
      .set({
        cachedProjectsCompletedCount: counts?.projectsCompletedCount ?? 0,
        // Deliberately left NULL — see the module comment. §9's ledger is what fills it,
        // and `talent_profile_cached_ck` requires it to move in lockstep with
        // projectionComputedAt, so this stays null until there is something real to sum.
        cachedEffortMinutesLogged: null,
        projectionComputedAt: null,
      })
      .where(
        and(
          eq(talentProfile.userId, profile.userId),
          or(
            isNull(talentProfile.projectionComputedAt),
            lt(talentProfile.projectionComputedAt, asOf),
          ),
        ),
      );
  }
}
