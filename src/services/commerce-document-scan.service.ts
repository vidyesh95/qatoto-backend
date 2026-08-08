import { and, eq, lt, sql } from "drizzle-orm";

import {
  resolveDocumentScanner,
  type DocumentScanVerdict,
} from "#src/adapters/document-scanner.adapter.js";
import { db } from "#src/db/index.js";
import { commerceEncryptedDocument, commerceOrganizationVerification } from "#src/db/schema.js";
import { decryptCommerceDocument } from "#src/lib/commerce-document-encryption.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import { errorFields, logger } from "#src/lib/logger.js";
import { downloadPrivateCommerceDocument } from "#src/lib/object-storage.js";
import type { Result } from "#src/types/index.js";

/**
 * Automated malware scanning for private commerce documents (STORE Phase 14b).
 *
 * ## What this fixes
 *
 * A18's customization artwork, Phase 0's verification evidence and Phase 12's certificates
 * all land `pending_scan`, and before this service only ONE of the three could ever leave
 * that state. `recordDocumentScannerVerdict` requires a pending
 * `commerce_organization_verification` row referencing the document, which artwork and
 * certificates never have — so a product with a required upload slot could not be checked
 * out by anyone, because `resolveCustomizationSelections` refuses anything not `available`.
 *
 * THIS PROMOTES BY DOCUMENT KIND, not by walking a verification row. That is the whole
 * correction: whether a file is malware has nothing to do with which workflow attached it.
 *
 * ## What it deliberately does not do
 *
 * Promoting to `available` means "not malware". It is NOT an approval. A verification is
 * still approved by a moderator and a certificate is still reviewed; this only unblocks the
 * document from being attachable at all. The manual `recordDocumentScannerVerdict` path
 * stays exactly as it was, as the human override.
 */

export type CommerceDocumentScanError =
  | { type: "DOCUMENT_NOT_FOUND" }
  | { type: "DOCUMENT_NOT_PENDING"; state: string }
  | { type: "SCANNER_UNAVAILABLE"; reason: string }
  | { type: "STORAGE_UNAVAILABLE"; reason: string }
  | { type: "DECRYPTION_FAILED" };

export interface DocumentScanOutcome {
  readonly documentId: string;
  readonly verdict: DocumentScanVerdict;
  readonly state: "available" | "quarantined" | "pending_scan";
}

/**
 * How long a document may sit unscanned before the sweep re-enqueues it.
 *
 * Two minutes, not two hours: the buyer who uploaded artwork is trying to place an order
 * right now, and a lost enqueue that costs them an hour is indistinguishable from the bug
 * this phase fixed.
 */
const RESCAN_AFTER_MS = 2 * 60 * 1000;

/**
 * Downloads, decrypts in memory, scans, and records the verdict.
 *
 * THE PLAINTEXT NEVER TOUCHES DISK and is never logged. It exists as a Buffer for the
 * duration of one scan because a scanner cannot read ciphertext — every encrypted byte is
 * uniform noise, so a scanner pointed at the stored object would call every file clean.
 */
export async function scanEncryptedDocument(
  documentId: string,
): Promise<Result<DocumentScanOutcome, CommerceDocumentScanError>> {
  const [document] = await db
    .select()
    .from(commerceEncryptedDocument)
    .where(eq(commerceEncryptedDocument.id, documentId))
    .limit(1);
  if (!document) return { success: false, error: { type: "DOCUMENT_NOT_FOUND" } };

  if (document.state !== "pending_scan") {
    /**
     * Not an error worth retrying. A redelivered job for a document a human already ruled
     * on must not re-open that decision — least of all re-promote something quarantined.
     */
    return {
      success: true,
      value: {
        documentId,
        verdict: document.state === "available" ? "clean" : "unscannable",
        state: document.state === "available" ? "available" : "pending_scan",
      },
    };
  }

  const scannerResolved = resolveDocumentScanner();
  if (!scannerResolved.success) {
    return {
      success: false,
      error: { type: "SCANNER_UNAVAILABLE", reason: scannerResolved.error.reason },
    };
  }

  const downloaded = await downloadPrivateCommerceDocument(document.objectStorageKey);
  if (!downloaded.success) {
    return {
      success: false,
      error: { type: "STORAGE_UNAVAILABLE", reason: downloaded.error.type },
    };
  }

  const decrypted = decryptCommerceDocument({
    ciphertext: downloaded.value.ciphertext,
    encryptedDataKey: document.encryptedDataKey,
    initializationVector: document.initializationVector,
  });
  if (!decrypted.success) return { success: false, error: { type: "DECRYPTION_FAILED" } };

  const scanned = await scannerResolved.value.scanDocument({
    documentId,
    plaintextBytes: decrypted.value,
    mediaType: document.mediaType,
    declaredByteSize: decrypted.value.byteLength,
  });
  if (!scanned.success) {
    return { success: false, error: { type: "SCANNER_UNAVAILABLE", reason: scanned.error.reason } };
  }

  return applyScanVerdict(documentId, scanned.value.verdict, scanned.value.detail);
}

async function applyScanVerdict(
  documentId: string,
  verdict: DocumentScanVerdict,
  detail: string,
): Promise<Result<DocumentScanOutcome, CommerceDocumentScanError>> {
  /**
   * `unscannable` changes nothing. The document stays `pending_scan` and stays unusable,
   * which is the correct answer to "we looked and cannot tell" — a human has to decide,
   * and `recordDocumentScannerVerdict` is where they do it.
   */
  if (verdict === "unscannable") {
    logger.warn("document could not be scanned; leaving it pending for a human", {
      documentId,
      detail,
    });
    return { success: true, value: { documentId, verdict, state: "pending_scan" } };
  }

  const nextState = verdict === "clean" ? ("available" as const) : ("quarantined" as const);

  return db.transaction(async (transaction) => {
    /**
     * Guarded on `pending_scan` in the predicate rather than checked beforehand, so two
     * concurrent scans of one document cannot both write — the second updates no rows.
     */
    const [updated] = await transaction
      .update(commerceEncryptedDocument)
      .set({ state: nextState, updatedAt: new Date() })
      .where(
        and(
          eq(commerceEncryptedDocument.id, documentId),
          eq(commerceEncryptedDocument.state, "pending_scan"),
        ),
      )
      .returning({ id: commerceEncryptedDocument.id });

    if (!updated) {
      return {
        success: true,
        value: { documentId, verdict, state: "pending_scan" as const },
      };
    }

    /**
     * A quarantined document must not leave a verification sitting `pending` forever with
     * evidence nobody can open. This mirrors what the manual verdict path already does, so
     * the automated and human routes leave the same shape behind.
     */
    if (verdict === "infected") {
      await transaction
        .update(commerceOrganizationVerification)
        .set({
          state: "rejected",
          decisionReason: "Evidence failed a malware scan.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(commerceOrganizationVerification.evidenceDocumentId, documentId),
            eq(commerceOrganizationVerification.state, "pending"),
          ),
        );
    }

    logger.info("document scan verdict recorded", { documentId, verdict, detail });
    return { success: true, value: { documentId, verdict, state: nextState } };
  });
}

/**
 * Enqueues a scan, after the upload transaction has committed.
 *
 * MUST NOT THROW, for the reason `scheduleConnectorDispatch` documents and an HTTP smoke
 * proved: this runs after the document row is durable, and letting a queue hiccup turn a
 * successful upload into a 500 would tell the buyer to retry an upload that already worked.
 * A lost enqueue costs at most `RESCAN_AFTER_MS`, because the sweep re-enqueues it.
 */
export async function scheduleDocumentScan(documentId: string): Promise<void> {
  try {
    const scheduled = await sendJob(
      JOB_NAMES.scanEncryptedDocument,
      { documentId },
      { idempotencyKey: idempotencyKeyFor.scanEncryptedDocument(documentId) },
    );
    if (!scheduled.success) {
      logger.error("failed to enqueue a document scan; the sweep will retry it", {
        documentId,
        enqueueError: scheduled.error.type,
      });
    }
  } catch (error: unknown) {
    logger.error("document scan enqueue threw; the sweep will retry it", {
      documentId,
      ...errorFields(error),
    });
  }
}

/**
 * Re-enqueues documents still pending past the rescan window.
 *
 * Bounded per run. A sweep that tries to drain an unbounded backlog in one tick starves the
 * queue it is meant to help, and the oldest documents are the ones a buyer is waiting on.
 */
export async function sweepPendingDocumentScans(
  limit = 200,
): Promise<{ readonly reEnqueued: number }> {
  const stale = await db
    .select({ id: commerceEncryptedDocument.id })
    .from(commerceEncryptedDocument)
    .where(
      and(
        eq(commerceEncryptedDocument.state, "pending_scan"),
        lt(commerceEncryptedDocument.updatedAt, new Date(Date.now() - RESCAN_AFTER_MS)),
      ),
    )
    .orderBy(commerceEncryptedDocument.updatedAt, commerceEncryptedDocument.id)
    .limit(limit);

  for (const document of stale) {
    await scheduleDocumentScan(document.id);
  }
  return { reEnqueued: stale.length };
}

/** Counts what is waiting, for the sweep's log line and the verifier. */
export async function countPendingDocumentScans(): Promise<number> {
  const result = await db.execute<{ value: number }>(
    sql`SELECT count(*)::int AS value FROM commerce_encrypted_document WHERE state = 'pending_scan'`,
  );
  return result.rows[0]?.value ?? 0;
}
