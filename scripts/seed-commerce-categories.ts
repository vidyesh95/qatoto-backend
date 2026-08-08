/**
 * Fills in the tile art for the eight root store categories seeded by migration `0098`.
 *
 * THE ROWS ALREADY EXIST. `0098` inserts clothes / furniture / accessories / beauty / shoes
 * / bags / machinery / jewelry with `image_url` NULL, because a migration that could not run
 * without Cloudinary credentials is a migration that blocks a restore. This script is the
 * second half: it reads the committed art from the frontend repo and fills that column.
 *
 * IDEMPOTENT, AND NON-DESTRUCTIVE ABOUT IT. The update is `WHERE image_url IS NULL`, so a
 * second run is a no-op and — more importantly — it can never revert art an admin has since
 * replaced through `/admin/store-categories`. Same rule `seed-content-categories.ts` states:
 * adding a row is safe, overwriting one is not. Pass `--force` to overwrite deliberately.
 *
 * IT GOES THROUGH `validateAndNormalizeImage`, THE SAME GATE THE HTTP ROUTE USES. A seed
 * that could write a value the API would refuse is a seed with its own, laxer rules.
 *
 * THE CLOUDINARY PUBLIC ID IS DERIVED FROM THE CATEGORY ID, and `0098` pins those ids, so
 * re-seeding overwrites the same asset instead of orphaning one, in every environment.
 *
 *   pnpm db:seed-commerce-categories [path/to/frontend/public/dummy] [--force]
 *
 * Requires Cloudinary credentials, and refuses up front without them rather than leaving a
 * taxonomy half pointing at nothing.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { eq, inArray, isNull, and } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { commerceCategory } from "#src/db/schema.js";
import { uploadCommerceCategoryImage } from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage } from "#src/lib/image.js";

/**
 * A category tile renders at most ~400 CSS px wide — the home rail is eight across at `xl`
 * — so 1200 covers it at 3×. Smaller than the promotional slide's 2400 because a slide
 * renders full-bleed and a tile does not. Matches the constant the HTTP route uses.
 */
const TILE_OUTPUT_MAX_DIMENSION_PX = 1200;

/**
 * Where the committed art lives, relative to this repo. Overridable by argument because the
 * two repos are siblings by convention, not by guarantee.
 */
const DEFAULT_IMAGE_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../../../frontend/qatoto-frontend/public/dummy",
);

interface RootCategoryArt {
  /** Pinned by migration 0098. The Cloudinary public id is derived from it. */
  readonly id: string;
  readonly slug: string;
  readonly sourceFileName: string;
}

/**
 * The eight roots and their committed art, in the order `0098` seeds them.
 *
 * `misc` is deliberately absent. It has no art, holds `image_url NULL` by design, and
 * inventing a placeholder would assert an image that does not exist — the same call
 * `seed-content-categories.ts` makes about its chips.
 */
const ROOT_CATEGORY_ART: readonly RootCategoryArt[] = [
  { id: "commerce_category_clothes", slug: "clothes", sourceFileName: "clothes.avif" },
  { id: "commerce_category_furniture", slug: "furniture", sourceFileName: "furniture.avif" },
  {
    id: "commerce_category_accessories",
    slug: "accessories",
    sourceFileName: "accessories.avif",
  },
  { id: "commerce_category_beauty", slug: "beauty", sourceFileName: "beauty.avif" },
  { id: "commerce_category_shoes", slug: "shoes", sourceFileName: "shoes.avif" },
  { id: "commerce_category_bags", slug: "bags", sourceFileName: "bags.avif" },
  { id: "commerce_category_machinery", slug: "machinery", sourceFileName: "machinery.avif" },
  { id: "commerce_category_jewelry", slug: "jewelry", sourceFileName: "jewelry.avif" },
];

async function uploadTile(art: RootCategoryArt, imageDirectory: string): Promise<string> {
  const sourcePath = path.join(imageDirectory, art.sourceFileName);
  const sourceBytes = await readFile(sourcePath);

  const normalized = await validateAndNormalizeImage(sourceBytes, {
    outputMaxDimensionPx: TILE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    throw new Error(
      `Seed image ${art.sourceFileName} was rejected: ${normalized.error.type}. ` +
        "The HTTP route would refuse it too.",
    );
  }

  const uploadResult = await uploadCommerceCategoryImage(art.id, normalized.value.buffer);
  if (!uploadResult.success) {
    throw new Error(`Cloudinary upload failed for ${art.slug}: ${uploadResult.error.type}`);
  }
  return uploadResult.value.secureUrl;
}

async function main(): Promise<void> {
  const positionalArguments = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  const imageDirectory = positionalArguments[0] ?? DEFAULT_IMAGE_DIRECTORY;
  const shouldForce = process.argv.includes("--force");

  const categoryIds = ROOT_CATEGORY_ART.map((art) => art.id);
  const existing = await db
    .select({
      id: commerceCategory.id,
      slug: commerceCategory.slug,
      imageUrl: commerceCategory.imageUrl,
    })
    .from(commerceCategory)
    .where(inArray(commerceCategory.id, categoryIds));

  // A missing row means 0098 has not run, and uploading art for a category that does not
  // exist would leave eight orphaned assets and no explanation.
  const presentIds = new Set(existing.map((row) => row.id));
  const missing = ROOT_CATEGORY_ART.filter((art) => !presentIds.has(art.id));
  if (missing.length > 0) {
    throw new Error(
      `Missing ${String(missing.length)} root categor(y/ies): ${missing.map((art) => art.slug).join(", ")}. ` +
        "Run `pnpm db:migrate` first — migration 0098 seeds these rows.",
    );
  }

  const alreadyArted = new Set(
    existing.filter((row) => row.imageUrl !== null).map((row) => row.id),
  );
  const pending = shouldForce
    ? ROOT_CATEGORY_ART
    : ROOT_CATEGORY_ART.filter((art) => !alreadyArted.has(art.id));

  if (pending.length === 0) {
    console.log(
      `All ${String(ROOT_CATEGORY_ART.length)} root categories already have art. Nothing to do.`,
    );
    console.log("Pass --force to re-upload and overwrite, including any admin replacements.");
    return;
  }

  console.log(`Reading ${String(pending.length)} tile image(s) from ${imageDirectory}`);

  let updatedCount = 0;
  for (const art of pending) {
    const secureUrl = await uploadTile(art, imageDirectory);

    // The guard is repeated in the WHERE, not just in the filter above: between reading the
    // list and writing the row an admin may have uploaded their own, and this is what stops
    // the seed from stamping over it. `--force` is the only way past it.
    const updated = await db
      .update(commerceCategory)
      .set({ imageUrl: secureUrl })
      .where(
        shouldForce
          ? eq(commerceCategory.id, art.id)
          : and(eq(commerceCategory.id, art.id), isNull(commerceCategory.imageUrl)),
      )
      .returning({ slug: commerceCategory.slug });

    if (updated.length === 0) {
      console.log(`  skipped ${art.slug} — it gained an image while this run was in flight`);
      continue;
    }
    updatedCount += 1;
    console.log(`  uploaded ${art.sourceFileName} → ${art.slug}`);
  }

  console.log(`\nSet art on ${String(updatedCount)} categor(y/ies).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Commerce category seed failed:", error);
    await pool.end();
    process.exit(1);
  });
