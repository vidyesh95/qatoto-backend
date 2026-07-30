/**
 * PDF validation for the §10 research-paper library. Bytes only — no parser.
 *
 * WHY THERE IS NO PDF LIBRARY HERE. A PDF parser is a large amount of code
 * interpreting attacker-controlled structure, and every one of them has a CVE history
 * involving embedded fonts, JavaScript actions and malformed xref tables. This module
 * makes exactly the claims it can make from a byte inspection, which is the same
 * position `src/lib/receipt-forensics.ts` takes on EXIF: it hand-reads four tags rather
 * than adding a dependency whose job is to interpret hostile input.
 *
 * WHAT THIS PROVES, precisely: the bytes begin with a PDF header, declare a version
 * this decade's readers understand, contain a trailer marker, and fall inside a size
 * bound. That is enough to reject the accidental case (someone uploaded a .docx) and
 * the trivially malicious case (an HTML page renamed .pdf, which a browser would then
 * be asked to render from our bucket).
 *
 * WHAT THIS DOES NOT PROVE, and no caller may assume: that the document is
 * well-formed, that it renders, that it has the page count it claims, that it contains
 * no JavaScript, and that it is the paper its title says it is. The last one is a
 * MODERATION question, which is why every paper lands `queued` and a human approves it
 * before it is listed publicly. Validation is not review.
 *
 * The multipart layer (`src/middleware/upload-research-paper.ts`) checks the declared
 * mimetype and the size cap; that is a client's claim about its own upload. This module
 * checks the bytes. Both run, in that order, for the same reason §1 re-validates
 * everything a client sends.
 */

/** `%PDF-` — the header every PDF opens with, per ISO 32000 §7.5.2. */
const PDF_HEADER = Buffer.from("%PDF-", "ascii");

/**
 * `%%EOF` — the trailer marker. Searched for in the LAST 2 KiB rather than at the exact
 * end, because writers legitimately append newlines, and incremental updates leave
 * earlier `%%EOF` markers behind. Its presence says the file was not truncated
 * mid-transfer, which is the failure this catches.
 */
const PDF_TRAILER = Buffer.from("%%EOF", "ascii");
const TRAILER_SEARCH_WINDOW_BYTES = 2048;

/**
 * 25 MiB, matching the multer cap so the two cannot disagree. A preprint with figures
 * is single-digit megabytes; well past this and it is a dataset wearing a paper's
 * extension, and object storage priced per gigabyte is not where that belongs.
 */
export const MAX_PAPER_BYTES = 25 * 1024 * 1024;

/**
 * Below this a file cannot be a PDF at all — header, one object, trailer. Chosen to
 * reject the empty and near-empty uploads a flaky client produces, not as a quality
 * bar.
 */
const MIN_PAPER_BYTES = 512;

export type PdfValidationError =
  | { type: "EMPTY" }
  | { type: "TOO_SMALL"; byteSize: number }
  | { type: "TOO_LARGE"; byteSize: number }
  | { type: "NOT_A_PDF" }
  | { type: "UNSUPPORTED_PDF_VERSION"; version: string }
  | { type: "TRUNCATED" };

export interface ValidatedPdf {
  readonly byteSize: number;
  /** The declared version, e.g. `"1.7"`. Stored nowhere; useful in an error message. */
  readonly version: string;
}

/**
 * The versions in the header we accept. 1.0–1.7 is ISO 32000-1 and 2.0 is 32000-2;
 * anything else is either a typo or a forgery, and an allowlist is the only form of
 * this check that does not need updating when someone invents `%PDF-9.9`.
 */
const SUPPORTED_PDF_VERSIONS: ReadonlySet<string> = new Set([
  "1.0",
  "1.1",
  "1.2",
  "1.3",
  "1.4",
  "1.5",
  "1.6",
  "1.7",
  "2.0",
]);

/**
 * Validates that `bytes` are plausibly a PDF, returning the facts worth recording.
 *
 * Returns a discriminated error rather than throwing, so the controller can map each
 * case to its own 422 message — "this is not a PDF" and "this file was cut off in
 * transit" are different things to tell someone, and one of them means "try again".
 */
export function validatePdfBytes(bytes: Buffer): ValidatedPdf | PdfValidationError {
  if (bytes.length === 0) return { type: "EMPTY" };
  if (bytes.length < MIN_PAPER_BYTES) return { type: "TOO_SMALL", byteSize: bytes.length };
  if (bytes.length > MAX_PAPER_BYTES) return { type: "TOO_LARGE", byteSize: bytes.length };

  // `subarray` + `equals`, not `toString().startsWith()`: decoding arbitrary bytes as
  // a string to compare a 5-byte prefix allocates the whole upload as UTF-16.
  if (!bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) {
    return { type: "NOT_A_PDF" };
  }

  // The version follows the header as `M.m`, so exactly three ASCII characters.
  const version = bytes.subarray(PDF_HEADER.length, PDF_HEADER.length + 3).toString("ascii");
  if (!SUPPORTED_PDF_VERSIONS.has(version)) {
    return { type: "UNSUPPORTED_PDF_VERSION", version };
  }

  const trailerWindow = bytes.subarray(Math.max(0, bytes.length - TRAILER_SEARCH_WINDOW_BYTES));
  if (!trailerWindow.includes(PDF_TRAILER)) {
    return { type: "TRUNCATED" };
  }

  return { byteSize: bytes.length, version };
}

/** Narrows the union `validatePdfBytes` returns. */
export function isPdfValidationError(
  result: ValidatedPdf | PdfValidationError,
): result is PdfValidationError {
  return "type" in result;
}
