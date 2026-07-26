/**
 * The CROSS-PROJECT daily-log feed, against a REAL database
 * (R_AND_D_BACKEND_STRUCTURE.md §11h, Appendix B2, §17 item 11).
 *
 * WHY THIS EXISTS. `GET /daily-logs` is the one endpoint in this domain whose whole reason
 * to be is spanning projects, and until this script nothing had ever executed it that way.
 * Every other smoke test inserts exactly one `research_project`, no user in a normal
 * database holds more than one active membership, and the only coverage of the feed is a
 * schema test that parses the query string and never reaches the keyset. A planner check
 * can show which index is chosen; it cannot show that paging returns every row exactly
 * once. That is the claim §17 item 11 left open, and this closes it.
 *
 * THE FIXTURE IS HAND-WRITTEN, AND THAT IS THE POINT. `submitDailyLog` stamps
 * `submittedAt = new Date()` per call, so N submits always land on N distinct
 * milliseconds — the service path CANNOT produce the same-instant tie that the cursor's
 * `id` tie-breaker exists for. Only a direct insert can choose the timestamp. Writing rows
 * directly also keeps the script offline: no oEmbed call, no `analyze-daily-log` enqueue,
 * no streak mutation. `db:smoke-proof-of-effort` sets the precedent, hand-writing its claim
 * rows so §9 stays deterministic.
 *
 * WHAT IT ASSERTS:
 *
 *   completeness      every page size returns each log exactly once — no repeat, no vanish
 *   ordering          concatenated pages are non-increasing in (logDate, submittedAt, id)
 *   membership        a project the caller is not in never leaks, at any page size
 *   drafts            an unsubmitted log never appears
 *   filters           ?projectSlug= and ?chipKind= page completely, not just correctly
 *   cursor            garbage is refused, never treated as "start again"
 *   precision         the column rounds to the millisecond the cursor can address
 *
 * Creates a disposable user, four projects, three memberships and their logs, and REMOVES
 * THEM ONLY IF EVERY ASSERTION PASSED. A failing run leaves the fixture on the table,
 * because a red keyset is worth inspecting and every id carries a per-run suffix, so
 * leftovers cannot collide with the next run.
 *
 *   pnpm db:smoke-daily-log-feed
 *
 * Needs no worker and no GEMINI_API_KEY. Exits non-zero on any failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  dailyLog,
  dailyLogAiSummaryChip,
  projectMember,
  projectStats,
  researchCategory,
  researchProject,
  user,
} from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import * as logsService from "#src/services/daily-logs.service.js";

const SMOKE_PREFIX = "smoke-feed";

interface Assertion {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];

function record(label: string, passed: boolean, detail: string): void {
  assertions.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

/** UTC day offsets, so no log is future-dated and no assertion is clock-fragile. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Walks the whole feed one page at a time and returns every row it saw, in order.
 *
 * The page cap is a deadlock guard, not a limit: a cursor that fails to advance would
 * otherwise spin forever re-serving the same page, and this turns that into a failed
 * assertion instead of a hung script.
 */
async function walkFeed(
  callerUserId: string,
  options: { readonly limit: number } & Omit<logsService.DailyLogFeedOptions, "cursor" | "limit">,
): Promise<{
  readonly rows: readonly logsService.DailyLogFeedRow[];
  readonly pageCount: number;
  readonly hitCap: boolean;
}> {
  const rows: logsService.DailyLogFeedRow[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  const pageCap = 200;

  while (pageCount < pageCap) {
    const page: Awaited<ReturnType<typeof logsService.listDailyLogFeed>> =
      await logsService.listDailyLogFeed(callerUserId, {
        ...options,
        ...(cursor === null ? {} : { cursor }),
      });

    if (!page.success) {
      throw new Error(`walkFeed: the feed returned ${page.error.type}`);
    }

    rows.push(...page.value.logs);
    pageCount += 1;
    cursor = page.value.nextCursor;
    if (cursor === null) break;
  }

  return { rows, pageCount, hitCap: pageCount >= pageCap };
}

/** The feed's total order, as a comparable key. Descending in all three terms. */
function orderKeyOf(row: logsService.DailyLogFeedRow): string {
  const submittedAt = row.submittedAt?.getTime() ?? 0;
  return `${row.logDate}|${String(submittedAt).padStart(16, "0")}|${row.id}`;
}

/** Asserts one page size returns exactly the expected set, once each, in order. */
function recordWalk(
  label: string,
  expectedIds: readonly string[],
  walked: {
    readonly rows: readonly logsService.DailyLogFeedRow[];
    readonly pageCount: number;
    readonly hitCap: boolean;
  },
): void {
  const walkedIds = walked.rows.map((row) => row.id);
  const distinct = new Set(walkedIds);
  const expected = new Set(expectedIds);
  const missing = expectedIds.filter((id) => !distinct.has(id));
  const unexpected = walkedIds.filter((id) => !expected.has(id));

  const keys = walked.rows.map(orderKeyOf);
  const outOfOrder = keys.filter((key, index) => index > 0 && key >= (keys[index - 1] ?? "")).length;

  record(
    label,
    !walked.hitCap &&
      walkedIds.length === expectedIds.length &&
      distinct.size === expectedIds.length &&
      missing.length === 0 &&
      unexpected.length === 0 &&
      outOfOrder === 0,
    `expected=${expectedIds.length} walked=${walkedIds.length} distinct=${distinct.size} ` +
      `missing=${missing.length} unexpected=${unexpected.length} outOfOrder=${outOfOrder} ` +
      `pages=${walked.pageCount}${walked.hitCap ? " CAPPED" : ""}`,
  );
}

interface SeededLog {
  readonly id: string;
  readonly projectIndex: number;
  readonly logDate: string;
  readonly submittedAt: Date | null;
  readonly status: "draft" | "submitted";
  readonly chipKind: "blocker" | "progress" | null;
}

async function main(): Promise<void> {
  const [category] = await db
    .select({ id: researchCategory.id })
    .from(researchCategory)
    .where(eq(researchCategory.status, "approved"))
    .limit(1);

  if (!category) {
    throw new Error("No approved category — run `pnpm db:seed-research-categories` first.");
  }

  const runId = randomUUID().slice(0, 8);
  const callerUserId = `${SMOKE_PREFIX}-caller-${runId}`;
  // Four projects: three the caller is a member of, and one they are not. The fourth is the
  // leak detector — its logs share the same dates, so a feed that forgot to scope by
  // membership would interleave them invisibly rather than failing loudly.
  const projectIds = [0, 1, 2, 3].map((index) => `${SMOKE_PREFIX}-project-${runId}-${index}`);
  const memberProjectIds = projectIds.slice(0, 3);
  const foreignProjectId = projectIds[3] ?? "";
  const memberIds: string[] = [];
  let succeeded = false;

  try {
    await db.insert(user).values({
      id: callerUserId,
      name: "Smoke Feed Caller",
      email: `${callerUserId}@example.test`,
      emailVerified: true,
    });

    await db.insert(researchProject).values(
      projectIds.map((projectId, index) => ({
        id: projectId,
        slug: `${SMOKE_PREFIX}-${runId}-${String(index)}`,
        founderUserId: callerUserId,
        name: `Smoke Feed Project ${String(index)}`,
        tagline: "A disposable project for the §11h feed smoke test",
        categoryId: category.id,
      })),
    );

    await db.insert(projectStats).values(projectIds.map((projectId) => ({ projectId })));

    // The caller is an ACTIVE member of the first three only. The fourth project has a
    // membership row for nobody — the founder FK does not grant feed access, membership does.
    const insertedMembers = await db
      .insert(projectMember)
      .values(
        memberProjectIds.map((projectId) => ({
          projectId,
          userId: callerUserId,
          projectRole: "founder" as const,
        })),
      )
      .returning({ id: projectMember.id, projectId: projectMember.projectId });

    memberIds.push(...insertedMembers.map((member) => member.id));

    const memberIdByProjectId = new Map(
      insertedMembers.map((member) => [member.projectId, member.id]),
    );

    // A member row on the foreign project too, owned by the caller — so the ONLY thing
    // keeping its logs out of the feed is `status`, not a missing row. That is the sharper
    // version of the test: a feed that filtered on membership existence rather than on
    // ACTIVE membership would pass a fixture where the row simply did not exist.
    const [foreignMember] = await db
      .insert(projectMember)
      .values({
        projectId: foreignProjectId,
        userId: callerUserId,
        projectRole: "contributor",
        status: "left",
        // Both instants are explicit: `joinedAt` defaults to the DB's `now()`, which is a
        // few milliseconds AFTER a JS `new Date()` computed in this process, and
        // `project_member_left_after_joined_ck` rejects a departure that predates the
        // arrival. The constraint caught this the first time it ran.
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
        leftAt: new Date("2026-01-02T00:00:00.000Z"),
      })
      .returning({ id: projectMember.id });

    if (!foreignMember) throw new Error("smoke: foreign member insert returned no row");
    memberIds.push(foreignMember.id);

    /**
     * The log fixture, and every line of it is a hazard the cursor has to survive.
     *
     * `logDate`s INTERLEAVE across projects, so a feed that read one project to exhaustion
     * would produce a plausible-looking but wrong order. Several logs share a `logDate`
     * across projects, which ties the first sort column. Two share a `logDate` AND a
     * byte-identical `submittedAt`, leaving `id` as the only discriminator — the case §4c
     * rule 4 exists for and the one no service-driven fixture can create.
     *
     * The unique index is `(projectId, authorMemberId, logDate)` and each project gives the
     * caller a different `project_member.id`, so one person legitimately holds the same
     * claimed day in all three projects at once.
     */
    const tiedInstant = new Date("2026-02-01T09:00:00.000Z");
    const plan: readonly Omit<SeededLog, "id">[] = [
      // Day 1 — three projects, three different instants.
      { projectIndex: 0, logDate: isoDaysAgo(1), submittedAt: new Date("2026-02-05T10:00:00.000Z"), status: "submitted", chipKind: "blocker" },
      { projectIndex: 1, logDate: isoDaysAgo(1), submittedAt: new Date("2026-02-05T11:00:00.000Z"), status: "submitted", chipKind: null },
      { projectIndex: 2, logDate: isoDaysAgo(1), submittedAt: new Date("2026-02-05T12:00:00.000Z"), status: "submitted", chipKind: "progress" },
      // Day 2 — TWO PROJECTS SHARING AN INSTANT TO THE MILLISECOND. Only `id` separates them.
      { projectIndex: 0, logDate: isoDaysAgo(2), submittedAt: tiedInstant, status: "submitted", chipKind: "blocker" },
      { projectIndex: 1, logDate: isoDaysAgo(2), submittedAt: tiedInstant, status: "submitted", chipKind: null },
      // Day 3 — interleaved back the other way.
      { projectIndex: 2, logDate: isoDaysAgo(3), submittedAt: new Date("2026-02-03T08:00:00.000Z"), status: "submitted", chipKind: "progress" },
      { projectIndex: 0, logDate: isoDaysAgo(3), submittedAt: new Date("2026-02-03T09:00:00.000Z"), status: "submitted", chipKind: null },
      // Day 4 and 5 — depth, so several page sizes cross a boundary mid-project.
      { projectIndex: 1, logDate: isoDaysAgo(4), submittedAt: new Date("2026-02-02T08:00:00.000Z"), status: "submitted", chipKind: "blocker" },
      { projectIndex: 2, logDate: isoDaysAgo(4), submittedAt: new Date("2026-02-02T09:00:00.000Z"), status: "submitted", chipKind: null },
      { projectIndex: 0, logDate: isoDaysAgo(5), submittedAt: new Date("2026-02-01T08:00:00.000Z"), status: "submitted", chipKind: "progress" },
      // A DRAFT in a member project. Never a feed row.
      { projectIndex: 1, logDate: isoDaysAgo(6), submittedAt: null, status: "draft", chipKind: null },
      // The FOREIGN project, on dates that collide with the member projects'.
      { projectIndex: 3, logDate: isoDaysAgo(1), submittedAt: new Date("2026-02-05T10:30:00.000Z"), status: "submitted", chipKind: "blocker" },
      { projectIndex: 3, logDate: isoDaysAgo(2), submittedAt: tiedInstant, status: "submitted", chipKind: "progress" },
    ];

    const seeded: SeededLog[] = plan.map((entry, index) => ({
      ...entry,
      id: `${SMOKE_PREFIX}-log-${runId}-${String(index).padStart(2, "0")}`,
    }));

    await db.insert(dailyLog).values(
      seeded.map((entry) => {
        const projectId = projectIds[entry.projectIndex] ?? "";
        const authorMemberId =
          entry.projectIndex === 3
            ? foreignMember.id
            : (memberIdByProjectId.get(projectId) ?? "");

        return {
          id: entry.id,
          projectId,
          authorMemberId,
          logDate: entry.logDate,
          narrative: `Seeded log ${entry.id}`,
          status: entry.status,
          submittedAt: entry.submittedAt,
          // `daily_log_analysis_ck`: a non-`not_requested` status requires `submitted`, and a
          // non-null `analysisCompletedAt` requires a terminal status. This mirrors exactly
          // what the service writes when no analysis provider is configured.
          ...(entry.status === "submitted"
            ? {
                analysisStatus: "skipped_unconfigured" as const,
                analysisCompletedAt: entry.submittedAt,
              }
            : {}),
        };
      }),
    );

    const chipRows = seeded.filter((entry) => entry.chipKind !== null);
    await db.insert(dailyLogAiSummaryChip).values(
      chipRows.map((entry, index) => ({
        dailyLogId: entry.id,
        sequenceNumber: index,
        kind: entry.chipKind ?? "blocker",
        label: `Seeded ${entry.chipKind ?? "chip"}`,
        generatedByModel: "smoke",
        promptVersion: "smoke",
      })),
    );

    // --- What the feed owes this caller: submitted logs in the three member projects.

    const expectedIds = seeded
      .filter((entry) => entry.status === "submitted" && entry.projectIndex !== 3)
      .map((entry) => entry.id);

    const draftIds = seeded.filter((entry) => entry.status === "draft").map((entry) => entry.id);
    const foreignIds = seeded.filter((entry) => entry.projectIndex === 3).map((entry) => entry.id);

    // --- 1 & 2. Completeness and ordering, at every page size that crosses a boundary
    //            differently. `1` maximises the number of boundaries; `50` proves the
    //            single-page case still terminates.

    for (const limit of [1, 2, 3, 7, 50]) {
      const walked = await walkFeed(callerUserId, { limit });
      recordWalk(`the feed pages completely at limit=${String(limit)}`, expectedIds, walked);
    }

    // --- 3. Membership scoping survives paging.

    const fullWalk = await walkFeed(callerUserId, { limit: 2 });
    const leakedIds = fullWalk.rows.filter((row) => foreignIds.includes(row.id));

    record(
      "a project the caller is not an active member of never appears",
      leakedIds.length === 0,
      `foreignSeeded=${foreignIds.length} leaked=${leakedIds.length}`,
    );

    // --- 4. Drafts are not feed rows.

    const leakedDrafts = fullWalk.rows.filter((row) => draftIds.includes(row.id));

    record(
      "an unsubmitted draft never appears",
      leakedDrafts.length === 0,
      `draftsSeeded=${draftIds.length} leaked=${leakedDrafts.length}`,
    );

    // --- 5. The same-instant tie really was exercised, rather than silently absent.

    const tiedIds = seeded
      .filter(
        (entry) =>
          entry.status === "submitted" &&
          entry.projectIndex !== 3 &&
          entry.submittedAt?.getTime() === tiedInstant.getTime(),
      )
      .map((entry) => entry.id);
    const tiedSeen = fullWalk.rows.filter((row) => tiedIds.includes(row.id));

    record(
      "two logs sharing a day AND an instant are both returned, ordered by id",
      tiedIds.length === 2 && tiedSeen.length === 2,
      `tiedSeeded=${tiedIds.length} tiedReturned=${tiedSeen.length}`,
    );

    // --- 6. `?projectSlug=` pages completely, and an unreachable slug is an empty page.

    const firstProjectSlug = `${SMOKE_PREFIX}-${runId}-0`;
    const firstProjectExpected = seeded
      .filter((entry) => entry.status === "submitted" && entry.projectIndex === 0)
      .map((entry) => entry.id);

    const slugWalk = await walkFeed(callerUserId, { limit: 1, projectSlug: firstProjectSlug });
    recordWalk("?projectSlug= pages completely", firstProjectExpected, slugWalk);

    const foreignSlugPage = await logsService.listDailyLogFeed(callerUserId, {
      projectSlug: `${SMOKE_PREFIX}-${runId}-3`,
      limit: 10,
    });

    record(
      "?projectSlug= for a project the caller cannot see is an EMPTY PAGE, not a 404",
      foreignSlugPage.success && foreignSlugPage.value.logs.length === 0,
      foreignSlugPage.success
        ? `logs=${foreignSlugPage.value.logs.length}`
        : `error=${foreignSlugPage.error.type}`,
    );

    // --- 7. `?chipKind=` pages completely. A filter applied after the fetch would
    //        short-page here rather than returning every match.

    const blockerExpected = seeded
      .filter(
        (entry) =>
          entry.status === "submitted" && entry.projectIndex !== 3 && entry.chipKind === "blocker",
      )
      .map((entry) => entry.id);

    const chipWalk = await walkFeed(callerUserId, { limit: 1, chipKind: "blocker" });
    recordWalk("?chipKind= pages completely", blockerExpected, chipWalk);

    // --- 8. A malformed cursor is refused, never silently restarted.

    const malformed = await logsService.listDailyLogFeed(callerUserId, { cursor: "garbage" });

    record(
      "a malformed cursor is refused rather than restarting the feed",
      !malformed.success && malformed.error.type === "CURSOR_MALFORMED",
      malformed.success ? `it returned ${malformed.value.logs.length} rows` : malformed.error.type,
    );

    // --- 9. The precision guarantee behind all of the above (migration 0021).

    // A deliberate sub-millisecond write, which Drizzle's typed API cannot express because
    // a JS `Date` has no microseconds to send. `timestamp(3)` rounds it at the column, so
    // the stored value stays exactly representable in the milliseconds the cursor carries.
    // Before migration 0021 this landed as-is and the row became unreachable on every page.
    const precisionProbeId = seeded[0]?.id ?? "";
    await db.execute(
      sql`UPDATE daily_log SET submitted_at = TIMESTAMP '2026-02-05 10:00:00.001500'
           WHERE id = ${precisionProbeId}`,
    );

    const [storedRow] = await db
      .select({ submittedAt: dailyLog.submittedAt })
      .from(dailyLog)
      .where(eq(dailyLog.id, precisionProbeId));

    const storedMs = storedRow?.submittedAt?.getTime() ?? 0;
    const roundsToMillisecond = storedMs === new Date("2026-02-05T10:00:00.002Z").getTime();

    record(
      "submitted_at rounds to the millisecond the cursor can address",
      roundsToMillisecond,
      `stored=${storedRow?.submittedAt?.toISOString() ?? "null"}`,
    );

    // And the row is still reachable by paging, which is the consequence that matters.
    const afterPrecisionWalk = await walkFeed(callerUserId, { limit: 1 });
    recordWalk(
      "the feed still pages completely after a sub-millisecond write",
      expectedIds,
      afterPrecisionWalk,
    );

    succeeded = assertions.every((assertion) => assertion.passed);
  } finally {
    if (succeeded) {
      // Reverse dependency order. The FKs into research_project are `restrict` (§4f), so a
      // missed step here fails loudly rather than orphaning rows.
      const logIds = await db
        .select({ id: dailyLog.id })
        .from(dailyLog)
        .where(inArray(dailyLog.projectId, projectIds));

      if (logIds.length > 0) {
        await db.delete(dailyLogAiSummaryChip).where(
          inArray(
            dailyLogAiSummaryChip.dailyLogId,
            logIds.map((row) => row.id),
          ),
        );
      }
      await db.delete(dailyLog).where(inArray(dailyLog.projectId, projectIds));
      if (memberIds.length > 0) {
        await db.delete(projectMember).where(inArray(projectMember.id, memberIds));
      }
      await db.delete(projectStats).where(inArray(projectStats.projectId, projectIds));
      await db.delete(researchProject).where(inArray(researchProject.id, projectIds));
      await db.delete(user).where(eq(user.id, callerUserId));
    } else {
      console.log(
        `\nFixture LEFT BEHIND for inspection: user ${callerUserId}, projects ` +
          `${SMOKE_PREFIX}-${runId}-0..3. Every id carries the run suffix ${runId}, so it ` +
          "cannot collide with the next run.",
      );
    }
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${assertions.length} daily-log feed assertions passed.`
      : `\n${failureCount} of ${assertions.length} daily-log feed assertions FAILED.`,
  );
  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    // Order matters: pg-boss must let go before the pool it borrows is ended.
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Daily-log feed smoke test failed to run:", error);
    await stopSendOnlyBoss().catch(() => undefined);
    await pool.end();
    process.exit(1);
  });
