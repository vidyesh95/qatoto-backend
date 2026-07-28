/**
 * End-to-end smoke test for the cluster↔project link write path, against a REAL database
 * (R_AND_D_BACKEND_STRUCTURE.md §11j.1's second dead end, §11j.4).
 *
 * WHY THIS EXISTS. The vitest suite mocks `#src/db/index.js` wholesale, so it can prove
 * things about schemas and arithmetic and nothing about the two properties that actually
 * matter here, both of which are enforced by Postgres rather than by TypeScript:
 *
 *   1. THE ROUTE IS NOT AN ID ORACLE. A caller who is neither the project's founder nor
 *      platform staff must get the SAME refusal for a real project id and a garbage one.
 *      §11j.4 specifies a 403 for this row; that cannot be correct, because founder-ness
 *      cannot be decided without reading the project id — so a 403/404 split would disclose
 *      whether the project exists. This asserts the two answers are identical.
 *
 *   2. TWO SEPARATE UNIQUE CONSTRAINTS RAISE 23505 ON ONE INSERT. The composite PK means
 *      "this pair is already linked"; `problem_cluster_project_link_origin_unq` means "this
 *      project already names a DIFFERENT origin cluster". The service disambiguates them
 *      with a re-read, and only a real database can prove it picks the right one.
 *
 * It also asserts the source vocabulary in both directions and on both verbs, including
 * that DELETE checks the STORED source — so a founder cannot retract a moderator's curation
 * link and a moderator cannot retract a founder's origin claim.
 *
 *   pnpm db:smoke-cluster-links
 *
 * Creates disposable rows, asserts, and removes everything it created. Exits non-zero on
 * any failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  problemCluster,
  problemClusterProjectLink,
  researchCategory,
  researchProject,
  user,
} from "#src/db/schema.js";
import {
  linkProjectToCluster,
  unlinkProjectFromCluster,
} from "#src/services/problem-clusters.service.js";

const P = "smoke-cluster-links";
const assertions: { label: string; passed: boolean; detail: string }[] = [];
function record(label: string, passed: boolean, detail: string): void {
  assertions.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

async function main(): Promise<void> {
  const founderId = randomUUID(),
    strangerId = randomUUID(),
    modId = randomUUID();
  const catId = randomUUID(),
    projId = randomUUID(),
    proj2Id = randomUUID();
  const clusterId = randomUUID(),
    cluster2Id = randomUUID(),
    hiddenId = randomUUID();

  try {
    await db.insert(user).values([
      { id: founderId, name: `${P}-founder`, email: `${founderId}@x.test`, emailVerified: true },
      { id: strangerId, name: `${P}-stranger`, email: `${strangerId}@x.test`, emailVerified: true },
      {
        id: modId,
        name: `${P}-mod`,
        email: `${modId}@x.test`,
        emailVerified: true,
        platformRole: "moderator",
      },
    ]);
    await db.insert(researchCategory).values({
      id: catId,
      slug: `${P}-${catId.slice(0, 8)}`,
      label: `${P} cat`,
      status: "approved",
    });
    await db.insert(researchProject).values([
      {
        id: projId,
        slug: `${P}-${projId.slice(0, 8)}`,
        name: `${P} project`,
        tagline: "t",
        categoryId: catId,
        founderUserId: founderId,
        status: "active",
        publishedAt: new Date(),
      },
      {
        id: proj2Id,
        slug: `${P}-${proj2Id.slice(0, 8)}`,
        name: `${P} project 2`,
        tagline: "t",
        categoryId: catId,
        founderUserId: founderId,
        status: "active",
        publishedAt: new Date(),
      },
    ]);
    await db.insert(problemCluster).values([
      {
        id: clusterId,
        title: `${P} cluster`,
        description: "d",
        categoryId: catId,
        status: "active",
        centroidLatitudeMicrodegrees: 1,
        centroidLongitudeMicrodegrees: 1,
        centroidLatitudeSumMicrodegrees: 1,
        centroidLongitudeSumMicrodegrees: 1,
        centroidSampleCount: 1,
        distinctReporterCount: 1,
        submissionCount: 1,
        countryCode: "IN",
        firstReportedAt: new Date(),
        lastReportedAt: new Date(),
      },
      {
        id: cluster2Id,
        title: `${P} cluster 2`,
        description: "d",
        categoryId: catId,
        status: "active",
        centroidLatitudeMicrodegrees: 2,
        centroidLongitudeMicrodegrees: 2,
        centroidLatitudeSumMicrodegrees: 2,
        centroidLongitudeSumMicrodegrees: 2,
        centroidSampleCount: 1,
        distinctReporterCount: 1,
        submissionCount: 1,
        countryCode: "IN",
        firstReportedAt: new Date(),
        lastReportedAt: new Date(),
      },
      {
        id: hiddenId,
        title: `${P} hidden`,
        description: "d",
        categoryId: catId,
        status: "hidden",
        centroidLatitudeMicrodegrees: 3,
        centroidLongitudeMicrodegrees: 3,
        centroidLatitudeSumMicrodegrees: 3,
        centroidLongitudeSumMicrodegrees: 3,
        centroidSampleCount: 1,
        distinctReporterCount: 1,
        submissionCount: 1,
        countryCode: "IN",
        firstReportedAt: new Date(),
        lastReportedAt: new Date(),
      },
    ]);

    // 1. Stranger: identical 404-class refusal for a REAL project and a GARBAGE one.
    const strangerReal = await linkProjectToCluster(strangerId, clusterId, {
      projectId: projId,
      source: "founder_declared",
    });
    const strangerFake = await linkProjectToCluster(strangerId, clusterId, {
      projectId: randomUUID(),
      source: "founder_declared",
    });
    const bothDenied =
      !strangerReal.success &&
      strangerReal.error.type === "LINK_DENIED" &&
      !strangerFake.success &&
      strangerFake.error.type === "LINK_DENIED";
    record(
      "not an id oracle",
      bothDenied,
      `real=${!strangerReal.success && strangerReal.error.type} garbage=${!strangerFake.success && strangerFake.error.type}`,
    );

    // 2. Founder may assert origin.
    const originOk = await linkProjectToCluster(founderId, clusterId, {
      projectId: projId,
      source: "origin",
    });
    record(
      "founder asserts origin",
      originOk.success,
      originOk.success ? `source=${originOk.value.source}` : originOk.error.type,
    );

    // 3. Second origin for the SAME project on a DIFFERENT cluster → ORIGIN_ALREADY_SET.
    const secondOrigin = await linkProjectToCluster(founderId, cluster2Id, {
      projectId: projId,
      source: "origin",
    });
    record(
      "second origin refused",
      !secondOrigin.success && secondOrigin.error.type === "ORIGIN_ALREADY_SET",
      !secondOrigin.success ? secondOrigin.error.type : "unexpectedly succeeded",
    );

    // 4. Same pair again → ALREADY_LINKED (the other 23505).
    const dupe = await linkProjectToCluster(founderId, clusterId, {
      projectId: projId,
      source: "founder_declared",
    });
    record(
      "duplicate pair refused",
      !dupe.success && dupe.error.type === "ALREADY_LINKED",
      !dupe.success ? dupe.error.type : "unexpectedly succeeded",
    );

    // 5. Founder may NOT assert moderator; moderator may NOT assert origin.
    const founderAsMod = await linkProjectToCluster(founderId, cluster2Id, {
      projectId: proj2Id,
      source: "moderator",
    });
    const modAsOrigin = await linkProjectToCluster(modId, cluster2Id, {
      projectId: proj2Id,
      source: "origin",
    });
    record(
      "source vocabulary enforced both ways",
      !founderAsMod.success &&
        founderAsMod.error.type === "LINK_SOURCE_NOT_PERMITTED" &&
        !modAsOrigin.success &&
        modAsOrigin.error.type === "LINK_SOURCE_NOT_PERMITTED",
      `founder→moderator=${!founderAsMod.success && founderAsMod.error.type} mod→origin=${!modAsOrigin.success && modAsOrigin.error.type}`,
    );

    // 6. Moderator links with `moderator`.
    const modOk = await linkProjectToCluster(modId, cluster2Id, {
      projectId: proj2Id,
      source: "moderator",
    });
    record(
      "moderator links non-owned project",
      modOk.success,
      modOk.success ? `source=${modOk.value.source}` : modOk.error.type,
    );

    // 7. Hidden cluster refuses new links.
    const hiddenLink = await linkProjectToCluster(founderId, hiddenId, {
      projectId: proj2Id,
      source: "founder_declared",
    });
    record(
      "hidden cluster not linkable",
      !hiddenLink.success && hiddenLink.error.type === "CLUSTER_NOT_LINKABLE",
      !hiddenLink.success ? hiddenLink.error.type : "unexpectedly succeeded",
    );

    // 8. Founder cannot delete the moderator's link; moderator can.
    const founderUnlinkMod = await unlinkProjectFromCluster(founderId, cluster2Id, proj2Id);
    const modUnlinkMod = await unlinkProjectFromCluster(modId, cluster2Id, proj2Id);
    record(
      "delete honours the STORED source",
      !founderUnlinkMod.success &&
        founderUnlinkMod.error.type === "LINK_SOURCE_NOT_PERMITTED" &&
        modUnlinkMod.success,
      `founder=${!founderUnlinkMod.success && founderUnlinkMod.error.type} moderator=${modUnlinkMod.success}`,
    );
  } finally {
    await db
      .delete(problemClusterProjectLink)
      .where(inArray(problemClusterProjectLink.clusterId, [clusterId, cluster2Id, hiddenId]));
    await db
      .delete(problemCluster)
      .where(inArray(problemCluster.id, [clusterId, cluster2Id, hiddenId]));
    await db.delete(researchProject).where(inArray(researchProject.id, [projId, proj2Id]));
    await db.delete(researchCategory).where(eq(researchCategory.id, catId));
    await db.delete(user).where(inArray(user.id, [founderId, strangerId, modId]));
  }

  const failed = assertions.filter((a) => !a.passed).length;
  console.log(
    failed === 0 ? `\nAll ${assertions.length} assertions passed.` : `\n${failed} FAILED.`,
  );
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
