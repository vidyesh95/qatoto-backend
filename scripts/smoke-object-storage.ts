/**
 * Smoke test for `src/lib/object-storage.ts` against the REAL Backblaze B2 bucket.
 *
 * WHY THIS EXISTS SEPARATELY from `db:smoke-research-programs`. This module is the one
 * piece of §10 that talks to a third party, and it is the only non-image byte storage in
 * the codebase — so it is the piece most likely to be misconfigured, and the piece whose
 * failure is least obvious from a green typecheck. A signed request that B2 rejects
 * because of path style, region derivation or key scope compiles perfectly.
 *
 * What it proves, in order, on bytes that are a real minimal PDF:
 *
 *   1. `validatePdfBytes` accepts a genuine PDF and rejects a renamed HTML page — the
 *      check that matters, since the multipart mimetype is a client's claim.
 *   2. A PUT succeeds and is content-addressed at the key `paperObjectKey` predicts.
 *   3. `ChecksumSHA256` is enforced end to end: a PUT whose declared hash disagrees with
 *      its bytes FAILS, rather than storing bad bytes under a key that describes them.
 *   4. A presigned GET actually fetches the same bytes back, byte-for-byte — which is the
 *      claim a private bucket plus a signed link rests on.
 *   5. Re-uploading identical bytes overwrites in place rather than creating a second
 *      object (the retry-idempotency the unique index assumes).
 *   6. DELETE removes it, and deleting an already-absent key still succeeds.
 *
 *   pnpm db:smoke-object-storage
 *
 * Touches NO database table and needs no worker. With the BLACKBLAZE_* variables unset it
 * asserts the NOT_CONFIGURED path instead and exits 0 — an unconfigured developer machine
 * is a supported configuration, not a failure.
 *
 * Exits non-zero on any failed assertion. Cleans up the object it created even on failure.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";

import {
  deleteResearchPaper,
  isObjectStorageConfigured,
  paperObjectKey,
  presignPaperDownload,
  uploadResearchPaper,
} from "#src/lib/object-storage.js";
import { isPdfValidationError, validatePdfBytes } from "#src/lib/pdf.js";

interface Assertion {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];

function check(label: string, passed: boolean, detail: string): void {
  assertions.push({ label, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${label} — ${detail}`);
}

/**
 * A syntactically real, minimal PDF, padded past `MIN_PAPER_BYTES`.
 *
 * Built here rather than committed as a fixture so this script has no binary asset to
 * keep in sync, and padded inside a COMMENT (`%`) so the padding cannot be mistaken for
 * document structure by anything that later parses it.
 */
function buildMinimalPdf(): Buffer {
  const body = [
    "%PDF-1.7",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
    "trailer<</Root 1 0 R>>",
    `% padding ${"q".repeat(600)}`,
    "%%EOF",
    "",
  ].join("\n");
  return Buffer.from(body, "ascii");
}

async function main(): Promise<void> {
  const pdfBytes = buildMinimalPdf();
  const contentSha256 = createHash("sha256").update(pdfBytes).digest("hex");
  // A disposable program id, so a smoke run can never collide with a real program's
  // prefix in the bucket.
  const programId = `smoke-${randomUUID()}`;
  const expectedKey = paperObjectKey(programId, contentSha256);

  console.log("\n--- 1. PDF byte validation ---");

  const validPdf = validatePdfBytes(pdfBytes);
  check(
    "a real PDF validates",
    !isPdfValidationError(validPdf) && validPdf.version === "1.7",
    isPdfValidationError(validPdf) ? `rejected as ${validPdf.type}` : `version ${validPdf.version}`,
  );

  // The case the mimetype check cannot catch: a client is free to label anything
  // `application/pdf`, so this is the check that actually decides.
  const htmlPretendingToBePdf = Buffer.from(
    `<!doctype html><title>not a paper</title>${"<p>x</p>".repeat(200)}`,
    "ascii",
  );
  const rejectedHtml = validatePdfBytes(htmlPretendingToBePdf);
  check(
    "HTML renamed .pdf is rejected on its bytes",
    isPdfValidationError(rejectedHtml) && rejectedHtml.type === "NOT_A_PDF",
    isPdfValidationError(rejectedHtml) ? rejectedHtml.type : "accepted — WRONG",
  );

  const truncated = validatePdfBytes(pdfBytes.subarray(0, pdfBytes.length - 8));
  check(
    "a PDF cut off in transit is rejected as TRUNCATED",
    isPdfValidationError(truncated) && truncated.type === "TRUNCATED",
    isPdfValidationError(truncated) ? truncated.type : "accepted — WRONG",
  );

  if (!isObjectStorageConfigured()) {
    console.log("\n--- 2-6. SKIPPED: no BLACKBLAZE_* credentials configured ---");
    console.log("    This is a supported configuration. Asserting the 503 path instead.");

    const unconfiguredUpload = await uploadResearchPaper({
      programId,
      contentSha256,
      pdfBytes,
      downloadFileName: "smoke",
    });
    check(
      "an unconfigured upload answers NOT_CONFIGURED rather than throwing",
      !unconfiguredUpload.success && unconfiguredUpload.error.type === "NOT_CONFIGURED",
      unconfiguredUpload.success ? "uploaded — WRONG" : unconfiguredUpload.error.type,
    );

    report();
    return;
  }

  console.log("\n--- 2. Content-addressed PUT ---");

  const uploaded = await uploadResearchPaper({
    programId,
    contentSha256,
    pdfBytes,
    // Deliberately hostile: a quote and a CRLF would inject a header if unsanitized.
    downloadFileName: 'Smoke "Paper"\r\nX-Injected: yes',
  });
  check(
    "upload succeeds",
    uploaded.success,
    uploaded.success ? uploaded.value.objectKey : `${uploaded.error.type}: ${describe(uploaded)}`,
  );
  if (!uploaded.success) {
    report();
    return;
  }
  check(
    "the key is the one paperObjectKey predicts",
    uploaded.value.objectKey === expectedKey,
    `${uploaded.value.objectKey} vs ${expectedKey}`,
  );

  try {
    console.log("\n--- 3. Checksum enforcement ---");

    // The declared hash is of DIFFERENT bytes. B2 must refuse the PUT; if it stores it,
    // the content-addressed key is a lie and the dedup index is defeated.
    const mismatched = await uploadResearchPaper({
      programId,
      contentSha256: createHash("sha256").update("different bytes").digest("hex"),
      pdfBytes,
      downloadFileName: "smoke-mismatch",
    });
    check(
      "a PUT whose declared sha256 disagrees with its bytes is REFUSED",
      !mismatched.success && mismatched.error.type === "UPLOAD_FAILED",
      mismatched.success ? "stored — WRONG, dedup is defeated" : mismatched.error.type,
    );

    console.log("\n--- 4. Presigned download round-trip ---");

    const presigned = await presignPaperDownload(uploaded.value.objectKey);
    check(
      "presigning succeeds and expires",
      presigned.success && presigned.value.expiresInSeconds === 300,
      presigned.success ? `ttl ${String(presigned.value.expiresInSeconds)}s` : presigned.error.type,
    );

    if (presigned.success) {
      const fetched = await fetch(presigned.value.downloadUrl);
      const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
      check(
        "the presigned URL returns the bytes we stored, unchanged",
        fetched.ok && fetchedBytes.equals(pdfBytes),
        `HTTP ${String(fetched.status)}, ${String(fetchedBytes.length)} of ${String(pdfBytes.length)} bytes, sha match ${String(
          createHash("sha256").update(fetchedBytes).digest("hex") === contentSha256,
        )}`,
      );
      check(
        "the stored object is served as an attachment, not rendered inline",
        (fetched.headers.get("content-disposition") ?? "").startsWith("attachment"),
        fetched.headers.get("content-disposition") ?? "(no header)",
      );
      check(
        "the injected header did not survive sanitization",
        fetched.headers.get("x-injected") === null,
        fetched.headers.get("x-injected") ?? "absent",
      );
    }

    console.log("\n--- 5. Retry idempotency ---");

    const reuploaded = await uploadResearchPaper({
      programId,
      contentSha256,
      pdfBytes,
      downloadFileName: "smoke-retry",
    });
    check(
      "re-uploading identical bytes overwrites in place at the same key",
      reuploaded.success && reuploaded.value.objectKey === expectedKey,
      reuploaded.success ? reuploaded.value.objectKey : reuploaded.error.type,
    );
  } finally {
    console.log("\n--- 6. Delete ---");

    const deleted = await deleteResearchPaper(uploaded.value.objectKey);
    check("delete succeeds", deleted.success, deleted.success ? "removed" : deleted.error.type);

    const deletedAgain = await deleteResearchPaper(uploaded.value.objectKey);
    check(
      "deleting an already-absent key still succeeds (the end state is what matters)",
      deletedAgain.success,
      deletedAgain.success ? "idempotent" : deletedAgain.error.type,
    );
  }

  report();
}

function describe(result: { success: false; error: { type: string; cause?: string } }): string {
  return result.error.cause ?? "";
}

function report(): void {
  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(assertions.length)} object-storage assertions passed.`
      : `\n${String(failureCount)} of ${String(assertions.length)} object-storage assertions FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("Object-storage smoke test failed to run:", error);
  process.exit(1);
});
