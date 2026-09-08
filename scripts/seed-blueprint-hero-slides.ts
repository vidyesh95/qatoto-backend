/**
 * Re-points the four seeded /blueprints hero slides off `public/dummy/` and onto Cloudinary.
 *
 * WHY THIS EXISTS. Migration 0149 seeded four `anime_hero_slide` rows whose `image_url` is a
 * SITE-RELATIVE path into the frontend repo's `public/dummy/` — the only honest way to seed,
 * since a migration cannot upload to Cloudinary. Frontend commit 0e6929d then retired /anime
 * and deleted all 31 anime fixtures from that directory, including the four these rows point
 * at. Deleting frontend code does not revert the shared database, so the rows survived and
 * `/blueprints` now serves image URLs that 404 — which `next/image` reports as a 400,
 * "The requested resource isn't a valid image".
 *
 * Their titles were wrong too, in a way the 404 was hiding: a hardware-teardown hub captioned
 * "God Troubles Me Season 3".
 *
 * THIS IS THE DOCUMENTED EXIT FROM THE SEED ROWS, taken in bulk. `blueprint-hero.service.ts`
 * names `replaceBlueprintHeroSlideImage` as "the intended way off the seed rows"; this script
 * performs the same act — validate, re-encode, upload under the row's own id, store the
 * returned secure_url — for all four at once. Afterwards no hero row depends on a file in the
 * other repo, so the failure that prompted this cannot recur.
 *
 *   pnpm db:seed-blueprint-hero-slides [path/to/frontend/public/dummy]
 *
 * IDEMPOTENT, and the selector is the guard: it only ever touches rows whose `image_url`
 * still starts with `/dummy/`. After one successful run every row is on `https://`, so a
 * second run finds nothing. That same selector is why a slide an admin has already replaced
 * by hand is skipped rather than reverted.
 *
 * Requires Cloudinary credentials; without them it exits non-zero rather than writing rows
 * that point at nothing.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { asc, eq, like } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { animeHeroSlide } from "#src/db/schema.js";
import { uploadBlueprintHeroSlideImage } from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage } from "#src/lib/image.js";
import { parsePromotionalDestination } from "#src/modules/home/promotions/promotional-destination.js";

/** Matches HERO_OUTPUT_MAX_DIMENSION_PX in blueprint-hero.service.ts. */
const HERO_OUTPUT_MAX_DIMENSION_PX = 1600;

/**
 * Where the committed dummy images live, relative to this repo. Overridable by argument
 * because the two repos are siblings by convention, not by guarantee.
 */
const DEFAULT_IMAGE_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../../../frontend/qatoto-frontend/public/dummy",
);

/**
 * Every slide goes to the teardown INDEX, not to a per-slide detail page.
 *
 * The detail slugs live only in the frontend's `src/mocks/blueprints-mocks.ts`, which is
 * mock on purpose and gets swapped for real rows later. Storing one here would recreate
 * exactly the dangling cross-repo reference this script exists to remove. The index is a
 * real route backed by `listTeardowns` and survives that swap untouched.
 *
 * The cost is accepted and named: a caption identifies one specific build while the link
 * lands on the list containing it.
 */
const TEARDOWN_INDEX_PATH = "/blueprints/teardowns";

/**
 * What each seeded row becomes, keyed by the `image_url` migration 0149 wrote.
 *
 * KEYED BY THE OLD PATH RATHER THAN BY POSITION, because position is admin-editable and a
 * reorder must not silently re-pair captions with the wrong images.
 *
 * The four replacement images are the teardown rail thumbnails already committed at
 * 492x277 — 16:9, which is the aspect ratio the carousel renders — and the captions are the
 * matching fixture titles, so the hub reads as itself rather than as a retired vertical.
 */
const SLIDE_REPLACEMENTS: ReadonlyMap<string, { sourceFileName: string; title: string }> = new Map([
  [
    "/dummy/anime_hero.avif",
    {
      sourceFileName: "thumbnail_image01.avif",
      title: "Solar cold-storage controller, board and all",
    },
  ],
  [
    "/dummy/recent_episode_01.avif",
    {
      sourceFileName: "thumbnail_image02.avif",
      title: "What is actually inside a $180 thermal camera module",
    },
  ],
  [
    "/dummy/recent_episode_02.avif",
    {
      sourceFileName: "thumbnail_image03.avif",
      title: "A 24 V brushless driver you can actually source in Lagos",
    },
  ],
  [
    "/dummy/recommended_for_you_01.avif",
    {
      sourceFileName: "thumbnail_image04.avif",
      title: "Borehole pump housing: the four tolerances that matter",
    },
  ],
]);

interface SeededSlideRow {
  readonly id: string;
  readonly imageUrl: string;
  readonly title: string;
  readonly destinationPath: string | null;
  readonly position: number;
}

async function main(): Promise<void> {
  const imageDirectory = process.argv[2] ?? DEFAULT_IMAGE_DIRECTORY;

  // Fail on the destination BEFORE spending an upload on it. The parser is the same one the
  // HTTP route uses — a seed that could write a value the API would refuse is a seed that
  // has its own, laxer rules.
  const destination = parsePromotionalDestination("internal_path", TEARDOWN_INDEX_PATH);
  if (!destination.success) {
    throw new Error(
      `Destination ${TEARDOWN_INDEX_PATH} is invalid: ${destination.error.type}. ` +
        "The HTTP route would refuse it too.",
    );
  }
  const normalizedDestinationPath = destination.value.normalizedValue;

  const seededSlides: SeededSlideRow[] = await db
    .select({
      id: animeHeroSlide.id,
      imageUrl: animeHeroSlide.imageUrl,
      title: animeHeroSlide.title,
      destinationPath: animeHeroSlide.destinationPath,
      position: animeHeroSlide.position,
    })
    .from(animeHeroSlide)
    .where(like(animeHeroSlide.imageUrl, "/dummy/%"))
    .orderBy(asc(animeHeroSlide.position), asc(animeHeroSlide.id));

  if (seededSlides.length === 0) {
    console.log("0 slides to re-point — every hero slide is already off /dummy/. Nothing to do.");
    return;
  }

  // Printed BEFORE any write, so the state being changed is on the record and the rollback
  // is a straight UPDATE by id back to these values.
  console.log(`Found ${String(seededSlides.length)} slide(s) still pointing at /dummy/:`);
  for (const slide of seededSlides) {
    console.log(
      `  [${String(slide.position)}] ${slide.id}\n` +
        `      image_url        ${slide.imageUrl}\n` +
        `      title            ${slide.title}\n` +
        `      destination_path ${slide.destinationPath ?? "NULL"}`,
    );
  }

  // Every unknown path is fatal and fatal BEFORE the first upload, so a half-applied run is
  // not reachable. A `/dummy/` row this script has no replacement for is a row somebody
  // added by a route this script does not know about — guessing at its caption would be
  // worse than stopping.
  for (const slide of seededSlides) {
    if (!SLIDE_REPLACEMENTS.has(slide.imageUrl)) {
      throw new Error(
        `No replacement defined for seeded slide ${slide.id} at ${slide.imageUrl}. ` +
          "Add one to SLIDE_REPLACEMENTS rather than letting this row be skipped.",
      );
    }
  }

  console.log(`\nReading dummy images from ${imageDirectory}`);

  let repointedCount = 0;
  for (const slide of seededSlides) {
    const replacement = SLIDE_REPLACEMENTS.get(slide.imageUrl);
    if (replacement === undefined) {
      throw new Error(`Unreachable: ${slide.imageUrl} passed the pre-check but has no entry.`);
    }

    const sourcePath = path.join(imageDirectory, replacement.sourceFileName);
    const sourceBytes = await readFile(sourcePath);

    // The same gate and the same output profile the admin route applies. An avif input is
    // reported by sharp as `heif`, which the allowlist accepts.
    const normalized = await validateAndNormalizeImage(sourceBytes, {
      outputMaxDimensionPx: HERO_OUTPUT_MAX_DIMENSION_PX,
      outputFormat: "avif",
    });
    if (!normalized.success) {
      throw new Error(
        `Source image ${replacement.sourceFileName} was rejected: ${normalized.error.type}. ` +
          "The HTTP route would refuse it too.",
      );
    }

    // Uploaded under the EXISTING row id, so the asset lands at the deterministic public id
    // every later replaceBlueprintHeroSlideImage overwrites in place.
    const uploadResult = await uploadBlueprintHeroSlideImage(slide.id, normalized.value.buffer);
    if (!uploadResult.success) {
      throw new Error(`Cloudinary upload failed for ${slide.id}: ${uploadResult.error.type}`);
    }

    await db
      .update(animeHeroSlide)
      .set({
        imageUrl: uploadResult.value.secureUrl,
        title: replacement.title,
        destinationPath: normalizedDestinationPath,
        updatedAt: new Date(),
        // No actor, and no platform audit row either. A data repair is not a staff action,
        // and stamping one would put a name on a decision nobody made — the same call 0149
        // made when it left created_by_user_id NULL.
        updatedByUserId: null,
      })
      .where(eq(animeHeroSlide.id, slide.id));

    repointedCount += 1;
    console.log(
      `  [${String(slide.position)}] ${replacement.sourceFileName} → ${uploadResult.value.secureUrl}`,
    );
  }

  console.log(
    `\nRe-pointed ${String(repointedCount)} hero slide(s) to ${normalizedDestinationPath}.`,
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Blueprint hero slide re-point failed:", error);
    await pool.end();
    process.exit(1);
  });
