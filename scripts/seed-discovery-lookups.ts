/**
 * Idempotently applies the baseline §6 discovery lookups: the region tree and the
 * canonical skill vocabulary.
 *
 * Migration 0011 already inserts these rows as a one-time bootstrap, so on a freshly
 * migrated database this script is a no-op. It exists for the same two cases as
 * `seed-research-categories.ts`: local resets where the tables were truncated but the
 * migration is already applied, and ADDING a region or skill later by appending to the
 * baseline arrays rather than hand-writing another migration.
 *
 * ON CONFLICT DO NOTHING, deliberately — never DO UPDATE. A moderator may have edited a
 * label, and a seed script must not silently revert an editorial decision.
 *
 * ORDER MATTERS: regions before skills is not required (they are unrelated), but regions
 * MUST insert parents before children, which the baseline array's ordering guarantees —
 * `discovery_region.parentRegionId` is ON DELETE RESTRICT and the FK is checked per row.
 *
 *   pnpm db:seed-discovery-lookups
 */
import "dotenv/config";
import { db, pool } from "#src/db/index.js";
import { discoveryRegion, discoverySkill } from "#src/db/schema.js";
import { BASELINE_DISCOVERY_REGIONS, BASELINE_DISCOVERY_SKILLS } from "#src/db/seed-data.js";

async function seedRegions(): Promise<number> {
  const insertedRegions = await db
    .insert(discoveryRegion)
    .values(
      BASELINE_DISCOVERY_REGIONS.map((region) => ({
        id: region.id,
        slug: region.slug,
        label: region.label,
        kind: region.kind,
        parentRegionId: region.parentRegionId,
        countryCode: region.countryCode,
      })),
    )
    .onConflictDoNothing({ target: discoveryRegion.slug })
    .returning({ slug: discoveryRegion.slug });

  return insertedRegions.length;
}

async function seedSkills(): Promise<number> {
  const insertedSkills = await db
    .insert(discoverySkill)
    .values(
      BASELINE_DISCOVERY_SKILLS.map((skill) => ({
        id: skill.id,
        slug: skill.slug,
        label: skill.label,
        categoryId: skill.categoryId,
        isActive: true,
      })),
    )
    .onConflictDoNothing({ target: discoverySkill.slug })
    .returning({ slug: discoverySkill.slug });

  return insertedSkills.length;
}

async function main(): Promise<void> {
  const insertedRegionCount = await seedRegions();
  const insertedSkillCount = await seedSkills();

  if (insertedRegionCount === 0 && insertedSkillCount === 0) {
    console.log(
      `All ${BASELINE_DISCOVERY_REGIONS.length} regions and ${BASELINE_DISCOVERY_SKILLS.length} skills already present. Nothing to do.`,
    );
    return;
  }

  console.log(`Inserted ${insertedRegionCount} region(s) and ${insertedSkillCount} skill(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Discovery lookup seed failed:", error);
    await pool.end();
    process.exit(1);
  });
