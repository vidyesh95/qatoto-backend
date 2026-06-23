import sharp, { type Metadata } from "sharp";

import type { Result } from "#src/types/index.js";

/**
 * Server-side avatar validation + normalization. The client's content-type and
 * dimensions are untrusted (CLAUDE.md §1.1): a hostile caller can label anything
 * `image/png`. We decode the bytes with sharp to PROVE they are a real raster
 * image, reject decompression bombs and out-of-range dimensions, then RE-ENCODE —
 * which strips EXIF/metadata and any non-image payload smuggled in the container.
 */

/** Formats we accept as input. Anything else (gif, svg, tiff, avif, …) is rejected. */
const ALLOWED_INPUT_FORMATS = new Set(["jpeg", "png", "webp"]);

/** Reject images smaller than this on either side — too small to be a real avatar. */
const MIN_DIMENSION_PX = 64;

/** Reject absurdly large source images outright (defense before the resize step). */
const MAX_DIMENSION_PX = 8192;

/** Final avatars are downscaled to fit this box (never enlarged). */
const OUTPUT_MAX_DIMENSION_PX = 1024;

/**
 * Cap decoded pixel count to blunt decompression-bomb attacks (a tiny file that
 * expands to gigapixels). 8192×8192 worth of pixels is well above any real avatar.
 */
const MAX_INPUT_PIXELS = MAX_DIMENSION_PX * MAX_DIMENSION_PX;

export type AvatarValidationError =
  | { type: "NOT_AN_IMAGE" }
  | { type: "UNSUPPORTED_FORMAT"; format: string }
  | { type: "DIMENSIONS_TOO_SMALL"; width: number; height: number }
  | { type: "DIMENSIONS_TOO_LARGE"; width: number; height: number };

/** A normalized avatar ready to upload: webp bytes plus its final dimensions. */
export interface NormalizedAvatar {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Validate raw upload bytes and return a normalized webp avatar, or a typed
 * reason for rejection. Never throws on bad input — a non-image decodes to
 * NOT_AN_IMAGE.
 */
export async function validateAndNormalizeAvatar(
  rawImageBytes: Buffer,
): Promise<Result<NormalizedAvatar, AvatarValidationError>> {
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
  // output box without enlarging, emit webp. The output buffer carries no EXIF.
  const normalizedBuffer = await sharp(rawImageBytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({
      width: OUTPUT_MAX_DIMENSION_PX,
      height: OUTPUT_MAX_DIMENSION_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });

  return {
    success: true,
    value: {
      buffer: normalizedBuffer.data,
      width: normalizedBuffer.info.width,
      height: normalizedBuffer.info.height,
    },
  };
}
