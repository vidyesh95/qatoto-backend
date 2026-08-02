/**
 * Maps the dead `video.category` free-text column onto `video_category` rows
 * (HOME_BACKEND_STRUCTURE.md §2.2).
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE MIGRATION — the opposite call from
 * `is_source_verified`, which IS backfilled in migration 0034. Two things differ:
 *
 *   1. NO DEADLINE. Nothing is refused while this is pending. An untagged video is simply
 *      not in any category filter, which is exactly what it was yesterday. The
 *      `is_source_verified` backfill had a deadline measured in the gap between migrate and
 *      "someone remembers", because for that whole window publish refused every draft.
 *
 *   2. IT NEEDS A HUMAN TO READ THE OUTPUT. The free-text values will not all map, and
 *      THE UNMATCHED LIST IS THE DELIVERABLE. The inserts are the easy half.
 *
 * MATCHING IS EXACT-SLUG-AFTER-NORMALIZATION AND NOTHING ELSE. §2.2 says "where a confident
 * match exists", and after lowercasing and hyphenating, exact equality against
 * `content_category.slug` is the only confidence available. No fuzzy matching, no edit
 * distance, no "Sci-Fi is probably Research": a wrong tag is worse than no tag, because it
 * silently feeds the §4 ranker a category the creator never chose and nobody will ever
 * audit it back.
 *
 * IDEMPOTENT. ON CONFLICT DO NOTHING against the (video_id, category_id) primary key, so
 * re-running adds nothing. It also never REMOVES a tag — a creator may have set categories
 * through the studio since, and this script must not undo that.
 *
 * Usage:
 *   pnpm db:backfill-video-categories            # DRY RUN — reports what would happen
 *   pnpm db:backfill-video-categories -- --apply # writes the confident matches
 */
import "dotenv/config";
import { isNotNull, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { contentCategory, video, videoCategory } from "#src/db/schema.js";

/**
 * The same shape `content_category_slug_ck` enforces: lowercase alphanumerics joined by
 * single hyphens. Anything that cannot be coerced into that shape has no possible match and
 * is reported rather than guessed at.
 */
function toSlug(rawCategory: string): string {
  return rawCategory
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main(): Promise<void> {
  const shouldApply = process.argv.includes("--apply");

  const taggedVideoRows = await db
    .select({ id: video.id, category: video.category })
    .from(video)
    .where(isNotNull(video.category));

  if (taggedVideoRows.length === 0) {
    console.log("No video carries a legacy `category` value. Nothing to do.");
    return;
  }

  const activeCategoryRows = await db
    .select({ id: contentCategory.id, slug: contentCategory.slug })
    .from(contentCategory);
  const categoryIdBySlug = new Map(activeCategoryRows.map((row) => [row.slug, row.id]));

  const pendingLinks: { videoId: string; categoryId: string }[] = [];
  // Keyed by the RAW value, not the slug, so the report shows the operator what is actually
  // stored in the column they have to go and fix.
  const unmatchedCountByRawValue = new Map<string, number>();

  for (const taggedVideo of taggedVideoRows) {
    if (taggedVideo.category === null) continue;

    const matchedCategoryId = categoryIdBySlug.get(toSlug(taggedVideo.category));
    if (matchedCategoryId === undefined) {
      unmatchedCountByRawValue.set(
        taggedVideo.category,
        (unmatchedCountByRawValue.get(taggedVideo.category) ?? 0) + 1,
      );
      continue;
    }

    pendingLinks.push({ videoId: taggedVideo.id, categoryId: matchedCategoryId });
  }

  console.log(`${String(taggedVideoRows.length)} video(s) carry a legacy category value.`);
  console.log(`  ${String(pendingLinks.length)} map confidently onto an existing category.`);
  console.log(`  ${String(unmatchedCountByRawValue.size)} distinct value(s) do not map.\n`);

  if (unmatchedCountByRawValue.size > 0) {
    // THE POINT OF THE SCRIPT. Sorted by row count so the values worth a product decision
    // come first.
    console.log("UNMATCHED — these need a human decision (value, rows):");
    const unmatchedByFrequency = [...unmatchedCountByRawValue.entries()].toSorted(
      ([, leftCount], [, rightCount]) => rightCount - leftCount,
    );
    for (const [rawValue, rowCount] of unmatchedByFrequency) {
      console.log(`  ${String(rowCount).padStart(5)}  ${JSON.stringify(rawValue)}`);
    }
    console.log(
      "\nEither add a category with the matching slug and re-run, or accept that these " +
        "videos stay untagged. Do NOT hand-map them here — see this file's header.",
    );
  }

  if (!shouldApply) {
    console.log("\nDRY RUN — nothing written. Re-run with `-- --apply` to insert the matches.");
    return;
  }

  if (pendingLinks.length === 0) {
    console.log("\nNothing confident to write.");
    return;
  }

  const insertedLinks = await db
    .insert(videoCategory)
    .values(pendingLinks)
    // The PK is (video_id, category_id), so a video already tagged through the studio is
    // left exactly as it is.
    .onConflictDoNothing()
    .returning({ videoId: videoCategory.videoId });

  console.log(`\nInserted ${String(insertedLinks.length)} video_category row(s).`);

  const remainingUntagged = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(video)
    .where(
      sql`${video.category} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM video_category vc WHERE vc.video_id = ${video.id})`,
    );
  console.log(
    `${String(remainingUntagged[0]?.value ?? 0)} video(s) still carry a legacy value and ` +
      "have no category link.",
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Video category backfill failed:", error);
    await pool.end();
    process.exit(1);
  });
