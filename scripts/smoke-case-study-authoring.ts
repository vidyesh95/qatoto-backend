/**
 * Drives the case-study write path against a REAL database.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. Every vitest suite in this repository mocks
 * `#src/db/index.js` wholesale, so no test can prove that the SUBMIT and PUBLISH TRANSACTIONS
 * actually run: that eight tables take their rows in an order the foreign keys accept, that the
 * withheld company name is nulled by the serializer on the way out rather than by a query nobody
 * can express, and that the related-lesson resolver drops an edge whose target is not visible.
 * `db:verify-case-study-constraints` proves the constraints; this proves the code that satisfies
 * them.
 *
 *   submitCaseStudy            → a `pending_review` row, no slug
 *   listMyCaseStudies          → the writer's own row, publicSlug null, AND NO COMPANIES AT ALL
 *   a second study of the name → CASE_STUDY_TITLE_TAKEN, naming nothing
 *   listCaseStudyReviewQueue   → the one route in the router that serves the REAL company name
 *   decideCaseStudy(published) → a slug, and the decision columns landing together
 *   getPublicCaseStudyBySlug   → `name: null`, and the raw bytes swept for the sentinel
 *
 *   pnpm db:smoke-case-study-authoring
 *
 * ⚠️ NO UPLOADS, NO CLOUDINARY, NO JOB QUEUE. Unlike the showcase and hero smokes, this one runs on
 * any development box with a database and nothing else — which is the case-study arm's own shape:
 * it has no files, which is also why it has ONE visibility gate where teardowns have two.
 *
 * ⚠️ THE SENTINEL SWEEP IS THE POINT OF THE FILE. `case-study-withheld-name.test.ts` proves the
 * serializer nulls one column; it cannot prove the name is absent from the WHOLE public payload,
 * because a writer can also name the company in a summary, a step, a tag or a source's publisher
 * label. Here the company is given a name no other string could contain and the serialized public
 * response is searched for it byte by byte, against real rows.
 *
 * CLEANS UP AFTER ITSELF — deleting the case study cascades its seven child tables. The audit
 * entries it appends are NOT deleted; that chain rejects DELETE, which is the guarantee rather than
 * a limitation. Run it against a DEVELOPMENT database.
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { caseStudy, caseStudyStats, user } from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import {
  decideCaseStudy,
  listCaseStudyReviewQueue,
} from "#src/modules/home/blueprints/case-study-moderation.service.js";
import { getPublicCaseStudyBySlug } from "#src/modules/home/blueprints/case-study-public-read.service.js";
import type { CaseStudySubmission } from "#src/modules/home/blueprints/case-study-submission.schemas.js";
import {
  listMyCaseStudies,
  submitCaseStudy,
} from "#src/modules/home/blueprints/case-study-submission.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

/**
 * ⚠️ A NAME NO OTHER STRING IN THE PAYLOAD COULD CONTAIN. The sweep below searches the serialized
 * public response for this exact token, so a name like "Acme" would produce a false pass the moment
 * some unrelated field happened to contain those four letters.
 */
const WITHHELD_COMPANY_NAME = `Zyxwvu-Withheld-Manufacturing-${randomUUID().slice(0, 8)}`;

function buildSubmission(title: string): CaseStudySubmission {
  return {
    title,
    oneLineAction: "Moved the tooling order before the mould was cut.",
    discipline: "tooling",
    sector: "Hardware",
    outcomeSummary: "Shipped eleven weeks earlier than the original plan.",
    authorRelationship: "first_hand",
    summary:
      "A first-hand account of reordering a tooling schedule, written so the constraints and the serializer can both be exercised.",
    problem:
      "The mould was being cut before the enclosure had been frozen, so every revision cost a new steel.",
    context:
      "A two-person hardware team working with one contract manufacturer and a fixed launch window.",
    actionSteps: [
      "Froze the enclosure geometry before releasing the tooling order.",
      "Asked for a soft-tool bridge run while the hard tool was cut.",
    ],
    pitfalls: ["Assuming a quoted lead time starts the day the purchase order is signed."],
    evidenceCompanies: [
      {
        // The withheld one. A moderator sees this; no reader ever does.
        name: WITHHELD_COMPANY_NAME,
        isNameWithheld: true,
        locationLabel: "Shenzhen, China",
        yearLabel: "2025",
      },
    ],
    timelineLabel: "Eleven weeks",
    capitalRaised: { amountInCents: 250000000, currency: "USD" },
    outcomeMetrics: [
      { label: "Weeks saved", value: { kind: "count", amount: 11 } },
      {
        label: "Tooling cost avoided",
        value: { kind: "money", amountInCents: 1800000, currency: "USD" },
      },
    ],
    sources: [
      {
        label: "The purchase order timeline",
        publisherLabel: "Internal records",
        url: "https://example.test/tooling-timeline",
      },
    ],
    relatedLessonSlugs: [],
    tags: ["tooling", "injection-molding"],
    acceptedStatementIds: ["was_part_of_it", "figures_from_records"],
  };
}

async function main(): Promise<void> {
  const runSuffix = randomUUID().slice(0, 8);
  const title = `Freezing the enclosure before cutting steel ${runSuffix}`;
  let caseStudyId: string | undefined;

  try {
    // --- 0. Two accounts. A writer cannot moderate their own study, so the publish half needs two.
    const accounts = await db.select({ id: user.id, name: user.name }).from(user).limit(2);
    const authorRow = accounts[0];
    if (!authorRow) {
      console.error("No user rows exist. Seed an account before running this smoke.");
      process.exit(1);
    }
    const moderatorUserId = accounts[1]?.id ?? authorRow.id;
    const isSelfModerating = moderatorUserId === authorRow.id;

    // --- 1. The submit.
    const submitResult = await submitCaseStudy({
      authorUserId: authorRow.id,
      submission: buildSubmission(title),
    });
    check(
      "a submission lands pending_review",
      submitResult.success && submitResult.value.moderationState === "pending_review",
      submitResult.success ? submitResult.value.submissionId : JSON.stringify(submitResult.error),
    );
    if (!submitResult.success) return;
    // A narrowed local: `caseStudyId` is the outer `string | undefined` the cleanup needs, and
    // every call below wants a `string`.
    const submittedCaseStudyId = submitResult.value.submissionId;
    caseStudyId = submittedCaseStudyId;

    const [submittedRow] = await db
      .select({ publicSlug: caseStudy.publicSlug })
      .from(caseStudy)
      .where(eq(caseStudy.id, submittedCaseStudyId));
    check(
      "a submission carries no public address — a moderator mints one by publishing it",
      submittedRow?.publicSlug === null,
      String(submittedRow?.publicSlug),
    );

    // --- 2. The writer's own list. ⚠️ CARRIES NO COMPANIES AT ALL, so the withheld name reaches
    // one route rather than two.
    const myList = await listMyCaseStudies({
      authorUserId: authorRow.id,
      cursor: undefined,
      limit: 20,
    });
    check(
      "the writer's own list is a cursor page and carries the row",
      myList.success && myList.value.items.some((row) => row.submissionId === submittedCaseStudyId),
      myList.success ? `${String(myList.value.items.length)} rows` : JSON.stringify(myList.error),
    );
    check(
      "the writer's own list carries no companies at all",
      myList.success && !JSON.stringify(myList.value).includes(WITHHELD_COMPANY_NAME),
      "the sentinel is absent from /case-studies/mine",
    );

    // --- 3. The duplicate title, which must name nothing.
    const duplicate = await submitCaseStudy({
      authorUserId: authorRow.id,
      submission: buildSubmission(title),
    });
    check(
      "a second study under the same title is refused",
      !duplicate.success && duplicate.error.type === "CASE_STUDY_TITLE_TAKEN",
      duplicate.success ? "it was ACCEPTED" : duplicate.error.type,
    );
    /*
     * ⚠️ THE REFUSAL NAMES THE FIELD AND NOTHING ELSE, unlike the teardown arm's duplicate-unit 409,
     * which names the clashing survey when it is public or the caller's own. There is no such
     * carve-out here, so echoing anything would be an existence oracle over unpublished work.
     */
    check(
      "and the refusal names no other row",
      !duplicate.success && Object.keys(duplicate.error).length === 1,
      duplicate.success ? "n/a" : JSON.stringify(duplicate.error),
    );

    if (isSelfModerating) {
      console.log(
        "\n  (only one account exists, so the publish half is skipped — it would be self-moderation)",
      );
      return;
    }

    // --- 4. The review queue: the ONE route in the whole router that serves the real name.
    // ⚠️ NOT A `Result`. The capability is resolved by the CONTROLLER before this is reached, so
    // the only failure a queue read has left is a malformed cursor, and this one passes none.
    const queue = await listCaseStudyReviewQueue({
      cursor: undefined,
      limit: 50,
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "the review queue carries the pending study",
      queue.items.some((row) => row.submissionId === submittedCaseStudyId),
      `${String(queue.items.length)} queued`,
    );
    check(
      "the review queue serves the REAL company name — a company nobody can see is a claim nobody can check",
      JSON.stringify(queue).includes(WITHHELD_COMPANY_NAME),
      "the sentinel is present for a moderator",
    );

    // --- 5. The publish.
    const decision = await decideCaseStudy({
      submissionId: submittedCaseStudyId,
      decision: { decision: "published", moderatorNote: null },
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "a publish mints an address",
      decision.success && decision.value.publicSlug !== null,
      decision.success ? String(decision.value.publicSlug) : JSON.stringify(decision.error),
    );
    if (!decision.success || decision.value.publicSlug === null) return;
    const publicSlug = decision.value.publicSlug;

    const [publishedRow] = await db
      .select({
        moderationState: caseStudy.moderationState,
        reviewedByUserId: caseStudy.reviewedByUserId,
        reviewedAt: caseStudy.reviewedAt,
      })
      .from(caseStudy)
      .where(eq(caseStudy.id, submittedCaseStudyId));
    check(
      "the decision columns landed together — state, reviewer and review time",
      publishedRow?.moderationState === "published" &&
        publishedRow.reviewedByUserId === moderatorUserId &&
        publishedRow.reviewedAt !== null,
      `${publishedRow?.moderationState ?? "(absent)"}, reviewed ${publishedRow?.reviewedAt?.toISOString() ?? "(never)"}`,
    );

    /*
     * ⚠️ THE CASE-STUDY ARM MINTS A STATS ROW AND THE SHOWCASE ARM DOES NOT. Both are correct: this
     * one has a two-counter sidecar written at publish, while `showcase_launch_stats` is left-joined
     * and coalesced so a launch with no row and a launch with a row of zeroes are the same answer.
     * Asserted here so the difference is a recorded decision rather than a discovery.
     */
    const [statsRow] = await db
      .select({ viewCount: caseStudyStats.viewCount })
      .from(caseStudyStats)
      .where(eq(caseStudyStats.caseStudyId, submittedCaseStudyId));
    check(
      "publishing minted a stats row — unlike the showcase arm, which mints none",
      statsRow !== undefined,
      statsRow === undefined ? "no row" : `view_count ${String(statsRow.viewCount)}`,
    );

    // --- 6. What the reader gets, and what they must never get.
    const publicResult = await getPublicCaseStudyBySlug(publicSlug);
    check(
      "the published case study is readable at its address",
      publicResult.success,
      publicResult.success ? publicSlug : JSON.stringify(publicResult.error),
    );
    if (!publicResult.success) return;

    const publicCompany = publicResult.value.caseStudy.evidenceCompanies[0];
    check(
      "the withheld company's name is null on the public read",
      publicCompany?.name === null,
      String(publicCompany?.name),
    );
    check(
      "and its location and year survive — the guarantee nulls ONE column, not the company",
      publicCompany?.locationLabel === "Shenzhen, China" && publicCompany.yearLabel === "2025",
      `${publicCompany?.locationLabel ?? "(absent)"} / ${publicCompany?.yearLabel ?? "(absent)"}`,
    );

    /*
     * ⚠️ THE SWEEP. Not "the name column is null" — that is one field, and a writer can also put a
     * company's name in a summary, a step, a tag or a source's publisher label. This searches the
     * whole serialized payload, which is the same technique `case-study-withheld-name.test.ts` uses
     * against mocked rows, applied here to real ones that went through the real write path.
     */
    const serializedPublicPayload = JSON.stringify(publicResult.value);
    check(
      "the sentinel appears NOWHERE in the serialized public payload",
      !serializedPublicPayload.includes(WITHHELD_COMPANY_NAME),
      `${String(serializedPublicPayload.length)} bytes swept`,
    );

    // --- 7. A decision is taken once.
    const secondDecision = await decideCaseStudy({
      submissionId: submittedCaseStudyId,
      decision: { decision: "rejected", moderatorNote: "Changed my mind." },
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "a decided study cannot be decided again",
      !secondDecision.success && secondDecision.error.type === "CASE_STUDY_ALREADY_DECIDED",
      secondDecision.success ? "it was ACCEPTED" : secondDecision.error.type,
    );
  } finally {
    if (caseStudyId !== undefined) {
      // Deleting the case study cascades all seven child tables, including the evidence companies
      // whose composite foreign key is what pins a withheld name to its parent's relationship.
      await db.delete(caseStudy).where(eq(caseStudy.id, caseStudyId));
    }
    await stopSendOnlyBoss();
    await pool.end();
  }

  console.log(
    failureCount === 0
      ? "\nThe case-study write path works end to end, and the withheld name never reached a reader."
      : `\n${String(failureCount)} assertion(s) FAILED.`,
  );
  process.exit(failureCount === 0 ? 0 : 1);
}

void main();
