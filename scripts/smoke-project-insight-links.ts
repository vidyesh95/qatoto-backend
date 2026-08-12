/**
 * End-to-end smoke test for §11k — the two project-side reads §11j left open, and the
 * citation write path one of them needed (R_AND_D_BACKEND_STRUCTURE.md §11k.1, §11k.2).
 *
 * WHY THIS EXISTS. The vitest suite mocks `#src/db/index.js` wholesale, so it can prove
 * things about schemas and arithmetic and nothing about the four properties that matter here,
 * every one of which lives in Postgres or in a join:
 *
 *   1. THE ROUTE IS NOT AN ID ORACLE. A caller who is neither the project's founder nor
 *      platform staff must get the SAME refusal for a real project slug and a garbage one,
 *      and a founder must get that same refusal for an UNPUBLISHED insight. Founder-ness
 *      cannot be decided without reading the slug, so any split discloses existence.
 *
 *   2. THE CHIPS HIDE A DRAFT. An insight can be unpublished AFTER being cited. The link row
 *      survives on purpose; the chip must not, or the project detail becomes the one place in
 *      the domain where a draft insight leaks.
 *
 *   3. A CITED INSIGHT CANNOT BE DELETED. `market_insight_project_link.insight_id` is
 *      `ON DELETE restrict` (migration 0023), and the service translates the 23503 rather
 *      than 500-ing. Only a real database raises it.
 *
 *   4. `originCluster` RESPECTS `hidden`. The project detail read is public, and a
 *      moderator-hidden cluster must not surface through it.
 *
 *   pnpm db:smoke-insight-links
 *
 * Creates disposable rows, asserts, and removes everything it created. Exits non-zero on any
 * failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  discoveryRegion,
  marketInsight,
  marketInsightProjectLink,
  problemCluster,
  problemClusterProjectLink,
  researchCategory,
  researchProject,
  user,
} from "#src/db/schema.js";
import {
  linkMarketInsightToProject,
  unlinkMarketInsightFromProject,
} from "#src/modules/rnd/projects/project-insight-links.service.js";
import { findResearchProjectBySlug } from "#src/modules/rnd/projects/research-projects.service.js";
import { deleteMarketInsight } from "#src/services/market-insights.service.js";

const P = "smoke-insight-links";
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
    hiddenClusterId = randomUUID();
  const publishedInsightId = randomUUID(),
    secondInsightId = randomUUID(),
    draftInsightId = randomUUID();

  const projSlug = `${P}-${projId.slice(0, 8)}`;
  const proj2Slug = `${P}-${proj2Id.slice(0, 8)}`;

  const [region] = await db.select({ id: discoveryRegion.id }).from(discoveryRegion).limit(1);
  if (!region) {
    throw new Error(`${P}: discovery_region is empty — run pnpm db:seed-discovery-lookups first`);
  }

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
        slug: projSlug,
        name: `${P} project`,
        tagline: "t",
        categoryId: catId,
        founderUserId: founderId,
        status: "active",
        publishedAt: new Date(),
      },
      {
        id: proj2Id,
        slug: proj2Slug,
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
        id: hiddenClusterId,
        title: `${P} hidden cluster`,
        description: "d",
        categoryId: catId,
        status: "hidden",
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
    ]);
    await db.insert(marketInsight).values([
      {
        id: publishedInsightId,
        headline: `${P} published insight`,
        statKind: "absolute_count",
        statValueMilli: 68_000_000,
        statUnitKey: "people",
        trendDirection: "up",
        regionId: region.id,
        categoryId: catId,
        sourceName: `${P} source`,
        sourcePublishedDate: "2026-01-01",
        publishedAt: new Date(),
      },
      {
        id: secondInsightId,
        headline: `${P} second insight`,
        statKind: "absolute_count",
        statValueMilli: 12_000_000,
        statUnitKey: "households",
        trendDirection: "flat",
        regionId: region.id,
        categoryId: catId,
        sourceName: `${P} source`,
        sourcePublishedDate: "2026-01-02",
        publishedAt: new Date(),
      },
      {
        id: draftInsightId,
        headline: `${P} draft insight`,
        statKind: "absolute_count",
        statValueMilli: 1_000,
        statUnitKey: "count",
        trendDirection: "flat",
        regionId: region.id,
        categoryId: catId,
        sourceName: `${P} source`,
        sourcePublishedDate: "2026-01-03",
        // publishedAt deliberately absent — this row is the draft.
      },
    ]);

    // 1. Stranger: identical refusal for a REAL project slug and a GARBAGE one.
    const strangerReal = await linkMarketInsightToProject(strangerId, projSlug, publishedInsightId);
    const strangerFake = await linkMarketInsightToProject(
      strangerId,
      `${P}-nonexistent`,
      publishedInsightId,
    );
    record(
      "not an id oracle: real slug and garbage slug refuse identically",
      !strangerReal.success &&
        strangerReal.error.type === "INSIGHT_LINK_DENIED" &&
        !strangerFake.success &&
        strangerFake.error.type === "INSIGHT_LINK_DENIED",
      `real=${!strangerReal.success && strangerReal.error.type} garbage=${!strangerFake.success && strangerFake.error.type}`,
    );

    // 2. A DRAFT insight is refused with that SAME error, to the project's own founder.
    const draftAttempt = await linkMarketInsightToProject(founderId, projSlug, draftInsightId);
    const missingAttempt = await linkMarketInsightToProject(founderId, projSlug, randomUUID());
    record(
      "a draft insight is indistinguishable from a nonexistent one",
      !draftAttempt.success &&
        draftAttempt.error.type === "INSIGHT_LINK_DENIED" &&
        !missingAttempt.success &&
        missingAttempt.error.type === "INSIGHT_LINK_DENIED",
      `draft=${!draftAttempt.success && draftAttempt.error.type} missing=${!missingAttempt.success && missingAttempt.error.type}`,
    );

    // 3. The founder cites a published insight; the second attempt is a 409.
    const linked = await linkMarketInsightToProject(founderId, projSlug, publishedInsightId);
    const linkedAgain = await linkMarketInsightToProject(founderId, projSlug, publishedInsightId);
    record(
      "founder cites a published insight, once",
      linked.success &&
        linked.value.insightId === publishedInsightId &&
        !linkedAgain.success &&
        linkedAgain.error.type === "INSIGHT_ALREADY_LINKED",
      `first=${linked.success} second=${!linkedAgain.success && linkedAgain.error.type}`,
    );

    // 4. A moderator who is not the founder may cite too.
    const modLinked = await linkMarketInsightToProject(modId, projSlug, secondInsightId);
    record(
      "a moderator may cite without being a member",
      modLinked.success,
      modLinked.success ? "201" : modLinked.error.type,
    );

    // 5. The chips read back, newest first, and carry the headline.
    const withChips = await findResearchProjectBySlug(projSlug, null);
    const chipIds = withChips.success
      ? withChips.value.relatedInsights.map((i) => i.insightId)
      : [];
    record(
      "relatedInsights renders both citations",
      withChips.success &&
        chipIds.length === 2 &&
        chipIds.includes(publishedInsightId) &&
        chipIds.includes(secondInsightId) &&
        withChips.value.relatedInsights.every((i) => i.headline.startsWith(P)),
      `${chipIds.length} chips`,
    );

    // 6. Unpublishing hides the chip and KEEPS the row.
    await db
      .update(marketInsight)
      .set({ publishedAt: null })
      .where(eq(marketInsight.id, secondInsightId));
    const afterUnpublish = await findResearchProjectBySlug(projSlug, null);
    const [survivingRow] = await db
      .select({ insightId: marketInsightProjectLink.insightId })
      .from(marketInsightProjectLink)
      .where(eq(marketInsightProjectLink.insightId, secondInsightId));
    record(
      "an unpublished insight leaves the chips but keeps the link",
      afterUnpublish.success &&
        afterUnpublish.value.relatedInsights.length === 1 &&
        afterUnpublish.value.relatedInsights[0]?.insightId === publishedInsightId &&
        survivingRow !== undefined,
      `chips=${afterUnpublish.success ? afterUnpublish.value.relatedInsights.length : "?"} row=${survivingRow !== undefined}`,
    );

    // 7. That link is still retractable — the delete does not re-check publishedAt.
    const unlinkedDraft = await unlinkMarketInsightFromProject(modId, projSlug, secondInsightId);
    const unlinkedTwice = await unlinkMarketInsightFromProject(modId, projSlug, secondInsightId);
    record(
      "a citation of an unpublished insight can still be retracted",
      unlinkedDraft.success &&
        !unlinkedTwice.success &&
        unlinkedTwice.error.type === "INSIGHT_LINK_NOT_FOUND",
      `first=${unlinkedDraft.success} second=${!unlinkedTwice.success && unlinkedTwice.error.type}`,
    );

    // 8. A CITED insight cannot be hard-deleted — the restrict FK, translated not 500'd.
    const deleteCited = await deleteMarketInsight(modId, publishedInsightId);
    record(
      "a cited insight refuses deletion",
      !deleteCited.success && deleteCited.error.type === "MARKET_INSIGHT_CITED",
      !deleteCited.success ? deleteCited.error.type : "unexpectedly deleted",
    );

    // 9. §11k.1 — originCluster resolves, and a HIDDEN cluster does not.
    await db.insert(problemClusterProjectLink).values([
      { clusterId, projectId: projId, source: "origin", linkedByUserId: founderId },
      {
        clusterId: hiddenClusterId,
        projectId: proj2Id,
        source: "origin",
        linkedByUserId: founderId,
      },
    ]);
    const withOrigin = await findResearchProjectBySlug(projSlug, null);
    const withHiddenOrigin = await findResearchProjectBySlug(proj2Slug, null);
    record(
      "originCluster resolves for an active cluster",
      withOrigin.success && withOrigin.value.originCluster?.clusterId === clusterId,
      withOrigin.success ? JSON.stringify(withOrigin.value.originCluster) : "read failed",
    );
    record(
      "originCluster stays null for a moderator-hidden cluster",
      withHiddenOrigin.success && withHiddenOrigin.value.originCluster === null,
      withHiddenOrigin.success
        ? JSON.stringify(withHiddenOrigin.value.originCluster)
        : "read failed",
    );
  } finally {
    await db
      .delete(marketInsightProjectLink)
      .where(inArray(marketInsightProjectLink.projectId, [projId, proj2Id]));
    await db
      .delete(problemClusterProjectLink)
      .where(inArray(problemClusterProjectLink.projectId, [projId, proj2Id]));
    await db
      .delete(marketInsight)
      .where(inArray(marketInsight.id, [publishedInsightId, secondInsightId, draftInsightId]));
    await db.delete(problemCluster).where(inArray(problemCluster.id, [clusterId, hiddenClusterId]));
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
