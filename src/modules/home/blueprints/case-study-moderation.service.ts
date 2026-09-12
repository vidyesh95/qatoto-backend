import { and, asc, eq, gt, inArray, or, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  CASE_STUDY_RESERVED_SLUGS,
  caseStudy,
  caseStudyActionStep,
  caseStudyEvidenceCompany,
  caseStudyOutcomeMetric,
  caseStudyPitfall,
  caseStudyRelatedLesson,
  caseStudySource,
  user,
} from "#src/db/schema.js";
import { encodeInstantCursor, type InstantCursor } from "#src/lib/instant-cursor.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import type {
  PlatformAccessError,
  PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import { slugifyProgramTitle } from "#src/modules/rnd/programs/research-programs.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The case-study review queue and the decision on one case study.
 *
 * ⚠️ THIS IS THE ONLY MODULE THAT SERVES A WITHHELD COMPANY'S REAL NAME, and that is the whole
 * reason it is a separate file from the public read service. A first-hand writer may keep a
 * company's name from READERS — an NDA is the ordinary reason — and a moderator has to see it,
 * because a company nobody at Qatoto can see is a claim nobody can check. The public serializer
 * nulls it; this one does not, and the queue card marks it as withheld so the moderator knows the
 * reader is not seeing what they are.
 *
 * ⚠️ SO THIS RESPONSE MUST NEVER ACQUIRE A SHARED CACHE HEADER. Every other read on this surface is
 * caller-independent and deliberately cacheable; this one is the exception, and a cache in front of
 * it would serve a withheld name to whoever asked next.
 *
 * ⚠️ AND THE AUDIT PAYLOAD IS IDS AND FLAGS ONLY. The chain is hash-linked and kept forever, so a
 * company name written into an entry could never be removed by an erasure request. The moderator's
 * note to the writer lives on the case-study row, where erasure can reach it; the entry records
 * only THAT a note was sent.
 *
 * THE CAPABILITY CHECK IS THE CALLER'S JOB, and it has already happened. Every function takes a
 * `PlatformStaffContext` — the proof, not a user id — so neither can be called without standing
 * having been proven first, and proven before any submission id is read: a 403 that only arrives
 * for case studies that exist turns this route into an existence oracle over pending submissions.
 */

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CaseStudyModerationError =
  | PlatformAccessError
  | { readonly type: "CASE_STUDY_NOT_FOUND" }
  | { readonly type: "CASE_STUDY_SELF_MODERATION_FORBIDDEN" }
  | {
      readonly type: "CASE_STUDY_ALREADY_DECIDED";
      readonly moderationState: (typeof caseStudy.$inferSelect)["moderationState"];
    };

/** A company as a MODERATOR sees it: the name is present, withheld or not. */
export interface CaseStudyModerationCompanyView {
  readonly name: string;
  readonly isNameWithheld: boolean;
  readonly locationLabel: string;
  readonly yearLabel: string;
}

/** One case study as a moderator reads it: everything the writer sent, and who sent it. */
export interface CaseStudyReviewItemView {
  readonly submissionId: string;
  readonly submittedAt: Date;
  /** `handle` is nullable because an account's handle is; the contract mirrors that. */
  readonly author: { readonly displayName: string; readonly handle: string | null };
  readonly authorRelationship: (typeof caseStudy.$inferSelect)["authorRelationship"];
  /** What the writer vouched for, so a moderator can hold the case study to it. */
  readonly acceptedStatementIds: readonly string[];
  readonly title: string;
  readonly oneLineAction: string;
  readonly discipline: (typeof caseStudy.$inferSelect)["discipline"];
  readonly sector: string;
  readonly outcomeSummary: string | null;
  readonly summary: string;
  readonly problem: string;
  readonly context: string;
  readonly actionSteps: readonly string[];
  readonly pitfalls: readonly string[];
  readonly evidenceCompanies: readonly CaseStudyModerationCompanyView[];
  readonly timelineLabel: string | null;
  readonly capitalRaised: {
    readonly amountInCents: number;
    readonly currency: string;
  } | null;
  readonly outcomeMetrics: readonly {
    readonly label: string;
    readonly value:
      | { readonly kind: "count"; readonly amount: number }
      | { readonly kind: "money"; readonly amountInCents: number; readonly currency: string }
      | { readonly kind: "percentage"; readonly basisPoints: number };
  }[];
  readonly sources: readonly {
    readonly label: string;
    readonly publisherLabel: string;
    readonly url: string;
  }[];
  readonly relatedLessonSlugs: readonly string[];
  readonly tags: readonly string[];
}

export interface CaseStudyReviewQueuePage {
  readonly items: readonly CaseStudyReviewItemView[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export interface CaseStudyModerationDecisionView {
  readonly submissionId: string;
  readonly moderationState: "published" | "rejected";
  readonly publicSlug: string | null;
  readonly decidedAt: Date;
}

export type CaseStudyModerationDecisionInput =
  | { readonly decision: "published"; readonly moderatorNote: string | null }
  | { readonly decision: "rejected"; readonly moderatorNote: string };

function buildMetricValue(
  metricRow: typeof caseStudyOutcomeMetric.$inferSelect,
): CaseStudyReviewItemView["outcomeMetrics"][number]["value"] {
  switch (metricRow.kind) {
    case "count":
      if (metricRow.countAmount === null) break;
      return { kind: "count", amount: metricRow.countAmount };
    case "money":
      if (metricRow.moneyAmountCents === null || metricRow.moneyCurrency === null) break;
      return {
        kind: "money",
        amountInCents: metricRow.moneyAmountCents,
        currency: metricRow.moneyCurrency,
      };
    case "percentage":
      if (metricRow.basisPoints === null) break;
      return { kind: "percentage", basisPoints: metricRow.basisPoints };
    default: {
      const exhaustiveCheck: never = metricRow.kind;
      throw new Error(`Unhandled case study metric kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
  throw new Error(
    `case_study_outcome_metric ${metricRow.id} is a ${metricRow.kind} with no value; its CHECK should have refused it.`,
  );
}

/**
 * Case studies waiting for a decision, OLDEST FIRST.
 *
 * Oldest first for the reason every queue here is: newest-first starves its own tail, and the
 * submission that has waited longest is the one owed an answer.
 *
 * ⚠️ AN INNER JOIN ON `user`, WHICH IS A STATEMENT RATHER THAN A SHORTCUT. Only an account-authored
 * case study is reviewable — the ten seeded rows carry a byline and no account, and they are
 * inserted `published`, so they were never in this queue. The inner join makes that declarative and
 * makes the non-null `displayName` this view promises a property of the join rather than a runtime
 * fallback.
 */
export async function listCaseStudyReviewQueue(input: {
  readonly staff: PlatformStaffContext;
  readonly limit: number;
  readonly cursor: InstantCursor | undefined;
}): Promise<CaseStudyReviewQueuePage> {
  const conditions: SQL[] = [eq(caseStudy.moderationState, "pending_review")];
  if (input.cursor !== undefined) {
    const { instant, id } = input.cursor;
    // Ascending, so `>`.
    const afterCursorCondition = or(
      gt(caseStudy.createdAt, instant),
      and(eq(caseStudy.createdAt, instant), gt(caseStudy.id, id)),
    );
    if (afterCursorCondition !== undefined) conditions.push(afterCursorCondition);
  }

  const caseStudyRows = await db
    .select({
      caseStudy,
      authorDisplayName: user.name,
      authorHandle: user.handle,
    })
    .from(caseStudy)
    .innerJoin(user, eq(user.id, caseStudy.authorUserId))
    .where(and(...conditions))
    .orderBy(asc(caseStudy.createdAt), asc(caseStudy.id))
    .limit(input.limit + 1);

  const hasMore = caseStudyRows.length > input.limit;
  const pageRows = hasMore ? caseStudyRows.slice(0, input.limit) : caseStudyRows;
  const caseStudyIds = pageRows.map((row) => row.caseStudy.id);

  // Six `IN` queries for the page rather than six per case study.
  const [stepRows, pitfallRows, companyRows, metricRows, sourceRows, relatedRows] =
    caseStudyIds.length === 0
      ? [[], [], [], [], [], []]
      : await Promise.all([
          db
            .select()
            .from(caseStudyActionStep)
            .where(inArray(caseStudyActionStep.caseStudyId, caseStudyIds))
            .orderBy(asc(caseStudyActionStep.caseStudyId), asc(caseStudyActionStep.position)),
          db
            .select()
            .from(caseStudyPitfall)
            .where(inArray(caseStudyPitfall.caseStudyId, caseStudyIds))
            .orderBy(asc(caseStudyPitfall.caseStudyId), asc(caseStudyPitfall.position)),
          db
            .select()
            .from(caseStudyEvidenceCompany)
            .where(inArray(caseStudyEvidenceCompany.caseStudyId, caseStudyIds))
            .orderBy(
              asc(caseStudyEvidenceCompany.caseStudyId),
              asc(caseStudyEvidenceCompany.position),
            ),
          db
            .select()
            .from(caseStudyOutcomeMetric)
            .where(inArray(caseStudyOutcomeMetric.caseStudyId, caseStudyIds))
            .orderBy(asc(caseStudyOutcomeMetric.caseStudyId), asc(caseStudyOutcomeMetric.position)),
          db
            .select()
            .from(caseStudySource)
            .where(inArray(caseStudySource.caseStudyId, caseStudyIds))
            .orderBy(asc(caseStudySource.caseStudyId), asc(caseStudySource.position)),
          db
            .select()
            .from(caseStudyRelatedLesson)
            .where(inArray(caseStudyRelatedLesson.caseStudyId, caseStudyIds))
            .orderBy(asc(caseStudyRelatedLesson.caseStudyId), asc(caseStudyRelatedLesson.position)),
        ]);

  const lastRow = pageRows.at(-1);

  return {
    items: pageRows.map(({ caseStudy: row, authorDisplayName, authorHandle }) => ({
      submissionId: row.id,
      submittedAt: row.createdAt,
      author: { displayName: authorDisplayName, handle: authorHandle },
      authorRelationship: row.authorRelationship,
      acceptedStatementIds: row.acceptedStatementIds,
      title: row.title,
      oneLineAction: row.oneLineAction,
      discipline: row.discipline,
      sector: row.sector,
      outcomeSummary: row.outcomeSummary,
      summary: row.summary,
      problem: row.problem,
      context: row.context,
      actionSteps: stepRows
        .filter((stepRow) => stepRow.caseStudyId === row.id)
        .map((stepRow) => stepRow.body),
      pitfalls: pitfallRows
        .filter((pitfallRow) => pitfallRow.caseStudyId === row.id)
        .map((pitfallRow) => pitfallRow.body),
      /*
       * ⚠️ THE REAL NAME, DELIBERATELY, PLUS THE FLAG. This is the one read that serves it. The flag
       * travels beside it so the queue card can mark the row "Withheld from readers" — a moderator
       * who could not tell the difference would not know the public page shows something else.
       */
      evidenceCompanies: companyRows
        .filter((companyRow) => companyRow.caseStudyId === row.id)
        .map((companyRow) => ({
          name: companyRow.name,
          isNameWithheld: companyRow.isNameWithheld,
          locationLabel: companyRow.locationLabel,
          yearLabel: companyRow.yearLabel,
        })),
      timelineLabel: row.timelineLabel,
      capitalRaised:
        row.capitalRaisedAmountCents !== null && row.capitalRaisedCurrency !== null
          ? {
              amountInCents: row.capitalRaisedAmountCents,
              currency: row.capitalRaisedCurrency,
            }
          : null,
      outcomeMetrics: metricRows
        .filter((metricRow) => metricRow.caseStudyId === row.id)
        .map((metricRow) => ({ label: metricRow.label, value: buildMetricValue(metricRow) })),
      sources: sourceRows
        .filter((sourceRow) => sourceRow.caseStudyId === row.id)
        .map((sourceRow) => ({
          label: sourceRow.label,
          publisherLabel: sourceRow.publisherLabel,
          url: sourceRow.url,
        })),
      relatedLessonSlugs: relatedRows
        .filter((relatedRow) => relatedRow.caseStudyId === row.id)
        .map((relatedRow) => relatedRow.relatedPublicSlug),
      tags: row.tags,
    })),
    page: {
      nextCursor:
        hasMore && lastRow
          ? encodeInstantCursor({ instant: lastRow.caseStudy.createdAt, id: lastRow.caseStudy.id })
          : null,
      hasMore,
    },
  };
}

/**
 * The public address a published case study gets, before any collision suffix.
 *
 * A title of pure punctuation slugifies to nothing, and one that slugifies to a route literal would
 * be shadowed by that route; both fall back to an address derived from the id, which is ugly and
 * always usable.
 */
function buildCaseStudySlugBase(title: string, caseStudyId: string): string {
  const titleSlug = slugifyProgramTitle(title);
  const isReservedSlug = CASE_STUDY_RESERVED_SLUGS.some(
    (reservedSlug) => reservedSlug === titleSlug,
  );
  if (titleSlug.length < 3 || isReservedSlug) {
    return `lesson-${caseStudyId.replaceAll("-", "").slice(0, 8)}`;
  }
  return titleSlug;
}

/**
 * Publishes under the first free slug.
 *
 * EACH ATTEMPT IN ITS OWN SAVEPOINT. A failed statement aborts the whole transaction in Postgres,
 * so a bare try/catch around a colliding update would leave every later statement — including the
 * audit append — failing with `25P02`. Drizzle's nested `transaction` is SAVEPOINT / ROLLBACK TO
 * SAVEPOINT, which keeps the outer transaction usable.
 *
 * ⚠️ A `-2` SUFFIX IS AN EXPECTED OUTCOME ON THIS ARM, not a symptom. A lesson title is an
 * imperative sentence and most end in a period, so `"Budget for a second mould."` and the same
 * sentence without the period are two distinct live titles that slugify to one base. Do not add
 * punctuation stripping to avoid it: there is one normalisation expression in this codebase and it
 * is `title_normalized`'s.
 */
async function publishUnderFreeSlug(
  transaction: DatabaseExecutor,
  submission: { readonly id: string; readonly title: string },
  decision: {
    readonly reviewedByUserId: string;
    readonly reviewedAt: Date;
    readonly note: string | null;
  },
): Promise<string> {
  const baseSlug = buildCaseStudySlugBase(submission.title, submission.id);
  const candidateSlugs = [
    baseSlug,
    ...Array.from(
      { length: 10 },
      (_unused, suffixIndex) => `${baseSlug}-${String(suffixIndex + 2)}`,
    ),
    `${baseSlug}-${submission.id.replaceAll("-", "").slice(0, 8)}`,
  ];

  for (const candidateSlug of candidateSlugs) {
    try {
      await transaction.transaction(async (savepoint) => {
        await savepoint
          .update(caseStudy)
          .set({
            moderationState: "published",
            reviewedByUserId: decision.reviewedByUserId,
            reviewedAt: decision.reviewedAt,
            moderatorNote: decision.note,
            publicSlug: candidateSlug,
          })
          .where(
            and(eq(caseStudy.id, submission.id), eq(caseStudy.moderationState, "pending_review")),
          );
      });
      return candidateSlug;
    } catch (updateError: unknown) {
      if (!isUniqueViolation(updateError)) throw updateError;
      // Taken — try the next candidate.
    }
  }

  throw new Error(
    `publishUnderFreeSlug: every slug candidate for case study ${submission.id} was taken`,
  );
}

/**
 * Publishes a case study or sends it back.
 *
 * `FOR UPDATE`, then three refusals in a fixed order: no such case study (404), the moderator wrote
 * it (403), it is already decided (409). The update ALSO guards on `pending_review` in its WHERE, so
 * the lock and the predicate agree on what "undecided" means.
 *
 * ⚠️ THE SELF-MODERATION CHECK TESTS `!== null` FIRST, and that guard is load-bearing rather than
 * defensive. A seeded case study's `author_user_id` is NULL; without the guard, a comparison that
 * ever treated NULL as equal to a missing staff id would refuse a moderator on a row nobody wrote.
 * (A seeded row is `published`, so it would fail the already-decided check anyway — belt, braces,
 * and one fewer way for a later refactor to produce a nonsense 403.)
 */
export async function decideCaseStudy(input: {
  readonly submissionId: string;
  readonly decision: CaseStudyModerationDecisionInput;
  readonly staff: PlatformStaffContext;
}): Promise<Result<CaseStudyModerationDecisionView, CaseStudyModerationError>> {
  // A published note that trims to nothing is no note. A rejection's note is already non-empty.
  const moderatorNote =
    input.decision.moderatorNote === null || input.decision.moderatorNote === ""
      ? null
      : input.decision.moderatorNote;

  const outcome = await db.transaction(async (transaction) => {
    const [existingCaseStudy] = await transaction
      .select({
        id: caseStudy.id,
        title: caseStudy.title,
        authorUserId: caseStudy.authorUserId,
        moderationState: caseStudy.moderationState,
      })
      .from(caseStudy)
      .where(eq(caseStudy.id, input.submissionId))
      .for("update");

    if (!existingCaseStudy) return { kind: "missing" } as const;
    if (
      existingCaseStudy.authorUserId !== null &&
      existingCaseStudy.authorUserId === input.staff.staffUserId
    ) {
      return { kind: "self_moderation" } as const;
    }
    if (existingCaseStudy.moderationState !== "pending_review") {
      return {
        kind: "already_decided",
        moderationState: existingCaseStudy.moderationState,
      } as const;
    }

    const decidedAt = new Date();
    let publicSlug: string | null = null;

    if (input.decision.decision === "published") {
      publicSlug = await publishUnderFreeSlug(transaction, existingCaseStudy, {
        reviewedByUserId: input.staff.staffUserId,
        reviewedAt: decidedAt,
        note: moderatorNote,
      });
    } else {
      await transaction
        .update(caseStudy)
        .set({
          moderationState: "rejected",
          reviewedByUserId: input.staff.staffUserId,
          reviewedAt: decidedAt,
          moderatorNote,
        })
        .where(
          and(
            eq(caseStudy.id, existingCaseStudy.id),
            eq(caseStudy.moderationState, "pending_review"),
          ),
        );
    }

    await appendPlatformAuditEntry(transaction, {
      eventKind:
        input.decision.decision === "published" ? "case_study_published" : "case_study_rejected",
      actorUserId: input.staff.staffUserId,
      actorRoleSnapshot: input.staff.platformRole,
      actionLabel:
        input.decision.decision === "published"
          ? "Published a case study"
          : "Sent a case study back to its writer",
      targetLabel: `case study ${existingCaseStudy.id}`,
      /*
       * ⚠️ IDS AND FLAGS ONLY — see the file header. Not the title, not a company, not the note.
       * This chain is hash-linked and kept forever, so anything here outlives every erasure.
       */
      payload: {
        caseStudyId: existingCaseStudy.id,
        decision: input.decision.decision,
        hasModeratorNote: moderatorNote !== null,
      },
      occurredAt: decidedAt,
    });

    return {
      kind: "decided",
      moderationState: input.decision.decision,
      publicSlug,
      decidedAt,
    } as const;
  });

  switch (outcome.kind) {
    case "missing":
      return { success: false, error: { type: "CASE_STUDY_NOT_FOUND" } };
    case "self_moderation":
      return { success: false, error: { type: "CASE_STUDY_SELF_MODERATION_FORBIDDEN" } };
    case "already_decided":
      return {
        success: false,
        error: {
          type: "CASE_STUDY_ALREADY_DECIDED",
          moderationState: outcome.moderationState,
        },
      };
    case "decided":
      return {
        success: true,
        value: {
          submissionId: input.submissionId,
          moderationState: outcome.moderationState,
          publicSlug: outcome.publicSlug,
          decidedAt: outcome.decidedAt,
        },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled case study decision outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
