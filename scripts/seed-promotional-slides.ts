/**
 * Seeds the three promotional slides the frontend used to hardcode.
 *
 * Before this domain existed, `src/components/home/feed/promo-carousel.tsx` shipped a
 * module-level array of three images from `public/dummy/` with no links at all. This script
 * moves those same three images into the database as real, clickable, admin-editable rows
 * so the front page looks unchanged on the first deploy instead of going blank.
 *
 * IDEMPOTENT. Each slide has a deterministic id, and the insert is ON CONFLICT DO NOTHING —
 * never DO UPDATE. Once an admin has edited a slide's alt text or destination, re-running
 * this must not silently revert that editorial decision.
 *
 * IT GOES THROUGH `validateAndNormalizeImage`, THE SAME GATE THE HTTP ROUTE USES. It used to
 * bypass it and re-encode with sharp directly, because the allowlist was jpeg/png/webp and
 * these fixtures are avif. That exception was a bug wearing a justification: it meant the
 * seeded carousel was full of images the admin route would REFUSE as replacements, which is
 * exactly the failure that got reported. The allowlist now accepts avif, so the exception is
 * gone — and a seed that cannot write a value the API would reject is the point.
 *
 *   pnpm db:seed-promotional-slides [path/to/frontend/public/dummy]
 *
 * Requires Cloudinary credentials; without them it exits non-zero rather than writing rows
 * that point at nothing.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { db, pool } from "#src/db/index.js";
import { promotionalSlide } from "#src/db/schema.js";
import { uploadPromotionalSlideImage } from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage } from "#src/lib/image.js";
import { parsePromotionalDestination } from "#src/modules/home/promotions/promotional-destination.js";

/** Matches SLIDE_OUTPUT_MAX_DIMENSION_PX in promotions.service.ts. */
const SLIDE_OUTPUT_MAX_DIMENSION_PX = 2400;

/**
 * Where the committed dummy images live, relative to this repo. Overridable by argument
 * because the two repos are siblings by convention, not by guarantee.
 */
const DEFAULT_IMAGE_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../../../frontend/qatoto-frontend/public/dummy",
);

/**
 * The three slides, in the order the carousel showed them.
 *
 * The ids are FIXED rather than random so re-running is a no-op and so the Cloudinary
 * public id (derived from the slide id) stays stable across re-seeds.
 *
 * Note the source filenames are inconsistent — slide 1 is `highlight_image01` while 2 and 3
 * are `spotlight_image0N`. That is how they were in the component; it is preserved here
 * rather than "fixed", because renaming a committed asset is a separate change.
 */
const BASELINE_SLIDES = [
  {
    id: "seed-promotional-slide-01",
    sourceFileName: "highlight_image01.avif",
    altText: "Shop the Qatoto store",
    destinationValue: "/store",
  },
  {
    id: "seed-promotional-slide-02",
    sourceFileName: "spotlight_image02.avif",
    altText: "Explore engineering blueprints on Qatoto",
    destinationValue: "/blueprints",
  },
  {
    id: "seed-promotional-slide-03",
    sourceFileName: "spotlight_image03.avif",
    altText: "Explore research and development",
    destinationValue: "/research-and-development",
  },
] as const;

interface PreparedSlide {
  readonly id: string;
  readonly imageUrl: string;
  readonly imageWidthPx: number;
  readonly imageHeightPx: number;
  readonly altText: string;
  readonly destinationValue: string;
  readonly position: number;
}

async function prepareSlide(
  slide: (typeof BASELINE_SLIDES)[number],
  position: number,
  imageDirectory: string,
): Promise<PreparedSlide> {
  // Fail on the destination BEFORE spending an upload on it. Every seeded slide is an
  // internal path, and the parser is the same one the HTTP route uses — a seed that could
  // write a value the API would refuse is a seed that has its own, laxer rules.
  const destination = parsePromotionalDestination("internal_path", slide.destinationValue);
  if (!destination.success) {
    throw new Error(
      `Seed destination ${slide.destinationValue} is invalid: ${destination.error.type}`,
    );
  }

  const sourcePath = path.join(imageDirectory, slide.sourceFileName);
  const sourceBytes = await readFile(sourcePath);

  const normalized = await validateAndNormalizeImage(sourceBytes, {
    outputMaxDimensionPx: SLIDE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    throw new Error(
      `Seed image ${slide.sourceFileName} was rejected: ${normalized.error.type}. ` +
        "The HTTP route would refuse it too.",
    );
  }

  const uploadResult = await uploadPromotionalSlideImage(slide.id, normalized.value.buffer);
  if (!uploadResult.success) {
    throw new Error(`Cloudinary upload failed for ${slide.id}: ${uploadResult.error.type}`);
  }

  return {
    id: slide.id,
    imageUrl: uploadResult.value.secureUrl,
    imageWidthPx: normalized.value.width,
    imageHeightPx: normalized.value.height,
    altText: slide.altText,
    destinationValue: destination.value.normalizedValue,
    position,
  };
}

async function main(): Promise<void> {
  const imageDirectory = process.argv[2] ?? DEFAULT_IMAGE_DIRECTORY;

  const existing = await db.select({ id: promotionalSlide.id }).from(promotionalSlide);
  if (existing.length > 0) {
    console.log(
      `${String(existing.length)} promotional slide(s) already exist. Nothing to do — ` +
        "delete them in /admin/promotions first if you want to re-seed.",
    );
    return;
  }

  console.log(`Reading dummy images from ${imageDirectory}`);

  const prepared: PreparedSlide[] = [];
  for (const [index, slide] of BASELINE_SLIDES.entries()) {
    prepared.push(await prepareSlide(slide, index, imageDirectory));
    console.log(`  uploaded ${slide.sourceFileName} → ${slide.destinationValue}`);
  }

  const inserted = await db
    .insert(promotionalSlide)
    .values(
      prepared.map((slide) => ({
        id: slide.id,
        imageUrl: slide.imageUrl,
        imageWidthPx: slide.imageWidthPx,
        imageHeightPx: slide.imageHeightPx,
        altText: slide.altText,
        destinationKind: "internal_path" as const,
        destinationValue: slide.destinationValue,
        position: slide.position,
        isActive: true,
        // No actor: a seed is not a staff action, and stamping one would put a name on a
        // decision nobody made. The audit chain is correspondingly silent here.
        createdByUserId: null,
        updatedByUserId: null,
      })),
    )
    .onConflictDoNothing({ target: promotionalSlide.id })
    .returning({ id: promotionalSlide.id });

  console.log(`\nInserted ${String(inserted.length)} promotional slide(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Promotional slide seed failed:", error);
    await pool.end();
    process.exit(1);
  });
