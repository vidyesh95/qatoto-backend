import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import {
  COMMERCE_PII_ENCRYPTION_ALGORITHM,
  COMMERCE_PII_KEY_VERSION,
  decryptCommercePii,
  encryptCommercePii,
} from "#src/lib/commerce-pii-encryption.js";
import type { CommercePiiEncryptionError } from "#src/lib/commerce-pii-encryption.js";
import type { Result } from "#src/types/index.js";

const INITIALIZATION_VECTOR_BYTE_LENGTH = 12;

export interface EncryptedCommerceDocument {
  readonly ciphertext: Buffer;
  readonly contentSha256: string;
  readonly encryptedDataKey: string;
  readonly initializationVector: string;
  readonly encryptionAlgorithm: typeof COMMERCE_PII_ENCRYPTION_ALGORITHM;
  readonly encryptionKeyVersion: typeof COMMERCE_PII_KEY_VERSION;
}

export type CommerceDocumentEncryptionError =
  | CommercePiiEncryptionError
  | { type: "DOCUMENT_ENCRYPTION_FAILED" }
  | { type: "DOCUMENT_DECRYPTION_FAILED" };

export function encryptCommerceDocument(
  plaintextBytes: Buffer,
): Result<EncryptedCommerceDocument, CommerceDocumentEncryptionError> {
  const dataKey = randomBytes(32);
  const encryptedDataKey = encryptCommercePii(dataKey.toString("base64url"));
  if (!encryptedDataKey.success) return encryptedDataKey;

  try {
    const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTE_LENGTH);
    const cipher = createCipheriv(COMMERCE_PII_ENCRYPTION_ALGORITHM, dataKey, initializationVector);
    const encryptedBytes = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
    const ciphertext = Buffer.concat([encryptedBytes, cipher.getAuthTag()]);

    return {
      success: true,
      value: {
        ciphertext,
        contentSha256: createHash("sha256").update(ciphertext).digest("hex"),
        encryptedDataKey: encryptedDataKey.value,
        initializationVector: initializationVector.toString("base64url"),
        encryptionAlgorithm: COMMERCE_PII_ENCRYPTION_ALGORITHM,
        encryptionKeyVersion: COMMERCE_PII_KEY_VERSION,
      },
    };
  } catch {
    return { success: false, error: { type: "DOCUMENT_ENCRYPTION_FAILED" } };
  } finally {
    dataKey.fill(0);
  }
}

export function decryptCommerceDocument(input: {
  readonly ciphertext: Buffer;
  readonly encryptedDataKey: string;
  readonly initializationVector: string;
}): Result<Buffer, CommerceDocumentEncryptionError> {
  const decryptedDataKey = decryptCommercePii(input.encryptedDataKey);
  if (!decryptedDataKey.success) return decryptedDataKey;

  const dataKey = Buffer.from(decryptedDataKey.value, "base64url");
  try {
    const initializationVector = Buffer.from(input.initializationVector, "base64url");
    const authenticationTag = input.ciphertext.subarray(-16);
    const encryptedBytes = input.ciphertext.subarray(0, -16);
    if (
      dataKey.length !== 32 ||
      initializationVector.length !== INITIALIZATION_VECTOR_BYTE_LENGTH ||
      encryptedBytes.length === 0 ||
      authenticationTag.length !== 16
    ) {
      return { success: false, error: { type: "DOCUMENT_DECRYPTION_FAILED" } };
    }

    const decipher = createDecipheriv(
      COMMERCE_PII_ENCRYPTION_ALGORITHM,
      dataKey,
      initializationVector,
    );
    decipher.setAuthTag(authenticationTag);
    return {
      success: true,
      value: Buffer.concat([decipher.update(encryptedBytes), decipher.final()]),
    };
  } catch {
    return { success: false, error: { type: "DOCUMENT_DECRYPTION_FAILED" } };
  } finally {
    dataKey.fill(0);
  }
}
