import { beforeEach, describe, expect, it, vi } from "vitest";

const encryptionConfiguration: { COMMERCE_PII_ENCRYPTION_SECRET?: string } = {};

vi.mock("#src/config/index.js", () => ({ config: encryptionConfiguration }));

const { decryptCommercePii, encryptCommercePii, isCommercePiiEncryptionConfigured } =
  await import("#src/lib/commerce-pii-encryption.js");

describe("commerce PII encryption", () => {
  beforeEach(() => {
    delete encryptionConfiguration.COMMERCE_PII_ENCRYPTION_SECRET;
  });

  it("does not require key material at boot and reports unconfigured operations", () => {
    expect(isCommercePiiEncryptionConfigured()).toBe(false);
    expect(encryptCommercePii("private")).toEqual({
      success: false,
      error: { type: "NOT_CONFIGURED" },
    });
    expect(decryptCommercePii("v1.abc.def.ghi")).toEqual({
      success: false,
      error: { type: "NOT_CONFIGURED" },
    });
  });

  it("round-trips UTF-8 PII in a versioned authenticated envelope", () => {
    encryptionConfiguration.COMMERCE_PII_ENCRYPTION_SECRET = "test-commerce-secret-with-at-least-thirty-two-characters";

    const encrypted = encryptCommercePii("पुणे — tax identifier 123");
    expect(encrypted.success).toBe(true);
    if (!encrypted.success) return;

    expect(encrypted.value).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decryptCommercePii(encrypted.value)).toEqual({
      success: true,
      value: "पुणे — tax identifier 123",
    });
  });

  it("rejects tampering without exposing which bytes failed authentication", () => {
    encryptionConfiguration.COMMERCE_PII_ENCRYPTION_SECRET = "test-commerce-secret-with-at-least-thirty-two-characters";
    const encrypted = encryptCommercePii("registration-123");
    if (!encrypted.success) return;

    const finalCharacter = encrypted.value.endsWith("A") ? "B" : "A";
    const tamperedEnvelope = `${encrypted.value.slice(0, -1)}${finalCharacter}`;
    expect(decryptCommercePii(tamperedEnvelope)).toEqual({
      success: false,
      error: { type: "DECRYPTION_FAILED" },
    });
  });

  it("refuses unknown key versions explicitly", () => {
    encryptionConfiguration.COMMERCE_PII_ENCRYPTION_SECRET = "test-commerce-secret-with-at-least-thirty-two-characters";
    expect(decryptCommercePii("v2.abc.def.ghi")).toEqual({
      success: false,
      error: { type: "UNSUPPORTED_KEY_VERSION", keyVersion: 2 },
    });
  });
});
