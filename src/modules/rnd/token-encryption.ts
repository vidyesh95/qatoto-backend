import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * Envelope encryption for third-party integration tokens
 * (R_AND_D_BACKEND_STRUCTURE.md §9.10).
 *
 * WHY THESE TOKENS AND NOT BETTER AUTH's. `account.accessToken` is stored in plaintext by
 * Better Auth — that is its table and its decision, and those tokens read a user's profile.
 * These are ORG-SCOPED tokens whose blast radius is a customer's entire source repository,
 * and a database backup that leaks them leaks the customer's code. The two are not
 * comparable and are deliberately not stored the same way.
 *
 * AES-256-GCM, which is authenticated: a ciphertext altered in the database fails to
 * decrypt rather than decrypting to different bytes. A bare CBC or CTR mode would let
 * someone with write access flip bits in a token and watch what happens.
 *
 * THE KEY DERIVATION IS THE HONEST PART. §9.10 specifies a KMS-held key. This ships with
 * the key derived from an env var, and {@link deriveKeyMaterial} is the one function a KMS
 * integration replaces — everything else, including the stored `tokenKeyVersion` that makes
 * rotation a re-encrypt rather than a data loss, is already the shape it needs to be.
 *
 * NO CONFIGURED KEY MEANS NO INTEGRATIONS, not weak ones. `encryptToken` returns a typed
 * failure the route surfaces as `503 INTEGRATION_UNCONFIGURED` rather than falling back to
 * a default key, because a default key is indistinguishable from plaintext to anyone who
 * has read the source.
 */

/** Bumped when the derivation changes, so old ciphertexts stay decryptable. */
export const TOKEN_KEY_VERSION = "v1";

/** GCM's standard nonce length. 96 bits is what the mode is specified for. */
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type TokenEncryptionError = { type: "ENCRYPTION_UNCONFIGURED" } | { type: "DECRYPT_FAILED" };

/**
 * The 32-byte key, derived from the configured secret.
 *
 * SHA-256 of a labelled secret rather than the raw bytes: the label domain-separates this
 * key from every other use of the same secret, so a token ciphertext and a session
 * signature can never be produced by the same key material.
 *
 * Returns null when nothing is configured — never a zero key, never a constant.
 */
function deriveKeyMaterial(): Buffer | null {
  const secret = config.INTEGRATION_TOKEN_SECRET;
  if (!secret) {
    return null;
  }
  return createHash("sha256")
    .update(`qatoto:integration-token:${TOKEN_KEY_VERSION}:${secret}`, "utf8")
    .digest();
}

/** True when integration tokens can be stored at all. Gates the connect routes. */
export function isTokenEncryptionConfigured(): boolean {
  return deriveKeyMaterial() !== null;
}

/**
 * Encrypts a token for storage.
 *
 * The stored form is `nonce || authTag || ciphertext`, base64. Self-describing, so
 * decryption needs nothing but the string and the key version already on the row.
 */
export function encryptToken(plaintext: string): Result<string, TokenEncryptionError> {
  const key = deriveKeyMaterial();
  if (!key) {
    return { success: false, error: { type: "ENCRYPTION_UNCONFIGURED" } };
  }

  // A FRESH nonce per encryption, from the CSPRNG. Reusing a nonce under one key in GCM
  // is catastrophic — it leaks the XOR of two plaintexts and forges the authenticator —
  // which is why this is generated here rather than derived from anything on the row.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    success: true,
    value: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64"),
  };
}

/**
 * Decrypts a stored token.
 *
 * Every failure — a truncated string, a rotated key, a tampered ciphertext — collapses
 * into one `DECRYPT_FAILED`. Distinguishing them would tell an attacker with database read
 * access which of their guesses was closer.
 */
export function decryptToken(stored: string): Result<string, TokenEncryptionError> {
  const key = deriveKeyMaterial();
  if (!key) {
    return { success: false, error: { type: "ENCRYPTION_UNCONFIGURED" } };
  }

  try {
    const raw = Buffer.from(stored, "base64");
    if (raw.length <= NONCE_BYTES + AUTH_TAG_BYTES) {
      return { success: false, error: { type: "DECRYPT_FAILED" } };
    }

    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + AUTH_TAG_BYTES));

    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(NONCE_BYTES + AUTH_TAG_BYTES)),
      // Throws when the authentication tag does not verify — which is the entire point of
      // choosing GCM over an unauthenticated mode.
      decipher.final(),
    ]);

    return { success: true, value: plaintext.toString("utf8") };
  } catch {
    return { success: false, error: { type: "DECRYPT_FAILED" } };
  }
}
