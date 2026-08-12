/**
 * Seeds the §10 paper taxonomy and the Project Immortal program.
 *
 *   pnpm db:seed-research-programs
 *
 * WHAT IT SEEDS, and what it deliberately does not.
 *
 * The five paper categories land `approved`, exactly as `seed-research-categories.ts` does
 * for the project taxonomy — a seeded vocabulary is curated by definition, so it does not
 * pass through moderation.
 *
 * Project Immortal is seeded `published` with its eleven research branches, because those are
 * the program's own structure rather than anybody's contribution: the branch titles and
 * summaries are the editorial map the program is organised around, and an empty map has
 * nothing for a contributor to claim into.
 *
 * PAPERS, POSTS, CONTRIBUTORS AND EFFORT LOGS ARE NOT SEEDED. Every one of them is a claim
 * BY A PERSON — an uploaded paper has an uploader, a post has an author, logged effort has
 * somebody asserting they did the work — and inventing users to attribute them to would put
 * fabricated attestations in a database whose whole purpose is that its attestations are
 * real. Those sections render their empty states until real people fill them, which is the
 * honest outcome. It is also the difference between a seed and a mock.
 *
 * THE BRANCH SIGNALS ARE NOT SEEDED EITHER. Every branch lands at the column default
 * (`emerging`, overlap 0) and `recompute-branch-signals` derives the real values on its next
 * run — or immediately, via `pnpm db:smoke-research-programs`. Seeding a `missing` or
 * `contested` status would be writing the exact field §10 spends a page explaining no writer
 * outside that job may touch.
 *
 * IDEMPOTENT: re-running inserts nothing it has already inserted, so it is safe on a database
 * that has been seeded before.
 */
import "dotenv/config";
import { and, eq, isNotNull } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  researchPaperCategory,
  researchProgram,
  researchProgramBranch,
  user,
} from "#src/db/schema.js";
import { recomputeBranchSignalsForProgram } from "#src/modules/rnd/programs/research-branch-signals.service.js";
import { slugifyPaperCategoryLabel } from "#src/modules/rnd/programs/research-paper-categories.service.js";
import { recomputeProgramStats } from "#src/modules/rnd/programs/research-program-stats.service.js";
import { slugifyProgramTitle } from "#src/modules/rnd/programs/research-programs.service.js";

/** The five categories the §10 formal track opens with. */
const PAPER_CATEGORY_LABELS: readonly string[] = [
  "Longevity Biology",
  "Cellular Reprogramming",
  "AI Drug Discovery",
  "Organ Regeneration",
  "Ethics & Society",
];

const PROGRAM_TITLE = "Project Immortal";
const PROGRAM_TAGLINE = "Open research toward extending healthy human life";
const PROGRAM_MISSION = [
  "Project Immortal is an open research program: anyone may propose a research branch, publish",
  "into the formal paper library, argue in the informal track, and log the effort they put in.",
  "The branch map exists to make two things visible that closed research hides — where the",
  "gaps are, and where several groups are unknowingly duplicating each other's work. Both of",
  "those are computed from what contributors actually do, not asserted by anyone.",
].join(" ");

/**
 * The eleven branches, as a parent-slug tree.
 *
 * `parentTitle` rather than an id, because ids do not exist until the insert; the script
 * resolves them in one pass, parents before children, which the ordering below guarantees.
 */
interface SeedBranch {
  readonly title: string;
  readonly summary: string;
  readonly parentTitle: string | null;
}

const SEED_BRANCHES: readonly SeedBranch[] = [
  {
    title: "Hallmarks of Aging",
    summary:
      "The root question: which cellular and molecular changes actually drive ageing, as opposed to merely accompanying it. Every other branch descends from a position on this.",
    parentTitle: null,
  },
  {
    title: "Cellular Reprogramming",
    summary:
      "Partial reprogramming of somatic cells toward a younger epigenetic state without losing cell identity. The central promise and the central safety problem.",
    parentTitle: "Hallmarks of Aging",
  },
  {
    title: "Senescent-Cell Clearance",
    summary:
      "Selectively removing cells that have stopped dividing but continue to signal inflammation. The most clinically advanced of the hallmark interventions.",
    parentTitle: "Hallmarks of Aging",
  },
  {
    title: "Organ Replacement",
    summary:
      "Growing, preserving and transplanting replacement organs, on the argument that repair has limits an entire organ does not.",
    parentTitle: "Hallmarks of Aging",
  },
  {
    title: "AI Drug Discovery",
    summary:
      "Computational screening and ranking of candidate geroprotectors, to shorten the loop between a hypothesis about ageing and a compound to test it with.",
    parentTitle: "Hallmarks of Aging",
  },
  {
    title: "Long-term reprogramming safety data",
    summary:
      "Multi-year follow-up on partially reprogrammed tissue in large animals. Widely cited as the blocker on human trials, and almost nobody is producing it.",
    parentTitle: "Cellular Reprogramming",
  },
  {
    title: "Epigenetic Clocks",
    summary:
      "Methylation-based estimators of biological age. Contested: several clocks disagree on the same sample, and it is unsettled whether they measure damage or merely correlate with time.",
    parentTitle: "Cellular Reprogramming",
  },
  {
    title: "Human Senolytic Trials",
    summary:
      "Dose-finding and endpoint selection for senolytic compounds in humans, including which endpoints a regulator would accept for an indication that is not a disease.",
    parentTitle: "Senescent-Cell Clearance",
  },
  {
    title: "Aging biomarkers for South-Asian cohorts",
    summary:
      "Almost every ageing biomarker was calibrated on European-ancestry cohorts. Whether they transfer is an open question affecting a quarter of the world's population.",
    parentTitle: "Senescent-Cell Clearance",
  },
  {
    title: "Organ Preservation",
    summary:
      "Vitrification and controlled rewarming, so that a viable organ is not lost to the clock between donor and recipient.",
    parentTitle: "Organ Replacement",
  },
  {
    title: "Geroprotector Screening",
    summary:
      "Assay design and hit triage for compounds that extend healthy lifespan in model organisms, and the reproducibility problem in that literature.",
    parentTitle: "AI Drug Discovery",
  },
];

const PATH_SEPARATOR = "/";

async function main(): Promise<void> {
  console.log("\n--- 1. Paper categories ---");

  let insertedCategoryCount = 0;
  for (const label of PAPER_CATEGORY_LABELS) {
    const slug = slugifyPaperCategoryLabel(label);
    const [existing] = await db
      .select({ id: researchPaperCategory.id })
      .from(researchPaperCategory)
      .where(eq(researchPaperCategory.slug, slug));

    if (existing) {
      console.log(`  = ${slug} (already present)`);
      continue;
    }
    // `approved`, not `pending`: a seeded vocabulary is curated by definition and does not
    // pass through moderation. `createdByUserId` stays NULL — nobody proposed it.
    await db
      .insert(researchPaperCategory)
      .values({ slug, label, status: "approved", createdByUserId: null });
    insertedCategoryCount += 1;
    console.log(`  + ${slug}`);
  }
  console.log(`  ${String(insertedCategoryCount)} inserted.`);

  console.log("\n--- 2. Project Immortal ---");

  const programSlug = slugifyProgramTitle(PROGRAM_TITLE);
  const [existingProgram] = await db
    .select({ id: researchProgram.id, status: researchProgram.status })
    .from(researchProgram)
    .where(eq(researchProgram.slug, programSlug));

  let programId: string;

  if (existingProgram) {
    programId = existingProgram.id;
    console.log(`  = ${programSlug} (already present, status ${existingProgram.status})`);
  } else {
    /**
     * A PUBLISHED program needs a reviewer, and the CHECKs enforce it:
     * `(status = 'pending') = (reviewed_at IS NULL)` plus
     * `(reviewed_by_user_id IS NULL) = (reviewed_at IS NULL)`. That is the accountability
     * property working as designed — a published program records who decided to publish it —
     * so the seed uses a real staff account rather than loosening the constraint.
     */
    const [reviewer] = await db
      .select({ id: user.id, email: user.email, platformRole: user.platformRole })
      .from(user)
      .where(and(isNotNull(user.platformRole), isNotNull(user.email)))
      .limit(1);

    if (!reviewer) {
      console.error(
        [
          "",
          "  No platform staff account exists, so a PUBLISHED program cannot be seeded.",
          "",
          "  A published program records who published it — that is the accountability",
          "  property the CHECK constraints enforce, not an inconvenience to work around.",
          "",
          "  Grant a role first, then re-run:",
          "    pnpm db:grant-platform-role <email> admin",
          "    pnpm db:seed-research-programs",
          "",
        ].join("\n"),
      );
      process.exitCode = 1;
      return;
    }

    const publishedAt = new Date();
    const [created] = await db
      .insert(researchProgram)
      .values({
        slug: programSlug,
        title: PROGRAM_TITLE,
        tagline: PROGRAM_TAGLINE,
        missionStatement: PROGRAM_MISSION,
        status: "published",
        // NULL: nobody proposed this one through the wizard. `set null` on the FK makes that
        // representable, and it is the truth.
        createdByUserId: null,
        publishedAt,
        reviewedByUserId: reviewer.id,
        reviewedAt: publishedAt,
        reviewerNote: "Seeded as the reference research program (pnpm db:seed-research-programs).",
      })
      .returning({ id: researchProgram.id });

    if (!created) throw new Error("seed: program insert returned no row");
    programId = created.id;
    console.log(`  + ${programSlug} (published, reviewer ${reviewer.platformRole ?? "?"})`);
  }

  console.log("\n--- 3. Research branches ---");

  // Resolve existing titles so a re-run is a no-op and a partial run completes.
  const existingBranches = await db
    .select({
      id: researchProgramBranch.id,
      title: researchProgramBranch.title,
      ancestorPath: researchProgramBranch.ancestorPath,
    })
    .from(researchProgramBranch)
    .where(eq(researchProgramBranch.programId, programId));

  const branchIdByTitle = new Map(existingBranches.map((row) => [row.title, row.id]));
  const pathByTitle = new Map(existingBranches.map((row) => [row.title, row.ancestorPath]));
  const siblingOrderByParent = new Map<string, number>();

  let insertedBranchCount = 0;

  // Parents precede children in SEED_BRANCHES, so one pass resolves every parent id.
  for (const seedBranch of SEED_BRANCHES) {
    if (branchIdByTitle.has(seedBranch.title)) {
      console.log(`  = ${seedBranch.title} (already present)`);
      continue;
    }

    const parentId =
      seedBranch.parentTitle === null
        ? null
        : (branchIdByTitle.get(seedBranch.parentTitle) ?? null);

    if (seedBranch.parentTitle !== null && parentId === null) {
      throw new Error(
        `seed: branch "${seedBranch.title}" names parent "${seedBranch.parentTitle}", which was not inserted first`,
      );
    }

    const parentKey = seedBranch.parentTitle ?? "(root)";
    const siblingOrder = siblingOrderByParent.get(parentKey) ?? 0;
    siblingOrderByParent.set(parentKey, siblingOrder + 1);

    const [inserted] = await db
      .insert(researchProgramBranch)
      .values({
        programId,
        parentBranchId: parentId,
        title: seedBranch.title,
        summary: seedBranch.summary,
        // Placeholder, replaced below — the path contains the row's own id, which does not
        // exist until the insert returns. Same two-step the service uses.
        ancestorPath: `pending-${seedBranch.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        siblingOrder,
        createdByUserId: null,
        // `status` and `overlappingGroupCount` are left at their column defaults on purpose.
        // `recompute-branch-signals` owns them; seeding them would be writing the exact
        // fields §10 says no writer outside that job may touch.
      })
      .returning({ id: researchProgramBranch.id });

    if (!inserted) throw new Error(`seed: branch insert returned no row for "${seedBranch.title}"`);

    const parentPath =
      seedBranch.parentTitle === null ? null : (pathByTitle.get(seedBranch.parentTitle) ?? null);
    const ancestorPath =
      parentPath === null ? inserted.id : `${parentPath}${PATH_SEPARATOR}${inserted.id}`;

    await db
      .update(researchProgramBranch)
      .set({ ancestorPath })
      .where(eq(researchProgramBranch.id, inserted.id));

    branchIdByTitle.set(seedBranch.title, inserted.id);
    pathByTitle.set(seedBranch.title, ancestorPath);
    insertedBranchCount += 1;
    console.log(`  + ${seedBranch.title}`);
  }

  console.log(`  ${String(insertedBranchCount)} inserted.`);

  console.log("\n--- 4. Derive the signals and the stat tiles ---");

  /**
   * Runs the two nightly derivations once, now.
   *
   * WHY THE SEED DOES THIS. Both jobs are pure computations over rows that exist by the time
   * this line runs, so calling them fabricates nothing — it just does at seed time what cron
   * would do at 03:20 and 03:35 UTC. Without it the flagship page reads wrong for up to a day:
   * every branch shows the column default `emerging` when the derivation says `missing`, and
   * `GET …/stats` answers 404, which is honest but makes a seeded program look broken.
   *
   * The distinction that matters: these are DERIVATIONS, not seeded values. The seed still does
   * not write `status` or `overlappingGroupCount` itself — it asks the one module that owns them
   * to compute them, which is the same call the job makes.
   */
  const signalOutcomes = await recomputeBranchSignalsForProgram(programId);
  const statusTally = signalOutcomes.reduce<Record<string, number>>((tally, outcome) => {
    tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
    return tally;
  }, {});
  console.log(
    `  branch signals derived: ${Object.entries(statusTally)
      .map(([status, howMany]) => `${String(howMany)} ${status}`)
      .join(", ")}`,
  );

  // Quantized to the UTC day start, exactly as the tick does, so a later real run for the same
  // day dedups against this one instead of appending a second snapshot.
  const asOf = new Date();
  asOf.setUTCHours(0, 0, 0, 0);
  const statsOutcome = await recomputeProgramStats(programId, asOf);
  console.log(
    `  stat snapshot at ${asOf.toISOString()}${statsOutcome.wasAlreadyComputed ? " (already present)" : ""}`,
  );

  console.log(
    [
      "",
      "Seeded. What is deliberately EMPTY, and will stay so until real people act:",
      "  papers, posts, contributors and effort logs. Every one is a claim BY somebody, and",
      "  inventing users to attribute them to would put fabricated attestations in a database",
      "  whose whole point is that its attestations are real. Those sections render their empty",
      "  states — which is the difference between a seed and a mock.",
      "",
      "What is DERIVED rather than seeded: every branch's `status` and `overlappingGroupCount`,",
      "  and the four stat tiles. Recomputed above by the modules that own them, and again",
      "  nightly at 03:20 and 03:35 UTC.",
      "",
      `Visit: /research-and-development/programs/${programSlug}`,
      "",
    ].join("\n"),
  );
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Research program seed failed:", error);
    await pool.end();
    process.exit(1);
  });
