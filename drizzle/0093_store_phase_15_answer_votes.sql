-- ---------------------------------------------------------------------------
-- Store Phase 15 — Appendix A24. Helpful votes on a product answer.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- A9 shipped questions, answers, a derived `author_kind` and post-moderation, and
-- nothing that ranks or endorses an answer. `sections/questions-and-answers.tsx`
-- renders a like control per answer with no handler behind it, because there was no
-- vote table and no vote route anywhere in the Q&A domain.
--
-- This is `commerce_review_vote` (0065) byte for byte, and deliberately so:
--
--   * Row presence IS the vote. No `id`, no `value` column — a "dislike" would be a
--     different product decision, not a column, and A24 asks only for the endorsement
--     half.
--   * The vote is keyed on the ORGANIZATION, not the user. One procurement team does
--     not get five votes because it has five logins, which is the same reason
--     `commerce_review_vote` chose the organization.
--   * `helpful_count` is denormalized onto the answer because the seller-first preview
--     sorts on it, and a correlated count in an ORDER BY cannot use an index.
--
-- The relationship guard spans two tables (the vote and the answer it points at), so
-- it is a trigger rather than a CHECK, exactly as `commerce_review_vote`'s is. The
-- service refuses a self-vote too — that produces a useful 403; this is what makes the
-- rule true.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "commerce_product_answer_vote" (
  "answer_id" text NOT NULL,
  "voter_organization_id" text NOT NULL,
  "voter_member_id" text NOT NULL,
  "voter_user_id" text NOT NULL,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_product_answer_vote_pk"
    PRIMARY KEY ("answer_id", "voter_organization_id")
);--> statement-breakpoint

ALTER TABLE "commerce_product_answer_vote"
  ADD CONSTRAINT "commerce_product_answer_vote_answer_id_fk"
  FOREIGN KEY ("answer_id") REFERENCES "commerce_product_answer"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "commerce_product_answer_vote"
  ADD CONSTRAINT "commerce_product_answer_vote_voter_organization_id_fk"
  FOREIGN KEY ("voter_organization_id") REFERENCES "commerce_organization"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "commerce_product_answer_vote"
  ADD CONSTRAINT "commerce_product_answer_vote_voter_member_id_fk"
  FOREIGN KEY ("voter_member_id") REFERENCES "commerce_organization_member"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "commerce_product_answer_vote"
  ADD CONSTRAINT "commerce_product_answer_vote_voter_user_id_fk"
  FOREIGN KEY ("voter_user_id") REFERENCES "user"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "commerce_product_answer_vote_organization_idx"
  ON "commerce_product_answer_vote" ("voter_organization_id", "created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The denormalized counter. `0` is the honest default here, unlike the ranking
-- score's NULL: an answer with no votes has been voted on zero times, which is a
-- measurement rather than an absence of one.
-- ---------------------------------------------------------------------------

ALTER TABLE "commerce_product_answer"
  ADD COLUMN IF NOT EXISTS "helpful_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "commerce_product_answer"
  DROP CONSTRAINT IF EXISTS "commerce_product_answer_helpful_count_ck";--> statement-breakpoint

ALTER TABLE "commerce_product_answer"
  ADD CONSTRAINT "commerce_product_answer_helpful_count_ck"
  CHECK (helpful_count >= 0);--> statement-breakpoint

-- Serves the seller-first preview's helpful tie-break. Partial on `visible` for the
-- same reason `commerce_review_product_helpful_idx` is: a hidden answer is never
-- previewed, so it has no business widening the index.
CREATE INDEX IF NOT EXISTS "commerce_product_answer_question_helpful_idx"
  ON "commerce_product_answer" ("question_id", "helpful_count" DESC, "id")
  WHERE visibility_state = 'visible';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Relationship guard. Two rules, both spanning tables:
--   1. The answering organization cannot endorse its own answer.
--   2. The voting member must belong to the voting organization, so a member id
--      borrowed from another organization cannot launder a vote.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION commerce_validate_answer_vote_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_author_organization_id text;
  voter_member_organization_id text;
BEGIN
  SELECT author_organization_id
    INTO authoritative_author_organization_id
    FROM commerce_product_answer
   WHERE id = NEW.answer_id;

  IF NEW.voter_organization_id IS NOT DISTINCT FROM authoritative_author_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An answer author cannot vote on its own answer.';
  END IF;

  SELECT organization_id
    INTO voter_member_organization_id
    FROM commerce_organization_member
   WHERE id = NEW.voter_member_id;

  IF voter_member_organization_id IS DISTINCT FROM NEW.voter_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Answer vote member does not belong to the voting organization.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS commerce_product_answer_vote_relationship_guard
  ON "commerce_product_answer_vote";--> statement-breakpoint

CREATE TRIGGER commerce_product_answer_vote_relationship_guard
BEFORE INSERT ON "commerce_product_answer_vote"
FOR EACH ROW EXECUTE FUNCTION commerce_validate_answer_vote_relationship();
