/**
 * Binary glTF (.glb) validation for a listing's optional 3D model (STORE Appendix A47). Bytes
 * only — no parser. This takes the position `src/modules/rnd/pdf.ts` takes for PDFs, for the same
 * reason: a glTF loader is a large amount of code interpreting attacker-controlled structure, and
 * this module makes exactly the claims a header inspection can make.
 *
 * WHAT THIS PROVES, precisely: the bytes open with the glTF container magic, declare container
 * version 2, declare a total length that matches the bytes actually received (the truncation
 * check — the analogue of the PDF trailer scan), and carry a JSON chunk first, as glTF 2.0 §4.4.3
 * requires. That rejects the accidental case (a `.gltf` JSON text, an `.obj`, an `.fbx` renamed)
 * and the trivially malicious case (an HTML page renamed `.glb`, which a browser would then be
 * asked to fetch from a public CDN and hand to a renderer).
 *
 * WHAT THIS DOES NOT PROVE, and no caller may assume: that the JSON chunk is valid glTF, that
 * the mesh renders, that its textures are sane, or that it is not hostile to a viewer. There is
 * no scan and no moderation on this path; the row records what was uploaded, nothing more, and
 * no copy anywhere may say the file was checked.
 *
 * The multipart layer (`upload-product-model.ts`) checks the declared mimetype and the size cap;
 * that is a client's claim about its own upload. This module checks the bytes. Both run, in that
 * order, for the same reason §1 re-validates everything a client sends.
 */

/**
 * 10 MiB, matching the multer cap so the two cannot disagree.
 *
 * ⚠️ THIS IS CLOUDINARY'S PER-FILE CAP FOR `resource_type: "raw"` ON THE FREE PLAN, not a product
 * judgement. A Draco- or meshopt-compressed furniture model is single-digit megabytes; the number
 * rises with the plan, and it lives here rather than in a CHECK so raising it is a constant, not
 * a migration.
 */
export const MAX_PRODUCT_MODEL_BYTES = 10 * 1024 * 1024;

/** The fixed 12-byte container header: magic, version, total length — glTF 2.0 §4.4.1. */
const GLB_HEADER_BYTES = 12;
/** Every chunk opens with its length and its type, 4 bytes each — glTF 2.0 §4.4.2. */
const GLB_CHUNK_HEADER_BYTES = 8;
/** `{"asset":{"version":"2.0"}}` is 27 bytes; chunks are padded to a 4-byte boundary. */
const MINIMUM_JSON_CHUNK_BYTES = 28;

/**
 * Below this a file cannot be a GLB at all — header, one chunk header, the smallest conforming
 * JSON chunk. Chosen to reject the empty and near-empty uploads a flaky client produces, not as
 * a quality bar.
 */
const MIN_PRODUCT_MODEL_BYTES =
  GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + MINIMUM_JSON_CHUNK_BYTES;

/** `glTF` in ASCII, read as a little-endian uint32. */
const GLB_MAGIC = 0x46546c67;
/** `JSON` in ASCII, read as a little-endian uint32 — the type of the mandatory first chunk. */
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
/** The only container version that exists; glTF 1.0's binary form was a different, retired format. */
const SUPPORTED_GLB_VERSION = 2;

export type GlbValidationError =
  | { type: "EMPTY" }
  | { type: "TOO_SMALL"; byteSize: number }
  | { type: "TOO_LARGE"; byteSize: number }
  | { type: "NOT_A_GLB" }
  | { type: "UNSUPPORTED_GLTF_VERSION"; version: number }
  | { type: "LENGTH_MISMATCH"; declaredLength: number; byteSize: number }
  | { type: "MISSING_JSON_CHUNK" };

export interface ValidatedGlb {
  readonly byteSize: number;
  /** The declared container version. Always 2 when validation passed; useful in a message. */
  readonly version: number;
}

/**
 * Validates that `bytes` are plausibly a binary glTF 2.0 file, returning the facts worth
 * recording.
 *
 * Returns a discriminated error rather than throwing, so the controller can map each case to
 * its own message — "this is not a .glb" and "this file was cut off in transit" are different
 * things to tell someone, and one of them means "try again".
 */
export function validateGlbBytes(bytes: Buffer): ValidatedGlb | GlbValidationError {
  if (bytes.length === 0) return { type: "EMPTY" };
  if (bytes.length < MIN_PRODUCT_MODEL_BYTES) {
    return { type: "TOO_SMALL", byteSize: bytes.length };
  }
  if (bytes.length > MAX_PRODUCT_MODEL_BYTES) {
    return { type: "TOO_LARGE", byteSize: bytes.length };
  }

  // `readUInt32LE`, not `toString()`: decoding the upload as a string to compare four bytes
  // allocates the whole buffer as UTF-16 — the same point `pdf.ts` makes about `equals`.
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) return { type: "NOT_A_GLB" };

  const version = bytes.readUInt32LE(4);
  if (version !== SUPPORTED_GLB_VERSION) {
    return { type: "UNSUPPORTED_GLTF_VERSION", version };
  }

  // The header's own claim about the file's length. A mismatch is a truncated transfer or a
  // file with bytes appended after the container — either way not the file the header describes.
  const declaredLength = bytes.readUInt32LE(8);
  if (declaredLength !== bytes.length) {
    return { type: "LENGTH_MISMATCH", declaredLength, byteSize: bytes.length };
  }

  const jsonChunkLength = bytes.readUInt32LE(GLB_HEADER_BYTES);
  const jsonChunkType = bytes.readUInt32LE(GLB_HEADER_BYTES + 4);
  if (
    jsonChunkType !== GLB_JSON_CHUNK_TYPE ||
    GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + jsonChunkLength > bytes.length
  ) {
    return { type: "MISSING_JSON_CHUNK" };
  }

  return { byteSize: bytes.length, version };
}

/** Narrows the union `validateGlbBytes` returns. */
export function isGlbValidationError(
  result: ValidatedGlb | GlbValidationError,
): result is GlbValidationError {
  return "type" in result;
}
