/**
 * End-to-end smoke test for the §8 workshop and daily-log pipeline, against a REAL
 * database.
 *
 * WHY THIS EXISTS. The vitest suite mocks `#src/db/index.js` wholesale, so it can prove
 * things about arithmetic and nothing about the pipeline. The claims that matter most here
 * are all cross-layer:
 *
 *   - the board's TypeScript order and Postgres's `ORDER BY rank` are the SAME order
 *     (the COLLATE "C" guarantee, seen end to end rather than inspected);
 *   - a reorder passes through its own duplicate-position state (the DEFERRABLE unique);
 *   - the chat cursor neither repeats nor skips a row across a page boundary;
 *   - submit is one transaction: the log freezes, the streak moves, and with no
 *     GEMINI_API_KEY it records `skipped_unconfigured` and queues nothing.
 *
 * Creates a disposable user, project, membership and stats row, exercises the real
 * services, asserts the outcomes, and removes everything it created.
 *
 *   pnpm db:smoke-workshop
 *
 * Needs no worker. Exits non-zero on any failed assertion.
 *
 * WITH A GEMINI_API_KEY CONFIGURED, submit really does enqueue — which starts the API's
 * send-only pg-boss instance, and that instance polls. `stopSendOnlyBoss()` in the exit
 * path is therefore not tidiness: without it this script prints every assertion and then
 * hangs forever with nothing left to do.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { asc, eq, inArray } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  dailyLog,
  projectMember,
  projectStats,
  researchCategory,
  researchProject,
  user,
  workshopBoardColumn,
  workshopChatMessage,
  workshopFile,
  workshopTask,
} from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { compareUtf8Bytes } from "#src/lib/ordering.js";
import * as logsService from "#src/modules/rnd/workshop/daily-logs.service.js";
import * as boardService from "#src/modules/rnd/workshop/workshop-board.service.js";
import * as chatService from "#src/modules/rnd/workshop/workshop-chat.service.js";
import * as filesService from "#src/modules/rnd/workshop/workshop-files.service.js";

const SMOKE_PREFIX = "smoke-workshop";

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

/** Yesterday and today in UTC, so the streak assertions are not clock-fragile. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
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

  const founderUserId = `${SMOKE_PREFIX}-user-${randomUUID()}`;
  const projectId = `${SMOKE_PREFIX}-project-${randomUUID()}`;
  const projectSlug = `${SMOKE_PREFIX}-${randomUUID().slice(0, 8)}`;
  let memberId = "";

  try {
    await db.insert(user).values({
      id: founderUserId,
      name: "Smoke Founder",
      email: `${founderUserId}@example.test`,
      emailVerified: true,
    });

    await db.insert(researchProject).values({
      id: projectId,
      slug: projectSlug,
      founderUserId,
      name: "Smoke Project",
      tagline: "A disposable project for the §8 smoke test",
      categoryId: category.id,
    });

    const [member] = await db
      .insert(projectMember)
      .values({ projectId, userId: founderUserId, projectRole: "founder" })
      .returning({ id: projectMember.id });
    memberId = member?.id ?? "";

    await db.insert(projectStats).values({ projectId });

    // --- The board.

    const board = await boardService.ensureDefaultBoard(projectId, founderUserId);
    record(
      "a fresh board seeds three columns",
      board.length === 3,
      board.map((column) => column.title).join(" / "),
    );

    const firstColumnId = board[0]?.id ?? "";
    const createdTasks = [];
    for (const title of ["First", "Second", "Third"]) {
      const created = await boardService.createTask(projectId, founderUserId, {
        columnId: firstColumnId,
        title,
      });
      if (created.success) createdTasks.push(created.value);
    }
    record(
      "three tasks append in order",
      createdTasks.length === 3 &&
        compareUtf8Bytes(createdTasks[0]?.rank ?? "", createdTasks[1]?.rank ?? "") < 0 &&
        compareUtf8Bytes(createdTasks[1]?.rank ?? "", createdTasks[2]?.rank ?? "") < 0,
      createdTasks.map((task) => task.rank).join(" < "),
    );

    // Move the last card to the very top: rank must sort before the first.
    const moved = await boardService.moveTask(projectId, createdTasks[2]?.id ?? "", {
      columnId: firstColumnId,
      beforeTaskId: createdTasks[0]?.id ?? "",
    });
    record(
      "a move to the top derives a rank below the old head",
      moved.success && compareUtf8Bytes(moved.value.rank, createdTasks[0]?.rank ?? "") < 0,
      moved.success ? `${moved.value.rank} < ${createdTasks[0]?.rank}` : "move failed",
    );

    // THE COLLATION CLAIM, END TO END: what Postgres orders by rank must equal what a
    // client's byte compare orders. A locale collation would silently disagree here.
    const rowsByPostgres = await db
      .select({ id: workshopTask.id, rank: workshopTask.rank })
      .from(workshopTask)
      .where(eq(workshopTask.columnId, firstColumnId))
      .orderBy(asc(workshopTask.rank));
    const rowsByClient = [...rowsByPostgres].toSorted((left, right) =>
      compareUtf8Bytes(left.rank, right.rank),
    );
    record(
      "Postgres ORDER BY rank matches a client's byte compare",
      JSON.stringify(rowsByPostgres.map((row) => row.id)) ===
        JSON.stringify(rowsByClient.map((row) => row.id)),
      rowsByPostgres.map((row) => row.rank).join(", "),
    );

    // THE DEFERRABLE UNIQUE, END TO END: a full reversal passes through several duplicate
    // positions and must still commit.
    const reversed = await boardService.reorderColumns(
      projectId,
      board.map((column) => column.id).toReversed(),
    );
    record(
      "reversing the whole board commits in one transaction",
      reversed.success && reversed.value[0]?.title === board[2]?.title,
      reversed.success
        ? reversed.value.map((column) => column.title).join(" / ")
        : "reorder failed",
    );

    // --- Files.

    const linkUrl = "https://drive.google.com/file/d/smoke-abc/view";
    const linked = await filesService.addFileLink(projectId, memberId, {
      fileName: "spec.pdf",
      fileKind: "document",
      externalUrl: linkUrl,
    });
    record(
      "a linked file stores a NULL size, never a claimed one",
      linked.success &&
        linked.value.sizeBytes === null &&
        linked.value.externalHost === "drive.google.com",
      linked.success
        ? `host=${linked.value.externalHost} size=${String(linked.value.sizeBytes)}`
        : "link failed",
    );

    const duplicate = await filesService.addFileLink(projectId, memberId, {
      fileName: "spec-again.pdf",
      fileKind: "document",
      externalUrl: linkUrl,
    });
    record(
      "the same link twice is refused",
      !duplicate.success && duplicate.error.type === "FILE_LINK_ALREADY_ADDED",
      duplicate.success ? "it was accepted" : duplicate.error.type,
    );

    const hostileLink = await filesService.addFileLink(projectId, memberId, {
      fileName: "evil",
      fileKind: "other",
      externalUrl: "https://drive.google.com.evil.tld/x",
    });
    record(
      "a lookalike host is refused",
      !hostileLink.success && hostileLink.error.type === "LINK_HOST_NOT_ALLOWED",
      hostileLink.success ? "it was accepted" : hostileLink.error.type,
    );

    // --- Chat, and the cursor that must neither repeat nor skip.

    for (let index = 0; index < 7; index += 1) {
      await chatService.postMessage(projectId, memberId, `Message ${index}`);
    }

    const firstPage = await chatService.listMessages(projectId, { limit: 3 });
    const firstCursor = firstPage.success ? firstPage.value.nextCursor : null;
    const secondPage = await chatService.listMessages(projectId, {
      limit: 3,
      ...(firstCursor === null ? {} : { cursor: firstCursor }),
    });

    const firstIds = firstPage.success ? firstPage.value.messages.map((message) => message.id) : [];
    const secondIds = secondPage.success
      ? secondPage.value.messages.map((message) => message.id)
      : [];
    const overlap = firstIds.filter((id) => secondIds.includes(id));

    record(
      "the chat cursor pages without repeating a row",
      firstIds.length === 3 && secondIds.length === 3 && overlap.length === 0,
      `page1=${firstIds.length} page2=${secondIds.length} overlap=${overlap.length}`,
    );

    /**
     * THE OTHER HALF, which this file's header has always claimed and never checked: the
     * cursor must not SKIP a row either.
     *
     * A no-repeat assertion passes trivially for a cursor that drops rows — which is what
     * the loop above could not detect, for two reasons. It posts each message in its own
     * round trip, so every `sent_at` lands on a different millisecond; and it only compares
     * two pages for overlap, never asking whether the pages together contain everything.
     *
     * A BATCH INSERT IS WHAT MAKES THE HAZARD REPRODUCIBLE. `now()` is fixed for the
     * duration of a statement, so every row in one multi-row insert carries a
     * byte-identical `sent_at` — including its microseconds, which are non-zero for
     * essentially every call. If the cursor's precision is coarser than the column's, the
     * next page's predicate matches none of the tied rows and the rest of the history
     * becomes unreachable.
     */
    const batchedTexts = ["Batched A", "Batched B", "Batched C", "Batched D"];
    await db.insert(workshopChatMessage).values(
      batchedTexts.map((messageText) => ({
        projectId,
        authorMemberId: memberId,
        messageText,
      })),
    );

    const expectedIds = await db
      .select({ id: workshopChatMessage.id })
      .from(workshopChatMessage)
      .where(eq(workshopChatMessage.projectId, projectId));

    const walkedIds: string[] = [];
    let walkCursor: string | null = null;
    let walkPageCount = 0;

    // The cap is a deadlock guard: a cursor that fails to advance would otherwise spin
    // forever returning the same page.
    while (walkPageCount < 50) {
      const page: Awaited<ReturnType<typeof chatService.listMessages>> =
        await chatService.listMessages(projectId, {
          limit: 3,
          ...(walkCursor === null ? {} : { cursor: walkCursor }),
        });
      if (!page.success) break;

      walkedIds.push(...page.value.messages.map((message) => message.id));
      walkPageCount += 1;
      walkCursor = page.value.nextCursor;
      if (walkCursor === null) break;
    }

    const walkedUnique = new Set(walkedIds);
    const missingCount = expectedIds.filter((row) => !walkedUnique.has(row.id)).length;

    record(
      "the chat cursor pages without SKIPPING a row",
      walkedIds.length === expectedIds.length &&
        walkedUnique.size === expectedIds.length &&
        missingCount === 0,
      `expected=${expectedIds.length} walked=${walkedIds.length} ` +
        `distinct=${walkedUnique.size} missing=${missingCount} pages=${walkPageCount}`,
    );

    // --- Daily logs and the streak.

    const yesterdayLog = await logsService.createDailyLog(projectId, memberId, {
      logDate: isoDaysAgo(1),
      narrative: "Bench-tested the pump.",
    });
    record(
      "a text-only draft log is accepted",
      yesterdayLog.success && yesterdayLog.value.videoSource === "none",
      yesterdayLog.success ? yesterdayLog.value.status : "create failed",
    );

    const duplicateDay = await logsService.createDailyLog(projectId, memberId, {
      logDate: isoDaysAgo(1),
      narrative: "Same day again.",
    });
    record(
      "a second log for the same claimed day is refused",
      !duplicateDay.success && duplicateDay.error.type === "DAILY_LOG_ALREADY_EXISTS",
      duplicateDay.success ? "it was accepted" : duplicateDay.error.type,
    );

    const idempotencyKey = `smoke-${randomUUID()}`;
    const submitted = yesterdayLog.success
      ? await logsService.submitDailyLog(projectId, yesterdayLog.value.id, memberId, idempotencyKey)
      : null;

    // With no GEMINI_API_KEY this is `skipped_unconfigured`; with one it is `queued`. Both
    // are correct, and NEITHER is a verdict — that is the assertion.
    record(
      "submit returns a receipt, never a verdict",
      submitted?.success === true &&
        submitted.value.effortVerificationStatus === "not_run" &&
        ["queued", "skipped_unconfigured"].includes(submitted.value.analysisStatus),
      submitted?.success === true
        ? `analysis=${submitted.value.analysisStatus} verdict=${submitted.value.effortVerificationStatus}`
        : "submit failed",
    );

    record(
      "submitting moves the streak to 1",
      submitted?.success === true && submitted.value.dailyLogStreakDays === 1,
      submitted?.success === true ? `${submitted.value.dailyLogStreakDays}` : "submit failed",
    );

    const replayed = yesterdayLog.success
      ? await logsService.submitDailyLog(projectId, yesterdayLog.value.id, memberId, idempotencyKey)
      : null;
    record(
      "replaying the same idempotency key returns the first receipt",
      replayed?.success === true,
      replayed?.success === true ? "same receipt" : "the replay was refused",
    );

    const frozen = yesterdayLog.success
      ? await logsService.updateDailyLog(projectId, yesterdayLog.value.id, memberId, {
          narrative: "Rewriting history.",
        })
      : null;
    record(
      "a submitted log can no longer be edited",
      frozen?.success === false && frozen.error.type === "DAILY_LOG_ALREADY_SUBMITTED",
      frozen?.success === false ? frozen.error.type : "the edit was accepted",
    );

    // A consecutive day extends the streak; the same call proves the fold runs inside the
    // submit transaction rather than in a job.
    const todayLog = await logsService.createDailyLog(projectId, memberId, {
      logDate: isoDaysAgo(0),
      narrative: "Wired the controller.",
    });
    const todaySubmitted = todayLog.success
      ? await logsService.submitDailyLog(
          projectId,
          todayLog.value.id,
          memberId,
          `smoke-${randomUUID()}`,
        )
      : null;
    record(
      "a consecutive day extends the streak to 2",
      todaySubmitted?.success === true && todaySubmitted.value.dailyLogStreakDays === 2,
      todaySubmitted?.success === true
        ? `${todaySubmitted.value.dailyLogStreakDays}`
        : "submit failed",
    );

    const futureLog = await logsService.createDailyLog(projectId, memberId, {
      logDate: isoDaysAgo(-5),
      narrative: "Work I have not done yet.",
    });
    record(
      "a future-dated log is refused",
      !futureLog.success && futureLog.error.type === "LOG_DATE_IN_FUTURE",
      futureLog.success ? "it was accepted" : futureLog.error.type,
    );
  } finally {
    // Reverse dependency order. The FKs are `restrict` by design (§4f), so anything left
    // behind here would block the next run loudly rather than silently.
    await db.delete(dailyLog).where(eq(dailyLog.projectId, projectId));
    await db.delete(workshopChatMessage).where(eq(workshopChatMessage.projectId, projectId));
    await db.delete(workshopFile).where(eq(workshopFile.projectId, projectId));
    await db.delete(workshopTask).where(eq(workshopTask.projectId, projectId));
    await db.delete(workshopBoardColumn).where(eq(workshopBoardColumn.projectId, projectId));
    await db.delete(projectStats).where(eq(projectStats.projectId, projectId));
    if (memberId !== "") {
      await db.delete(projectMember).where(inArray(projectMember.id, [memberId]));
    }
    await db.delete(researchProject).where(eq(researchProject.id, projectId));
    await db.delete(user).where(eq(user.id, founderUserId));
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${assertions.length} workshop pipeline assertions passed.`
      : `\n${failureCount} of ${assertions.length} workshop pipeline assertions FAILED.`,
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
    console.error("Workshop pipeline smoke test failed to run:", error);
    await stopSendOnlyBoss();
    await pool.end();
    process.exit(1);
  });
