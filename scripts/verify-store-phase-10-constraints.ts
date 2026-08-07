/**
 * Verifies Store Phase 10 "public voice" database invariants after migrations
 * 0064–0068 (Appendix A8, A9, A11, A12, A14).
 *
 *   pnpm run db:verify-store-phase-10-constraints
 *
 * The structural checks (tables, indexes, constraints, enum values) are the usual
 * shape. The DATA checks below are the ones worth the file: every one of them asserts
 * a rule that no single constraint can express, either because it spans tables or
 * because it is a denormalized counter that can drift.
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const EXPECTED_TABLES: readonly string[] = [
  // A8
  "commerce_review_media",
  "commerce_review_score",
  "commerce_review_vote",
  "commerce_review_reply",
  // A11
  "commerce_product_engagement",
  "commerce_product_share",
  "commerce_product_stats",
  // A9
  "commerce_product_question",
  "commerce_product_answer",
  // A12
  "commerce_content_report",
  "commerce_moderation_action",
  // A14
  "commerce_product_inquiry",
];

const EXPECTED_TRIGGERS: readonly string[] = [
  "commerce_review_vote_relationship_guard",
  "commerce_review_reply_relationship_guard",
  "commerce_product_answer_relationship_guard",
];

const EXPECTED_INDEXES: readonly string[] = [
  // A8 keyset indexes — the four public sorts plus the organization read.
  "commerce_review_product_recent_idx",
  "commerce_review_product_helpful_idx",
  "commerce_review_product_rating_idx",
  "commerce_review_product_media_idx",
  "commerce_review_subject_recent_idx",
  "commerce_review_media_position_uidx",
  "commerce_review_score_axis_idx",
  "commerce_review_vote_organization_idx",
  "commerce_review_reply_organization_idx",
  // A11
  "commerce_product_engagement_user_idx",
  "commerce_product_engagement_product_idx",
  "commerce_product_share_product_idx",
  "commerce_product_stats_saved_idx",
  // A9
  "commerce_product_question_public_idx",
  "commerce_product_question_author_idx",
  "commerce_product_answer_question_org_uidx",
  "commerce_product_answer_question_idx",
  // A12
  "commerce_content_report_queue_idx",
  "commerce_content_report_target_idx",
  "commerce_moderation_action_audit_uidx",
  "commerce_moderation_action_timeline_idx",
  // A14
  "commerce_product_inquiry_product_buyer_uidx",
  "commerce_product_inquiry_seller_idx",
  /**
   * THE REGRESSION GUARD. Not a Phase 10 index at all — it has existed since the
   * thread tables shipped, and A14 exists specifically so it did not have to change.
   * Anyone who later "simplifies" it back into `(resource_kind, resource_id)` partials
   * to point threads at products directly reopens the cross-tenant leak this phase
   * designed around.
   */
  "commerce_thread_resource_uidx",
];

const EXPECTED_CONSTRAINTS: readonly {
  readonly tableName: string;
  readonly constraintName: string;
}[] = [
  { tableName: "commerce_review", constraintName: "commerce_review_helpful_count_ck" },
  { tableName: "commerce_review", constraintName: "commerce_review_media_count_ck" },
  { tableName: "commerce_review_media", constraintName: "commerce_review_media_supply_ck" },
  { tableName: "commerce_review_media", constraintName: "commerce_review_media_youtube_ck" },
  { tableName: "commerce_review_media", constraintName: "commerce_review_media_position_ck" },
  { tableName: "commerce_review_score", constraintName: "commerce_review_score_ck" },
  { tableName: "commerce_review_reply", constraintName: "commerce_review_reply_body_ck" },
  {
    tableName: "commerce_product_stats",
    constraintName: "commerce_product_stats_counters_non_negative_ck",
  },
  {
    tableName: "commerce_product_question",
    constraintName: "commerce_product_question_hidden_ck",
  },
  {
    tableName: "commerce_product_answer",
    constraintName: "commerce_product_answer_verified_ck",
  },
  { tableName: "commerce_content_report", constraintName: "commerce_content_report_target_ck" },
  {
    tableName: "commerce_content_report",
    constraintName: "commerce_content_report_resolution_ck",
  },
  {
    tableName: "commerce_moderation_action",
    constraintName: "commerce_moderation_action_source_ck",
  },
  {
    tableName: "commerce_moderation_action",
    constraintName: "commerce_moderation_action_target_ck",
  },
  {
    tableName: "commerce_product_inquiry",
    constraintName: "commerce_product_inquiry_parties_ck",
  },
];

const EXPECTED_ENUM_VALUES: readonly { readonly typeName: string; readonly value: string }[] = [
  { typeName: "commerce_review_media_kind", value: "photo" },
  { typeName: "commerce_review_media_kind", value: "youtube_video" },
  { typeName: "commerce_review_score_axis", value: "shipping" },
  { typeName: "commerce_ugc_visibility_state", value: "hidden_pending_review" },
  { typeName: "commerce_ugc_visibility_state", value: "removed_by_author" },
  { typeName: "commerce_product_answer_author_kind", value: "verified_buyer" },
  { typeName: "commerce_product_engagement_kind", value: "bookmarked" },
  { typeName: "commerce_content_target_kind", value: "answer" },
  { typeName: "commerce_content_report_reason", value: "counterfeit" },
  { typeName: "commerce_moderation_action_source", value: "automatic" },
  { typeName: "commerce_thread_resource_kind", value: "product_inquiry" },
  { typeName: "commerce_organization_audit_event_kind", value: "review_media_attached" },
  { typeName: "commerce_organization_audit_event_kind", value: "product_inquiry_opened" },
  { typeName: "platform_audit_event_kind", value: "commerce_content_hidden" },
  { typeName: "platform_audit_event_kind", value: "commerce_content_restored" },
];

async function countQuery(queryText: string, values: readonly unknown[] = []): Promise<number> {
  const queryResult = await pool.query<{ readonly row_count: string }>(queryText, [...values]);
  return Number(queryResult.rows[0]?.row_count ?? 0);
}

async function verifyPhaseConstraints(): Promise<readonly CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const tableCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES],
  );
  outcomes.push({
    label: "all store phase 10 tables exist",
    passed: tableCount === EXPECTED_TABLES.length,
    detail: `${String(tableCount)}/${String(EXPECTED_TABLES.length)}`,
  });

  const counterColumnCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'commerce_review'
        AND column_name IN ('helpful_count', 'media_count')`,
  );
  outcomes.push({
    label: "commerce_review carries its denormalized counters",
    passed: counterColumnCount === 2,
    detail: `${String(counterColumnCount)}/2`,
  });

  // Counted from pg_trigger, never information_schema.triggers: that view returns one
  // row PER EVENT, so an INSERT-OR-UPDATE trigger is double-counted there.
  const triggerCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY($1)`,
    [EXPECTED_TRIGGERS],
  );
  outcomes.push({
    label: "all store phase 10 triggers exist",
    passed: triggerCount === EXPECTED_TRIGGERS.length,
    detail: `${String(triggerCount)}/${String(EXPECTED_TRIGGERS.length)}`,
  });

  /**
   * THE MOST IMPORTANT STRUCTURAL CHECK IN THIS FILE.
   *
   * Migration 0065 narrowed `commerce_review_relationship_guard` from whole-row to
   * `UPDATE OF <identity columns>` so a counter bump stops re-running two point
   * lookups. A name-only check passes whether the trigger is column-scoped, whole-row,
   * or was dropped and hand-recreated wrongly — so this asserts `tgattr` is non-empty,
   * which is true only of the narrowed form.
   */
  const narrowedGuardCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = 'commerce_review_relationship_guard'
        AND coalesce(array_length(tgattr::int2[], 1), 0) = 5`,
  );
  outcomes.push({
    label: "review relationship guard is column-scoped to its five identity columns",
    passed: narrowedGuardCount === 1,
    detail: `${String(narrowedGuardCount)}/1 narrowed trigger`,
  });

  const indexCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [EXPECTED_INDEXES],
  );
  outcomes.push({
    label: "all store phase 10 indexes exist (incl. the thread-uniqueness regression guard)",
    passed: indexCount === EXPECTED_INDEXES.length,
    detail: `${String(indexCount)}/${String(EXPECTED_INDEXES.length)}`,
  });

  const constraintCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND (table_name, constraint_name) IN (
          SELECT * FROM unnest($1::text[], $2::text[])
        )`,
    [
      EXPECTED_CONSTRAINTS.map((entry) => entry.tableName),
      EXPECTED_CONSTRAINTS.map((entry) => entry.constraintName),
    ],
  );
  outcomes.push({
    label: "all store phase 10 check constraints exist",
    passed: constraintCount === EXPECTED_CONSTRAINTS.length,
    detail: `${String(constraintCount)}/${String(EXPECTED_CONSTRAINTS.length)}`,
  });

  const enumValueCount = await countQuery(
    `SELECT count(*) AS row_count
       FROM pg_type AS enum_type
       INNER JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
      WHERE (enum_type.typname, enum_value.enumlabel) IN (
        SELECT * FROM unnest($1::text[], $2::text[])
      )`,
    [
      EXPECTED_ENUM_VALUES.map((entry) => entry.typeName),
      EXPECTED_ENUM_VALUES.map((entry) => entry.value),
    ],
  );
  outcomes.push({
    label: "all store phase 10 enum values exist",
    passed: enumValueCount === EXPECTED_ENUM_VALUES.length,
    detail: `${String(enumValueCount)}/${String(EXPECTED_ENUM_VALUES.length)}`,
  });

  // ---------------------------------------------------------------------------
  // Data invariants. These are what a denormalized counter and a cross-table rule
  // cost, and the reason this file is worth running.
  // ---------------------------------------------------------------------------

  const driftedReviewCounters = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_review AS review
      WHERE review.helpful_count <> (
              SELECT count(*) FROM commerce_review_vote AS vote
               WHERE vote.review_id = review.id)
         OR review.media_count <> (
              SELECT count(*) FROM commerce_review_media AS media
               WHERE media.review_id = review.id)`,
  );
  outcomes.push({
    label: "review helpful_count and media_count agree with their rows",
    passed: driftedReviewCounters === 0,
    detail: `${String(driftedReviewCounters)} drifted review(s)`,
  });

  const productsWithoutStats = await countQuery(
    `SELECT count(*) AS row_count
       FROM product
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_product_stats AS stats WHERE stats.product_id = product.id)`,
  );
  outcomes.push({
    // Catches a product-creation path that forgot `ensureCommerceProductStatsRow`. A
    // missing stats row makes the counter UPDATE affect zero rows and lose the count
    // with no error at all.
    label: "every product has an engagement stats row",
    passed: productsWithoutStats === 0,
    detail: `${String(productsWithoutStats)} product(s) without stats`,
  });

  const driftedEngagementCounters = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_product_stats AS stats
      WHERE stats.saved_count <> (
              SELECT count(*) FROM commerce_product_engagement AS engagement
               WHERE engagement.product_id = stats.product_id
                 AND engagement.engagement_kind = 'saved')
         OR stats.bookmarked_count <> (
              SELECT count(*) FROM commerce_product_engagement AS engagement
               WHERE engagement.product_id = stats.product_id
                 AND engagement.engagement_kind = 'bookmarked')
         OR stats.share_count <> (
              SELECT count(*) FROM commerce_product_share AS share
               WHERE share.product_id = stats.product_id)`,
  );
  outcomes.push({
    label: "engagement counters agree with their rows",
    passed: driftedEngagementCounters === 0,
    detail: `${String(driftedEngagementCounters)} drifted stats row(s)`,
  });

  const driftedQuestionCounters = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_product_stats AS stats
      WHERE stats.question_count <> (
              SELECT count(*) FROM commerce_product_question AS question
               WHERE question.product_id = stats.product_id
                 AND question.visibility_state = 'visible')
         OR stats.answered_question_count <> (
              SELECT count(*) FROM commerce_product_question AS question
               WHERE question.product_id = stats.product_id
                 AND question.visibility_state = 'visible'
                 AND EXISTS (
                   SELECT 1 FROM commerce_product_answer AS answer
                    WHERE answer.question_id = question.id
                      AND answer.visibility_state = 'visible'))`,
  );
  outcomes.push({
    label: "question counters agree with their rows",
    passed: driftedQuestionCounters === 0,
    detail: `${String(driftedQuestionCounters)} drifted question counter(s)`,
  });

  const driftedAnswerSummaries = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_product_question AS question
      WHERE question.answer_count <> (
              SELECT count(*) FROM commerce_product_answer AS answer
               WHERE answer.question_id = question.id
                 AND answer.visibility_state = 'visible')
         OR question.has_seller_answer <> EXISTS (
              SELECT 1 FROM commerce_product_answer AS answer
               WHERE answer.question_id = question.id
                 AND answer.visibility_state = 'visible'
                 AND answer.author_kind = 'seller')`,
  );
  outcomes.push({
    label: "question answer summaries agree with their answers",
    passed: driftedAnswerSummaries === 0,
    detail: `${String(driftedAnswerSummaries)} drifted question(s)`,
  });

  const selfVotes = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_review_vote AS vote
       INNER JOIN commerce_review AS review ON review.id = vote.review_id
      WHERE vote.voter_organization_id IN (
        review.reviewer_organization_id, review.subject_organization_id)`,
  );
  outcomes.push({
    label: "no review party has voted on its own review",
    passed: selfVotes === 0,
    detail: `${String(selfVotes)} self-vote(s)`,
  });

  const strayReplies = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_review_reply AS reply
       INNER JOIN commerce_review AS review ON review.id = reply.review_id
      WHERE reply.responder_organization_id <> review.subject_organization_id`,
  );
  outcomes.push({
    label: "every review reply comes from the reviewed organization",
    passed: strayReplies === 0,
    detail: `${String(strayReplies)} stray reply(ies)`,
  });

  const nonContiguousMedia = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT media.review_id
           FROM commerce_review_media AS media
          GROUP BY media.review_id
         HAVING max(media.position) <> count(*) - 1 OR min(media.position) <> 0
       ) AS gapped`,
  );
  outcomes.push({
    // The re-pack after a detach either ran or it did not; a gap means the parked-then-
    // renumbered two-pass write was interrupted.
    label: "review media positions are contiguous from zero",
    passed: nonContiguousMedia === 0,
    detail: `${String(nonContiguousMedia)} gapped gallery(ies)`,
  });

  const straySellerAnswers = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_product_answer AS answer
       INNER JOIN commerce_product_question AS question ON question.id = answer.question_id
       INNER JOIN product ON product.id = question.product_id
      WHERE answer.author_kind = 'seller'
        AND answer.author_organization_id <> product.seller_organization_id`,
  );
  outcomes.push({
    // No foreign key can express this — it spans answer, question and product.
    label: "every seller answer comes from the organization that owns the product",
    passed: straySellerAnswers === 0,
    detail: `${String(straySellerAnswers)} stray seller answer(s)`,
  });

  const unprovenBuyerAnswers = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_product_answer AS answer
       INNER JOIN commerce_product_question AS question ON question.id = answer.question_id
       LEFT JOIN commerce_completion AS completion
         ON completion.id = answer.verified_completion_id
      WHERE answer.author_kind = 'verified_buyer'
        AND (completion.id IS NULL
          OR completion.product_id IS DISTINCT FROM question.product_id
          OR completion.buyer_organization_id IS DISTINCT FROM answer.author_organization_id)`,
  );
  outcomes.push({
    // The verified-buyer badge is earned structurally or not at all (A8's rule, applied
    // to answers).
    label: "every verified-buyer answer cites a matching completion",
    passed: unprovenBuyerAnswers === 0,
    detail: `${String(unprovenBuyerAnswers)} unproven answer(s)`,
  });

  const malformedReportTargets = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_content_report
      WHERE num_nonnulls(product_id, review_id, question_id, answer_id, organization_id) <> 1`,
  );
  outcomes.push({
    label: "every content report points at exactly one target",
    passed: malformedReportTargets === 0,
    detail: `${String(malformedReportTargets)} malformed report(s)`,
  });

  const incoherentActions = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_moderation_action
      WHERE (action_source = 'moderator') <> (moderator_user_id IS NOT NULL)
         OR (action_source = 'moderator') <> (audit_entry_id IS NOT NULL)
         OR (action_source = 'moderator') <> (moderator_role_snapshot IS NOT NULL)`,
  );
  outcomes.push({
    // An `automatic` row with a moderator is a lie; a `moderator` row without an audit
    // entry is an unlogged staff action, which is what the hash chain exists to prevent.
    label: "moderation action source agrees with its attribution columns",
    passed: incoherentActions === 0,
    detail: `${String(incoherentActions)} incoherent action(s)`,
  });

  const inquiriesWithoutThreads = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_product_inquiry AS inquiry
      WHERE NOT EXISTS (
        SELECT 1 FROM commerce_thread AS thread
         WHERE thread.resource_kind = 'product_inquiry' AND thread.resource_id = inquiry.id)`,
  );
  outcomes.push({
    label: "every product inquiry has its thread",
    passed: inquiriesWithoutThreads === 0,
    detail: `${String(inquiriesWithoutThreads)} inquiry(ies) without a thread`,
  });

  const orphanInquiryThreads = await countQuery(
    `SELECT count(*) AS row_count
       FROM commerce_thread AS thread
      WHERE thread.resource_kind = 'product_inquiry'
        AND NOT EXISTS (
          SELECT 1 FROM commerce_product_inquiry AS inquiry WHERE inquiry.id = thread.resource_id)`,
  );
  outcomes.push({
    // `commerce_thread.resource_id` has no foreign key — it is polymorphic by design —
    // so this is the only thing standing between it and a dangling pointer.
    label: "no inquiry thread points at a missing inquiry",
    passed: orphanInquiryThreads === 0,
    detail: `${String(orphanInquiryThreads)} orphan thread(s)`,
  });

  const hiddenStateMismatches = await countQuery(
    `SELECT count(*) AS row_count
       FROM (
         SELECT visibility_state, hidden_at FROM commerce_product_question
         UNION ALL
         SELECT visibility_state, hidden_at FROM commerce_product_answer
       ) AS ugc
      WHERE (ugc.visibility_state = 'visible') <> (ugc.hidden_at IS NULL)`,
  );
  outcomes.push({
    label: "question and answer visibility agrees with hidden_at",
    passed: hiddenStateMismatches === 0,
    detail: `${String(hiddenStateMismatches)} mismatched row(s)`,
  });

  return outcomes;
}

async function main(): Promise<void> {
  const outcomes = await verifyPhaseConstraints();
  let hasFailure = false;
  for (const outcome of outcomes) {
    const outcomeMark = outcome.passed ? "PASS" : "FAIL";
    console.log(`[${outcomeMark}] ${outcome.label} — ${outcome.detail}`);
    if (!outcome.passed) hasFailure = true;
  }

  await pool.end();
  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  void pool.end();
});
