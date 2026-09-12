import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { teardown, teardownSubmission } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { buildErrorWithoutQueryParameters } from "#src/modules/home/blueprints/blueprint-write-errors.js";
import {
  TEARDOWN_SUBMISSION_DOCUMENT_SCHEMA_VERSION,
  type TeardownSubmissionInput,
} from "#src/modules/home/blueprints/teardown-submission.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * Sending in a teardown, and an author's own list.
 *
 * NOTHING HERE PUBLISHES. A submitted teardown lands `pending_review` in `teardown_submission`,
 * creates no `teardown` row, has no slug and no public address, and is visible to its author and to
 * moderators only. `teardown-moderation.service.ts` is where a decision happens, and a publish is
 * where a `teardown` row is born.
 *
 * ⚠️ THE DOCUMENT THIS FILE WRITES CARRIES CORRESPONDENCE, which makes two rules load-bearing:
 *
 *   1. **No database error from this write may reach the logger.** `provenance.authorizationNote` is
 *      one party's account of a private permission from a named manufacturer, and every material
 *      element may carry an `operatorNote`. All of it is bound into one statement, and
 *      `DrizzleQueryError`'s message carries bound parameters. See
 *      `buildErrorWithoutQueryParameters`.
 *   2. **The receipt echoes nothing back.** `idempotency.ts` stores whole 2xx bodies, so a handler
 *      that returned the submission would put that correspondence in a replay cache. Three scalars,
 *      and it must stay that way — the frontend's own receipt schema asks for exactly those three.
 */

export type TeardownSubmitError = {
  readonly type: "TEARDOWN_SUBJECT_ALREADY_SURVEYED";
  /**
   * The clashing survey's title, or `null` when naming it would disclose somebody's unpublished
   * work. See `findExistingSurveyOfSubject`.
   */
  readonly existingTitle: string | null;
};

export interface TeardownSubmissionReceipt {
  readonly submissionId: string;
  readonly moderationState: "pending_review";
  readonly receivedAt: Date;
}

/** One row of the author's own list. */
export interface MyTeardownView {
  readonly submissionId: string;
  readonly title: string;
  readonly subjectProductName: string;
  readonly submittedAt: Date;
  readonly moderationState: (typeof teardownSubmission.$inferSelect)["moderationState"];
  readonly publicSlug: string | null;
  readonly moderatorNote: string | null;
}

/**
 * The cap on an author's own list.
 *
 * ⚠️ A LIMIT, NOT A PAGE, AND THE DIFFERENCE IS A DECISION. `GET /showcases/mine` returns a flat
 * array; `/case-studies/mine` moved to a cursor page because a writer accumulates case studies
 * cheaply. A teardown is a multi-hour instrumented survey and `teardownSubmitLimiter` caps an author
 * at five per fifteen minutes, so 200 is roughly a decade of honest work. The frontend's query key
 * carries no cursor, which is the other half of the same decision. The day somebody passes this
 * number is the day this becomes a keyset page and the frontend grows a cursor.
 */
export const MY_TEARDOWN_LIST_LIMIT = 200;

/**
 * The normalised unit-name predicate, run IN SQL.
 *
 * ⚠️ NEVER A JAVASCRIPT COPY of `subject_product_name_normalized`'s expression. POSIX
 * `[[:space:]]` is not JavaScript's `\s` and `lower()` is not `toLowerCase()` — they disagree on a
 * Turkish dotted İ and on ß — so a reimplementation would answer a different question than
 * `teardown_submission_subject_live_uidx` does, and the index is the one that decides.
 */
function normalizedSubjectName(subjectProductName: string) {
  return sql`lower(regexp_replace(btrim(${subjectProductName}::text), '[[:space:]]+', ' ', 'g'))`;
}

/**
 * Finds a survey of the same unit, and decides whether its title may be named.
 *
 * ⚠️ THE CONTRACT ASKS FOR THE TITLE AND THAT MAKES THIS AN ORACLE IF IT IS ANSWERED CARELESSLY.
 * The frontend's refusal reads "A survey of this unit is already on Qatoto: …", which is useful
 * precisely because the author can go and read it. But a title taken from somebody else's
 * `pending_review` submission would let a stranger enumerate unpublished work by guessing product
 * names — which is the failure `case-study-submission.service.ts` avoids by naming nothing at all.
 *
 * So the title is returned only when the row is ALREADY PUBLIC — a published teardown, or a
 * published submission — or when the clashing submission is the caller's own. Otherwise the refusal
 * still happens and still says why, and names nothing.
 */
async function findExistingSurveyOfSubject(input: {
  readonly subjectProductName: string;
  readonly authorUserId: string;
}): Promise<{ readonly found: boolean; readonly existingTitle: string | null }> {
  const normalized = normalizedSubjectName(input.subjectProductName);

  const [submissionRow] = await db
    .select({
      title: teardownSubmission.title,
      moderationState: teardownSubmission.moderationState,
      authorUserId: teardownSubmission.authorUserId,
    })
    .from(teardownSubmission)
    .where(
      and(
        sql`${teardownSubmission.subjectProductNameNormalized} = ${normalized}`,
        inArray(teardownSubmission.moderationState, ["pending_review", "published"]),
      ),
    )
    .limit(1);

  if (submissionRow) {
    const isPublic = submissionRow.moderationState === "published";
    const isOwn = submissionRow.authorUserId === input.authorUserId;
    return { found: true, existingTitle: isPublic || isOwn ? submissionRow.title : null };
  }

  /*
   * The second arm: the twelve seeded teardowns have no submission behind them, so a survey of one
   * of those units would otherwise pass a check that only reads the paperwork.
   *
   * Restricted to the three states a stranger can reach, so this arm cannot name a row nobody is
   * allowed to see. Nothing writes `pending_review` into this table any more, and the restriction is
   * what keeps that true even if something ever did.
   */
  const [teardownRow] = await db
    .select({ title: teardown.title })
    .from(teardown)
    .where(
      and(
        sql`lower(btrim(${teardown.provenanceSubjectProductName})) = ${normalized}`,
        inArray(teardown.moderationState, ["published", "flagged", "quarantined"]),
      ),
    )
    .limit(1);

  if (teardownRow) return { found: true, existingTitle: teardownRow.title };
  return { found: false, existingTitle: null };
}

/**
 * Takes in a teardown for review.
 *
 * THE UNIT RULE IS ANSWERED TWICE AND BY THE DATABASE BOTH TIMES. The pre-check exists for the
 * message; `teardown_submission_subject_live_uidx` exists for the truth. Two authors sending the
 * same unit a millisecond apart both pass the pre-check and the second insert raises 23505 — which
 * is why a check-then-insert alone would be a TOCTOU race, and why both paths map to ONE error type.
 * The race loses the title, because the losing request never read the winning row.
 *
 * ONE STATEMENT, SO NO TRANSACTION. Everything the wizard sends that no query needs travels in
 * `document_json`; there are no child rows to order, nothing to roll back, and a transaction here
 * would be ceremony around a single atomic insert. The publish path is where the ordering problem
 * actually lives.
 *
 * THE AUTHOR IS THE SESSION'S, NEVER THE BODY'S. `TeardownSubmissionSchema` has no field that could
 * name one, and `.strict()` refuses a client that invents one.
 */
export async function submitTeardown(input: {
  readonly authorUserId: string;
  readonly submission: TeardownSubmissionInput;
}): Promise<Result<TeardownSubmissionReceipt, TeardownSubmitError>> {
  const { submission } = input;

  const existingSurvey = await findExistingSurveyOfSubject({
    subjectProductName: submission.provenance.subjectProductName,
    authorUserId: input.authorUserId,
  });

  if (existingSurvey.found) {
    return {
      success: false,
      error: {
        type: "TEARDOWN_SUBJECT_ALREADY_SURVEYED",
        existingTitle: existingSurvey.existingTitle,
      },
    };
  }

  const receivedAt = new Date();

  try {
    const [insertedSubmission] = await db
      .insert(teardownSubmission)
      .values({
        authorUserId: input.authorUserId,
        title: submission.title,
        subjectProductName: submission.provenance.subjectProductName,
        documentJson: JSON.stringify(submission),
        documentSchemaVersion: TEARDOWN_SUBMISSION_DOCUMENT_SCHEMA_VERSION,
        /*
         * Written explicitly rather than left to the column default, so this call answers "what
         * state does a submission start in" without opening the schema.
         */
        moderationState: "pending_review",
        createdAt: receivedAt,
        updatedAt: receivedAt,
      })
      .returning({ id: teardownSubmission.id });

    if (!insertedSubmission) throw new Error("teardown submission insert returned no row");

    return {
      success: true,
      value: {
        submissionId: insertedSubmission.id,
        moderationState: "pending_review",
        receivedAt,
      },
    };
  } catch (writeError: unknown) {
    /*
     * A 23505 HERE IS THE UNIT RACE the pre-check cannot close, and it is the only expected fault on
     * this path — the other unique key on this table guards `published_teardown_id`, which a
     * submission does not carry.
     */
    if (isUniqueViolation(writeError)) {
      return {
        success: false,
        error: { type: "TEARDOWN_SUBJECT_ALREADY_SURVEYED", existingTitle: null },
      };
    }
    // ⚠️ STRIPPED, NOT RE-THROWN AS IT CAME. See `buildErrorWithoutQueryParameters`.
    throw buildErrorWithoutQueryParameters(
      writeError,
      "submitTeardown",
      "this statement binds a publisher's account of a private permission",
    );
  }
}

/**
 * The author's own submissions, newest first, in every state.
 *
 * ⚠️ SCOPED BY `author_user_id`, WHICH IS THE WHOLE AUTHORIZATION OF THIS READ. There is no id in
 * the path, so there is nothing to probe; an author sees their own work and nobody else's. The
 * twelve seeded teardowns name no account and have no submission, so they can never appear here,
 * which is correct: nobody submitted those.
 *
 * ⚠️ THE STATE COMES FROM THE TEARDOWN ONCE ONE EXISTS, and that `COALESCE` is the design rather
 * than a convenience. A moderator who flags or quarantines a PUBLISHED teardown changes the state of
 * the teardown, not of the paperwork that produced it — and this list must show that. Reading it off
 * the joined row means one source of truth per lifecycle phase; the alternative is a second state
 * machine writing back into `teardown_submission`, and two rows that can disagree about one fact.
 *
 * ⚠️ `publicSlug` IS COMPUTED FROM THE STATE, NEVER PROJECTED RAW. The frontend renders a "View the
 * page" link whenever it is non-null, and its own schema only checks the `published ⇒ non-null`
 * direction — so handing back a slug for a flagged or quarantined row would render a live link to a
 * page that refuses the reader, with nothing failing anywhere to say so.
 */
export async function listMyTeardowns(input: {
  readonly authorUserId: string;
}): Promise<readonly MyTeardownView[]> {
  const rows = await db
    .select({
      submissionId: teardownSubmission.id,
      title: teardownSubmission.title,
      subjectProductName: teardownSubmission.subjectProductName,
      submittedAt: teardownSubmission.createdAt,
      submissionModerationState: teardownSubmission.moderationState,
      teardownModerationState: teardown.moderationState,
      teardownSlug: teardown.slug,
      moderatorNote: teardownSubmission.moderatorNote,
    })
    .from(teardownSubmission)
    .leftJoin(teardown, eq(teardownSubmission.publishedTeardownId, teardown.id))
    .where(eq(teardownSubmission.authorUserId, input.authorUserId))
    .orderBy(desc(teardownSubmission.createdAt), asc(teardownSubmission.id))
    .limit(MY_TEARDOWN_LIST_LIMIT);

  return rows.map((row) => {
    const moderationState = row.teardownModerationState ?? row.submissionModerationState;
    return {
      submissionId: row.submissionId,
      title: row.title,
      subjectProductName: row.subjectProductName,
      submittedAt: row.submittedAt,
      moderationState,
      publicSlug: moderationState === "published" ? row.teardownSlug : null,
      moderatorNote: row.moderatorNote,
    };
  });
}
