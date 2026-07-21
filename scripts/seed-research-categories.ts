/**
 * Idempotently applies the baseline R&D taxonomy.
 *
 * Migration 0010 already inserts these rows as a one-time bootstrap, so on a freshly
 * migrated database this script is a no-op. It exists for two other cases:
 *   - local resets, where the table was truncated but the migration is already applied;
 *   - ADDING a category later, by appending to BASELINE_RESEARCH_CATEGORIES rather than
 *     hand-writing another migration.
 *
 * ON CONFLICT DO NOTHING, deliberately — never DO UPDATE. A moderator may have edited a
 * label ("Housing" → "Housing & Shelter"), and a seed script must not silently revert
 * an editorial decision. Adding a row is safe; overwriting one is not.
 *
 *   pnpm db:seed-research-categories
 */
import "dotenv/config";
import { db, pool } from "#src/db/index.js";
import { researchCategory } from "#src/db/schema.js";
import { BASELINE_RESEARCH_CATEGORIES } from "#src/db/seed-data.js";

async function main(): Promise<void> {
  const insertedRows = await db
    .insert(researchCategory)
    .values(
      BASELINE_RESEARCH_CATEGORIES.map((category) => ({
        id: category.id,
        slug: category.slug,
        label: category.label,
        // Seeded rows are trusted, so they bypass the `pending` moderation queue that
        // user-minted categories land in.
        status: "approved" as const,
        pinIconKey: category.pinIconKey,
        createdByUserId: null,
      })),
    )
    .onConflictDoNothing({ target: researchCategory.slug })
    .returning({ slug: researchCategory.slug });

  if (insertedRows.length === 0) {
    console.log(
      `All ${BASELINE_RESEARCH_CATEGORIES.length} baseline categories already present. Nothing to do.`,
    );
    return;
  }

  console.log(`Inserted ${insertedRows.length} categor(y/ies):`);
  for (const row of insertedRows) {
    console.log(`  ${row.slug}`);
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Research category seed failed:", error);
    await pool.end();
    process.exit(1);
  });
