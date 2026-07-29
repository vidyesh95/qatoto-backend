/**
 * Smoke test for the controlled-vocabulary delete guards, against a REAL database
 * (R_AND_D_BACKEND_STRUCTURE.md §11j.4).
 *
 * WHY THIS EXISTS, and it is one assertion in particular. Seven foreign keys into
 * `discovery_region` are `restrict`, so Postgres refuses those deletes on its own — but
 * `talent_profile.regionId` is `ON DELETE SET NULL`. An FK configured to OVERWRITE cannot
 * also protect: without the service's explicit pre-count, deleting a region SUCCEEDS,
 * silently blanks the region on every talent profile that used it, and drops them out of the
 * `?region=` facet with nothing raised anywhere. Nothing in the type system can see that,
 * and the mocked vitest suite cannot either.
 *
 * The remaining assertions cover the cases Postgres DOES catch, so the two halves of the
 * guard are both exercised: a region with children, a skill cited by a profile (refused with
 * a count, so the message can name a number), and the unreferenced cases that must succeed.
 *
 *   pnpm db:smoke-vocabulary
 *
 * Creates disposable rows, asserts, and removes everything it created.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  discoveryRegion,
  discoverySkill,
  talentProfile,
  talentProfileSkill,
  user,
} from "#src/db/schema.js";
import {
  deleteDiscoveryRegion,
  deleteDiscoverySkill,
} from "#src/services/discovery-vocabulary.service.js";

const out: { p: boolean; l: string; d: string }[] = [];
const rec = (l: string, p: boolean, d: string) => {
  out.push({ p, l, d });
  console.log(`${p ? "PASS" : "FAIL"}  ${l} — ${d}`);
};

/**
 * The moderator fixture is STABLE across runs, and it is not deletable.
 *
 * Every vocabulary write now appends to the platform audit chain (§11l.2 item 2), whose
 * `actor_user_id` FK is `restrict` and whose rows are append-only by trigger. Together those
 * mean a user who has ever moderated ANYTHING can never be deleted — which is the point of
 * both rules and is exactly what the teardown below used to attempt.
 *
 * A fresh random moderator per run would therefore accumulate one undeletable user row every
 * time this script is run. One fixed id, reused, accumulates none.
 */
const VOCABULARY_SMOKE_MODERATOR_ID = "00000000-0000-4000-8000-0000000a0c01";

async function main(): Promise<void> {
  const modId = VOCABULARY_SMOKE_MODERATOR_ID;
  const profileUserId = randomUUID();
  const rootId = randomUUID(),
    citedRegionId = randomUUID(),
    freeRegionId = randomUUID();
  const citedSkillId = randomUUID(),
    freeSkillId = randomUUID();
  try {
    // Upsert, because the moderator survives every previous run (see the constant above).
    await db
      .insert(user)
      .values({
        id: modId,
        name: "vocab-mod",
        email: `${modId}@x.test`,
        emailVerified: true,
        platformRole: "moderator",
      })
      .onConflictDoUpdate({ target: user.id, set: { platformRole: "moderator" } });

    await db.insert(user).values({
      id: profileUserId,
      name: "vocab-talent",
      email: `${profileUserId}@x.test`,
      emailVerified: true,
    });
    await db.insert(discoveryRegion).values([
      {
        id: rootId,
        slug: `vocab-root-${rootId.slice(0, 8)}`,
        label: "Root",
        kind: "global",
        parentRegionId: null,
      },
      {
        id: citedRegionId,
        slug: `vocab-cited-${citedRegionId.slice(0, 8)}`,
        label: "Cited",
        kind: "macro_region",
        parentRegionId: rootId,
      },
      {
        id: freeRegionId,
        slug: `vocab-free-${freeRegionId.slice(0, 8)}`,
        label: "Free",
        kind: "macro_region",
        parentRegionId: rootId,
      },
    ]);
    await db.insert(discoverySkill).values([
      { id: citedSkillId, slug: `vocab-cited-${citedSkillId.slice(0, 8)}`, label: "Cited skill" },
      { id: freeSkillId, slug: `vocab-free-${freeSkillId.slice(0, 8)}`, label: "Free skill" },
    ]);
    // A talent profile pointing at the cited region AND citing the cited skill.
    await db
      .insert(talentProfile)
      .values({ userId: profileUserId, headlineRole: "Engineer", regionId: citedRegionId });
    await db
      .insert(talentProfileSkill)
      .values({ talentProfileUserId: profileUserId, skillId: citedSkillId });

    // THE ONE THAT MATTERS: region delete must be refused even though its FK is SET NULL.
    const citedRegion = await deleteDiscoveryRegion(modId, citedRegionId);
    const [profileAfter] = await db
      .select({ regionId: talentProfile.regionId })
      .from(talentProfile)
      .where(eq(talentProfile.userId, profileUserId));
    rec(
      "region cited by a talent profile is refused (SET NULL would have blanked it silently)",
      !citedRegion.success &&
        citedRegion.error.type === "REGION_HAS_REFERENCES" &&
        profileAfter?.regionId === citedRegionId,
      `refusal=${!citedRegion.success && citedRegion.error.type} profile.regionId still set=${profileAfter?.regionId === citedRegionId}`,
    );

    // A region with a CHILD is refused by restrict on the self-reference.
    const rootRegion = await deleteDiscoveryRegion(modId, rootId);
    rec(
      "region with children refused",
      !rootRegion.success && rootRegion.error.type === "REGION_HAS_REFERENCES",
      !rootRegion.success ? rootRegion.error.type : "unexpectedly succeeded",
    );

    // An unreferenced region deletes.
    const freeRegion = await deleteDiscoveryRegion(modId, freeRegionId);
    rec("unreferenced region deletes", freeRegion.success, String(freeRegion.success));

    // Skill cited by a profile → refused, with a COUNT.
    const citedSkill = await deleteDiscoverySkill(modId, citedSkillId);
    rec(
      "cited skill refused and names the count",
      !citedSkill.success &&
        citedSkill.error.type === "SKILL_HAS_REFERENCES" &&
        citedSkill.error.profileCount === 1,
      !citedSkill.success && citedSkill.error.type === "SKILL_HAS_REFERENCES"
        ? `profileCount=${citedSkill.error.profileCount}`
        : "wrong error",
    );

    // Unused skill deletes.
    const freeSkill = await deleteDiscoverySkill(modId, freeSkillId);
    rec("unused skill deletes", freeSkill.success, String(freeSkill.success));

    // A non-moderator gets 403-class refusal, and it names no resource.
    const nonStaff = await deleteDiscoveryRegion(profileUserId, rootId);
    rec(
      "non-moderator refused by capability",
      !nonStaff.success && nonStaff.error.type === "PLATFORM_CAPABILITY_REQUIRED",
      !nonStaff.success ? nonStaff.error.type : "unexpectedly succeeded",
    );
  } finally {
    await db
      .delete(talentProfileSkill)
      .where(eq(talentProfileSkill.talentProfileUserId, profileUserId));
    await db.delete(talentProfile).where(eq(talentProfile.userId, profileUserId));
    await db.delete(discoverySkill).where(inArray(discoverySkill.id, [citedSkillId, freeSkillId]));
    await db
      .delete(discoveryRegion)
      .where(inArray(discoveryRegion.id, [citedRegionId, freeRegionId]));
    await db.delete(discoveryRegion).where(eq(discoveryRegion.id, rootId));
    // ONLY the talent profile's user. The moderator is deliberately left: it now owns
    // append-only platform audit entries behind a `restrict` FK, so deleting it is refused
    // by Postgres — correctly. It is a fixed id precisely so this leaves one row, not one
    // per run.
    await db.delete(user).where(eq(user.id, profileUserId));
  }
  const failed = out.filter((a) => !a.p).length;
  console.log(failed === 0 ? `\nAll ${out.length} assertions passed.` : `\n${failed} FAILED.`);
  if (failed > 0) process.exitCode = 1;
}
main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (e: unknown) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
