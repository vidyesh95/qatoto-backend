import sharp from "sharp";

import type { ImageValidationError } from "#src/lib/image.js";
import type { Result } from "#src/types/index.js";

/**
 * ITS OWN MODULE, NOT A MEMBER OF `image.ts`. Service tests stub `#src/lib/image.js` wholesale to
 * control the normalizer while leaving this on the (separately stubbed) `sharp` path, and a second
 * export there would have to be threaded through every one of those stubs.
 */

/** The blur placeholder's box. Small enough to inline in every read as a data URL. */
const BLUR_PLACEHOLDER_DIMENSION_PX = 16;

/**
 * A 16px WebP, base64, for the reserved box to paint until the real file loads.
 *
 * Made from the RAW upload with the same auto-orientation the normalizer applies, rather than by
 * re-decoding the stored AVIF: that would depend on this deployment's libvips carrying an AV1
 * decoder as well as an encoder. The raw bytes already decoded once inside
 * `validateAndNormalizeImage`, so a failure here is not a bad upload — it is still answered as
 * one rather than as a 500, because the caller can do nothing else with it.
 *
 * SHARED by the showcase launch images and the problem-report photos; it lived privately in
 * `showcase-launch.service.ts` until a second caller needed it.
 */
export async function buildBlurPlaceholderDataUrl(
  rawImageBytes: Buffer,
): Promise<Result<string, ImageValidationError>> {
  try {
    const placeholderBuffer = await sharp(rawImageBytes)
      .rotate()
      .resize(BLUR_PLACEHOLDER_DIMENSION_PX, BLUR_PLACEHOLDER_DIMENSION_PX, { fit: "inside" })
      .webp({ quality: 50 })
      .toBuffer();
    return {
      success: true,
      value: `data:image/webp;base64,${placeholderBuffer.toString("base64")}`,
    };
  } catch {
    return { success: false, error: { type: "NOT_AN_IMAGE" } };
  }
}
