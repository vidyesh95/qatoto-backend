import { and, asc, desc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCompletion,
  commerceOrganization,
  commerceProductAnswer,
  commerceProductAnswerVote,
  commerceProductQuestion,
  commerceProductStats,
  product,
  user,
} from "#src/db/schema.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import type {
  AnswerProductQuestionInput,
  AskProductQuestionInput,
  ProductQuestionListQuery,
} from "#src/schemas/commerce-product-qa.schemas.js";
import { resolveActiveCommerceOrganization } from "#src/services/commerce-organization-access.service.js";
import { ensureCommerceProductStatsRow } from "#src/services/commerce-product-engagement.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ProductAnswerAuthorKind = (typeof commerceProductAnswer.$inferSelect)["authorKind"];

export type CommerceProductQaError =
  | { type: "NOT_FOUND" }
  /**
   * 403, not 404, and this is the one place in the slice where that is right: the
   * question is PUBLIC, so refusing to answer it discloses only the caller's own
   * standing, which they already know.
   */
  | { type: "NOT_AUTHORIZED_TO_ANSWER" }
  | { type: "ALREADY_ANSWERED" }
  /**
   * A24. 403 for the same reason `NOT_AUTHORIZED_TO_ANSWER` is: it discloses only the
   * caller's own standing, which the caller already knows.
   */
  | { type: "SELF_VOTE_FORBIDDEN" }
  | { type: "INVALID_CURSOR" };

/** A24. What the CALLER has done to this answer, absent when there is no caller. */
export interface ProductAnswerViewerState {
  readonly hasVotedHelpful: boolean;
}

export interface ProductAnswerProjection {
  readonly id: string;
  readonly questionId: string;
  readonly authorKind: ProductAnswerAuthorKind;
  readonly bodyText: string;
  readonly createdAt: Date;
  readonly helpfulCount: number;
  /**
   * A24, following A11's `engagement.viewer`: `null` for a caller with no active
   * commerce organization, NOT `{hasVotedHelpful: false}`. "You have not endorsed this"
   * and "we do not know who you are" are different facts, and a toggle that renders the
   * second as the first teaches a buyer the count is not to be trusted.
   *
   * The key is the ORGANIZATION rather than the user, because that is what
   * `commerce_product_answer_vote` is keyed on — a signed-in visitor with no active
   * organization cannot vote, so `null` is also the honest answer about what they may do.
   */
  readonly viewer: ProductAnswerViewerState | null;
  readonly author: {
    readonly organizationId: string;
    readonly slug: string;
    readonly displayName: string;
    readonly logoUrl: string | null;
  } | null;
}

/**
 * Who is reading. Resolved by the controller from the optional session — descriptively,
 * never by a guard, because on a public read a missing organization is a rendering
 * detail rather than a refusal.
 */
export interface ProductQaViewerContext {
  readonly organizationId: string | null;
}

export const ANONYMOUS_QA_VIEWER: ProductQaViewerContext = { organizationId: null };

/**
 * A24. Who is voting. Unlike the answer WRITE, which resolves the organization itself to
 * keep two author kinds distinguishable, a vote has one requirement — an active
 * membership — so the route guard supplies it and the service takes it as given.
 */
export interface CommerceProductQaActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
}

export interface ProductQuestionProjection {
  readonly id: string;
  readonly bodyText: string;
  readonly createdAt: Date;
  readonly answerCount: number;
  readonly hasSellerAnswer: boolean;
  /** The asker's display handle. Their EMPLOYER is never projected — see the table. */
  readonly askedBy: { readonly name: string; readonly handle: string | null } | null;
  /**
   * At most one answer, seller's first. The full list is its own paginated route:
   * a cursor over a computed preference rank is how pagination starts skipping rows.
   */
  readonly topAnswer: ProductAnswerProjection | null;
}

export interface ProductQuestionListPage {
  readonly items: readonly ProductQuestionProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export interface ProductAnswerListPage {
  readonly items: readonly ProductAnswerProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * Recomputes the two derived question counters for a product.
 *
 * A recompute rather than a delta, unlike A11's engagement counters, because
 * `answeredQuestionCount` is not a count of rows — it counts QUESTIONS that have at
 * least one visible answer, so posting a second answer to an already-answered question
 * must not move it. Expressing that as an increment means duplicating the "does this
 * question already have one?" test at four call sites; expressing it as a recompute
 * means one query that is correct by construction.
 */
async function refreshProductQuestionCounters(
  transaction: DatabaseTransaction,
  productId: string,
): Promise<void> {
  await ensureCommerceProductStatsRow(transaction, productId);
  await transaction
    .update(commerceProductStats)
    .set({
      questionCount: sql`(
        select count(*)::int from commerce_product_question
         where product_id = ${productId} and visibility_state = 'visible'
      )`,
      answeredQuestionCount: sql`(
        select count(*)::int from commerce_product_question as question
         where question.product_id = ${productId}
           and question.visibility_state = 'visible'
           and exists (
             select 1 from commerce_product_answer as answer
              where answer.question_id = question.id
                and answer.visibility_state = 'visible'
           )
      )`,
    })
    .where(eq(commerceProductStats.productId, productId));
}

/** Keeps a question's own answer summary in step with its answer rows. */
async function refreshQuestionAnswerSummary(
  transaction: DatabaseTransaction,
  questionId: string,
): Promise<void> {
  await transaction
    .update(commerceProductQuestion)
    .set({
      answerCount: sql`(
        select count(*)::int from commerce_product_answer
         where question_id = ${questionId} and visibility_state = 'visible'
      )`,
      hasSellerAnswer: sql`exists (
        select 1 from commerce_product_answer
         where question_id = ${questionId}
           and visibility_state = 'visible'
           and author_kind = 'seller'
      )`,
    })
    .where(eq(commerceProductQuestion.id, questionId));
}

/**
 * Ask a question about a publicly eligible product (Appendix A9).
 *
 * Takes a product ID: the controller resolves the slug through the catalog's single
 * eligibility rule, so this service never restates it.
 */
export async function askProductQuestion(
  askerUserId: string,
  productId: string,
  input: AskProductQuestionInput,
): Promise<Result<ProductQuestionProjection, CommerceProductQaError>> {
  const question = await db.transaction(async (transaction) => {
    const [inserted] = await transaction
      .insert(commerceProductQuestion)
      .values({ productId, askedByUserId: askerUserId, bodyText: input.bodyText })
      .returning();
    if (!inserted) return null;
    await refreshProductQuestionCounters(transaction, productId);
    return inserted;
  });

  if (!question) return { success: false, error: { type: "NOT_FOUND" } };

  // The viewer is unused with `includeTopAnswer: false` — a question just asked has no
  // answers, so there is nothing for a vote state to be about.
  const [projected] = await projectQuestions(
    [question],
    /* includeTopAnswer */ false,
    ANONYMOUS_QA_VIEWER,
  );
  return projected
    ? { success: true, value: projected }
    : { success: false, error: { type: "NOT_FOUND" } };
}

/**
 * Withdraw one's own question (Appendix A9).
 *
 * `removed_by_author`, never a DELETE. Its answers are other people's writing, and a
 * hard delete would cascade them away; the state also keeps an author retraction
 * distinguishable from a moderator hide, which is the whole reason the visibility enum
 * has four values instead of two.
 */
export async function retractProductQuestion(
  askerUserId: string,
  questionId: string,
): Promise<Result<{ readonly questionId: string }, CommerceProductQaError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [question] = await transaction
      .select()
      .from(commerceProductQuestion)
      .where(
        and(
          eq(commerceProductQuestion.id, questionId),
          eq(commerceProductQuestion.askedByUserId, askerUserId),
          eq(commerceProductQuestion.visibilityState, "visible"),
        ),
      )
      .limit(1)
      .for("update");
    if (!question) return { status: "not_found" as const };

    await transaction
      .update(commerceProductQuestion)
      .set({ visibilityState: "removed_by_author", hiddenAt: new Date() })
      .where(eq(commerceProductQuestion.id, question.id));

    await refreshProductQuestionCounters(transaction, question.productId);
    return { status: "retracted" as const };
  });

  return outcome.status === "not_found"
    ? { success: false, error: { type: "NOT_FOUND" } }
    : { success: true, value: { questionId } };
}

interface AnswerAuthority {
  readonly authorKind: ProductAnswerAuthorKind;
  readonly organizationId: string;
  readonly memberId: string;
  readonly verifiedCompletionId: string | null;
}

/**
 * Decides, from the database alone, what standing the caller has to answer.
 *
 * Tried in order: does the caller's organization OWN the product, or does it hold a
 * completion for it? Nothing about this comes from the request body. A caller with
 * neither standing is refused rather than allowed to answer unbadged — that refusal is
 * what stops Q&A quietly becoming the public comment surface A10 says needs a decision
 * first.
 */
async function resolveAnswerAuthority(
  transaction: DatabaseTransaction,
  input: {
    readonly productId: string;
    readonly sellerOrganizationId: string;
    readonly organizationId: string;
    readonly memberId: string;
  },
): Promise<AnswerAuthority | null> {
  if (input.organizationId === input.sellerOrganizationId) {
    return {
      authorKind: "seller",
      organizationId: input.organizationId,
      memberId: input.memberId,
      verifiedCompletionId: null,
    };
  }

  const [completion] = await transaction
    .select({ id: commerceCompletion.id })
    .from(commerceCompletion)
    .where(
      and(
        eq(commerceCompletion.productId, input.productId),
        eq(commerceCompletion.buyerOrganizationId, input.organizationId),
      ),
    )
    .orderBy(asc(commerceCompletion.completedAt), asc(commerceCompletion.id))
    .limit(1);

  if (!completion) return null;

  return {
    authorKind: "verified_buyer",
    organizationId: input.organizationId,
    memberId: input.memberId,
    verifiedCompletionId: completion.id,
  };
}

/**
 * Answer a public question (Appendix A9).
 *
 * The caller's organization is resolved HERE rather than by route middleware, because
 * this route serves two author kinds with two different organization requirements. A
 * `requireActive...Organization` guard would answer with one 403 for all of them and
 * lose the distinction; resolving it as a `Result` puts "no organization" into the same
 * exhaustive switch as every other outcome.
 */
export async function answerProductQuestion(
  input: {
    readonly answererUserId: string;
    readonly activeOrganizationId: string | null;
    readonly questionId: string;
  },
  body: AnswerProductQuestionInput,
): Promise<Result<ProductAnswerProjection, CommerceProductQaError>> {
  const activeOrganization = await resolveActiveCommerceOrganization({
    userId: input.answererUserId,
    activeOrganizationId: input.activeOrganizationId,
  });
  if (!activeOrganization.success) {
    return { success: false, error: { type: "NOT_AUTHORIZED_TO_ANSWER" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [questionRow] = await transaction
      .select({
        id: commerceProductQuestion.id,
        productId: commerceProductQuestion.productId,
        sellerOrganizationId: product.sellerOrganizationId,
      })
      .from(commerceProductQuestion)
      .innerJoin(product, eq(product.id, commerceProductQuestion.productId))
      .where(
        and(
          eq(commerceProductQuestion.id, input.questionId),
          eq(commerceProductQuestion.visibilityState, "visible"),
        ),
      )
      .limit(1)
      .for("update", { of: commerceProductQuestion });
    if (!questionRow) return { status: "not_found" as const };

    const authority = await resolveAnswerAuthority(transaction, {
      productId: questionRow.productId,
      sellerOrganizationId: questionRow.sellerOrganizationId,
      organizationId: activeOrganization.value.organizationId,
      memberId: activeOrganization.value.memberId,
    });
    if (!authority) return { status: "not_authorized" as const };

    const inserted = await transaction
      .insert(commerceProductAnswer)
      .values({
        questionId: questionRow.id,
        authorUserId: input.answererUserId,
        authorKind: authority.authorKind,
        authorOrganizationId: authority.organizationId,
        authorMemberId: authority.memberId,
        verifiedCompletionId: authority.verifiedCompletionId,
        bodyText: body.bodyText,
      })
      // The unique index is (question_id, author_organization_id): one answer per
      // organization per question, so a seller cannot own the whole thread.
      .onConflictDoNothing()
      .returning();

    const answer = inserted[0];
    if (!answer) return { status: "already_answered" as const };

    await refreshQuestionAnswerSummary(transaction, questionRow.id);
    await refreshProductQuestionCounters(transaction, questionRow.productId);
    return { status: "answered" as const, answer };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "not_authorized":
      return { success: false, error: { type: "NOT_AUTHORIZED_TO_ANSWER" } };
    case "already_answered":
      return { success: false, error: { type: "ALREADY_ANSWERED" } };
    case "answered": {
      const [projected] = await projectAnswers([outcome.answer], {
        organizationId: activeOrganization.value.organizationId,
      });
      return projected
        ? { success: true, value: projected }
        : { success: false, error: { type: "NOT_FOUND" } };
    }
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(
        `Unhandled answerProductQuestion outcome: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

/** Withdraw one's own answer (Appendix A9). */
export async function retractProductAnswer(
  answererUserId: string,
  answerId: string,
): Promise<Result<{ readonly answerId: string }, CommerceProductQaError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [answer] = await transaction
      .select({
        id: commerceProductAnswer.id,
        questionId: commerceProductAnswer.questionId,
        productId: commerceProductQuestion.productId,
      })
      .from(commerceProductAnswer)
      .innerJoin(
        commerceProductQuestion,
        eq(commerceProductQuestion.id, commerceProductAnswer.questionId),
      )
      .where(
        and(
          eq(commerceProductAnswer.id, answerId),
          eq(commerceProductAnswer.authorUserId, answererUserId),
          eq(commerceProductAnswer.visibilityState, "visible"),
        ),
      )
      .limit(1);
    if (!answer) return { status: "not_found" as const };

    await transaction
      .update(commerceProductAnswer)
      .set({ visibilityState: "removed_by_author", hiddenAt: new Date() })
      .where(eq(commerceProductAnswer.id, answer.id));

    await refreshQuestionAnswerSummary(transaction, answer.questionId);
    await refreshProductQuestionCounters(transaction, answer.productId);
    return { status: "retracted" as const };
  });

  return outcome.status === "not_found"
    ? { success: false, error: { type: "NOT_FOUND" } }
    : { success: true, value: { answerId } };
}

// ---------------------------------------------------------------------------
// Public reads.
// ---------------------------------------------------------------------------

/**
 * Two queries regardless of page size, and the second is issued only when there is a
 * viewer organization to ask about. The vote lookup is a prefix scan of
 * `commerce_product_answer_vote`'s primary key, so it needs no index of its own.
 */
async function projectAnswers(
  answerRows: readonly (typeof commerceProductAnswer.$inferSelect)[],
  viewer: ProductQaViewerContext,
): Promise<readonly ProductAnswerProjection[]> {
  if (answerRows.length === 0) return [];

  const organizationIds = [...new Set(answerRows.map((row) => row.authorOrganizationId))];
  const viewerOrganizationId = viewer.organizationId;
  const [organizationRows, viewerVoteRows] = await Promise.all([
    db
      .select({
        organizationId: commerceOrganization.id,
        slug: commerceOrganization.slug,
        displayName: commerceOrganization.displayName,
        logoUrl: commerceOrganization.logoUrl,
      })
      .from(commerceOrganization)
      .where(
        and(
          inArray(commerceOrganization.id, organizationIds),
          eq(commerceOrganization.visibility, "public"),
          eq(commerceOrganization.tradeState, "active"),
        ),
      ),
    viewerOrganizationId === null
      ? Promise.resolve([])
      : db
          .select({ answerId: commerceProductAnswerVote.answerId })
          .from(commerceProductAnswerVote)
          .where(
            and(
              inArray(
                commerceProductAnswerVote.answerId,
                answerRows.map((row) => row.id),
              ),
              eq(commerceProductAnswerVote.voterOrganizationId, viewerOrganizationId),
            ),
          ),
  ]);
  const organizationById = new Map(organizationRows.map((row) => [row.organizationId, row]));
  const votedAnswerIds = new Set(viewerVoteRows.map((row) => row.answerId));

  return answerRows.map((row) => {
    const organization = organizationById.get(row.authorOrganizationId);
    return {
      id: row.id,
      questionId: row.questionId,
      authorKind: row.authorKind,
      bodyText: row.bodyText,
      createdAt: row.createdAt,
      helpfulCount: row.helpfulCount,
      viewer:
        viewerOrganizationId === null
          ? null
          : { hasVotedHelpful: votedAnswerIds.has(row.id) },
      author: organization
        ? {
            organizationId: organization.organizationId,
            slug: organization.slug,
            displayName: organization.displayName,
            logoUrl: organization.logoUrl,
          }
        : null,
    };
  });
}

/**
 * Picks at most one answer per question for the list preview, seller's first and then
 * most-endorsed.
 *
 * The preference rank lives here, in a bounded per-page query, and NOT in the
 * paginated answer read — a cursor over a computed rank is how pagination starts
 * skipping rows. A24's helpful ordering therefore lands here and only here: it sits
 * BEHIND the seller-first rank rather than replacing it, because a seller's answer to a
 * question about their own product is authoritative whether or not anyone voted on it.
 */
async function loadTopAnswers(
  questionIds: readonly string[],
  viewer: ProductQaViewerContext,
): Promise<ReadonlyMap<string, ProductAnswerProjection>> {
  const topAnswers = new Map<string, ProductAnswerProjection>();
  if (questionIds.length === 0) return topAnswers;

  const rows = await db
    .select()
    .from(commerceProductAnswer)
    .where(
      and(
        inArray(commerceProductAnswer.questionId, [...questionIds]),
        eq(commerceProductAnswer.visibilityState, "visible"),
      ),
    )
    .orderBy(
      asc(commerceProductAnswer.questionId),
      sql`case when ${commerceProductAnswer.authorKind} = 'seller' then 0 else 1 end`,
      desc(commerceProductAnswer.helpfulCount),
      asc(commerceProductAnswer.createdAt),
      asc(commerceProductAnswer.id),
    );

  const firstPerQuestion = new Map<string, typeof commerceProductAnswer.$inferSelect>();
  for (const row of rows) {
    if (!firstPerQuestion.has(row.questionId)) firstPerQuestion.set(row.questionId, row);
  }

  const projected = await projectAnswers([...firstPerQuestion.values()], viewer);
  for (const answer of projected) topAnswers.set(answer.questionId, answer);
  return topAnswers;
}

async function projectQuestions(
  questionRows: readonly (typeof commerceProductQuestion.$inferSelect)[],
  includeTopAnswer: boolean,
  viewer: ProductQaViewerContext,
): Promise<readonly ProductQuestionProjection[]> {
  if (questionRows.length === 0) return [];

  const askerIds = [...new Set(questionRows.map((row) => row.askedByUserId))];
  const [askerRows, topAnswers] = await Promise.all([
    db
      .select({ id: user.id, name: user.name, handle: user.handle })
      .from(user)
      .where(inArray(user.id, askerIds)),
    includeTopAnswer
      ? loadTopAnswers(
          questionRows.map((row) => row.id),
          viewer,
        )
      : Promise.resolve(new Map<string, ProductAnswerProjection>()),
  ]);
  const askerById = new Map(askerRows.map((row) => [row.id, row]));

  return questionRows.map((row) => {
    const asker = askerById.get(row.askedByUserId);
    return {
      id: row.id,
      bodyText: row.bodyText,
      createdAt: row.createdAt,
      answerCount: row.answerCount,
      hasSellerAnswer: row.hasSellerAnswer,
      askedBy: asker ? { name: asker.name, handle: asker.handle ?? null } : null,
      topAnswer: topAnswers.get(row.id) ?? null,
    };
  });
}

/** Public question list for one product, oldest first, keyset-paginated. */
export async function listProductQuestions(
  productId: string,
  query: ProductQuestionListQuery,
  viewer: ProductQaViewerContext = ANONYMOUS_QA_VIEWER,
): Promise<Result<ProductQuestionListPage, CommerceProductQaError>> {
  const filters: SQL[] = [
    eq(commerceProductQuestion.productId, productId),
    eq(commerceProductQuestion.visibilityState, "visible"),
  ];

  if (query.cursor !== undefined) {
    const cursor = decodeTimestampStoreCursor(query.cursor);
    if (!cursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    const keyset = or(
      gt(commerceProductQuestion.createdAt, cursor.sortKey),
      and(
        eq(commerceProductQuestion.createdAt, cursor.sortKey),
        gt(commerceProductQuestion.id, cursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(commerceProductQuestion)
    .where(and(...filters))
    .orderBy(asc(commerceProductQuestion.createdAt), asc(commerceProductQuestion.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: await projectQuestions(pageRows, true, viewer),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
            : null,
        hasMore: hasMore && lastRow !== undefined,
      },
    },
  };
}

/** Every visible answer to one question, oldest first, keyset-paginated. */
export async function listProductQuestionAnswers(
  input: { readonly productId: string; readonly questionId: string },
  query: ProductQuestionListQuery,
  viewer: ProductQaViewerContext = ANONYMOUS_QA_VIEWER,
): Promise<Result<ProductAnswerListPage, CommerceProductQaError>> {
  const [question] = await db
    .select({ id: commerceProductQuestion.id })
    .from(commerceProductQuestion)
    .where(
      and(
        eq(commerceProductQuestion.id, input.questionId),
        // Bound to the product in the URL: an id from another listing must 404 rather
        // than resolve, or the route becomes a question-id oracle across the catalog.
        eq(commerceProductQuestion.productId, input.productId),
        eq(commerceProductQuestion.visibilityState, "visible"),
      ),
    )
    .limit(1);
  if (!question) return { success: false, error: { type: "NOT_FOUND" } };

  const filters: SQL[] = [
    eq(commerceProductAnswer.questionId, question.id),
    eq(commerceProductAnswer.visibilityState, "visible"),
  ];

  if (query.cursor !== undefined) {
    const cursor = decodeTimestampStoreCursor(query.cursor);
    if (!cursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    const keyset = or(
      gt(commerceProductAnswer.createdAt, cursor.sortKey),
      and(
        eq(commerceProductAnswer.createdAt, cursor.sortKey),
        gt(commerceProductAnswer.id, cursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(commerceProductAnswer)
    .where(and(...filters))
    .orderBy(asc(commerceProductAnswer.createdAt), asc(commerceProductAnswer.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: await projectAnswers(pageRows, viewer),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
            : null,
        hasMore: hasMore && lastRow !== undefined,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// A24. Helpful votes on an answer.
// ---------------------------------------------------------------------------

export interface AnswerHelpfulVoteProjection {
  readonly answerId: string;
  readonly isHelpful: boolean;
  readonly helpfulCount: number;
}

/**
 * Endorse an answer (Appendix A24). Idempotent: voting twice is one vote.
 *
 * The counter is incremented in the same transaction as the vote row and only when the
 * insert actually created one, so a replayed PUT cannot inflate it.
 *
 * Self-voting is refused here AND by `commerce_product_answer_vote_relationship_guard`.
 * The service check produces a useful 403; the trigger is what makes the rule true.
 */
export async function setAnswerHelpfulVote(
  actor: CommerceProductQaActorContext,
  answerId: string,
): Promise<Result<AnswerHelpfulVoteProjection, CommerceProductQaError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [answer] = await transaction
      .select()
      .from(commerceProductAnswer)
      .where(
        and(
          eq(commerceProductAnswer.id, answerId),
          eq(commerceProductAnswer.visibilityState, "visible"),
        ),
      )
      .limit(1)
      .for("update");
    if (!answer) return { status: "not_found" as const };

    if (actor.organizationId === answer.authorOrganizationId) {
      return { status: "self_vote" as const };
    }

    const inserted = await transaction
      .insert(commerceProductAnswerVote)
      .values({
        answerId: answer.id,
        voterOrganizationId: actor.organizationId,
        voterMemberId: actor.memberId,
        voterUserId: actor.actorUserId,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      return { status: "unchanged" as const, helpfulCount: answer.helpfulCount };
    }

    const [updated] = await transaction
      .update(commerceProductAnswer)
      .set({ helpfulCount: sql`${commerceProductAnswer.helpfulCount} + 1` })
      .where(eq(commerceProductAnswer.id, answer.id))
      .returning({ helpfulCount: commerceProductAnswer.helpfulCount });

    return { status: "voted" as const, helpfulCount: updated?.helpfulCount ?? answer.helpfulCount };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "self_vote":
      return { success: false, error: { type: "SELF_VOTE_FORBIDDEN" } };
    case "unchanged":
    case "voted":
      return {
        success: true,
        value: { answerId, isHelpful: true, helpfulCount: outcome.helpfulCount },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled setAnswerHelpfulVote outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Withdraw a helpful vote (Appendix A24). Idempotent: removing a vote twice is fine.
 *
 * No self-vote check, deliberately — deleting a row that the guard made impossible to
 * create is a no-op, and refusing it would be a 403 about nothing.
 */
export async function clearAnswerHelpfulVote(
  actor: CommerceProductQaActorContext,
  answerId: string,
): Promise<Result<AnswerHelpfulVoteProjection, CommerceProductQaError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [answer] = await transaction
      .select()
      .from(commerceProductAnswer)
      .where(
        and(
          eq(commerceProductAnswer.id, answerId),
          eq(commerceProductAnswer.visibilityState, "visible"),
        ),
      )
      .limit(1)
      .for("update");
    if (!answer) return { status: "not_found" as const };

    const removed = await transaction
      .delete(commerceProductAnswerVote)
      .where(
        and(
          eq(commerceProductAnswerVote.answerId, answer.id),
          eq(commerceProductAnswerVote.voterOrganizationId, actor.organizationId),
        ),
      )
      .returning();

    if (removed.length === 0) {
      return { status: "unchanged" as const, helpfulCount: answer.helpfulCount };
    }

    const [updated] = await transaction
      .update(commerceProductAnswer)
      .set({ helpfulCount: sql`GREATEST(${commerceProductAnswer.helpfulCount} - 1, 0)` })
      .where(eq(commerceProductAnswer.id, answer.id))
      .returning({ helpfulCount: commerceProductAnswer.helpfulCount });

    return {
      status: "cleared" as const,
      helpfulCount: updated?.helpfulCount ?? answer.helpfulCount,
    };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "unchanged":
    case "cleared":
      return {
        success: true,
        value: { answerId, isHelpful: false, helpfulCount: outcome.helpfulCount },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(
        `Unhandled clearAnswerHelpfulVote outcome: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

/**
 * Exported for the A12 moderation service, which flips visibility on these rows and
 * must leave the derived counters consistent afterwards.
 */
export { refreshProductQuestionCounters, refreshQuestionAnswerSummary };
