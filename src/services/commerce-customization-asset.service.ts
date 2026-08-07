import { randomUUID } from "node:crypto";

import { db } from "#src/db/index.js";
import { commerceEncryptedDocument } from "#src/db/schema.js";
import { encryptCommerceDocument } from "#src/lib/commerce-document-encryption.js";
import { encryptCommercePii } from "#src/lib/commerce-pii-encryption.js";
import {
  deletePrivateCommerceDocument,
  uploadPrivateCommerceDocument,
} from "#src/lib/object-storage.js";
import type { Result } from "#src/types/index.js";

/**
 * Buyer-uploaded customization artwork (Appendix A18).
 *
 * Deliberately the SAME shape as verification evidence: encrypt the bytes, put the
 * ciphertext in private object storage, then record the row. Artwork is a buyer's
 * commercial material — a logo, a packaging design — not a public product image, so it
 * never goes near Cloudinary.
 *
 * IT LANDS `pending_scan`, and `resolveCustomizationSelections` refuses to attach
 * anything that is not `available`. Upload completion is not a malware verdict, and a
 * buyer handing a seller an unscanned file is exactly the path that must not exist.
 */

export type CommerceCustomizationAssetError =
  | { type: "PII_ENCRYPTION_UNAVAILABLE" }
  | { type: "STORAGE_NOT_CONFIGURED" }
  | { type: "STORAGE_FAILED" }
  | { type: "MEDIA_TYPE_MISMATCH" };

export interface UploadedCustomizationAsset {
  readonly encryptedDocumentId: string;
  readonly state: (typeof commerceEncryptedDocument.$inferSelect)["state"];
  readonly mediaType: string;
  readonly fileByteSize: number;
}

export async function uploadCustomizationAsset(input: {
  readonly userId: string;
  readonly buyerOrganizationId: string;
  readonly assetBytes: Buffer;
  readonly mediaType: string;
  readonly originalFileName: string;
}): Promise<Result<UploadedCustomizationAsset, CommerceCustomizationAssetError>> {
  const encryptedDocument = encryptCommerceDocument(input.assetBytes);
  if (!encryptedDocument.success) {
    return { success: false, error: { type: "PII_ENCRYPTION_UNAVAILABLE" } };
  }

  const encryptedFileName = encryptCommercePii(input.originalFileName);
  if (!encryptedFileName.success) {
    return { success: false, error: { type: "PII_ENCRYPTION_UNAVAILABLE" } };
  }

  const documentId = randomUUID();
  const uploaded = await uploadPrivateCommerceDocument({
    organizationId: input.buyerOrganizationId,
    documentId,
    contentSha256: encryptedDocument.value.contentSha256,
    documentBytes: encryptedDocument.value.ciphertext,
    /**
     * The stored object is ciphertext, so its transport type is octet-stream and its
     * download name is opaque. The real media type lives on the row, where the
     * customization resolver can check it.
     */
    mediaType: "application/octet-stream",
    downloadFileName: `${documentId}.bin`,
  });
  if (!uploaded.success) {
    return {
      success: false,
      error: {
        type: uploaded.error.type === "NOT_CONFIGURED" ? "STORAGE_NOT_CONFIGURED" : "STORAGE_FAILED",
      },
    };
  }

  try {
    const [document] = await db
      .insert(commerceEncryptedDocument)
      .values({
        id: documentId,
        organizationId: input.buyerOrganizationId,
        documentKind: "customization_artwork",
        state: "pending_scan",
        storageProvider: "backblaze_b2",
        objectStorageKey: uploaded.value.objectKey,
        mediaType: input.mediaType,
        fileByteSize: input.assetBytes.length,
        contentSha256: encryptedDocument.value.contentSha256,
        encryptionAlgorithm: encryptedDocument.value.encryptionAlgorithm,
        encryptionKeyVersion: encryptedDocument.value.encryptionKeyVersion,
        encryptedDataKey: encryptedDocument.value.encryptedDataKey,
        initializationVector: encryptedDocument.value.initializationVector,
        originalFileNameEncrypted: encryptedFileName.value,
        uploadedByUserId: input.userId,
      })
      .returning();
    if (!document) throw new Error("Customization asset insert returned no row.");

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
