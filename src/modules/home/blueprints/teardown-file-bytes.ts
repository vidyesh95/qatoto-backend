import { isPdfValidationError, MAX_PAPER_BYTES, validatePdfBytes } from "#src/modules/rnd/pdf.js";
import { isGlbValidationError, validateGlbBytes } from "#src/modules/store/catalog/glb.js";

/**
 * Byte-level validation for an uploaded teardown document or fabrication file. Bytes only — no
 * parser. This takes the position `src/modules/rnd/pdf.ts` and `src/modules/store/catalog/glb.ts`
 * take, for the same reason: a CAD reader is a large amount of code interpreting attacker-controlled
 * structure, and this module makes exactly the claims a header inspection can make.
 *
 * ⚠️ THIS IS THE CONTROL THAT REPLACES THE RE-ENCODE, AND IT IS WEAKER THAN ONE. Every other upload
 * on this platform is an image: `src/lib/image.ts` decodes the bytes and writes new ones, so what
 * lands in storage is something sharp produced rather than something a client sent. Nothing
 * equivalent exists for CAD. The bytes stored here are the bytes uploaded, and all that stands
 * between them and a reader is the framing check below plus the delivery decisions in
 * `object-storage.ts` — a private bucket, a pinned `Content-Type`, and `attachment` disposition set
 * at PUT time.
 *
 * WHAT THIS PROVES, precisely: that the container's framing is internally consistent and matches the
 * format the client DECLARED. That rejects the accidental case (a `.dxf` saved as `.step`, a
 * truncated transfer) and the trivially malicious one (an HTML page renamed `.step`, which is the
 * shape that turns a file listing into a stored-XSS vector on any surface that renders it inline).
 *
 * ⚠️ WHAT THIS DOES NOT PROVE, and no caller and no copy anywhere may assume: that the file is what
 * its TITLE says, that it opens, that it is a model of the thing the teardown surveys, or that it is
 * safe to hand to a CAD program. A hostile STEP or DXF that exploits a reader's parser is fully
 * representable inside a well-framed file, and a PDF that passes `validatePdfBytes` may still carry
 * JavaScript actions, embedded files and external references. There is no scan on this path. The
 * phrase `store.controller.ts` uses is the one to reuse: nothing here claims the file was scanned.
 *
 * ⚠️ THE DECLARED `format` IS PART OF THE CONTROL, NOT DECORATION. The multipart layer can only
 * check `file.mimetype`, and browsers send `application/octet-stream` for `.step`, `.stl` and `.dxf`
 * far more often than any registered type — so that gate refuses almost nothing and must not be
 * mistaken for validation. Making the client NAME the format and then proving the bytes support that
 * name is what stops it storing bytes under a label they do not carry. Same shape as
 * `evidenceBytesMatchMediaType` in the commerce verification upload.
 */

/**
 * The five formats the uploaded arm accepts. A pasted link may still be any of the eight kinds.
 *
 * ⚠️ `glb` IS A MODEL, NOT A DOCUMENT, AND IT TRAVELS THE SAME ROUTE ANYWAY. It is never filed into
 * `teardown_document` or `teardown_manufacturing_file` — it lands on `teardown_assembly.model_url`'s
 * uploaded arm, or on a part's. Sharing the upload route is what keeps one staging table, one
 * ceiling, one sweep and one download gate; a second route for one format would have been a second
 * of each.
 */
export const TEARDOWN_UPLOAD_FORMATS = ["pdf", "step", "stl", "dxf", "glb"] as const;
export type TeardownUploadFormat = (typeof TEARDOWN_UPLOAD_FORMATS)[number];

/**
 * 50 MiB for CAD, against `MAX_PAPER_BYTES`' 25 MiB for a PDF.
 *
 * ⚠️ A SEPARATE CONSTANT IS CORRECT HERE AND WOULD BE WRONG FOR THE PDF ARM. `upload-video-document.ts`
 * argues the rule: `MAX_PAPER_BYTES` is reused rather than re-invented because `validatePdfBytes`
 * HARDCODES it in its own `TOO_LARGE` branch, so a second PDF cap would mean two limits that
 * eventually disagree — surfacing as a confusing 422 after a successful 25 MB transfer. The CAD
 * validators below are new and hardcode nothing, so they take a cap of their own; an assembly STEP
 * of a real product is routinely larger than a research paper.
 */
export const MAX_TEARDOWN_FABRICATION_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Below this a CAD text format cannot carry a conforming header. Not a quality bar.
 *
 * ⚠️ IT APPLIES TO `step`, `stl` AND `dxf` ONLY, AND THE ORDERING MATTERS. `pdf` and `glb` are
 * delegated to validators that carry their own floors — 512 and 48 bytes — and a conforming minimal
 * `.glb` is 49 bytes, so applying this 64-byte floor to it refused a valid file. Found by a smoke
 * run, not by a unit test: the fixture there is the smallest legal model, which is exactly the
 * shape a made-up floor rejects.
 */
const MINIMUM_TEARDOWN_FILE_BYTES = 64;

/** The fixed part of a binary STL: 80-byte comment header plus a uint32 triangle count. */
const BINARY_STL_HEADER_BYTES = 84;
/** Each binary STL triangle is 12 floats plus a uint16 attribute count. */
const BINARY_STL_TRIANGLE_BYTES = 50;

export type TeardownFileValidationError =
  | { readonly type: "EMPTY" }
  | { readonly type: "TOO_SMALL"; readonly byteSize: number }
  | { readonly type: "TOO_LARGE"; readonly byteSize: number }
  | { readonly type: "FORMAT_MISMATCH"; readonly declaredFormat: TeardownUploadFormat }
  | { readonly type: "TRUNCATED"; readonly declaredFormat: TeardownUploadFormat };

export interface ValidatedTeardownFile {
  readonly byteSize: number;
  readonly format: TeardownUploadFormat;
}

export function isTeardownFileValidationError(
  candidate: ValidatedTeardownFile | TeardownFileValidationError,
): candidate is TeardownFileValidationError {
  return "type" in candidate;
}

/**
 * ISO 10303-21 §4: a part-21 exchange file opens `ISO-10303-21;` and closes `END-ISO-10303-21;`.
 * Both markers are mandated by the spec rather than conventional, which is what makes checking them
 * a real control rather than a heuristic. Binary and zipped STEP are refused: they are a second
 * container to reason about, and a fab wants the text form.
 */
function stepBytesAreWellFramed(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 64).toString("latin1").trimStart();
  if (!head.startsWith("ISO-10303-21;")) return false;
  // The tail, not a full scan: the closing marker is the last non-whitespace token in the file.
  return bytes.subarray(-64).toString("latin1").trimEnd().endsWith("END-ISO-10303-21;");
}

/**
 * ASCII DXF only. The file opens with the group-code pair `0` / `SECTION` and ends with `EOF`.
 *
 * ⚠️ BINARY DXF IS REFUSED DELIBERATELY. Its sentinel is `AutoCAD Binary DXF\r\n\x1a\0`, so
 * detecting it would be easy — the reason to refuse is that accepting it means a second parser
 * surface for a format a fab does not need, and "we accept the one spelling" is a rule an author
 * can act on.
 */
function dxfBytesAreWellFramed(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 64).toString("latin1").trimStart();
  if (!/^0\s+SECTION/.test(head)) return false;
  return bytes.subarray(-32).toString("latin1").trimEnd().endsWith("EOF");
}

/**
 * ASCII STL opens `solid ` and closes `endsolid`; binary STL carries an ARITHMETIC INVARIANT.
 *
 * ⚠️ THE BINARY ARM IS THE STRONGEST CHECK IN THIS MODULE, and it is worth having for that alone:
 * `byteLength === 84 + 50 * triangleCount`, where the count is the uint32 at offset 80. A file that
 * is not an STL essentially cannot satisfy that by accident, and a truncated one cannot satisfy it
 * at all — so the truncation check and the format check are the same test.
 */
function stlBytesAreWellFramed(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 6).toString("latin1");
  if (head === "solid ") {
    return bytes.subarray(-16).toString("latin1").trimEnd().includes("endsolid");
  }
  if (bytes.length < BINARY_STL_HEADER_BYTES) return false;
  const triangleCount = bytes.readUInt32LE(80);
  return bytes.length === BINARY_STL_HEADER_BYTES + BINARY_STL_TRIANGLE_BYTES * triangleCount;
}

/**
 * Proves the bytes support the format the client declared.
 *
 * The `pdf` arm delegates to `validatePdfBytes` rather than re-implementing a header scan: that
 * module already proves the header, the version allowlist and the trailer, and it has its own test
 * suite. Forking it would be two PDF validators that drift.
 */
export function validateTeardownFileBytes(
  declaredFormat: TeardownUploadFormat,
  bytes: Buffer,
): ValidatedTeardownFile | TeardownFileValidationError {
  if (bytes.length === 0) return { type: "EMPTY" };

  if (declaredFormat === "pdf") {
    const validated = validatePdfBytes(bytes);
    if (isPdfValidationError(validated)) {
      /*
       * The PDF union is richer than this one, and it is narrowed rather than widened: `EMPTY`,
       * `TOO_SMALL`, `TOO_LARGE` and `TRUNCATED` carry straight across, and the two that are
       * PDF-specific (`NOT_A_PDF`, `UNSUPPORTED_PDF_VERSION`) both mean the same thing to an
       * author — the bytes are not the format you said.
       */
      switch (validated.type) {
        case "EMPTY":
          return { type: "EMPTY" };
        case "TOO_SMALL":
          return { type: "TOO_SMALL", byteSize: validated.byteSize };
        case "TOO_LARGE":
          return { type: "TOO_LARGE", byteSize: validated.byteSize };
        case "TRUNCATED":
          return { type: "TRUNCATED", declaredFormat };
        case "NOT_A_PDF":
        case "UNSUPPORTED_PDF_VERSION":
          return { type: "FORMAT_MISMATCH", declaredFormat };
        default: {
          const exhaustiveCheck: never = validated;
          throw new Error(`Unhandled PDF validation error: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    }
    return { byteSize: validated.byteSize, format: "pdf" };
  }

  if (declaredFormat === "glb") {
    /*
     * ⚠️ DELEGATED TO `validateGlbBytes`, NEVER RE-IMPLEMENTED — the same rule the `pdf` arm
     * follows. That module proves the glTF container magic, container version 2, a declared total
     * length matching the bytes received (the truncation check) and a JSON first chunk, and it has
     * its own test suite. It also hardcodes `MAX_PRODUCT_MODEL_BYTES` in its own `TOO_LARGE`
     * branch, so a second cap here would mean two limits that eventually disagree.
     */
    const validated = validateGlbBytes(bytes);
    if (isGlbValidationError(validated)) {
      switch (validated.type) {
        case "EMPTY":
          return { type: "EMPTY" };
        case "TOO_SMALL":
          return { type: "TOO_SMALL", byteSize: validated.byteSize };
        case "TOO_LARGE":
          return { type: "TOO_LARGE", byteSize: validated.byteSize };
        // The glTF container declares its own total length; a mismatch is a truncated transfer.
        case "LENGTH_MISMATCH":
          return { type: "TRUNCATED", declaredFormat };
        case "NOT_A_GLB":
        case "UNSUPPORTED_GLTF_VERSION":
        case "MISSING_JSON_CHUNK":
          return { type: "FORMAT_MISMATCH", declaredFormat };
        default: {
          const exhaustiveCheck: never = validated;
          throw new Error(`Unhandled GLB validation error: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    }
    return { byteSize: validated.byteSize, format: "glb" };
  }

  if (bytes.length < MINIMUM_TEARDOWN_FILE_BYTES) {
    return { type: "TOO_SMALL", byteSize: bytes.length };
  }
  if (bytes.length > MAX_TEARDOWN_FABRICATION_FILE_BYTES) {
    return { type: "TOO_LARGE", byteSize: bytes.length };
  }

  switch (declaredFormat) {
    case "step":
      return stepBytesAreWellFramed(bytes)
        ? { byteSize: bytes.length, format: "step" }
        : { type: "FORMAT_MISMATCH", declaredFormat };
    case "stl":
      return stlBytesAreWellFramed(bytes)
        ? { byteSize: bytes.length, format: "stl" }
        : { type: "FORMAT_MISMATCH", declaredFormat };
    case "dxf":
      return dxfBytesAreWellFramed(bytes)
        ? { byteSize: bytes.length, format: "dxf" }
        : { type: "FORMAT_MISMATCH", declaredFormat };
    default: {
      const exhaustiveCheck: never = declaredFormat;
      throw new Error(`Unhandled teardown upload format: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** The per-format ceiling, so the multipart layer and this module cannot disagree. */
export function maximumBytesForTeardownUpload(): number {
  /*
   * The multer cap must admit the LARGEST format; the per-format checks narrow it afterwards. GLB's
   * own ceiling lives in `validateGlbBytes` and is smaller than both of these, so it is not part of
   * the maximum — it is enforced where it is hardcoded.
   */
  return Math.max(MAX_PAPER_BYTES, MAX_TEARDOWN_FABRICATION_FILE_BYTES);
}
