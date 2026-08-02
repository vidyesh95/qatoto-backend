/**
 * Seeds the content taxonomy behind the home feed (HOME_BACKEND_STRUCTURE.md §2.1).
 *
 * TWO POPULATIONS, ONE TABLE. The 12 TILES come from `all-content.tsx`'s VIDEO_CATEGORIES
 * and have commissioned art committed in the frontend repo; they seed with `isTile: true`
 * and a Cloudinary URL. The 11 CHIPS come from `filter.tsx`'s FILTER_CHIPS and have no art
 * anywhere; they seed with `imageUrl: null`. That null is deliberate and is why the column
 * is nullable — inventing a placeholder would assert an image that does not exist, which is
 * the same class of error as fabricating a zero (§0 Rule 5).
 *
 * WHAT WAS DROPPED FROM FILTER_CHIPS, and why:
 *   - "All", "Trending", "New to you", "Recently uploaded", "Watched" — these are feed
 *     MODES (§4.8), not subjects. They become `?mode=` values in phase 3, not rows here.
 *   - "Live" — §5.3. There is no stream table, no ingest, no provider, and the studio doc
 *     puts live streaming out of scope. A chip that always returns nothing teaches users
 *     the filters are broken.
 *   - "Minimalist", "Retro", "Precision", "Upcoming" — §2.1. These describe an aesthetic or
 *     a time, not a subject. A creator cannot reliably tag into them and a ranker cannot
 *     learn from them.
 *   - "Robotics" — not dropped, DEDUPED. It appears in both source lists and seeds once, as
 *     a tile, because the tile is the richer row.
 *
 * IDEMPOTENT ON SLUG, and ON CONFLICT DO NOTHING — never DO UPDATE. A product owner may
 * have renamed a label or reordered the grid; a seed script must not silently revert an
 * editorial decision. Adding a row is safe; overwriting one is not.
 *
 * IDS ARE FIXED UUIDs, not generated. Every environment agrees on them, a curl example can
 * reference one directly, the Cloudinary public id (derived from the category id) stays
 * stable across re-seeds, and §5.1 job payloads can validate a categoryId with `z.uuid()`.
 *
 * IT GOES THROUGH `validateAndNormalizeImage`, THE SAME GATE THE HTTP ROUTE USES — a seed
 * that could write a value the API would refuse is a seed with its own, laxer rules.
 *
 *   pnpm db:seed-content-categories [path/to/frontend/public/dummy]
 *
 * Requires Cloudinary credentials, and refuses up front without them rather than writing a
 * partial taxonomy in which the tiles point at nothing.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { db, pool } from "#src/db/index.js";
import { contentCategory } from "#src/db/schema.js";
import { uploadContentCategoryImage } from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage } from "#src/lib/image.js";

/**
 * The tile grid renders roughly 2 across on mobile and 6 across on desktop, so a tile is
 * never wider than ~400 CSS px. 1200 covers that at 3x. Smaller than the promotional
 * slide's 2400 because a slide renders full-bleed and a tile does not.
 */
const TILE_OUTPUT_MAX_DIMENSION_PX = 1200;

/**
 * Where the committed dummy images live, relative to this repo. Overridable by argument
 * because the two repos are siblings by convention, not by guarantee.
 */
const DEFAULT_IMAGE_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../../../frontend/qatoto-frontend/public/dummy",
);

/**
 * Sort order is seeded in STEPS OF TEN so a category inserted later can be slotted between
 * two existing ones without renumbering the whole table.
 */
const SORT_ORDER_STEP = 10;

interface BaselineTileCategory {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly sourceFileName: string;
}

interface BaselineChipCategory {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
}

/**
 * The 12 tiles, in the order `all-content.tsx` renders them. The `category_NN.avif`
 * filenames are positional in the frontend and are preserved as-is; renaming a committed
 * asset is a separate change.
 */
const BASELINE_TILE_CATEGORIES: readonly BaselineTileCategory[] = [
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000001",
    slug: "manufacturing",
    label: "Manufacturing",
    sourceFileName: "category_01.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000002",
    slug: "robotics",
    label: "Robotics",
    sourceFileName: "category_02.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000003",
    slug: "immortality",
    label: "Immortality",
    sourceFileName: "category_03.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000004",
    slug: "magic",
    label: "Magic",
    sourceFileName: "category_04.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000005",
    slug: "toys",
    label: "Toys",
    sourceFileName: "category_05.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000006",
    slug: "teleportation",
    label: "Teleportation",
    sourceFileName: "category_06.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000007",
    slug: "fusion-energy",
    label: "Fusion Energy",
    sourceFileName: "category_07.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000008",
    slug: "quantum-computing",
    label: "Quantum Computing",
    sourceFileName: "category_08.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-000000000009",
    slug: "neural-interfaces",
    label: "Neural Interfaces",
    sourceFileName: "category_09.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-00000000000a",
    slug: "space-mining",
    label: "Space Mining",
    sourceFileName: "category_10.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-00000000000b",
    slug: "nanotech",
    label: "Nanotech",
    sourceFileName: "category_11.avif",
  },
  {
    id: "c0a7e1d3-4b52-4f68-9a71-00000000000c",
    slug: "space-jump-gate",
    label: "Space Jump Gate",
    sourceFileName: "category_12.avif",
  },
];

/**
 * The 11 topical chips, in `filter.tsx`'s own declaration order minus the modes, the
 * aesthetics, "Live", and the Robotics duplicate. Preserving that order keeps the chip row
 * looking as close to today as a taxonomy change allows.
 */
const BASELINE_CHIP_CATEGORIES: readonly BaselineChipCategory[] = [
  { id: "c0a7e1d3-4b52-4f68-9a71-00000000000d", slug: "news", label: "News" },
  { id: "c0a7e1d3-4b52-4f68-9a71-00000000000e", slug: "gaming", label: "Gaming" },
  { id: "c0a7e1d3-4b52-4f68-9a71-00000000000f", slug: "shopping", label: "Shopping" },
  { id: "c0a7e1d3-4b52-4f68-9a71-000000000010", slug: "cosplay", label: "Cosplay" },
  { id: "c0a7e1d3-4b52-4f68-9a71-000000000011", slug: "music", label: "Music" },
  { id: "c0a7e1d3-4b52-4f68-9a71-000000000012", slug: "ai", label: "AI" },
  { id: "c0a7e1d3-4b52-4f68-9a71-000000000013", slug: "research", label: "Research" },
  { id: "c0a7e1d3-4b52-4f68-9a71-000000000014", slug: "hardware", label: "Hardware" },
  { id: "c0a7e1d3-4b52-4f68-9a71-000000000015", slug: "electronics", label: "Electronics" },
  { id: "c0a7e1d3-4b52-4f68-9a71-000000000016", slug: "sports", label: "Sports" },
  { id: "c0a7e1d3-4b52-4f68-9a71-000000000017", slug: "animated", label: "Animated" },
];

interface PreparedCategory {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly imageUrl: string | null;
  readonly isTile: boolean;
  readonly sortOrder: number;
}

async function prepareTile(
  tile: BaselineTileCategory,
  sortOrder: number,
  imageDirectory: string,
): Promise<PreparedCategory> {
  const sourcePath = path.join(imageDirectory, tile.sourceFileName);
  const sourceBytes = await readFile(sourcePath);

  const normalized = await validateAndNormalizeImage(sourceBytes, {
    outputMaxDimensionPx: TILE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    throw new Error(
      `Seed image ${tile.sourceFileName} was rejected: ${normalized.error.type}. ` +
        "The HTTP route would refuse it too.",
    );
  }

  const uploadResult = await uploadContentCategoryImage(tile.id, normalized.value.buffer);
  if (!uploadResult.success) {
    throw new Error(`Cloudinary upload failed for ${tile.slug}: ${uploadResult.error.type}`);
  }

  return {
    id: tile.id,
    slug: tile.slug,
    label: tile.label,
    imageUrl: uploadResult.value.secureUrl,
    isTile: true,
    sortOrder,
  };
}

async function main(): Promise<void> {
  const imageDirectory = process.argv[2] ?? DEFAULT_IMAGE_DIRECTORY;

  const existing = await db.select({ slug: contentCategory.slug }).from(contentCategory);
  const existingSlugs = new Set(existing.map((row) => row.slug));

  const missingTiles = BASELINE_TILE_CATEGORIES.filter((tile) => !existingSlugs.has(tile.slug));
  const missingChips = BASELINE_CHIP_CATEGORIES.filter((chip) => !existingSlugs.has(chip.slug));

  if (missingTiles.length === 0 && missingChips.length === 0) {
    const total = BASELINE_TILE_CATEGORIES.length + BASELINE_CHIP_CATEGORIES.length;
    console.log(`All ${String(total)} baseline categories already present. Nothing to do.`);
    return;
  }

  // Every tile is uploaded BEFORE any row is written. A partial taxonomy — some tiles
  // present, others missing because the upload died halfway — is worse than none, because
  // the grid renders as complete and simply has holes in it.
  const prepared: PreparedCategory[] = [];

  if (missingTiles.length > 0) {
    console.log(`Reading ${String(missingTiles.length)} tile image(s) from ${imageDirectory}`);
    for (const tile of missingTiles) {
      const tileIndex = BASELINE_TILE_CATEGORIES.indexOf(tile);
      prepared.push(await prepareTile(tile, (tileIndex + 1) * SORT_ORDER_STEP, imageDirectory));
      console.log(`  uploaded ${tile.sourceFileName} → ${tile.slug}`);
    }
  }

  for (const chip of missingChips) {
    const chipIndex = BASELINE_CHIP_CATEGORIES.indexOf(chip);
    prepared.push({
      id: chip.id,
      slug: chip.slug,
      label: chip.label,
      // NULL, deliberately. A chip renders as a label; it has no art and claims none.
      imageUrl: null,
      isTile: false,
      sortOrder: (BASELINE_TILE_CATEGORIES.length + chipIndex + 1) * SORT_ORDER_STEP,
    });
  }

  const inserted = await db
    .insert(contentCategory)
    .values(
      prepared.map((category) => ({
        id: category.id,
        slug: category.slug,
        label: category.label,
        imageUrl: category.imageUrl,
        isTile: category.isTile,
        sortOrder: category.sortOrder,
        isActive: true,
      })),
    )
    .onConflictDoNothing({ target: contentCategory.slug })
    .returning({ slug: contentCategory.slug });

  if (inserted.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  console.log(`\nInserted ${String(inserted.length)} categor(y/ies):`);
  for (const row of inserted) {
    console.log(`  ${row.slug}`);
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Content category seed failed:", error);
    await pool.end();
    process.exit(1);
  });
