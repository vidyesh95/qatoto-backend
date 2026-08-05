import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

export const COMMERCE_PII_KEY_VERSION = 1;
export const COMMERCE_PII_ENCRYPTION_ALGORITHM = "aes-256-gcm";

const INITIALIZATION_VECTOR_BYTE_LENGTH = 12;
const AUTHENTICATION_TAG_BYTE_LENGTH = 16;
const ENVELOPE_PREFIX = `v${String(COMMERCE_PII_KEY_VERSION)}`;

export type CommercePiiEncryptionError =
  | { type: "NOT_CONFIGURED" }
  | { type: "INVALID_ENVELOPE" }
  | { type: "UNSUPPORTED_KEY_VERSION"; keyVersion: number }
  | { type: "ENCRYPTION_FAILED" }
  | { type: "DECRYPTION_FAILED" };

function deriveCommercePiiKey(keyVersion: number): Buffer | null {
  const rootSecret = config.COMMERCE_PII_ENCRYPTION_SECRET;
  if (!rootSecret) return null;

  return createHash("sha256")
    .update(`qatoto:commerce-pii:v${String(keyVersion)}:${rootSecret}`, "utf8")
    .digest();
}

export function isCommercePiiEncryptionConfigured(): boolean {
  return deriveCommercePiiKey(COMMERCE_PII_KEY_VERSION) !== null;
}

/**
 * Stored envelope: `v<version>.<iv base64url>.<auth tag base64url>.<ciphertext base64url>`.
 * The version is authenticated as additional data, so it cannot be changed independently.
 */
export function encryptCommercePii(plaintext: string): Result<string, CommercePiiEncryptionError> {
  const encryptionKey = deriveCommercePiiKey(COMMERCE_PII_KEY_VERSION);
  if (!encryptionKey) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTE_LENGTH);
    const cipher = createCipheriv(
      COMMERCE_PII_ENCRYPTION_ALGORITHM,
      encryptionKey,
      initializationVector,
    );
    cipher.setAAD(Buffer.from(ENVELOPE_PREFIX, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return {
      success: true,
      value: [
        ENVELOPE_PREFIX,
        initializationVector.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join("."),
    };
  } catch {
    return { success: false, error: { type: "ENCRYPTION_FAILED" } };
  }
}

export function decryptCommercePii(envelope: string): Result<string, CommercePiiEncryptionError> {
  const envelopeParts = envelope.split(".");
  if (envelopeParts.length !== 4) {
    return { success: false, error: { type: "INVALID_ENVELOPE" } };
  }

  const [versionPart, initializationVectorPart, authenticationTagPart, ciphertextPart] =
    envelopeParts;
  if (
    versionPart === undefined ||
    initializationVectorPart === undefined ||
    authenticationTagPart === undefined ||
    ciphertextPart === undefined
  ) {
    return { success: false, error: { type: "INVALID_ENVELOPE" } };
  }

  const versionMatch = /^v([1-9][0-9]*)$/.exec(versionPart);
  if (!versionMatch) return { success: false, error: { type: "INVALID_ENVELOPE" } };

  const keyVersion = Number(versionMatch[1]);
  if (keyVersion !== COMMERCE_PII_KEY_VERSION) {
    return { success: false, error: { type: "UNSUPPORTED_KEY_VERSION", keyVersion } };
  }

  const encryptionKey = deriveCommercePiiKey(keyVersion);
  if (!encryptionKey) return { success: false, error: { type: "NOT_CONFIGURED" } };

  try {
    const initializationVector = Buffer.from(initializationVectorPart, "base64url");
    const authenticationTag = Buffer.from(authenticationTagPart, "base64url");
    const ciphertext = Buffer.from(ciphertextPart, "base64url");
    if (
      initializationVector.length !== INITIALIZATION_VECTOR_BYTE_LENGTH ||
      authenticationTag.length !== AUTHENTICATION_TAG_BYTE_LENGTH ||
      ciphertext.length === 0
    ) {
      return { success: false, error: { type: "INVALID_ENVELOPE" } };
    }
    if (
      initializationVector.toString("base64url") !== initializationVectorPart ||
      authenticationTag.toString("base64url") !== authenticationTagPart ||
      ciphertext.toString("base64url") !== ciphertextPart
    ) {
      return { success: false, error: { type: "DECRYPTION_FAILED" } };
    }

    const decipher = createDecipheriv(
      COMMERCE_PII_ENCRYPTION_ALGORITHM,
      encryptionKey,
      initializationVector,
    );
    decipher.setAAD(Buffer.from(versionPart, "utf8"));
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { success: true, value: plaintext.toString("utf8") };
  } catch {
    return { success: false, error: { type: "DECRYPTION_FAILED" } };
  }
}
