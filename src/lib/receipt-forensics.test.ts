import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  computePerceptualHash,
  perceptualHashDistance,
  readReceiptExif,
} from "#src/lib/receipt-forensics.js";

/** A deterministic gradient, so every hash below is reproducible rather than fixture-shaped. */
async function gradientImage(
  width: number,
  height: number,
  options: { readonly brightnessOffset?: number; readonly invert?: boolean } = {},
): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const ramp = Math.floor((column / width) * 200);
      const value = Math.min(
        255,
        (options.invert === true ? 200 - ramp : ramp) + (options.brightnessOffset ?? 0),
      );
      const offset = (row * width + column) * 3;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe("computePerceptualHash", () => {
  it("returns a fixed-width 16-character lowercase hex hash", async () => {
    const hash = await computePerceptualHash(await gradientImage(64, 64));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for identical bytes", async () => {
    const image = await gradientImage(64, 64);
    expect(await computePerceptualHash(image)).toBe(await computePerceptualHash(image));
  });

  it("survives a brightness shift — the re-upload case it exists to catch", async () => {
    // dHash compares each pixel to its NEIGHBOUR, so a uniform exposure change leaves
    // every gradient intact. An average-hash would drift here, which is why it is not used.
    const original = await computePerceptualHash(await gradientImage(64, 64));
    const brighter = await computePerceptualHash(
      await gradientImage(64, 64, { brightnessOffset: 40 }),
    );
    expect(perceptualHashDistance(original, brighter)).toBeLessThanOrEqual(4);
  });

  it("survives a resize, because the aspect ratio is deliberately discarded", async () => {
    const original = await computePerceptualHash(await gradientImage(64, 64));
    const resized = await computePerceptualHash(await gradientImage(200, 150));
    expect(perceptualHashDistance(original, resized)).toBeLessThanOrEqual(4);
  });

  it("separates a genuinely different picture", async () => {
    const original = await computePerceptualHash(await gradientImage(64, 64));
    const inverted = await computePerceptualHash(await gradientImage(64, 64, { invert: true }));
    expect(perceptualHashDistance(original, inverted)).toBeGreaterThan(20);
  });
});

describe("perceptualHashDistance", () => {
  it("is zero for identical hashes", () => {
    expect(perceptualHashDistance("0f0f0f0f0f0f0f0f", "0f0f0f0f0f0f0f0f")).toBe(0);
  });

  it("counts differing BITS, not differing characters", () => {
    // 0x0 vs 0xf differs in four bits, and the remaining fifteen nibbles are equal.
    expect(perceptualHashDistance("00000000000000f0", "00000000000000ff")).toBe(4);
  });

  it("throws on mismatched lengths rather than returning a meaningless number", () => {
    expect(() => perceptualHashDistance("0f0f", "0f0f0f")).toThrow(/same length/);
  });

  it("throws on non-hex input", () => {
    expect(() => perceptualHashDistance("zzzzzzzzzzzzzzzz", "0f0f0f0f0f0f0f0f")).toThrow(
      /lowercase hex/,
    );
  });
});

describe("readReceiptExif", () => {
  it("reports no EXIF for an image that carries none", async () => {
    const exif = await readReceiptExif(await gradientImage(64, 64));
    expect(exif).toEqual({ capturedAt: null, deviceFingerprintSource: null, hasExif: false });
  });

  it("reads DateTimeOriginal, Make and Model out of a real EXIF block", async () => {
    const withExif = await sharp(await gradientImage(64, 64))
      .withExif({
        IFD0: { Make: "Qatoto", Model: "SmokeCam" },
        IFD2: { DateTimeOriginal: "2026:07:01 09:30:00" },
      })
      .jpeg()
      .toBuffer();

    const exif = await readReceiptExif(withExif);

    expect(exif.hasExif).toBe(true);
    // Read as UTC by documented convention: EXIF carries a naive local time with no zone,
    // and this value is only ever used for span arithmetic between two receipts.
    expect(exif.capturedAt?.toISOString()).toBe("2026-07-01T09:30:00.000Z");
    expect(exif.deviceFingerprintSource).toContain("Qatoto");
    expect(exif.deviceFingerprintSource).toContain("SmokeCam");
  });

  it("returns nulls rather than throwing on a camera clock that was never set", async () => {
    const withZeroDate = await sharp(await gradientImage(64, 64))
      .withExif({ IFD2: { DateTimeOriginal: "0000:00:00 00:00:00" } })
      .jpeg()
      .toBuffer();

    const exif = await readReceiptExif(withZeroDate);
    expect(exif.hasExif).toBe(true);
    expect(exif.capturedAt).toBeNull();
  });

  it("never throws on bytes that are not an image at all", async () => {
    const exif = await readReceiptExif(Buffer.from("not an image", "utf8"));
    expect(exif.hasExif).toBe(false);
  });
});
