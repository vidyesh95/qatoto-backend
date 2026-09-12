/**
 * Drives the teardown write path against a REAL database.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. Every vitest suite in this repository mocks
 * `#src/db/index.js` wholesale, so no test can prove that the PUBLISH TRANSACTION actually runs:
 * that a submission's document survives a round trip through a `text` column, that the ten public
 * tables take their rows in an order the foreign keys accept, that the slug minter's savepoint loop
 * leaves the outer transaction usable, and that what comes back out of the public read is what the
 * author sent. `db:verify-teardown-constraints` proves the constraints; this proves the code that
 * has to satisfy them.
 *
 *   submitTeardown              → a `pending_review` row, no teardown, no slug
 *   listMyTeardowns             → the author's own row, publicSlug null
 *   a second survey of the unit → TEARDOWN_SUBJECT_ALREADY_SURVEYED
 *   decideTeardown(published)   → a teardown row, its stats, its parts listing, its files
 *   getPublicTeardown(slug)     → the parts the author listed, and the files routed by their label
 *   listMyTeardowns             → the same row, now `published`, now carrying the slug
 *
 *   pnpm db:smoke-teardown-authoring
 *
 * CLEANS UP AFTER ITSELF. Unlike the funding smoke, nothing here is append-only: deleting the
 * teardown cascades its children and deleting the submission takes the paperwork. The audit entries
 * it appends are NOT deleted — that chain rejects DELETE, which is the guarantee rather than a
 * limitation. Run it against a DEVELOPMENT database.
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { teardown, teardownSubmission, user } from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { decideTeardown } from "#src/modules/home/blueprints/teardown-moderation.service.js";
import { getPublicTeardownBySlug } from "#src/modules/home/blueprints/teardown-public-read.service.js";
import type { TeardownSubmissionInput } from "#src/modules/home/blueprints/teardown-submission.schemas.js";
import {
  listMyTeardowns,
  submitTeardown,
} from "#src/modules/home/blueprints/teardown-submission.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

function buildSubmission(subjectProductName: string): TeardownSubmissionInput {
  return {
    subjectKind: "existing_physical_product",
    title: "Inside a supermarket cordless drill",
    summary:
      "Eleven fasteners, two of them hidden under the label, and a gearbox that comes out in one piece.",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName,
      unitAcquisition: "retail_purchase",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-01-05T12:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-01-06T09:00:00.000Z",
      notes: null,
    },
    materials: [
      {
        appliesToLabel: "Gearbox housing",
        partId: null,
        designation: "PA66-GF30",
        designationSource: "contributor_freetext",
        materialClass: "polymer",
        process: "injection_molded",
        finish: null,
        elements: [],
      },
    ],
    parts: [
      { label: "Gearbox housing", material: "Glass-filled nylon" },
      { label: "Trigger", material: "ABS" },
    ],
    // One of each vocabulary, so the publish's routing by label is exercised in both directions.
    documents: [
      {
        kind: "schematic",
        title: "Control board schematic",
        url: "https://files.example.com/drill-schematic.pdf",
      },
      // What the frontend actually sends today: a fab label in the documents array.
      {
        kind: "gerber",
        title: "Board gerbers",
        url: "https://files.example.com/drill-gerbers.zip",
      },
    ],
    manufacturingFiles: [
      { kind: "step", title: "Housing STEP", url: "https://files.example.com/housing.step" },
    ],
    walkthroughVideo: {
      source: "youtube",
      youtubeVideoId: "dQw4w9WgXcQ",
      // Deliberately wrong, to prove the publish rebuilds it rather than storing what it was given.
      posterUrl: "https://images.evil.test/not-the-poster.jpg",
      durationSeconds: null,
    },
    tags: ["power-tools"],
    acceptedAttestationClauseIds: [
      "lawful_acquisition",
      "own_measurement",
      "no_confidential_material",
      "independent_discovery",
    ],
  };
}

async function main(): Promise<void> {
  const runSuffix = randomUUID().slice(0, 8);
  const subjectProductName = `Rotel RD-18 smoke ${runSuffix}`;

  const [authorRow] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .orderBy(user.createdAt)
    .limit(1);
  const [moderatorRow] = await db
    .select({ id: user.id })
    .from(user)
    .orderBy(user.createdAt)
    .limit(2);

  if (!authorRow || !moderatorRow) {
    console.error("This script needs at least one account. Sign someone up first.");
    process.exitCode = 1;
    return;
  }

  // The author and the moderator must differ, or the self-moderation refusal fires.
  const [, secondUserRow] = await db
    .select({ id: user.id })
    .from(user)
    .orderBy(user.createdAt)
    .limit(2);
  const moderatorUserId = secondUserRow?.id ?? authorRow.id;
  const isSelfModerating = moderatorUserId === authorRow.id;

  let submissionId: string | undefined;
  let publishedTeardownId: string | undefined;

  try {
    // --- 1. The submit.
    const submitResult = await submitTeardown({
      authorUserId: authorRow.id,
      submission: buildSubmission(subjectProductName),
    });
    check(
      "a submission is accepted and lands pending_review",
      submitResult.success && submitResult.value.moderationState === "pending_review",
      submitResult.success ? submitResult.value.submissionId : JSON.stringify(submitResult.error),
    );
    if (!submitResult.success) return;
    submissionId = submitResult.value.submissionId;

    const [storedSubmission] = await db
      .select()
      .from(teardownSubmission)
      .where(eq(teardownSubmission.id, submissionId));
    check(
      "the submission creates no teardown and no address",
      storedSubmission?.publishedTeardownId === null,
      `published_teardown_id ${String(storedSubmission?.publishedTeardownId)}`,
    );
    check(
      "the promoted unit name is normalised by the database",
      storedSubmission?.subjectProductNameNormalized === subjectProductName.toLowerCase(),
      String(storedSubmission?.subjectProductNameNormalized),
    );

    // --- 2. The author's own list, before any decision.
    const pendingList = await listMyTeardowns({ authorUserId: authorRow.id });
    const pendingRow = pendingList.find((row) => row.submissionId === submissionId);
    check(
      "the author's list carries the row with no slug",
      pendingRow?.moderationState === "pending_review" && pendingRow.publicSlug === null,
      `${String(pendingRow?.moderationState)}, slug ${String(pendingRow?.publicSlug)}`,
    );

    // --- 3. One live survey per unit.
    const duplicateResult = await submitTeardown({
      authorUserId: authorRow.id,
      submission: buildSubmission(` ${subjectProductName.toUpperCase()} `),
    });
    check(
      "a second live survey of the same unit is refused",
      !duplicateResult.success &&
        duplicateResult.error.type === "TEARDOWN_SUBJECT_ALREADY_SURVEYED",
      duplicateResult.success ? "it was ACCEPTED" : duplicateResult.error.type,
    );
    check(
      "and the refusal names the caller's own survey",
      !duplicateResult.success && duplicateResult.error.existingTitle !== null,
      duplicateResult.success ? "n/a" : String(duplicateResult.error.existingTitle),
    );

    if (isSelfModerating) {
      console.log(
        "\n  (only one account exists, so the publish half is skipped — it would be self-moderation)",
      );
      return;
    }

    // --- 4. The publish.
    const decisionResult = await decideTeardown({
      submissionId,
      decision: {
        decision: "published",
        moderatorNote: null,
        thumbnailUrl: "https://images.example.com/drill.webp",
        difficulty: "intermediate",
        desiredSlug: `inside-a-supermarket-drill-${runSuffix}`,
      },
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "a publish mints an address",
      decisionResult.success && decisionResult.value.publicSlug !== null,
      decisionResult.success
        ? String(decisionResult.value.publicSlug)
        : JSON.stringify(decisionResult.error),
    );
    if (!decisionResult.success || decisionResult.value.publicSlug === null) return;

    const publicSlug = decisionResult.value.publicSlug;
    const [publishedSubmission] = await db
      .select()
      .from(teardownSubmission)
      .where(eq(teardownSubmission.id, submissionId));
    publishedTeardownId = publishedSubmission?.publishedTeardownId ?? undefined;
    check(
      "the paperwork now names the teardown it produced",
      publishedTeardownId !== undefined,
      String(publishedTeardownId),
    );

    // --- 5. What the reader gets.
    const publicResult = await getPublicTeardownBySlug(publicSlug);
    check(
      "the published teardown is readable at its address",
      publicResult.success,
      publicResult.success ? publicSlug : JSON.stringify(publicResult.error),
    );
    if (!publicResult.success) return;

    const publicTeardown = publicResult.value;
    check(
      "the author's parts list survived publication",
      publicTeardown.partsList.length === 2 &&
        publicTeardown.partsList[0]?.label === "Gearbox housing",
      `${String(publicTeardown.partsList.length)} listed parts`,
    );
    check(
      "a reader's document is filed as a document",
      publicTeardown.documents.length === 1 && publicTeardown.documents[0]?.kind === "schematic",
      `${String(publicTeardown.documents.length)} documents`,
    );
    /*
     * ⚠️ TWO, NOT ONE. The wizard sent a `gerber` inside `documents[]` — the frontend contract bug —
     * and the publish files each file by its OWN label rather than by the array it arrived in. That
     * gerber lands here beside the STEP file, where a backfill can move it if the frontend is fixed.
     */
    check(
      "a fab file sent in documents[] is filed by its own label",
      publicTeardown.manufacturingFiles.length === 2,
      `${String(publicTeardown.manufacturingFiles.length)} manufacturing files`,
    );
    check(
      "no byte size was invented for a pasted link",
      publicTeardown.documents[0]?.byteSize === null,
      String(publicTeardown.documents[0]?.byteSize),
    );
    check(
      "the walkthrough poster was rebuilt, not stored as sent",
      publicTeardown.walkthroughVideo?.posterUrl ===
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      String(publicTeardown.walkthroughVideo?.posterUrl),
    );
    check(
      "the byline is the account's, snapshotted at publish",
      publicTeardown.author.displayName === authorRow.name,
      publicTeardown.author.displayName,
    );
    check(
      "the author's own tally was not invented from the parts list",
      publicTeardown.partCount === null,
      String(publicTeardown.partCount),
    );
    check(
      "the material came across with no part to attach to",
      publicTeardown.materials.length === 1 && publicTeardown.materials[0]?.partId === null,
      `${String(publicTeardown.materials.length)} materials`,
    );

    // --- 6. The author's list, after.
    const publishedList = await listMyTeardowns({ authorUserId: authorRow.id });
    const publishedRow = publishedList.find((row) => row.submissionId === submissionId);
    check(
      "the author's list now carries the address",
      publishedRow?.moderationState === "published" && publishedRow.publicSlug === publicSlug,
      `${String(publishedRow?.moderationState)}, slug ${String(publishedRow?.publicSlug)}`,
    );

    // --- 7. A decision is taken once.
    const secondDecision = await decideTeardown({
      submissionId,
      decision: { decision: "rejected", moderatorNote: "Changed my mind." },
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "a decided submission cannot be decided again",
      !secondDecision.success && secondDecision.error.type === "TEARDOWN_ALREADY_DECIDED",
      secondDecision.success ? "it was ACCEPTED" : secondDecision.error.type,
    );
  } finally {
    /*
     * The teardown first: `teardown_submission.published_teardown_id` is `set null`, and the
     * decision CHECK reads `(moderation_state = 'published') = (published_teardown_id IS NOT NULL)`
     * — so deleting the teardown under a published row would raise 23514. The submission goes first
     * for the same reason erasure must take it first.
     */
    if (submissionId !== undefined) {
      await db.delete(teardownSubmission).where(eq(teardownSubmission.id, submissionId));
    }
    if (publishedTeardownId !== undefined) {
      await db.delete(teardown).where(eq(teardown.id, publishedTeardownId));
    }
    console.log("\n  (rows removed; the audit entries stay, because that chain refuses DELETE)");
  }
}

main()
  .then(async () => {
    await stopSendOnlyBoss();
    await pool.end();
    if (failureCount > 0) process.exitCode = 1;
    console.log(
      failureCount === 0
        ? "\nTeardown authoring smoke passed."
        : `\n${String(failureCount)} FAILED.`,
    );
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Teardown authoring smoke failed to run:", error);
    await stopSendOnlyBoss();
    await pool.end();
    process.exit(1);
  });
