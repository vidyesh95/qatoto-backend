import sharp, { type Metadata } from "sharp";

import type { Result } from "#src/types/index.js";

/**
 * Server-side image validation + normalization. The client's content-type and
 * dimensions are untrusted (CLAUDE.md §1.1): a hostile caller can label anything
 * `image/png`. We decode the bytes with sharp to PROVE they are a real raster
 * image, reject decompression bombs and out-of-range dimensions, then RE-ENCODE —
 * which strips EXIF/metadata and any non-image payload smuggled in the container.
 *
 * SHARED BY SEVEN CALL SITES with different output profiles — avatars (avif @ 1024px),
 * product images (avif @ 1600px), project covers, video thumbnails, physical receipts
 * (webp) and promotional slides (avif @ 2400px, twice). Everything but the output box and
 * codec is identical, so the validation core lives in {@link validateAndNormalizeImage} and
 * the entry points just pass options.
 *
 * BECAUSE IT IS SHARED, THE ALLOWLIST BELOW IS THE PLATFORM'S ANSWER to "what may anyone
 * upload?" — there is deliberately no per-caller override. No route wants a NARROWER set
 * than this one, and five copies of the answer is five things to keep in sync, with the copy
 * that drifted being the security-relevant one.
 */

/**
 * Formats we accept as input.
 *
 * `heif` IS THE CONTAINER, NOT THE CODEC, and that distinction is load-bearing: both AVIF and
 * HEIC report `format: "heif"`, but this build links only the AOM (AV1) decoder — libheif has
 * no libde265, so HEVC-coded HEIC parses its header and then FAILS AT DECODE. That is why
 * {@link detectUnsupportedInput} inspects `metadata.compression` rather than stopping at the
 * format name, and why the decode below is guarded. Adding "heif" without both would turn an
 * honest 422 into an opaque 500 for every iPhone photo.
 *
 * WHAT STAYS OUT, and why each is a decision rather than an oversight:
 *
 *   - `svg` — NEVER, non-negotiable. rsvg is linked and libvips would happily rasterize it.
 *     It stays out because SVG is script-bearing XML, not a raster image: accepting it means
 *     accepting an XML parser plus external-entity and network-fetch surface on fully
 *     untrusted bytes. `image.test.ts` asserts this refusal — a security invariant with no
 *     test is one someone deletes during a refactor.
 *   - `gif` — a 256-colour palette format with no source that cannot also export PNG, and it
 *     carries animation this static pipeline would silently flatten to frame 1.
 *   - `tiff` — a scanner/print format (multi-page, CMYK, 16-bit). No browser renders one, so
 *     an admin who picked a TIFF has already made a mistake and should be told.
 */
const ALLOWED_INPUT_FORMATS: ReadonlySet<string> = new Set(["jpeg", "png", "webp", "heif"]);

/** Reject images smaller than this on either side — too small to be a real photo. */
const MIN_DIMENSION_PX = 64;

/** Reject absurdly large source images outright (defense before the resize step). */
const MAX_DIMENSION_PX = 8192;

/**
 * Cap decoded pixel count to blunt decompression-bomb attacks (a tiny file that
 * expands to gigapixels). 8192×8192 worth of pixels is well above any real photo.
 */
const MAX_INPUT_PIXELS = MAX_DIMENSION_PX * MAX_DIMENSION_PX;

/** Default output box for avatars (never enlarged). */
const AVATAR_OUTPUT_MAX_DIMENSION_PX = 1024;

/**
 * WHY the bytes were refused, in enough detail to write a sentence a human can act on.
 *
 * A UNION RATHER THAN A `format: string` PLUS FLAGS, so "an animated HEIC" cannot be
 * constructed and every reason carries exactly the payload its sentence needs (CLAUDE.md
 * §3.2). The old shape was a bare format name, which produced `Unsupported image format:
 * heif` for a file the operating system calls `.avif` — technically true and useless.
 */
export type DetectedImageFormat =
  /** A HEIF container carrying HEVC — an iPhone photo. No decoder for it in this build. */
  | { kind: "heic" }
  /** More than one frame or page. Our output is a single still image. */
  | { kind: "animated"; format: string }
  /** gif, tiff, svg, bmp, or anything sharp named that we do not accept. */
  | { kind: "other"; format: string };

export type ImageValidationError =
  | { type: "NOT_AN_IMAGE" }
  | { type: "UNSUPPORTED_FORMAT"; detected: DetectedImageFormat }
  | { type: "DIMENSIONS_TOO_SMALL"; width: number; height: number }
  | { type: "DIMENSIONS_TOO_LARGE"; width: number; height: number };

/**
 * What a caller may upload, in the words a person uses rather than the words libvips uses.
 *
 * ONE SOURCE. Six HTTP error mappers used to spell this sentence out themselves, which is six
 * copies to update every time the allowlist moves — and the one that got missed would have
 * been telling users the wrong thing. They now call {@link describeUnsupportedImageFormat}.
 */
export const ACCEPTED_IMAGE_FORMATS_SENTENCE = "Use a JPEG, PNG, WebP or AVIF image.";

/** The user-facing sentence for one refusal. Names what to DO, not what libvips saw. */
export function describeUnsupportedImageFormat(detected: DetectedImageFormat): string {
  switch (detected.kind) {
    case "heic":
      // The one refusal the user can fix in fifteen seconds, so it says how.
      return (
        "iPhone HEIC photos aren't supported. On iPhone: Settings → Camera → Formats → " +
        `Most Compatible, or export the photo as JPEG. ${ACCEPTED_IMAGE_FORMATS_SENTENCE}`
      );
    case "animated":
      return `Animated images aren't supported — upload a still frame. ${ACCEPTED_IMAGE_FORMATS_SENTENCE}`;
    case "other":
      return `${detected.format.toUpperCase()} images aren't supported. ${ACCEPTED_IMAGE_FORMATS_SENTENCE}`;
    default: {
      const exhaustiveCheck: never = detected;
      throw new Error(`Unhandled detected image format: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Back-compat alias — the avatar pipeline named this type first. Identical
 * variants; kept so existing imports (users.service) don't churn.
 */
export type AvatarValidationError = ImageValidationError;

/** A normalized image ready to upload: re-encoded bytes plus its final dimensions. */
export interface NormalizedImage {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Back-compat alias for the avatar caller. */
export type NormalizedAvatar = NormalizedImage;

/** Output codec for the re-encoded buffer. */
export type ImageOutputFormat = "webp" | "avif";

/** Tunables for the re-encode step; validation bounds are fixed. */
export interface NormalizeImageOptions {
  /** Downscale to fit this box (px), never enlarged. */
  readonly outputMaxDimensionPx: number;
  /** Codec of the emitted buffer. avif is smaller-per-byte but slower to encode. */
  readonly outputFormat: ImageOutputFormat;
}

/**
 * Decides whether we refuse this input, from the HEADER ALONE — before any pixel is decoded.
 *
 * ORDER MATTERS. The codec check runs before the allowlist result is trusted, because "heif"
 * is on the allowlist while HALF of what it names (HEVC-coded HEIC) is undecodable here. The
 * animation check runs last because it is the only one that applies to a format we otherwise
 * accept: animated WebP has been on the allowlist since day one and was, until this function
 * existed, SILENTLY FROZEN to its first frame and returned with a 200. An admin uploading a
 * moving banner got a still image and a success message, which is the same
 * "it-looks-like-nothing-happened" failure this whole change is about.
 *
 * Returns null when the input is acceptable.
 */
function detectUnsupportedInput(metadata: Metadata): DetectedImageFormat | null {
  const { format, compression, pages } = metadata;

  if (!format || !ALLOWED_INPUT_FORMATS.has(format)) {
    return { kind: "other", format: format ?? "unknown" };
  }

  // A HEIF container is AVIF when AV1-coded and HEIC when HEVC-coded. Only the former has a
  // decoder linked in this build, and `metadata()` cannot tell the difference for us — it
  // parses the container happily either way and leaves the failure for `toBuffer()`.
  if (format === "heif" && compression !== "av1") {
    return { kind: "heic" };
  }

  if ((pages ?? 1) > 1) {
    return { kind: "animated", format };
  }

  return null;
}

/**
 * Validate raw upload bytes and return a normalized image, or a typed reason for
 * rejection. Never throws on bad input — a non-image decodes to NOT_AN_IMAGE.
 * The re-encode always auto-orients then strips all metadata (EXIF/GPS gone).
 */
export async function validateAndNormalizeImage(
  rawImageBytes: Buffer,
  options: NormalizeImageOptions,
): Promise<Result<NormalizedImage, ImageValidationError>> {
  const pipeline = sharp(rawImageBytes, { limitInputPixels: MAX_INPUT_PIXELS });

  let metadata: Metadata;
  try {
    metadata = await pipeline.metadata();
  } catch {
    return { success: false, error: { type: "NOT_AN_IMAGE" } };
  }

  const unsupported = detectUnsupportedInput(metadata);
  if (unsupported !== null) {
    return { success: false, error: { type: "UNSUPPORTED_FORMAT", detected: unsupported } };
  }

  const { width, height } = metadata;

  if (typeof width !== "number" || typeof height !== "number") {
    return { success: false, error: { type: "NOT_AN_IMAGE" } };
  }

  if (width < MIN_DIMENSION_PX || height < MIN_DIMENSION_PX) {
    return { success: false, error: { type: "DIMENSIONS_TOO_SMALL", width, height } };
  }

  if (width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX) {
    return { success: false, error: { type: "DIMENSIONS_TOO_LARGE", width, height } };
  }

  // Re-encode: auto-orient via EXIF then drop all metadata, downscale into the
  // output box without enlarging, emit the chosen codec. Output carries no EXIF.
  const resized = sharp(rawImageBytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({
    width: options.outputMaxDimensionPx,
    height: options.outputMaxDimensionPx,
    fit: "inside",
    withoutEnlargement: true,
  });

  // AVIF quality 55 ≈ WebP quality 85 visually, at a smaller byte size.
  const encoded =
    options.outputFormat === "avif" ? resized.avif({ quality: 55 }) : resized.webp({ quality: 85 });

  /**
   * GUARDED, and this is the half that keeps a 422 from becoming a 500.
   *
   * `metadata()` succeeding proves the CONTAINER parsed, not that the PIXELS are decodable —
   * a HEIF file whose codec has no decoder linked reports its width and height quite happily
   * and only fails here. {@link detectUnsupportedInput} catches the case we know about, but
   * "the codec set libvips was built with" is a deployment fact this module cannot see, so a
   * decode failure has to be a value rather than a throw. Unguarded, any codec we mispredict
   * lands in the express error handler and renders as "Something went wrong on our side."
   */
  let normalizedBuffer: { data: Buffer; info: { width: number; height: number } };
  try {
    normalizedBuffer = await encoded.toBuffer({ resolveWithObject: true });
  } catch {
    return { success: false, error: { type: "NOT_AN_IMAGE" } };
  }

  return {
    success: true,
    value: {
      buffer: normalizedBuffer.data,
      width: normalizedBuffer.info.width,
      height: normalizedBuffer.info.height,
    },
  };
}

/**
 * Validate + normalize an avatar: avif, downscaled into a 1024px box. Thin
 * wrapper over {@link validateAndNormalizeImage} so the avatar route is
 * unchanged.
 */
export async function validateAndNormalizeAvatar(
  rawImageBytes: Buffer,
): Promise<Result<NormalizedImage, ImageValidationError>> {
  return validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: AVATAR_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
}
