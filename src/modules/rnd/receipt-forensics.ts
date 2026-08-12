import sharp from "sharp";

/**
 * Image forensics for physical-work receipts (R_AND_D_BACKEND_STRUCTURE.md §9.10;
 * PROOF_OF_EFFORT_SPEC.md §4's hardware edge case).
 *
 * WHY THIS EXISTS. Git is deterministic; sanding a 3D-printed chassis is not. For
 * non-digital work the only receipt is an uploaded photograph — and a photograph is the
 * easiest evidence in the world to fake, because a stock image or a re-upload of last
 * month's picture looks identical to real work.
 *
 * Two hashes, doing two different jobs:
 *
 *   - `contentSha256` is IDENTITY. The same bytes cannot fund two receipts, enforced by a
 *     unique index. It catches a literal re-upload.
 *   - `perceptualHash` is SIMILARITY. Re-crop, re-compress or screenshot the same photo
 *     and every byte changes while the pixels do not — sha256 sees two files, this sees
 *     one picture. It is INDEXED but not unique, deliberately: a second honest photo of
 *     the same workbench should be flagged for a human, never rejected outright.
 *
 * EVERYTHING HERE READS THE RAW UPLOAD, BEFORE NORMALIZATION.
 * `validateAndNormalizeImage` re-encodes and strips all metadata by design (EXIF and GPS
 * gone), so EXIF must be read from the original bytes or not at all.
 */

/**
 * dHash, 64 bits, over a 9×8 grayscale reduction.
 *
 * WHY dHash RATHER THAN aHash OR pHash. Average-hash compares each pixel to the image
 * mean and collapses under a brightness shift; pHash needs a DCT, which is more code and
 * more CPU for no gain at this scale. dHash compares each pixel to its RIGHT-HAND
 * NEIGHBOUR, so it measures GRADIENT rather than absolute luminance — which makes it
 * stable under exposure changes, re-compression and moderate re-crops, the three things a
 * re-uploader actually does.
 *
 * `9 × 8 = 72` pixels produce exactly `8 × 8 = 64` comparisons, one bit each, emitted as
 * 16 lowercase hex characters. Fixed width, so two hashes are comparable with a plain
 * Hamming distance.
 *
 * @throws if the bytes cannot be decoded — the caller has already proven they are an
 *         image, so a failure here is an unrecoverable programmer error (CLAUDE.md §3.3).
 */
export async function computePerceptualHash(rawImageBytes: Buffer): Promise<string> {
  const { data } = await sharp(rawImageBytes)
    // `fit: "fill"` on purpose: the aspect ratio is deliberately discarded so a crop of
    // the same scene still reduces to a comparable grid.
    .resize(9, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const left = data[row * 9 + column] ?? 0;
      const right = data[row * 9 + column + 1] ?? 0;
      bits += left > right ? "1" : "0";
    }
  }

  // Grouped into 16 nibbles rather than built with BigInt: the string form is what is
  // stored and compared, and going through a number would invite a float somewhere.
  let hex = "";
  for (let nibble = 0; nibble < 16; nibble += 1) {
    hex += Number.parseInt(bits.slice(nibble * 4, nibble * 4 + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Hamming distance between two dHashes — how many of the 64 bits differ.
 *
 * A distance under about 10 means "almost certainly the same picture"; over about 20 means
 * "unrelated". The middle is genuinely ambiguous, which is why this returns a NUMBER and
 * the decision to flag lives with the caller rather than being buried here.
 *
 * @throws on malformed input, rather than returning a distance that means nothing.
 */
export function perceptualHashDistance(left: string, right: string): number {
  if (left.length !== right.length) {
    throw new Error(
      `perceptualHashDistance: hashes must be the same length, got ${left.length} and ${right.length}`,
    );
  }

  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftNibble = Number.parseInt(left[index] ?? "0", 16);
    const rightNibble = Number.parseInt(right[index] ?? "0", 16);
    if (Number.isNaN(leftNibble) || Number.isNaN(rightNibble)) {
      throw new Error("perceptualHashDistance: hashes must be lowercase hex");
    }
    let difference = leftNibble ^ rightNibble;
    while (difference > 0) {
      distance += difference & 1;
      difference >>= 1;
    }
  }
  return distance;
}

export interface ReceiptExif {
  /**
   * EXIF `DateTimeOriginal` — when the CAMERA says the shutter fired.
   *
   * READ AS UTC, and that is a documented quantization rather than an oversight: EXIF
   * records a naive local time with no zone, so no reading of it can be zone-correct. It
   * is only ever used to measure the SPAN between two receipts on one claim, and a span is
   * zone-invariant as long as both ends use the same convention. It is never rendered to a
   * user as an instant.
   */
  readonly capturedAt: Date | null;
  /**
   * Make + model + body serial, concatenated. The SERVICE salts and hashes this before it
   * touches a column — a camera body serial is biometric-adjacent in some jurisdictions
   * and identifies a person across every photo they have ever taken (§9.10).
   */
  readonly deviceFingerprintSource: string | null;
  /** Whether the upload carried EXIF at all. A stock image usually does not. */
  readonly hasExif: boolean;
}

const TIFF_TAG_MAKE = 0x01_0f;
const TIFF_TAG_MODEL = 0x01_10;
const TIFF_TAG_EXIF_SUB_IFD = 0x87_69;
const EXIF_TAG_DATE_TIME_ORIGINAL = 0x90_03;
const EXIF_TAG_BODY_SERIAL_NUMBER = 0xa4_31;
const TIFF_TYPE_ASCII = 2;

/**
 * Reads the handful of EXIF tags forensics actually uses.
 *
 * A HAND-ROLLED PARSER RATHER THAN A DEPENDENCY, because the surface needed is four tags
 * and the alternative is a package that parses two hundred — including maker-note blobs
 * from untrusted uploads, which is a parsing attack surface bought for nothing. Everything
 * below is bounds-checked against the buffer and returns null rather than throwing: a
 * malformed EXIF block is an ordinary property of real uploads, not an error.
 */
export async function readReceiptExif(rawImageBytes: Buffer): Promise<ReceiptExif> {
  let exifBlock: Buffer | undefined;
  try {
    exifBlock = (await sharp(rawImageBytes).metadata()).exif;
  } catch {
    return { capturedAt: null, deviceFingerprintSource: null, hasExif: false };
  }

  if (!exifBlock || exifBlock.length < 8) {
    return { capturedAt: null, deviceFingerprintSource: null, hasExif: false };
  }

  // sharp hands back the block with the "Exif\0\0" APP1 preamble already removed, so the
  // TIFF header is at offset 0. Guarded anyway, because a container that keeps it would
  // otherwise be parsed as garbage.
  const tiff = exifBlock.subarray(
    exifBlock.subarray(0, 6).toString("latin1") === "Exif\0\0" ? 6 : 0,
  );

  const byteOrder = tiff.subarray(0, 2).toString("latin1");
  if (byteOrder !== "II" && byteOrder !== "MM") {
    return { capturedAt: null, deviceFingerprintSource: null, hasExif: true };
  }
  const isLittleEndian = byteOrder === "II";

  const readUint16 = (offset: number): number | null =>
    offset + 2 > tiff.length
      ? null
      : isLittleEndian
        ? tiff.readUInt16LE(offset)
        : tiff.readUInt16BE(offset);
  const readUint32 = (offset: number): number | null =>
    offset + 4 > tiff.length
      ? null
      : isLittleEndian
        ? tiff.readUInt32LE(offset)
        : tiff.readUInt32BE(offset);

  const firstIfdOffset = readUint32(4);
  if (firstIfdOffset === null) {
    return { capturedAt: null, deviceFingerprintSource: null, hasExif: true };
  }

  const collected = new Map<number, string | number>();

  /** Walks one IFD, collecting the ASCII and LONG values of the tags we care about. */
  const walkIfd = (ifdOffset: number, wantedTags: ReadonlySet<number>): void => {
    const entryCount = readUint16(ifdOffset);
    if (entryCount === null || entryCount > 512) return;

    for (let entry = 0; entry < entryCount; entry += 1) {
      const entryOffset = ifdOffset + 2 + entry * 12;
      const tag = readUint16(entryOffset);
      const type = readUint16(entryOffset + 2);
      const count = readUint32(entryOffset + 4);
      if (tag === null || type === null || count === null || !wantedTags.has(tag)) continue;

      if (type === TIFF_TYPE_ASCII) {
        // ASCII values of four bytes or fewer live INLINE in the value field; longer ones
        // are an offset. Getting this backwards silently reads the offset as text.
        const valueOffset = count <= 4 ? entryOffset + 8 : readUint32(entryOffset + 8);
        if (valueOffset === null || valueOffset + count > tiff.length) continue;
        collected.set(
          tag,
          tiff
            .subarray(valueOffset, valueOffset + count)
            .toString("latin1")
            // `replaceAll`, not a regex: EXIF ASCII values are NUL-padded, and a NUL
            // inside a regex literal is both unreadable in a diff and a lint error.
            .replaceAll("\u0000", "")
            .trim(),
        );
        continue;
      }

      const pointer = readUint32(entryOffset + 8);
      if (pointer !== null) collected.set(tag, pointer);
    }
  };

  walkIfd(firstIfdOffset, new Set([TIFF_TAG_MAKE, TIFF_TAG_MODEL, TIFF_TAG_EXIF_SUB_IFD]));

  const subIfdOffset = collected.get(TIFF_TAG_EXIF_SUB_IFD);
  if (typeof subIfdOffset === "number") {
    walkIfd(subIfdOffset, new Set([EXIF_TAG_DATE_TIME_ORIGINAL, EXIF_TAG_BODY_SERIAL_NUMBER]));
  }

  const fingerprintParts = [
    collected.get(TIFF_TAG_MAKE),
    collected.get(TIFF_TAG_MODEL),
    collected.get(EXIF_TAG_BODY_SERIAL_NUMBER),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  const dateTimeOriginal = collected.get(EXIF_TAG_DATE_TIME_ORIGINAL);

  return {
    capturedAt: typeof dateTimeOriginal === "string" ? parseExifDateTime(dateTimeOriginal) : null,
    deviceFingerprintSource: fingerprintParts.length > 0 ? fingerprintParts.join(" ") : null,
    hasExif: true,
  };
}

/**
 * Parses EXIF's `YYYY:MM:DD HH:MM:SS`.
 *
 * Built through `Date.UTC` rather than `new Date(string)`: the EXIF form is not ISO-8601,
 * and every engine parses non-ISO strings by its own rules — which is exactly the kind of
 * silent per-platform divergence §4c exists to remove. Returns null on anything malformed,
 * including the all-zeroes value cameras write when the clock was never set.
 */
function parseExifDateTime(value: string): Date | null {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(instant.getTime()) ? null : instant;
}
