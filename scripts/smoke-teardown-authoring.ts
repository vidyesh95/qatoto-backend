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
import {
  teardown,
  teardownSubmission,
  teardownSubmissionFileUpload,
  user,
} from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { isObjectStorageConfigured } from "#src/lib/object-storage.js";
import { decideTeardown } from "#src/modules/home/blueprints/teardown-moderation.service.js";
import {
  getPublicTeardownBySlug,
  resolveDownloadableTeardownFile,
} from "#src/modules/home/blueprints/teardown-public-read.service.js";
import type { TeardownSubmissionInput } from "#src/modules/home/blueprints/teardown-submission.schemas.js";
import {
  listMyTeardowns,
  submitTeardown,
} from "#src/modules/home/blueprints/teardown-submission.service.js";
import { uploadTeardownSubmissionFile } from "#src/modules/home/blueprints/teardown-upload.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

/** A minimal PDF that clears `validatePdfBytes`' own 512-byte floor. */
function buildSmokePdfBytes(): Buffer {
  const lines = [
    "%PDF-1.7",
    "1 0 obj",
    "<< /Type /Catalog >>",
    "endobj",
    ...Array.from({ length: 80 }, () => "% padding"),
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
  ];
  return Buffer.from(lines.join("\n") + "\n", "latin1");
}

function buildSubmission(
  subjectProductName: string,
  uploadedUploadId: string | undefined,
): TeardownSubmissionInput {
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
      /*
       * ⚠️ THE UPLOADED ARM, PRESENT ONLY WHEN STORAGE IS CONFIGURED. It carries an upload id and
       * NO url: the address of an uploaded file does not exist until a moderator publishes the
       * submission that claims it.
       */
      ...(uploadedUploadId === undefined
        ? []
        : [
            {
              source: "uploaded" as const,
              kind: "datasheet" as const,
              title: "Controller datasheet",
              uploadId: uploadedUploadId,
            },
          ]),
      {
        source: "pasted_link" as const,
        kind: "schematic",
        title: "Control board schematic",
        url: "https://files.example.com/drill-schematic.pdf",
      },
      // What the frontend actually sends today: a fab label in the documents array.
      {
        source: "pasted_link" as const,
        kind: "gerber",
        title: "Board gerbers",
        url: "https://files.example.com/drill-gerbers.zip",
      },
    ],
    manufacturingFiles: [
      {
        source: "pasted_link" as const,
        kind: "step",
        title: "Housing STEP",
        url: "https://files.example.com/housing.step",
      },
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
  let uploadedUploadId: string | undefined;

  try {
    /*
     * --- 0. THE UPLOAD, BEFORE ANY SUBMISSION EXISTS.
     *
     * ⚠️ THIS HALF IS SKIPPED WITHOUT OBJECT STORAGE, and skipped LOUDLY rather than silently
     * passing: a run that quietly dropped the only assertions proving a quarantine withholds bytes
     * would be worse than one that says it could not check.
     */
    const storageConfigured = isObjectStorageConfigured();
    if (!storageConfigured) {
      console.log("\n  (object storage is not configured — the upload half is skipped)");
    }

    if (storageConfigured) {
      const uploadResult = await uploadTeardownSubmissionFile({
        uploaderUserId: authorRow.id,
        declaredFormat: "pdf",
        fileBytes: buildSmokePdfBytes(),
        originalFileName: "controller-datasheet.pdf",
      });
      check(
        "a file uploads before any submission exists",
        uploadResult.success,
        uploadResult.success ? uploadResult.value.uploadId : JSON.stringify(uploadResult.error),
      );
      if (!uploadResult.success) return;
      uploadedUploadId = uploadResult.value.uploadId;

      const [unclaimedRow] = await db
        .select({ submissionId: teardownSubmissionFileUpload.submissionId })
        .from(teardownSubmissionFileUpload)
        .where(eq(teardownSubmissionFileUpload.id, uploadedUploadId));
      check(
        "and it is UNCLAIMED — submission_id is NULL until a submit names it",
        unclaimedRow?.submissionId === null,
        String(unclaimedRow?.submissionId),
      );

      /*
       * ⚠️ A RE-UPLOAD OF THE SAME BYTES CONVERGES RATHER THAN DUPLICATING, which is why this route
       * carries no idempotency key. The object key is content-addressed and the column is unique.
       */
      const repeatResult = await uploadTeardownSubmissionFile({
        uploaderUserId: authorRow.id,
        declaredFormat: "pdf",
        fileBytes: buildSmokePdfBytes(),
        originalFileName: "controller-datasheet.pdf",
      });
      check(
        "re-uploading the same bytes converges on the same row, rather than a 409",
        repeatResult.success && repeatResult.value.uploadId === uploadedUploadId,
        repeatResult.success ? repeatResult.value.uploadId : JSON.stringify(repeatResult.error),
      );

      /* A file the author does not own cannot be claimed — proven at submit, below. */
    }

    // --- 1. The submit.
    const submitResult = await submitTeardown({
      authorUserId: authorRow.id,
      submission: buildSubmission(subjectProductName, uploadedUploadId),
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
      submission: buildSubmission(` ${subjectProductName.toUpperCase()} `, undefined),
    });
    check(
      "a second live survey of the same unit is refused",
      !duplicateResult.success &&
        duplicateResult.error.type === "TEARDOWN_SUBJECT_ALREADY_SURVEYED",
      duplicateResult.success ? "it was ACCEPTED" : duplicateResult.error.type,
    );
    /*
     * ⚠️ NARROWED ON `type` BEFORE READING `existingTitle`. `TeardownSubmitError` became a union
     * when uploads landed, and the other arm carries no such field — so the check that used to read
     * the property directly now has to say which arm it means.
     */
    const namedOwnSurvey =
      !duplicateResult.success &&
      duplicateResult.error.type === "TEARDOWN_SUBJECT_ALREADY_SURVEYED" &&
      duplicateResult.error.existingTitle !== null;
    check(
      "and the refusal names the caller's own survey",
      namedOwnSurvey,
      namedOwnSurvey ? "named" : "not named",
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
    /*
     * The schematic is a reader's document and is filed as one. The count varies with whether the
     * upload half ran, so this asserts the ROUTING rather than a total — which is what the
     * assertion was always about.
     */
    const schematicDocument = publicTeardown.documents.find(
      (document) => document.kind === "schematic",
    );
    check(
      "a reader's document is filed as a document",
      schematicDocument !== undefined,
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
    /*
     * ⚠️ TARGETED AT THE PASTED ROW, NOT AT `documents[0]`. Once the uploaded arm exists the two
     * kinds sit in one array with different honest answers: an upload measured its bytes, a pasted
     * link never did. Indexing would have made this assertion depend on insertion order and quietly
     * start reading the wrong row — §3.3's NULL is a claim about PASTED links specifically.
     */
    check(
      "no byte size was invented for a pasted link",
      schematicDocument?.byteSize === null,
      String(schematicDocument?.byteSize),
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

    /*
     * --- 6b. THE UPLOADED FILE, AND THE PAIR NO VITEST CAN PROVE.
     *
     * ⚠️ THIS IS THE POINT OF THE WHOLE FEATURE. Before uploads, a quarantine could only stop
     * ADVERTISING a file — the bytes sat on somebody else's host and stayed live for anyone who had
     * saved the link. An uploaded file's only address is a route that consults the LIST gate on
     * every request, so the moment a teardown is quarantined the bytes stop being reachable at any
     * address anyone holds. These four assertions are that claim, against a real database.
     */
    if (uploadedUploadId !== undefined && publishedTeardownId !== undefined) {
      const [claimedRow] = await db
        .select({ submissionId: teardownSubmissionFileUpload.submissionId })
        .from(teardownSubmissionFileUpload)
        .where(eq(teardownSubmissionFileUpload.id, uploadedUploadId));
      check(
        "the submit CLAIMED the upload the document named",
        claimedRow?.submissionId === submissionId,
        String(claimedRow?.submissionId),
      );

      const uploadedDocument = publicTeardown.documents.find(
        (document) => document.title === "Controller datasheet",
      );
      check(
        "the published document's address is a route on this server, not a stored link",
        uploadedDocument?.url.startsWith(`/blueprints/teardowns/${publicSlug}/documents/`) === true,
        String(uploadedDocument?.url),
      );
      check(
        "and the publish copied the MEASURED byte size the upload recorded",
        typeof uploadedDocument?.byteSize === "number" && uploadedDocument.byteSize > 0,
        String(uploadedDocument?.byteSize),
      );
      /*
       * ⚠️ THE OBJECT KEY NEVER REACHES THE WIRE — it describes our bucket layout and embeds the
       * uploader's account id. Asserted against the STORED key rather than against a substring:
       * the first spelling of this check looked for "teardowns/" and failed on the route address
       * itself, which legitimately contains it. A test that cannot tell the address from the key
       * is not testing the thing it names.
       */
      const [storedKeyRow] = await db
        .select({ objectStorageKey: teardownSubmissionFileUpload.objectStorageKey })
        .from(teardownSubmissionFileUpload)
        .where(eq(teardownSubmissionFileUpload.id, uploadedUploadId));
      const storedKey = storedKeyRow?.objectStorageKey ?? "";
      const payloadJson = JSON.stringify(publicTeardown);
      check(
        "and the object key is absent from the whole public payload",
        storedKey.length > 0 && !payloadJson.includes(storedKey),
        payloadJson.includes(storedKey) ? "THE KEY LEAKED" : "absent",
      );
      check(
        "and so is the uploader's account id, which the key embeds",
        !payloadJson.includes(authorRow.id),
        payloadJson.includes(authorRow.id) ? "THE UPLOADER ID LEAKED" : "absent",
      );

      const documentId = uploadedDocument?.url.split("/").at(-1) ?? "";
      const beforeQuarantine = await resolveDownloadableTeardownFile({
        teardownSlug: publicSlug,
        fileId: documentId,
        segment: "documents",
      });
      check(
        "the download gate resolves the file while the teardown is published",
        beforeQuarantine !== null,
        beforeQuarantine === null ? "refused" : "resolved",
      );

      /*
       * ⚠️ A FILE ON ANOTHER TEARDOWN IS REFUSED — the composite check that stops one teardown's
       * slug being used to reach another's files.
       */
      const crossTeardown = await resolveDownloadableTeardownFile({
        teardownSlug: publicSlug,
        fileId: randomUUID(),
        segment: "documents",
      });
      check(
        "a file id that does not belong to this teardown is refused",
        crossTeardown === null,
        crossTeardown === null ? "refused" : "RESOLVED, which is a leak",
      );

      await db
        .update(teardown)
        .set({ moderationState: "quarantined" })
        .where(eq(teardown.id, publishedTeardownId));
      const duringQuarantine = await resolveDownloadableTeardownFile({
        teardownSlug: publicSlug,
        fileId: documentId,
        segment: "documents",
      });
      check(
        "A QUARANTINE STOPS THE BYTES BEING REACHABLE — no presign is mintable at any address",
        duringQuarantine === null,
        duringQuarantine === null ? "refused, as designed" : "STILL RESOLVED — the gate is open",
      );

      const quarantinedRead = await getPublicTeardownBySlug(publicSlug);
      check(
        "and the page still answers, with its documents withheld",
        quarantinedRead.success && quarantinedRead.value.documents.length === 0,
        quarantinedRead.success
          ? `${String(quarantinedRead.value.documents.length)} documents`
          : "the read failed",
      );

      await db
        .update(teardown)
        .set({ moderationState: "published" })
        .where(eq(teardown.id, publishedTeardownId));
    }

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
