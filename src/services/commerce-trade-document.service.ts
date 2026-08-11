import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceEncryptedDocument,
  commerceMessage,
  commerceMessageAttachment,
  commerceRfq,
  commerceRfqDocument,
  commerceRfqInvitation,
  commerceThreadParticipant,
} from "#src/db/schema.js";
import {
  decryptCommerceDocument,
  encryptCommerceDocument,
} from "#src/lib/commerce-document-encryption.js";
import { decryptCommercePii, encryptCommercePii } from "#src/lib/commerce-pii-encryption.js";
import {
  deletePrivateCommerceDocument,
  downloadPrivateCommerceDocument,
  uploadPrivateCommerceDocument,
} from "#src/lib/object-storage.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import { scheduleDocumentScan } from "#src/services/commerce-document-scan.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Trade attachments (Appendix A30, and A27's second half).
 *
 * `CreateDraftRfqSchema` has always accepted `documentIds`, and `assertOwnedDocuments`
 * has always required each one to name a document the buyer's organization owns. NO
 * ROUTE CREATED ONE — the only uploads in this backend were verification evidence,
 * customization artwork and A21's image multiparts, none of which a buyer composing an
 * RFQ can use. So the field existed and could not be filled, and `/store/rfqs/new`
 * shipped with no attachment step at all.
 *
 * Two routes, and BOTH are required for either to be worth building. The RFQ read
 * projects `encryptedDocumentId` and minted no URL, so an upload without a matching
 * download would have left a composer able to attach a file that nobody — including the
 * buyer who uploaded it — could open.
 *
 * The upload is `uploadCustomizationAsset`'s shape, for its reasons: encrypt, put the
 * ciphertext in private storage, then record the row, and land it `pending_scan` so a
 * party cannot hand a counterparty an unscanned file.
 */

export type CommerceTradeDocumentError =
  | { type: "PII_ENCRYPTION_UNAVAILABLE" }
  | { type: "STORAGE_NOT_CONFIGURED" }
  | { type: "STORAGE_FAILED" }
  | { type: "MEDIA_TYPE_MISMATCH" }
  /**
   * 404 for EVERY refusal — missing, quarantined, still scanning, or simply not the
   * caller's to read. A document id names a drawing two organizations are negotiating
   * over, so distinguishing "no such document" from "not yours" would make the route an
   * oracle for which documents exist.
   */
  | { type: "NOT_FOUND" }
  /** A38. The attachment picker's list is the first paginated read on this service. */
  | { type: "INVALID_CURSOR" };

export interface UploadedTradeDocument {
  readonly encryptedDocumentId: string;
  readonly state: (typeof commerceEncryptedDocument.$inferSelect)["state"];
  readonly mediaType: string;
  readonly fileByteSize: number;
}

export interface DownloadedTradeDocument {
  readonly documentId: string;
  readonly mediaType: string;
  readonly fileName: string;
  readonly bytes: Buffer;
}

export interface CommerceTradeDocumentActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export async function uploadTradeDocument(input: {
  readonly userId: string;
  readonly organizationId: string;
  readonly documentBytes: Buffer;
  readonly mediaType: string;
  readonly originalFileName: string;
}): Promise<Result<UploadedTradeDocument, CommerceTradeDocumentError>> {
  const encryptedDocument = encryptCommerceDocument(input.documentBytes);
  if (!encryptedDocument.success) {
    return { success: false, error: { type: "PII_ENCRYPTION_UNAVAILABLE" } };
  }

  const encryptedFileName = encryptCommercePii(input.originalFileName);
  if (!encryptedFileName.success) {
    return { success: false, error: { type: "PII_ENCRYPTION_UNAVAILABLE" } };
  }

  // Minted before the upload so the storage key is deterministic and the compensating
  // delete below has something to name.
  const documentId = randomUUID();
  const uploaded = await uploadPrivateCommerceDocument({
    organizationId: input.organizationId,
    documentId,
    contentSha256: encryptedDocument.value.contentSha256,
    documentBytes: encryptedDocument.value.ciphertext,
    /**
     * The stored object is ciphertext, so its transport type is octet-stream and its
     * download name is opaque. The real media type lives on the row.
     */
    mediaType: "application/octet-stream",
    downloadFileName: `${documentId}.bin`,
  });
  if (!uploaded.success) {
    return {
      success: false,
      error: {
        type:
          uploaded.error.type === "NOT_CONFIGURED" ? "STORAGE_NOT_CONFIGURED" : "STORAGE_FAILED",
      },
    };
  }

  try {
    const [document] = await db
      .insert(commerceEncryptedDocument)
      .values({
        id: documentId,
        organizationId: input.organizationId,
        documentKind: "trade_attachment",
        state: "pending_scan",
        storageProvider: "backblaze_b2",
        objectStorageKey: uploaded.value.objectKey,
        mediaType: input.mediaType,
        fileByteSize: input.documentBytes.length,
        contentSha256: encryptedDocument.value.contentSha256,
        encryptionAlgorithm: encryptedDocument.value.encryptionAlgorithm,
        encryptionKeyVersion: encryptedDocument.value.encryptionKeyVersion,
        encryptedDataKey: encryptedDocument.value.encryptedDataKey,
        initializationVector: encryptedDocument.value.initializationVector,
        originalFileNameEncrypted: encryptedFileName.value,
        uploadedByUserId: input.userId,
      })
      .returning();
    if (!document) throw new Error("Trade document insert returned no row.");

    /**
     * Phase 14b. Enqueued after the row is durable and never allowed to fail this call:
     * the upload succeeded, and turning a queue hiccup into a 500 would tell the caller
     * to retry an upload that already worked. The quarter-hourly sweep re-enqueues.
     */
    await scheduleDocumentScan(document.id);

    return {
      success: true,
      value: {
        encryptedDocumentId: document.id,
        state: document.state,
        mediaType: document.mediaType,
        fileByteSize: document.fileByteSize,
      },
    };
  } catch (error: unknown) {
    /**
     * Compensating delete: the bytes went up before the row existed, so a failed insert
     * would otherwise leave an orphan nothing references and nothing can reach.
     */
    await deletePrivateCommerceDocument(uploaded.value.objectKey);
    throw error;
  }
}

/**
 * May this organization open this document?
 *
 * Three ways, and no fourth. Ownership, or a link table that already records the two
 * parties agreeing this file is part of their conversation:
 *
 *   1. the organization that uploaded it;
 *   2. a participant of a thread carrying it as a message attachment;
 *   3. the buyer or an INVITED provider on an RFQ carrying it.
 *
 * RFQ access is scoped to invited providers rather than every provider, because an open
 * RFQ is broadcast and its drawings are not. `commerce_rfq_invitation` is the record of
 * who was actually asked to quote.
 */
async function organizationMayReadDocument(input: {
  readonly documentId: string;
  readonly ownerOrganizationId: string;
  readonly readerOrganizationId: string;
}): Promise<boolean> {
  if (input.ownerOrganizationId === input.readerOrganizationId) return true;

  const [threadLink] = await db
    .select({ id: commerceMessageAttachment.id })
    .from(commerceMessageAttachment)
    .innerJoin(commerceMessage, eq(commerceMessage.id, commerceMessageAttachment.messageId))
    .innerJoin(
      commerceThreadParticipant,
      and(
        eq(commerceThreadParticipant.threadId, commerceMessage.threadId),
        eq(commerceThreadParticipant.organizationId, input.readerOrganizationId),
      ),
    )
    .where(eq(commerceMessageAttachment.encryptedDocumentId, input.documentId))
    .limit(1);
  if (threadLink) return true;

  const [rfqBuyerLink] = await db
    .select({ id: commerceRfqDocument.id })
    .from(commerceRfqDocument)
    .innerJoin(commerceRfq, eq(commerceRfq.id, commerceRfqDocument.rfqId))
    .where(
      and(
        eq(commerceRfqDocument.encryptedDocumentId, input.documentId),
        eq(commerceRfq.buyerOrganizationId, input.readerOrganizationId),
      ),
    )
    .limit(1);
  if (rfqBuyerLink) return true;

  const [rfqProviderLink] = await db
    .select({ id: commerceRfqDocument.id })
    .from(commerceRfqDocument)
    .innerJoin(
      commerceRfqInvitation,
      and(
        eq(commerceRfqInvitation.rfqId, commerceRfqDocument.rfqId),
        eq(commerceRfqInvitation.providerOrganizationId, input.readerOrganizationId),
      ),
    )
    .where(eq(commerceRfqDocument.encryptedDocumentId, input.documentId))
    .limit(1);

  return rfqProviderLink !== undefined;
}

/**
 * Decrypt and stream one trade attachment.
 *
 * A DECRYPT-AND-STREAM, not a presigned URL, and that is the same call
 * `downloadVerificationEvidence` made. `presignPrivateCommerceDocumentDownload` exists
 * and has never had a caller: a signed URL is a bearer capability that outlives the
 * authorization decision, and the authorization here — thread participation, RFQ
 * invitation — is exactly the sort that can be revoked.
 *
 * `state = 'available'` ONLY. A `pending_scan` document has not been checked for malware
 * and a `quarantined` one failed; neither is a thing to hand anybody, including its own
 * uploader.
 */
export interface TradeDocumentListItem {
  readonly documentId: string;
  readonly mediaType: string;
  readonly fileByteSize: number;
  /** NULL when the stored name cannot be decrypted — the same fallback the download takes. */
  readonly fileName: string | null;
  readonly createdAt: Date;
}

/**
 * The caller's own uploaded trade attachments (Appendix A38).
 *
 * WHY THIS ROUTE HAD TO EXIST. `POST /commerce/documents` minted an id and
 * `GET /commerce/documents/:documentId` streamed one back, and nothing enumerated them — so
 * `documentIds` on an RFQ and `encryptedDocumentIds` on a message were fields the frontend
 * could only fill with an id it had just uploaded in the same session. An attachment picker
 * had no backing list.
 *
 * THE FILTER MIRRORS `assertOwnedDocuments` EXACTLY — own organization, `state = 'available'` —
 * and that is the point. A list that offered a `pending_scan` id would be a picker whose every
 * fresh upload is rejected on attach, which is worse than no picker.
 *
 * OWN UPLOADS ONLY, not everything the caller may read. `organizationMayReadDocument` also
 * admits documents shared through a thread or an RFQ, and those are reachable by their id from
 * the message or RFQ that carries them. Enumerating them here would turn a picker into a
 * cross-organization file browser.
 */
export async function listTradeDocuments(
  actor: CommerceTradeDocumentActorContext,
  input: {
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
): Promise<
  Result<
    {
      readonly items: readonly TradeDocumentListItem[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceTradeDocumentError
  >
> {
  const limit = input.limit ?? 20;
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          lt(commerceEncryptedDocument.createdAt, new Date(decodedCursor.sortKey)),
          and(
            eq(commerceEncryptedDocument.createdAt, new Date(decodedCursor.sortKey)),
            gt(commerceEncryptedDocument.id, decodedCursor.id),
          ),
        );

  const rows = await db
    .select({
      id: commerceEncryptedDocument.id,
      mediaType: commerceEncryptedDocument.mediaType,
      fileByteSize: commerceEncryptedDocument.fileByteSize,
      originalFileNameEncrypted: commerceEncryptedDocument.originalFileNameEncrypted,
      createdAt: commerceEncryptedDocument.createdAt,
    })
    .from(commerceEncryptedDocument)
    .where(
      and(
        eq(commerceEncryptedDocument.organizationId, actor.organizationId),
        eq(commerceEncryptedDocument.documentKind, "trade_attachment"),
        eq(commerceEncryptedDocument.state, "available"),
        cursorPredicate,
      ),
    )
    .orderBy(desc(commerceEncryptedDocument.createdAt), asc(commerceEncryptedDocument.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  const items = pageRows.map((row) => {
    const decryptedFileName =
      row.originalFileNameEncrypted === null
        ? null
        : decryptCommercePii(row.originalFileNameEncrypted);
    return {
      documentId: row.id,
      mediaType: row.mediaType,
      fileByteSize: row.fileByteSize,
      // NULL rather than the id the download falls back to: a picker showing an opaque uuid
      // as a file name is worse than showing none, and the client can label it itself.
      fileName:
        decryptedFileName !== null && decryptedFileName.success ? decryptedFileName.value : null,
      createdAt: row.createdAt,
    };
  });

  return { success: true, value: { items, page: { nextCursor, hasMore: nextCursor !== null } } };
}

export async function downloadTradeDocument(
  actor: CommerceTradeDocumentActorContext,
  documentId: string,
): Promise<Result<DownloadedTradeDocument, CommerceTradeDocumentError>> {
  const [document] = await db
    .select()
    .from(commerceEncryptedDocument)
    .where(
      and(
        eq(commerceEncryptedDocument.id, documentId),
        eq(commerceEncryptedDocument.state, "available"),
      ),
    )
    .limit(1);
  if (!document) return { success: false, error: { type: "NOT_FOUND" } };

  const mayRead = await organizationMayReadDocument({
    documentId: document.id,
    ownerOrganizationId: document.organizationId,
    readerOrganizationId: actor.organizationId,
  });
  if (!mayRead) return { success: false, error: { type: "NOT_FOUND" } };

  const ciphertext = await downloadPrivateCommerceDocument(document.objectStorageKey);
  if (!ciphertext.success) {
    return {
      success: false,
      error: {
        type:
          ciphertext.error.type === "NOT_CONFIGURED" ? "STORAGE_NOT_CONFIGURED" : "STORAGE_FAILED",
      },
    };
  }

  const plaintext = decryptCommerceDocument({
    ciphertext: ciphertext.value.ciphertext,
    encryptedDataKey: document.encryptedDataKey,
    initializationVector: document.initializationVector,
  });
  if (!plaintext.success) {
    return { success: false, error: { type: "PII_ENCRYPTION_UNAVAILABLE" } };
  }

  /**
   * A15's audit rule, applied to bytes instead of an address. Three details carried over
   * verbatim, because each one is load-bearing:
   *
   *   * the append runs INSIDE a transaction and a failed append THROWS, so a read that
   *     could not be logged does not happen;
   *   * ids ride `targetEntityId`, never the payload, whose keys are PII-name checked;
   *   * only a CROSS-ORGANIZATION read is audited. An organization opening its own file
   *     is not an access anybody needs a record of, and logging it would bury the reads
   *     that matter under the ones that do not.
   */
  if (document.organizationId !== actor.organizationId) {
    await db.transaction(async (transaction) => {
      const appended = await appendCommerceOrganizationAuditEntry(transaction, {
        organizationId: document.organizationId,
        eventKind: "document_downloaded",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_encrypted_document",
        targetEntityId: document.id,
        payload: {
          readByOrganizationId: actor.organizationId,
          documentKind: document.documentKind,
        },
        occurredAt: new Date(),
      });
      if (!appended.success) {
        throw new Error(`Trade document download audit failed: ${appended.error.type}`);
      }
    });
  }

  const decryptedFileName =
    document.originalFileNameEncrypted === null
      ? null
      : decryptCommercePii(document.originalFileNameEncrypted);

  return {
    success: true,
    value: {
      documentId: document.id,
      mediaType: document.mediaType,
      // A file name is the uploader's, so an undecryptable one falls back to the opaque
      // id rather than failing the download or inventing a name.
      fileName:
        decryptedFileName !== null && decryptedFileName.success
          ? decryptedFileName.value
          : document.id,
      bytes: plaintext.value,
    },
  };
}
