import path from "node:path";
import { pathToFileURL } from "node:url";

import "dotenv/config";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db, pool } from "#src/db/index.js";
import {
  caseStudy,
  caseStudyActionStep,
  caseStudyEvidenceCompany,
  caseStudyOutcomeMetric,
  caseStudyPitfall,
  caseStudyRelatedLesson,
  caseStudySource,
  caseStudyStats,
} from "#src/db/schema.js";
import {
  CASE_STUDY_STATEMENT_IDS_BY_RELATIONSHIP,
  CaseStudySubmissionSchema,
  type CaseStudySubmission,
} from "#src/modules/home/blueprints/case-study-submission.schemas.js";

/**
 * Seeds the ten case studies the frontend has been serving from fixtures.
 *
 * WHY A SEED WHEN THE WRITE ROUTE IS REAL. Because the ten are already visible. This round makes the
 * composer work, so new case studies arrive the honest way — but shipping reads without these ten
 * would take a page that shows ten lessons down to an empty state on the same day, which is a worse
 * answer than the fixtures were.
 *
 * ⚠️ THE FIXTURES ARE THE POST-SERIALIZER VIEW AND ARE NOT A VALID WRITE PAYLOAD. This is the one
 * real difference from `seed-blueprint-teardowns.ts`, which could parse its fixtures with the write
 * schema directly. These cannot:
 *
 *   * one company's `name` is `null` — that is what a withheld name LOOKS LIKE to a reader, and the
 *     real name exists nowhere in that file;
 *   * `isNameWithheld` is absent entirely, because a reader never sees the flag;
 *   * `acceptedStatementIds` is absent, because the statements a writer ticked are for moderators.
 *
 * So `toSubmission` below adapts the read shape back into a write payload, and every value it
 * invents is named. It is a small, documented lie in one direction only: the seed can express
 * something the fixture cannot, never something the write route would refuse.
 *
 * ⚠️ `name` DOES NOT BECOME NULLABLE BECAUSE OF THIS. A nullable name beside `is_name_withheld`
 * would be two spellings of one fact, and the moderator read's contract requires a non-null name.
 *
 * IDEMPOTENT BY DELETE-AND-REPLACE keyed on the public slug; every child cascades. Parents are
 * inserted before any related-lesson edge, because `related_public_slug` is a real foreign key onto
 * `case_study.public_slug` — one transaction and plain ordering, no deferred constraint.
 *
 * ⚠️ THIS SCRIPT PRINTS A REFUSED ROW ON FAILURE, into a terminal and a CI log. One of those rows
 * carries a withheld company name. That is acceptable for an operator-run script against fixtures
 * whose every name is invented, and it is written down so nobody points it at real data.
 */

const DEFAULT_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../frontend/qatoto-frontend/src/mocks/blueprints-mocks.ts",
);

/**
 * ⚠️ THE ONE VALUE IN THIS SEED THAT IS NOT IN THE FIXTURE FILE.
 *
 * The fixtures' withheld company has no name to read — `{ name: null }` is the whole record. A
 * withheld company still needs one, because the moderator queue is the reason the column exists, so
 * the seed supplies an invented one. The mocks file's own header governs the choice: "every person
 * and company is invented and must stay invented."
 *
 * DELIBERATELY NOT `"Halden Toolroom"`, which is the frontend's only real withheld name — it belongs
 * to an unpublished submission in the review-queue mocks, and borrowing it would make a review
 * fixture look like it had been published.
 */
const INVENTED_WITHHELD_COMPANY_NAME = "Kvarnby Mouldworks";

/**
 * The fields the seed needs that a submission does not carry: identity, the byline, the counters and
 * the instant. A published case study has all of them; the write route mints or derives each one.
 */
const CaseStudyFixtureSchema = z
  .object({
    slug: z.string().min(3).max(120),
    author: z
      .object({
        displayName: z.string().min(1).max(80),
        handle: z.string().min(1).max(64).nullable(),
        avatarUrl: z.string().min(1).max(2048).nullable(),
      })
      .strip(),
    viewCount: z.number().int().nonnegative(),
    likeCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .strip();

type CaseStudyFixture = z.infer<typeof CaseStudyFixtureSchema>;

/**
 * The read shape a fixture carries, as a write payload.
 *
 * THREE DERIVATIONS, each one a fact the reader's view dropped rather than a fact being made up:
 * a `null` name means the writer withheld it; a withheld company needs the real name back (see the
 * constant above); and the statements a writer ticked follow from the answer the fixture does state.
 */
function toSubmission(fixtureRecord: Record<string, unknown>): unknown {
  const evidenceCompanies = Array.isArray(fixtureRecord.evidenceCompanies)
    ? fixtureRecord.evidenceCompanies.map((company: unknown) => {
        const companyRecord: Record<string, unknown> =
          typeof company === "object" && company !== null ? { ...company } : {};
        const isNameWithheld = companyRecord.name === null;
        return {
          name: isNameWithheld ? INVENTED_WITHHELD_COMPANY_NAME : companyRecord.name,
          isNameWithheld,
          locationLabel: companyRecord.locationLabel,
          yearLabel: companyRecord.yearLabel,
        };
      })
    : fixtureRecord.evidenceCompanies;

  const authorRelationship = fixtureRecord.authorRelationship;
  const acceptedStatementIds =
    authorRelationship === "first_hand" || authorRelationship === "public_sources"
      ? [...CASE_STUDY_STATEMENT_IDS_BY_RELATIONSHIP[authorRelationship]]
      : [];

  return {
    title: fixtureRecord.title,
    oneLineAction: fixtureRecord.oneLineAction,
    discipline: fixtureRecord.discipline,
    sector: fixtureRecord.sector,
    outcomeSummary: fixtureRecord.outcomeSummary,
    authorRelationship,
    summary: fixtureRecord.summary,
    problem: fixtureRecord.problem,
    context: fixtureRecord.context,
    actionSteps: fixtureRecord.actionSteps,
    pitfalls: fixtureRecord.pitfalls,
    evidenceCompanies,
    timelineLabel: fixtureRecord.timelineLabel,
    capitalRaised: fixtureRecord.capitalRaised,
    outcomeMetrics: fixtureRecord.outcomeMetrics,
    sources: fixtureRecord.sources,
    relatedLessonSlugs: fixtureRecord.relatedLessonSlugs,
    tags: fixtureRecord.tags,
    acceptedStatementIds,
  };
}

interface SeedableCaseStudy {
  readonly fixture: CaseStudyFixture;
  readonly submission: CaseStudySubmission;
}

async function loadCaseStudyFixtures(): Promise<readonly SeedableCaseStudy[]> {
  // The two repositories are siblings by convention, not by guarantee — so the path is overridable.
  const fixturePath =
    process.argv[2] ?? process.env.QATOTO_FRONTEND_MOCKS_PATH ?? DEFAULT_FIXTURE_PATH;
  /*
   * ⚠️ A RUNTIME IMPORT, NOT A STATIC ONE. `tsconfig.scripts.json` includes `scripts/**`, and
   * TypeScript resolves even type-only imports, so a static import of the sibling repo's fixtures
   * makes `@/lib/blueprints/schemas` a TS2307 in THIS repo's typecheck. A `file://` specifier is
   * invisible to the compiler and lands the payload as `unknown`, where CLAUDE.md §3.1 wants it.
   */
  const fixtureModule: unknown = await import(pathToFileURL(fixturePath).href);

  if (
    typeof fixtureModule !== "object" ||
    fixtureModule === null ||
    !("MOCK_BLUEPRINTS" in fixtureModule)
  ) {
    throw new Error(`No MOCK_BLUEPRINTS export in ${fixturePath}`);
  }
  const blueprints: unknown = fixtureModule.MOCK_BLUEPRINTS;
  if (!Array.isArray(blueprints)) throw new Error("MOCK_BLUEPRINTS is not an array.");

  const seedable: SeedableCaseStudy[] = [];
  const failures: string[] = [];

  for (const blueprint of blueprints) {
    if (
      typeof blueprint !== "object" ||
      blueprint === null ||
      !("category" in blueprint) ||
      blueprint.category !== "case_study"
    ) {
      continue;
    }
    const blueprintRecord: Record<string, unknown> = { ...blueprint };
    const slug = typeof blueprintRecord.slug === "string" ? blueprintRecord.slug : "(no slug)";

    const parsedFixture = CaseStudyFixtureSchema.safeParse(blueprintRecord);
    const parsedSubmission = CaseStudySubmissionSchema.safeParse(toSubmission(blueprintRecord));

    if (parsedFixture.success && parsedSubmission.success) {
      seedable.push({ fixture: parsedFixture.data, submission: parsedSubmission.data });
      continue;
    }
    for (const issue of [
      ...(parsedFixture.success ? [] : parsedFixture.error.issues),
      ...(parsedSubmission.success ? [] : parsedSubmission.error.issues),
    ]) {
      failures.push(`  ${slug} · ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  // ⚠️ EVERY ROW IS PARSED BEFORE ANY ROW IS WRITTEN. The route and the seed share one gate; a seed
  // that wrote a row the route would refuse would be the second, laxer front door this avoids.
  if (failures.length > 0) {
    throw new Error(`Fixtures rejected before any write:\n${failures.join("\n")}`);
  }
  return seedable;
}

type SeedTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Writes one case study and everything that hangs off it, except the related-lesson edges. */
async function writeCaseStudy(
  transaction: SeedTransaction,
  seedable: SeedableCaseStudy,
): Promise<void> {
  const { fixture, submission } = seedable;

  // Replace rather than merge. Children cascade, so this clears the tree in one statement.
  await transaction.delete(caseStudy).where(eq(caseStudy.publicSlug, fixture.slug));

  const [insertedCaseStudy] = await transaction
    .insert(caseStudy)
    .values({
      publicSlug: fixture.slug,
      title: submission.title,
      oneLineAction: submission.oneLineAction,
      summary: submission.summary,
      problem: submission.problem,
      context: submission.context,
      discipline: submission.discipline,
      sector: submission.sector,
      outcomeSummary: submission.outcomeSummary,
      timelineLabel: submission.timelineLabel,
      authorRelationship: submission.authorRelationship,
      acceptedStatementIds: [...submission.acceptedStatementIds],
      tags: [...submission.tags],
      capitalRaisedAmountCents: submission.capitalRaised?.amountInCents ?? null,
      capitalRaisedCurrency: submission.capitalRaised?.currency ?? null,
      /*
       * THE BYLINE ARM, not an account. These ten writers are invented people; minting them as
       * accounts would spend ten entries in a UNIQUE handle namespace and ten account-closure
       * obligations to render ten bylines. `author_user_id` stays NULL, so `/mine` can never
       * return one of these — which is true.
       */
      authorUserId: null,
      authorDisplayName: fixture.author.displayName,
      authorHandle: fixture.author.handle,
      authorAvatarUrl: fixture.author.avatarUrl,
      /*
       * PUBLISHED WITH NO REVIEWER, which `case_study_decision_ck` permits on purpose: nobody
       * reviewed these ten, and naming a reviewer would be inventing a fact about a person.
       */
      moderationState: "published",
      createdAt: new Date(fixture.createdAt),
    })
    .returning({ id: caseStudy.id });

  if (!insertedCaseStudy) throw new Error(`${fixture.slug}: insert returned no row`);
  const caseStudyId = insertedCaseStudy.id;

  await transaction.insert(caseStudyStats).values({
    caseStudyId,
    viewCount: fixture.viewCount,
    likeCount: fixture.likeCount,
  });

  if (submission.actionSteps.length > 0) {
    await transaction
      .insert(caseStudyActionStep)
      .values(submission.actionSteps.map((body, position) => ({ caseStudyId, position, body })));
  }
  if (submission.pitfalls.length > 0) {
    await transaction
      .insert(caseStudyPitfall)
      .values(submission.pitfalls.map((body, position) => ({ caseStudyId, position, body })));
  }
  if (submission.evidenceCompanies.length > 0) {
    await transaction.insert(caseStudyEvidenceCompany).values(
      submission.evidenceCompanies.map((company, position) => ({
        caseStudyId,
        position,
        name: company.name,
        isNameWithheld: company.isNameWithheld,
        // Denormalised so the withholding CHECK can read it; the composite FK forces agreement.
        authorRelationship: submission.authorRelationship,
        locationLabel: company.locationLabel,
        yearLabel: company.yearLabel,
      })),
    );
  }
  if (submission.outcomeMetrics.length > 0) {
    await transaction.insert(caseStudyOutcomeMetric).values(
      submission.outcomeMetrics.map((metric, position) => ({
        caseStudyId,
        position,
        label: metric.label,
        kind: metric.value.kind,
        countAmount: metric.value.kind === "count" ? metric.value.amount : null,
        moneyAmountCents: metric.value.kind === "money" ? metric.value.amountInCents : null,
        moneyCurrency: metric.value.kind === "money" ? metric.value.currency : null,
        basisPoints: metric.value.kind === "percentage" ? metric.value.basisPoints : null,
      })),
    );
  }
  if (submission.sources.length > 0) {
    await transaction.insert(caseStudySource).values(
      submission.sources.map((source, position) => ({
        caseStudyId,
        position,
        label: source.label,
        publisherLabel: source.publisherLabel,
        url: source.url,
      })),
    );
  }
}

async function main(): Promise<void> {
  const seedables = await loadCaseStudyFixtures();
  console.log(`Parsed ${String(seedables.length)} case-study fixtures. Writing.`);

  // ONE TRANSACTION for all ten: a half-seeded surface is worse than an unseeded one.
  await db.transaction(async (transaction) => {
    for (const seedable of seedables) {
      await writeCaseStudy(transaction, seedable);
    }

    /*
     * ⚠️ THE EDGES GO IN A SECOND PASS, AFTER EVERY PARENT EXISTS. `related_public_slug` is a real
     * foreign key onto `case_study.public_slug`, and the fixture graph is mutual — five pairs point
     * at each other — so no single ordering of the rows could satisfy it one row at a time. Two
     * passes inside one transaction is the whole fix; a DEFERRABLE constraint would be machinery for
     * a problem that ordering already solves.
     */
    for (const seedable of seedables) {
      if (seedable.submission.relatedLessonSlugs.length === 0) continue;
      const [parentRow] = await transaction
        .select({ id: caseStudy.id })
        .from(caseStudy)
        .where(eq(caseStudy.publicSlug, seedable.fixture.slug))
        .limit(1);
      if (!parentRow) throw new Error(`${seedable.fixture.slug}: vanished before its edges`);

      await transaction.insert(caseStudyRelatedLesson).values(
        seedable.submission.relatedLessonSlugs.map((relatedPublicSlug, position) => ({
          caseStudyId: parentRow.id,
          position,
          relatedPublicSlug,
        })),
      );
    }
  });

  const childCounts = seedables.reduce(
    (totals, seedable) => ({
      actionSteps: totals.actionSteps + seedable.submission.actionSteps.length,
      pitfalls: totals.pitfalls + seedable.submission.pitfalls.length,
      companies: totals.companies + seedable.submission.evidenceCompanies.length,
      metrics: totals.metrics + seedable.submission.outcomeMetrics.length,
      sources: totals.sources + seedable.submission.sources.length,
      relatedLessons: totals.relatedLessons + seedable.submission.relatedLessonSlugs.length,
      withheldNames:
        totals.withheldNames +
        seedable.submission.evidenceCompanies.filter((company) => company.isNameWithheld).length,
    }),
    {
      actionSteps: 0,
      pitfalls: 0,
      companies: 0,
      metrics: 0,
      sources: 0,
      relatedLessons: 0,
      withheldNames: 0,
    },
  );

  console.log("Seeded:");
  console.log(`  case_study                    ${String(seedables.length)}`);
  console.log(`  case_study_stats              ${String(seedables.length)}`);
  console.log(`  case_study_action_step        ${String(childCounts.actionSteps)}`);
  console.log(`  case_study_pitfall            ${String(childCounts.pitfalls)}`);
  console.log(`  case_study_evidence_company   ${String(childCounts.companies)}`);
  console.log(`  case_study_outcome_metric     ${String(childCounts.metrics)}`);
  console.log(`  case_study_source             ${String(childCounts.sources)}`);
  console.log(`  case_study_related_lesson     ${String(childCounts.relatedLessons)}`);
  console.log(`  (withheld company names:      ${String(childCounts.withheldNames)})`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Case study seed failed:", error);
    await pool.end();
    process.exit(1);
  });
