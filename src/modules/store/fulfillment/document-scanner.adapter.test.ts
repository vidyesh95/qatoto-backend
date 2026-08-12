import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { FakeDocumentScannerAdapter, resolveDocumentScanner } =
  await import("#src/modules/store/fulfillment/document-scanner.adapter.js");

/**
 * The EICAR test string, assembled at runtime so this test file is not itself quarantined
 * by whatever scans the repository. Every real engine is required to detect it, which is
 * what makes an end-to-end quarantine path testable without handling actual malware.
 */
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-", "ANTIVIRUS-TEST-FILE!$H+H*"].join("");

function scanInput(contents: string | Buffer) {
  const plaintextBytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  return {
    documentId: "doc_1",
    plaintextBytes,
    mediaType: "application/pdf",
    declaredByteSize: plaintextBytes.byteLength,
  };
}

describe("the fake document scanner", () => {
  const scanner = new FakeDocumentScannerAdapter();

  it("passes an ordinary file", async () => {
    const scanned = await scanner.scanDocument(scanInput("a perfectly ordinary purchase order"));

    expect(scanned.success).toBe(true);
    if (!scanned.success) return;
    expect(scanned.value.verdict).toBe("clean");
  });

  it("detects the EICAR signature", async () => {
    const scanned = await scanner.scanDocument(scanInput(EICAR));

    expect(scanned.success).toBe(true);
    if (!scanned.success) return;
    expect(scanned.value).toEqual({ verdict: "infected", detail: "eicar_test_signature" });
  });

  it("detects the signature when it is embedded in a larger file", async () => {
    const scanned = await scanner.scanDocument(
      scanInput(`%PDF-1.4\nlots of legitimate looking content\n${EICAR}\ntrailer`),
    );

    expect(scanned.success).toBe(true);
    if (!scanned.success) return;
    expect(scanned.value.verdict).toBe("infected");
  });

  /**
   * `unscannable` is a third answer, not a synonym for clean. Folding it into clean would
   * promote a file nobody vetted; folding it into infected would quarantine a seller's
   * legitimate artwork on a technicality.
   */
  it("reports an empty file as unscannable rather than clean", async () => {
    const scanned = await scanner.scanDocument(scanInput(Buffer.alloc(0)));

    expect(scanned.success).toBe(true);
    if (!scanned.success) return;
    expect(scanned.value).toEqual({ verdict: "unscannable", detail: "empty_file" });
  });

  it("reports a size it cannot account for as unscannable", async () => {
    const scanned = await scanner.scanDocument({
      ...scanInput("some bytes"),
      declaredByteSize: 999,
    });

    expect(scanned.success).toBe(true);
    if (!scanned.success) return;
    expect(scanned.value).toEqual({ verdict: "unscannable", detail: "size_mismatch" });
  });

  /**
   * Binary input must not throw. Artwork is PNG and PDF far more often than it is text, and
   * a scanner that crashes on non-UTF-8 bytes would leave every real upload pending.
   */
  it("handles arbitrary binary without throwing", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);

    const scanned = await scanner.scanDocument(scanInput(binary));

    expect(scanned.success).toBe(true);
    if (!scanned.success) return;
    expect(scanned.value.verdict).toBe("clean");
  });
});

describe("scanner resolution", () => {
  /**
   * Unlike the payment and escrow factories, the fake resolves everywhere INCLUDING
   * production — because refusing to resolve means refusing to scan, and an unscanned
   * document stays pending_scan forever, which re-breaks the A18 upload path this whole
   * piece exists to fix.
   */
  it("resolves the fake rather than failing closed", () => {
    const resolved = resolveDocumentScanner();

    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.value.scannerName).toBe("fake");
  });
});
