import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { describeUnsupportedImageFormat, validateAndNormalizeImage, type DetectedImageFormat } from "#src/lib/image.js";

/**
 * The upload gate had no test at all, which is how ONE wrong allowlist reached seven call
 * sites at once: avatars, product images, project covers, video thumbnails, receipts and both
 * promotional-slide routes all shared a constant that silently refused AVIF.
 *
 * FIXTURES ARE GENERATED IN MEMORY rather than checked in as binaries — same approach as
 * `scripts/smoke-promotional-slides.ts`. That keeps the repo free of opaque blobs and makes
 * every case's intent readable at the call site.
 *
 * ONE FORMAT CANNOT BE COVERED HERE. A HEVC-coded HEIC cannot be synthesized on this build —
 * the encoder is as absent as the decoder — so the `{ kind: "heic" }` path is proven only
 * through `describeUnsupportedImageFormat` below and by the manual check with a real iPhone
 * photo. Flagged deliberately rather than faked with a hand-built container.
 */

const OUTPUT_OPTIONS = { outputMaxDimensionPx: 512, outputFormat: "avif" } as const;

/** A plain single-frame raster in the requested codec. */
async function makeImage(
  format: "png" | "jpeg" | "webp" | "avif" | "gif" | "tiff",
  options: { readonly widthPx?: number; readonly heightPx?: number } = {},
): Promise<Buffer> {
  const pipeline = sharp({
    create: {
      width: options.widthPx ?? 400,
      height: options.heightPx ?? 300,
      channels: 3,
      background: { r: 120, g: 80, b: 200 },
    },
  });

  switch (format) {
    case "png":
      return pipeline.png().toBuffer();
    case "jpeg":
      return pipeline.jpeg().toBuffer();
    case "webp":
      return pipeline.webp().toBuffer();
    case "avif":
      return pipeline.avif({ quality: 50 }).toBuffer();
    case "gif":
      return pipeline.gif().toBuffer();
    case "tiff":
      return pipeline.tiff().toBuffer();
    default: {
      const exhaustiveCheck: never = format;
      throw new Error(`Unhandled fixture format: ${String(exhaustiveCheck)}`);
    }
  }
}

/** One frame of the animation fixture below. */
function makeAnimationFrame(red: number): Promise<Buffer> {
  return sharp({
    create: { width: 80, height: 80, channels: 3, background: { r: red, g: 100, b: 150 } },
  })
    .png()
    .toBuffer();
}

/**
 * A genuinely two-frame animated WebP — `pages: 2` is what the animation gate reads.
 *
 * Built with sharp's `join` rather than by setting `pageHeight` on a tall image: the latter
 * silently produces a STILL image (verified — `metadata()` reports no `pages` at all), which
 * would have made this test pass against a fixture that never exercised the gate at all.
 */
async function makeAnimatedWebp(): Promise<Buffer> {
  const frames = [await makeAnimationFrame(10), await makeAnimationFrame(240)];
  return sharp(frames, { join: { across: 1, animated: true } })
    .webp({ loop: 0 })
    .toBuffer();
}

describe("validateAndNormalizeImage — accepted formats", () => {
  it.each(["png", "jpeg", "webp"] as const)("accepts %s", async (format) => {
    const result = await validateAndNormalizeImage(await makeImage(format), OUTPUT_OPTIONS);
    expect(result.success).toBe(true);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. AVIF decodes as `format: "heif"`, so the old
   * jpeg/png/webp allowlist refused it — including the repo's own `public/dummy/*.avif`
   * assets, which the promotional-slide seed had already uploaded to Cloudinary. An admin
   * could see an AVIF slide on the front page and be unable to replace it with another one.
   */
  it("accepts avif — the format the old allowlist silently refused", async () => {
    const result = await validateAndNormalizeImage(await makeImage("avif"), OUTPUT_OPTIONS);
    expect(result.success).toBe(true);
  });

  it("re-encodes into the requested output box without enlarging", async () => {
    const result = await validateAndNormalizeImage(
      await makeImage("png", { widthPx: 2000, heightPx: 1000 }),
      OUTPUT_OPTIONS,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.width).toBe(512);
    expect(result.value.height).toBe(256);
  });
});

describe("validateAndNormalizeImage — refusals", () => {
  /**
   * A SECURITY INVARIANT, NOT A FORMAT PREFERENCE, and the reason it is asserted rather than
   * merely commented: rsvg IS linked into this libvips build, so libvips would happily
   * rasterize an SVG. It stays out because SVG is script-bearing XML — accepting it means
   * accepting an XML parser plus external-entity and network-fetch surface on fully untrusted
   * bytes. A security rule with no test is one somebody removes during a refactor.
   */
  it("REFUSES svg, which libvips could otherwise rasterize", async () => {
    const svgBytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
        '<rect width="200" height="200" fill="red"/></svg>',
    );
    const result = await validateAndNormalizeImage(svgBytes, OUTPUT_OPTIONS);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({
      type: "UNSUPPORTED_FORMAT",
      detected: { kind: "other", format: "svg" },
    });
  });

  it.each(["gif", "tiff"] as const)("refuses %s as an unsupported format", async (format) => {
    const result = await validateAndNormalizeImage(await makeImage(format), OUTPUT_OPTIONS);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({
      type: "UNSUPPORTED_FORMAT",
      detected: { kind: "other", format },
    });
  });

  /**
   * A PRE-EXISTING BUG this change closes. Animated WebP was on the allowlist from day one and
   * the pipeline emits a single still frame, so an admin uploading a moving banner got a
   * frozen image back WITH A 200 — the same "it looks like nothing happened" failure that made
   * a broken image replace read as a caching problem.
   */
  it("refuses animated input rather than silently freezing it to frame one", async () => {
    const result = await validateAndNormalizeImage(await makeAnimatedWebp(), OUTPUT_OPTIONS);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({
      type: "UNSUPPORTED_FORMAT",
      detected: { kind: "animated", format: "webp" },
    });
  });

  it("refuses an image smaller than the minimum on either side", async () => {
    const result = await validateAndNormalizeImage(
      await makeImage("png", { widthPx: 32, heightPx: 32 }),
      OUTPUT_OPTIONS,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("DIMENSIONS_TOO_SMALL");
  });

  /** Never throws on hostile input — a refusal is a value, so the route answers 422 not 500. */
  it("returns NOT_AN_IMAGE for bytes that are not an image at all", async () => {
    const result = await validateAndNormalizeImage(Buffer.from("this is definitely not an image"), OUTPUT_OPTIONS);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ type: "NOT_AN_IMAGE" });
  });

  it("returns a Result rather than throwing when the bytes are truncated mid-file", async () => {
    const wholeImage = await makeImage("png");
    const truncated = wholeImage.subarray(0, Math.floor(wholeImage.length / 3));

    // The assertion is that this RESOLVES at all. An unguarded decode would reject, the
    // express error handler would render "Something went wrong on our side.", and a
    // fixable 422 would become an opaque 500.
    await expect(validateAndNormalizeImage(truncated, OUTPUT_OPTIONS)).resolves.toMatchObject({
      success: false,
    });
  });
});

describe("describeUnsupportedImageFormat", () => {
  it("tells an iPhone user exactly what to change", () => {
    const message = describeUnsupportedImageFormat({ kind: "heic" });
    expect(message).toContain("Most Compatible");
    expect(message).toContain("JPEG");
  });

  it("names the offending format for anything else", () => {
    expect(describeUnsupportedImageFormat({ kind: "other", format: "tiff" })).toContain("TIFF");
  });

  it("says to upload a still frame for animated input", () => {
    expect(describeUnsupportedImageFormat({ kind: "animated", format: "webp" })).toContain("still frame");
  });

  /** Every variant renders; none falls through to the exhaustiveness throw. */
  it("handles every DetectedImageFormat variant", () => {
    const everyVariant: readonly DetectedImageFormat[] = [
      { kind: "heic" },
      { kind: "animated", format: "webp" },
      { kind: "other", format: "gif" },
    ];
    for (const detected of everyVariant) {
      expect(describeUnsupportedImageFormat(detected).length).toBeGreaterThan(0);
    }
  });
});
