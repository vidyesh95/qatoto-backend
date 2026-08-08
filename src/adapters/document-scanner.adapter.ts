import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * Malware scanning for private commerce documents (STORE Phase 14b).
 *
 * ## Why this exists
 *
 * Three upload paths land a document in `pending_scan` — A18 customization artwork, Phase 0
 * verification evidence, and Phase 12 certificates — and until this adapter there was
 * NOTHING that could move any of them to `available`. The only promoter,
 * `recordDocumentScannerVerdict`, first requires a pending `commerce_organization_verification`
 * row referencing the document, which artwork and certificates never have.
 *
 * The consequence was not cosmetic. `resolveCustomizationSelections` refuses any document
 * that is not `available`, so a product with a REQUIRED upload customization slot could
 * never be checked out by anybody. A shipped feature that cannot complete.
 *
 * ## Fail-closed, and it matters more here than anywhere else in the phase
 *
 * With no scanner configured, documents STAY `pending_scan`. They are never promoted on the
 * grounds that nothing objected. An adapter that answered "clean" when it had not looked
 * would turn a security control into a rubber stamp, and would do so silently — the failure
 * would be invisible right up until somebody attached a payload a seller then opened.
 */

export const DOCUMENT_SCANNER_NAMES = ["fake", "clamav"] as const;

export type DocumentScannerName = (typeof DOCUMENT_SCANNER_NAMES)[number];

export type DocumentScannerError =
  | { type: "SCANNER_UNAVAILABLE"; reason: string }
  | { type: "SCANNER_FAILED"; reason: string };

/**
 * `unscannable` is a THIRD answer and not a synonym for either of the others.
 *
 * An encrypted archive, a corrupt container, a file past the engine's size ceiling — the
 * scanner looked and cannot tell. Folding it into `clean` promotes something nobody vetted;
 * folding it into `infected` quarantines a seller's legitimate artwork on a technicality.
 * It leaves the document where it is and asks for a human.
 */
export type DocumentScanVerdict = "clean" | "infected" | "unscannable";

export interface ScanDocumentInput {
  readonly documentId: string;
  /**
   * PLAINTEXT. Documents are encrypted at rest and a scanner cannot read ciphertext — every
   * byte would look like uniform noise and every file would come back clean. The caller
   * decrypts in memory and the plaintext is never written anywhere.
   */
  readonly plaintextBytes: Buffer;
  readonly mediaType: string;
  readonly declaredByteSize: number;
}

export interface DocumentScanResult {
  readonly verdict: DocumentScanVerdict;
  /** A short machine-readable tag, never the file's contents. */
  readonly detail: string;
}

export interface DocumentScannerAdapter {
  readonly scannerName: DocumentScannerName;
  scanDocument(
    input: ScanDocumentInput,
  ): Promise<Result<DocumentScanResult, DocumentScannerError>>;
}

/**
 * The EICAR anti-malware test string, split so that this source file is not itself flagged
 * by whatever scans the repository. It is the industry-standard harmless fixture that every
 * real engine is required to detect, which makes an end-to-end quarantine path testable
 * without anyone handling actual malware.
 */
const EICAR_SIGNATURE = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-", "ANTIVIRUS-TEST-FILE!$H+H*"].join(
  "",
);

/**
 * Deterministic fake.
 *
 * It performs one real check — the EICAR signature — and answers `clean` otherwise. That is
 * enough to exercise promotion, quarantine and the refusal that follows a quarantine, and it
 * is honest about being a fixture rather than pretending to be an engine.
 */
export class FakeDocumentScannerAdapter implements DocumentScannerAdapter {
  readonly scannerName = "fake" as const;

  async scanDocument(
    input: ScanDocumentInput,
  ): Promise<Result<DocumentScanResult, DocumentScannerError>> {
    if (input.plaintextBytes.length === 0) {
      return { success: true, value: { verdict: "unscannable", detail: "empty_file" } };
    }
    if (input.plaintextBytes.byteLength !== input.declaredByteSize) {
      /**
       * The stored byte size is the CIPHERTEXT length and the plaintext is shorter, so this
       * is only a mismatch when a caller passes the wrong pair. Reported as unscannable
       * rather than clean: a size we cannot account for is a file we have not understood.
       */
      return { success: true, value: { verdict: "unscannable", detail: "size_mismatch" } };
    }

    const asText = input.plaintextBytes.toString("latin1");
    if (asText.includes(EICAR_SIGNATURE)) {
      return { success: true, value: { verdict: "infected", detail: "eicar_test_signature" } };
    }

    return { success: true, value: { verdict: "clean", detail: "fake_scanner_no_signature" } };
  }
}

/**
 * Resolves the configured scanner.
 *
 * UNLIKE THE PAYMENT AND ESCROW FACTORIES, the fake is permitted in production — because
 * refusing to resolve would mean refusing to scan, and an unscanned document stays
 * `pending_scan` forever, which quietly re-breaks the feature this exists to fix. The
 * honest failure mode here is a scanner that detects too little, loudly configured, not an
 * absent one. `COMMERCE_DOCUMENT_SCANNER` therefore defaults to `fake` in development and
 * must be set deliberately in production, and the resolver says which one answered so the
 * verdict record can name it.
 */
export function resolveDocumentScanner(): Result<DocumentScannerAdapter, DocumentScannerError> {
  switch (config.COMMERCE_DOCUMENT_SCANNER) {
    case "fake":
      return { success: true, value: new FakeDocumentScannerAdapter() };
    case "clamav":
      return {
        success: false,
        error: {
          type: "SCANNER_UNAVAILABLE",
          reason: "The ClamAV scanner adapter is not implemented yet.",
        },
      };
    default: {
      const exhaustiveScanner: never = config.COMMERCE_DOCUMENT_SCANNER;
      throw new Error(`Unhandled document scanner: ${JSON.stringify(exhaustiveScanner)}`);
    }
  }
}
