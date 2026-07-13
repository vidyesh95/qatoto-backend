import sharp, { type Metadata } from "sharp";

import type { Result } from "#src/types/index.js";

/**
 * Server-side image validation + normalization. The client's content-type and
 * dimensions are untrusted (CLAUDE.md §1.1): a hostile caller can label anything
 * `image/png`. We decode the bytes with sharp to PROVE they are a real raster
 * image, reject decompression bombs and out-of-range dimensions, then RE-ENCODE —
 * which strips EXIF/metadata and any non-image payload smuggled in the container.
 *
 * Shared by two callers with different output profiles: avatars (webp @ 1024px)
 * and product listing images (avif @ 1600px). Everything but the output box and
 * codec is identical, so the validation core lives in
 * {@link validateAndNormalizeImage} and the two entry points just pass options.
 */

/** Formats we accept as input. Anything else (gif, svg, tiff, avif, …) is rejected. */
const ALLOWED_INPUT_FORMATS = new Set(["jpeg", "png", "webp"]);

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

export type ImageValidationError =
  | { type: "NOT_AN_IMAGE" }
  | { type: "UNSUPPORTED_FORMAT"; format: string }
  | { type: "DIMENSIONS_TOO_SMALL"; width: number; height: number }
  | { type: "DIMENSIONS_TOO_LARGE"; width: number; height: number };

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

  const { format, width, height } = metadata;

  if (!format || !ALLOWED_INPUT_FORMATS.has(format)) {
    return { success: false, error: { type: "UNSUPPORTED_FORMAT", format: format ?? "unknown" } };
  }

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

  const normalizedBuffer = await encoded.toBuffer({ resolveWithObject: true });

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
 * Validate + normalize an avatar: webp, downscaled into a 1024px box. Thin
 * wrapper over {@link validateAndNormalizeImage} so the avatar route is
 * unchanged.
 */
export async function validateAndNormalizeAvatar(
  rawImageBytes: Buffer,
): Promise<Result<NormalizedImage, ImageValidationError>> {
  return validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: AVATAR_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "webp",
  });
}
