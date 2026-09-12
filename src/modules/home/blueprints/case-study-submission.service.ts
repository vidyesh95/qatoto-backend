import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
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
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { buildErrorWithoutQueryParameters } from "#src/modules/home/blueprints/blueprint-write-errors.js";
import { findUnresolvableRelatedSlugs } from "#src/modules/home/blueprints/case-study-public-read.service.js";
import type { CaseStudySubmission } from "#src/modules/home/blueprints/case-study-submission.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * Writing a case study, and a writer's own list.
 *
 * NOTHING HERE PUBLISHES. A submitted case study lands `pending_review`, appears in no index, has no
 * public slug, and is visible to its writer and to moderators only.
 * `case-study-moderation.service.ts` is where a decision happens.
 *
 * ⚠️ THE WITHHELD COMPANY NAME IS IN EVERY PAYLOAD THIS FILE WRITES, which makes two rules
 * load-bearing here and nowhere else on the write path:
 *
 *   1. **No database error from this transaction may reach the logger.** `DrizzleQueryError`'s
 *      message is ``Failed query: ${sql}\nparams: ${params}`` and `errorFields` copies
 *      `error.message` into `errorMessage`, so ANY failed statement touching
 *      `case_study_evidence_company` — a 23505 on a duplicate company name, a 23514, a connection
 *      reset mid-insert — would write the withheld name into the log stream verbatim as a bound
 *      parameter. `request-log.ts` is careful never to log a body; this routes around it. So the
 *      transaction's catch re-throws a BARE error carrying only the SQLSTATE (see
 *      `buildErrorWithoutQueryParameters`). Fixing `errorFields` instead would change every other
 *      surface's diagnostics.
 *   2. **The receipt echoes nothing back.** `idempotency.ts` stores whole 2xx response bodies, so a
 *      handler that returned the submission would put a withheld name in a replay cache. The
 *      receipt is three scalars, and it must stay that way.
 *
 * `GET /mine` CARRIES NO COMPANIES AT ALL, which is not an omission: the writer's list renders a
 * title, an action line, a discipline, a state, a slug and a note. Returning companies there would
 * be a second route able to serve a real name, for no consumer.
 */

export type CaseStudySubmitError =
  | { readonly type: "CASE_STUDY_TITLE_TAKEN" }
  | {
      readonly type: "CASE_STUDY_RELATED_LESSON_UNRESOLVABLE";
      readonly slugs: readonly string[];
    };

export interface CaseStudySubmissionReceipt {
  readonly submissionId: string;
  readonly moderationState: "pending_review";
  readonly receivedAt: Date;
}

/** One row of the writer's own list. Deliberately scalar-only — see the file docblock. */
export interface MyCaseStudyView {
  readonly submissionId: string;
  readonly title: string;
  readonly oneLineAction: string;
  readonly discipline: (typeof caseStudy.$inferSelect)["discipline"];
  readonly moderationState: (typeof caseStudy.$inferSelect)["moderationState"];
  readonly submittedAt: Date;
  readonly publicSlug: string | null;
  readonly moderatorNote: string | null;
}

export interface MyCaseStudyPage {
  readonly items: readonly MyCaseStudyView[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export type MyCaseStudyListError = { readonly type: "CASE_STUDY_LIST_CURSOR_MALFORMED" };

/**
 * The normalised-title predicate, run IN SQL.
 *
 * ⚠️ NEVER A JAVASCRIPT COPY OF `title_normalized`'s EXPRESSION. POSIX `[[:space:]]` is not
 * JavaScript's `\s` and `lower()` is not `toLowerCase()` — they disagree on a Turkish dotted İ and
 * on ß — so a JS reimplementation would answer a different question than the unique index does, and
 * the index is the one that decides.
 */
function titleAlreadyTakenCondition(title: string) {
  return and(
    sql`${caseStudy.titleNormalized} = lower(regexp_replace(btrim(${title}::text), '[[:space:]]+', ' ', 'g'))`,
    inArray(caseStudy.moderationState, ["pending_review", "published", "flagged"]),
  );
}

/**
 * Submits a case study for review.
 *
 * THE TITLE RULE IS ANSWERED TWICE AND BY THE DATABASE BOTH TIMES. The pre-check exists for the
 * message; `case_study_title_live_uidx` exists for the truth. Two writers sending the same title a
 * millisecond apart both pass the pre-check, and the second insert raises 23505 — which is why a
 * check-then-insert alone would be a TOCTOU race, and why both paths map to ONE error type.
 *
 * A RELATED SLUG MUST NAME A CASE STUDY A READER CAN REACH, which the foreign key cannot say: it
 * proves the row exists, and `moderation_state` is deliberately not in that key (a composite key
 * with a cascade would make flagging a popular lesson fail). So the check is a query, and it runs
 * BEFORE the transaction — a 23503 from the key would be a fault with no field to report.
 *
 * A SELF-REFERENCE IS IMPOSSIBLE BY CONSTRUCTION rather than by a rule: a submission has no
 * `public_slug` yet, so there is nothing for it to name itself by. That stops being true if editing
 * and resubmission ever land, and this is the docblock that should be revisited when they do.
 */
export async function submitCaseStudy(input: {
  readonly authorUserId: string;
  readonly submission: CaseStudySubmission;
}): Promise<Result<CaseStudySubmissionReceipt, CaseStudySubmitError>> {
  const { submission } = input;

  const [takenTitleRow] = await db
    .select({ id: caseStudy.id })
    .from(caseStudy)
    .where(titleAlreadyTakenCondition(submission.title))
    .limit(1);
  /*
   * ⚠️ THE REFUSAL NAMES THE FIELD AND NOTHING ELSE. Echoing the clashing row's title, author or
   * slug would make this route an existence oracle over pending submissions — other people's
   * unpublished work — which is why `takenTitleRow` is selected as an id and then discarded.
   */
  if (takenTitleRow) return { success: false, error: { type: "CASE_STUDY_TITLE_TAKEN" } };

  const unresolvableSlugs = await findUnresolvableRelatedSlugs(submission.relatedLessonSlugs);
  if (unresolvableSlugs.length > 0) {
    return {
      success: false,
      error: { type: "CASE_STUDY_RELATED_LESSON_UNRESOLVABLE", slugs: unresolvableSlugs },
    };
  }

  const receivedAt = new Date();

  try {
    const submissionId = await db.transaction(async (transaction) => {
      const [insertedCaseStudy] = await transaction
        .insert(caseStudy)
        .values({
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
          authorUserId: input.authorUserId,
          // The account arm: the byline is the account's, so these three stay NULL.
          authorDisplayName: null,
          authorHandle: null,
          authorAvatarUrl: null,
          moderationState: "pending_review",
          createdAt: receivedAt,
        })
        .returning({ id: caseStudy.id });

      if (!insertedCaseStudy) throw new Error("case study insert returned no row");
      const caseStudyId = insertedCaseStudy.id;

      await transaction.insert(caseStudyStats).values({ caseStudyId });

      if (submission.actionSteps.length > 0) {
        await transaction
          .insert(caseStudyActionStep)
          .values(
            submission.actionSteps.map((body, position) => ({ caseStudyId, position, body })),
          );
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
            // Denormalised so the withholding CHECK can read it; the composite key forces agreement.
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
      if (submission.relatedLessonSlugs.length > 0) {
        await transaction.insert(caseStudyRelatedLesson).values(
          submission.relatedLessonSlugs.map((relatedPublicSlug, position) => ({
            caseStudyId,
            position,
            relatedPublicSlug,
          })),
        );
      }

      return caseStudyId;
    });

    return {
      success: true,
      value: { submissionId, moderationState: "pending_review", receivedAt },
    };
  } catch (transactionError: unknown) {
    /*
     * A 23505 HERE IS THE TITLE RACE the pre-check cannot close, and it is the only expected fault
     * on this path — every other unique index on these tables guards a rule the write gate already
     * refused, so reaching one is a programmer error.
     */
    if (isUniqueViolation(transactionError)) {
      return { success: false, error: { type: "CASE_STUDY_TITLE_TAKEN" } };
    }
    // ⚠️ STRIPPED, NOT RE-THROWN AS IT CAME. See `buildErrorWithoutQueryParameters`.
    throw buildErrorWithoutQueryParameters(
      transactionError,
      "submitCaseStudy",
      "this transaction carries a withheld company name",
    );
  }
}

/**
 * The writer's own case studies, newest first, in every state.
 *
 * ⚠️ SCOPED BY `author_user_id`, WHICH IS THE WHOLE AUTHORIZATION OF THIS READ — a writer sees their
 * own submissions and nobody else's. A seeded case study names no account, so it can never match,
 * which is correct: nobody submitted those.
 */
export async function listMyCaseStudies(input: {
  readonly authorUserId: string;
  readonly limit: number;
  readonly cursor: string | undefined;
}): Promise<Result<MyCaseStudyPage, MyCaseStudyListError>> {
  const conditions = [eq(caseStudy.authorUserId, input.authorUserId)];

  if (input.cursor !== undefined) {
    const cursor = decodeInstantCursor(input.cursor);
    if (cursor === null) {
      return { success: false, error: { type: "CASE_STUDY_LIST_CURSOR_MALFORMED" } };
    }
    const keysetCondition = or(
      lt(caseStudy.createdAt, cursor.instant),
      and(eq(caseStudy.createdAt, cursor.instant), gt(caseStudy.id, cursor.id)),
    );
    if (keysetCondition === undefined) {
      return { success: false, error: { type: "CASE_STUDY_LIST_CURSOR_MALFORMED" } };
    }
    conditions.push(keysetCondition);
  }

  const rows = await db
    .select({
      submissionId: caseStudy.id,
      title: caseStudy.title,
      oneLineAction: caseStudy.oneLineAction,
      discipline: caseStudy.discipline,
      moderationState: caseStudy.moderationState,
      submittedAt: caseStudy.createdAt,
      publicSlug: caseStudy.publicSlug,
      moderatorNote: caseStudy.moderatorNote,
    })
    .from(caseStudy)
    .where(and(...conditions))
    .orderBy(desc(caseStudy.createdAt), asc(caseStudy.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  const lastRow = items.at(-1);
  const nextCursor =
    hasMore && lastRow
      ? encodeInstantCursor({ instant: lastRow.submittedAt, id: lastRow.submissionId })
      : null;

  return { success: true, value: { items, page: { nextCursor, hasMore } } };
}
