-- Store Phase 10 — product Q&A (Appendix A9) and engagement counters (Appendix A11).
--
-- Depends on 0064 for `commerce_ugc_visibility_state`,
-- `commerce_product_answer_author_kind` and `commerce_product_engagement_kind`. All
-- three are CREATE TYPE, not ALTER TYPE ADD VALUE, so referencing them here in the
-- same migrate transaction is safe.
--
-- Rollback is clean: nothing outside this file references these five tables.

-- ---------------------------------------------------------------------------
-- A11. Saves and bookmarks — USER-scoped.
--
-- Not organization-scoped, because `commerce_organization.trade_state` starts
-- 'pending' and only a staff decision makes it 'active': an org-keyed bookmark would
-- put a single tap behind human verification. It would also flicker for a user in
-- several organizations and let any viewer-role colleague empty the team's list.
--
-- ONE table for both kinds. The video domain splits like/save because their index
-- shapes differ for a stated reason; here both kinds are rendered lists, so one shape
-- serves both and there is one toggle path instead of two copies of the same
-- race-safe insert.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_engagement" (
  "product_id" text NOT NULL,
  "user_id" text NOT NULL,
  "engagement_kind" "commerce_product_engagement_kind" NOT NULL,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_product_engagement_product_id_user_id_engagement_kind_pk" PRIMARY KEY("product_id","user_id","engagement_kind")
);--> statement-breakpoint
ALTER TABLE "commerce_product_engagement" ADD CONSTRAINT "commerce_product_engagement_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_engagement" ADD CONSTRAINT "commerce_product_engagement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_product_engagement_user_idx" ON "commerce_product_engagement" USING btree ("user_id","engagement_kind","created_at","product_id");--> statement-breakpoint
CREATE INDEX "commerce_product_engagement_product_idx" ON "commerce_product_engagement" USING btree ("product_id","engagement_kind");--> statement-breakpoint

-- A11. Share events. `user_id` is nullable and SET NULL — a signed-out visitor may
-- share, and deleting an account should not erase that a product was shared.
CREATE TABLE "commerce_product_share" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "user_id" text,
  "created_at" timestamp(3) DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "commerce_product_share" ADD CONSTRAINT "commerce_product_share_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_share" ADD CONSTRAINT "commerce_product_share_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_product_share_product_idx" ON "commerce_product_share" USING btree ("product_id","created_at","id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A11. Derived counters.
--
-- A separate table rather than columns on `product`: that row is wide, hot and
-- seller-owned, so a favourite tap would contend with a price edit for the same tuple
-- lock — and it would mix seller-DECLARED truth with platform-DERIVED counters in one
-- row, the distinction A13 says must stay visible.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_stats" (
  "product_id" text PRIMARY KEY NOT NULL,
  "saved_count" integer DEFAULT 0 NOT NULL,
  "bookmarked_count" integer DEFAULT 0 NOT NULL,
  "share_count" integer DEFAULT 0 NOT NULL,
  "question_count" integer DEFAULT 0 NOT NULL,
  "answered_question_count" integer DEFAULT 0 NOT NULL,
  "last_engagement_at" timestamp(3),
  CONSTRAINT "commerce_product_stats_counters_non_negative_ck" CHECK (
    saved_count >= 0 AND bookmarked_count >= 0 AND share_count >= 0
    AND question_count >= 0 AND answered_question_count >= 0
    AND answered_question_count <= question_count
  )
);--> statement-breakpoint
ALTER TABLE "commerce_product_stats" ADD CONSTRAINT "commerce_product_stats_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_product_stats_saved_idx" ON "commerce_product_stats" USING btree ("saved_count","product_id");--> statement-breakpoint

-- Mint a stats row for every existing product. A no-op against production today —
-- 0063 recorded that there are no products — but the phase verifier asserts that
-- every product has one, and the toggle path also inserts defensively, because
-- products have creation paths this phase does not own. A missing stats row makes an
-- UPDATE affect zero rows and lose the count silently; `video_stats` learned that.
INSERT INTO "commerce_product_stats" ("product_id")
SELECT "id" FROM "product"
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A9. Product questions.
--
-- No organization column: a question is asked by a PERSON, and snapshotting the
-- asker's employer publishes it — a §14-shaped disclosure Q&A does not need to make.
-- Organizations appear only on answers, where the badge is the substance.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_question" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "asked_by_user_id" text NOT NULL,
  "body_text" text NOT NULL,
  "visibility_state" "commerce_ugc_visibility_state" DEFAULT 'visible' NOT NULL,
  "answer_count" integer DEFAULT 0 NOT NULL,
  "has_seller_answer" boolean DEFAULT false NOT NULL,
  "hidden_at" timestamp(3),
  "hidden_by_user_id" text,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  "updated_at" timestamp(3) DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_product_question_body_ck" CHECK (char_length(body_text) BETWEEN 1 AND 1000),
  CONSTRAINT "commerce_product_question_answer_count_ck" CHECK (answer_count >= 0),
  CONSTRAINT "commerce_product_question_hidden_ck" CHECK (
    (visibility_state = 'visible') = (hidden_at IS NULL)
    AND (hidden_by_user_id IS NULL OR visibility_state = 'hidden_by_moderator')
  )
);--> statement-breakpoint
ALTER TABLE "commerce_product_question" ADD CONSTRAINT "commerce_product_question_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_question" ADD CONSTRAINT "commerce_product_question_asked_by_user_id_user_id_fk" FOREIGN KEY ("asked_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_question" ADD CONSTRAINT "commerce_product_question_hidden_by_user_id_user_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_product_question_public_idx" ON "commerce_product_question" USING btree ("product_id","visibility_state","created_at","id");--> statement-breakpoint
CREATE INDEX "commerce_product_question_author_idx" ON "commerce_product_question" USING btree ("asked_by_user_id","created_at","id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A9. Answers.
--
-- `verified_completion_id` is the design: the verified-buyer badge is earned
-- STRUCTURALLY, exactly as A8 demands of reviews. An answer cannot claim it without
-- pointing at a completion row, and `commerce_product_answer_verified_ck` keeps the
-- claim and its proof together in both directions.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_answer" (
  "id" text PRIMARY KEY NOT NULL,
  "question_id" text NOT NULL,
  "author_user_id" text NOT NULL,
  "author_kind" "commerce_product_answer_author_kind" NOT NULL,
  "author_organization_id" text NOT NULL,
  "author_member_id" text NOT NULL,
  "verified_completion_id" text,
  "body_text" text NOT NULL,
  "visibility_state" "commerce_ugc_visibility_state" DEFAULT 'visible' NOT NULL,
  "hidden_at" timestamp(3),
  "hidden_by_user_id" text,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  "updated_at" timestamp(3) DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_product_answer_body_ck" CHECK (char_length(body_text) BETWEEN 1 AND 4000),
  CONSTRAINT "commerce_product_answer_verified_ck" CHECK (
    (author_kind = 'verified_buyer') = (verified_completion_id IS NOT NULL)
  ),
  CONSTRAINT "commerce_product_answer_hidden_ck" CHECK (
    (visibility_state = 'visible') = (hidden_at IS NULL)
    AND (hidden_by_user_id IS NULL OR visibility_state = 'hidden_by_moderator')
  )
);--> statement-breakpoint
ALTER TABLE "commerce_product_answer" ADD CONSTRAINT "commerce_product_answer_question_id_commerce_product_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."commerce_product_question"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_answer" ADD CONSTRAINT "commerce_product_answer_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_answer" ADD CONSTRAINT "commerce_product_answer_author_organization_id_commerce_organization_id_fk" FOREIGN KEY ("author_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_answer" ADD CONSTRAINT "commerce_product_answer_author_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_answer" ADD CONSTRAINT "commerce_product_answer_verified_completion_id_commerce_completion_id_fk" FOREIGN KEY ("verified_completion_id") REFERENCES "public"."commerce_completion"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_answer" ADD CONSTRAINT "commerce_product_answer_hidden_by_user_id_user_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_answer_question_org_uidx" ON "commerce_product_answer" USING btree ("question_id","author_organization_id");--> statement-breakpoint
CREATE INDEX "commerce_product_answer_question_idx" ON "commerce_product_answer" USING btree ("question_id","created_at","id");--> statement-breakpoint
CREATE INDEX "commerce_product_answer_organization_idx" ON "commerce_product_answer" USING btree ("author_organization_id","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A9. Seller-answer authority.
--
-- The rule spans three tables — answer, question, product — so no CHECK can express
-- it. A 'seller' answer must come from the organization that OWNS the product the
-- question is about, and a 'verified_buyer' answer's completion must be that
-- organization's, for that same product. Without this, `author_kind` would be a label
-- the service could get wrong once and nobody would notice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commerce_validate_product_answer_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  question_product_id text;
  owning_organization_id text;
  author_member_organization_id text;
  completion_product_id text;
  completion_buyer_organization_id text;
BEGIN
  SELECT q.product_id, p.seller_organization_id
    INTO question_product_id, owning_organization_id
    FROM commerce_product_question AS q
    JOIN product AS p ON p.id = q.product_id
   WHERE q.id = NEW.question_id;

  SELECT organization_id
    INTO author_member_organization_id
    FROM commerce_organization_member
   WHERE id = NEW.author_member_id;

  IF author_member_organization_id IS DISTINCT FROM NEW.author_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Answer member does not belong to the answering organization.';
  END IF;

  IF NEW.author_kind = 'seller' THEN
    IF owning_organization_id IS DISTINCT FROM NEW.author_organization_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Only the selling organization may answer as the seller.';
    END IF;
  ELSE
    SELECT product_id, buyer_organization_id
      INTO completion_product_id, completion_buyer_organization_id
      FROM commerce_completion
     WHERE id = NEW.verified_completion_id;

    IF completion_product_id IS DISTINCT FROM question_product_id
       OR completion_buyer_organization_id IS DISTINCT FROM NEW.author_organization_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Verified-buyer answer must cite this organization''s completion for this product.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER commerce_product_answer_relationship_guard
BEFORE INSERT OR UPDATE OF question_id, author_kind, author_organization_id, author_member_id, verified_completion_id
ON "commerce_product_answer"
FOR EACH ROW EXECUTE FUNCTION commerce_validate_product_answer_relationship();
