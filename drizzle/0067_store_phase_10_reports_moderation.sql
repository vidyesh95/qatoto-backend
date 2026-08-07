-- Store Phase 10 — content reports and the commerce moderation queue (Appendix A12).
--
-- A DOC CORRECTION SHIPS WITH THIS FILE. Appendix A12 says commerce reports feed "the
-- existing content_review_action queue". They cannot: `content_review_action.video_id`
-- is NOT NULL with a cascade to `video`, so a commerce target has nowhere to go.
-- Generalizing that table would also merge two queues gated by DIFFERENT platform
-- capabilities — `moderate_content` and `moderate_commerce` — into one, which is the
-- coupling capabilities exist to prevent. R&D hit this first and built its own
-- `research_program_moderation_action`; this follows that precedent.
--
-- Depends on 0064 for the five CREATE TYPEs, and on 0066 for
-- `commerce_product_question` / `commerce_product_answer`, which the target foreign
-- keys point at.

-- ---------------------------------------------------------------------------
-- Reports.
--
-- Five nullable foreign keys with an XOR check, not one polymorphic `target_id`. A
-- bare text id carries no referential integrity, so a report could point at a row that
-- never existed, and the queue could not join to show a reviewer WHAT was reported.
-- The wire takes a single `targetId`; storage is XOR.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_content_report" (
  "id" text PRIMARY KEY NOT NULL,
  "target_kind" "commerce_content_target_kind" NOT NULL,
  "product_id" text,
  "review_id" text,
  "question_id" text,
  "answer_id" text,
  "organization_id" text,
  "reason" "commerce_content_report_reason" NOT NULL,
  "detail_text" text,
  "reporter_user_id" text,
  "reporter_organization_id" text,
  "status" "commerce_content_report_status" DEFAULT 'open' NOT NULL,
  "resolved_by_user_id" text,
  "resolved_at" timestamp(3),
  "resolution_note" text,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_content_report_target_ck" CHECK (
    num_nonnulls(product_id, review_id, question_id, answer_id, organization_id) = 1
    AND (target_kind = 'product') = (product_id IS NOT NULL)
    AND (target_kind = 'review') = (review_id IS NOT NULL)
    AND (target_kind = 'question') = (question_id IS NOT NULL)
    AND (target_kind = 'answer') = (answer_id IS NOT NULL)
    AND (target_kind = 'organization') = (organization_id IS NOT NULL)
  ),
  CONSTRAINT "commerce_content_report_detail_ck" CHECK (
    detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000
  ),
  CONSTRAINT "commerce_content_report_resolution_ck" CHECK (
    (resolved_by_user_id IS NULL) = (resolved_at IS NULL)
    AND (status = 'open') = (resolved_at IS NULL)
  )
);--> statement-breakpoint
ALTER TABLE "commerce_content_report" ADD CONSTRAINT "commerce_content_report_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_content_report" ADD CONSTRAINT "commerce_content_report_review_id_commerce_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."commerce_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_content_report" ADD CONSTRAINT "commerce_content_report_question_id_commerce_product_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."commerce_product_question"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_content_report" ADD CONSTRAINT "commerce_content_report_answer_id_commerce_product_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."commerce_product_answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_content_report" ADD CONSTRAINT "commerce_content_report_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_content_report" ADD CONSTRAINT "commerce_content_report_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_content_report" ADD CONSTRAINT "commerce_content_report_reporter_organization_id_commerce_organization_id_fk" FOREIGN KEY ("reporter_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_content_report" ADD CONSTRAINT "commerce_content_report_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- One report per user per target. Partial, because four of the five target columns are
-- null on any given row.
CREATE UNIQUE INDEX "commerce_content_report_product_reporter_uidx" ON "commerce_content_report" USING btree ("product_id","reporter_user_id") WHERE product_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_content_report_review_reporter_uidx" ON "commerce_content_report" USING btree ("review_id","reporter_user_id") WHERE review_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_content_report_question_reporter_uidx" ON "commerce_content_report" USING btree ("question_id","reporter_user_id") WHERE question_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_content_report_answer_reporter_uidx" ON "commerce_content_report" USING btree ("answer_id","reporter_user_id") WHERE answer_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_content_report_organization_reporter_uidx" ON "commerce_content_report" USING btree ("organization_id","reporter_user_id") WHERE organization_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_content_report_queue_idx" ON "commerce_content_report" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "commerce_content_report_target_idx" ON "commerce_content_report" USING btree ("target_kind","status","created_at","id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Moderation actions.
--
-- Target columns are SET NULL, the opposite of the report table's cascade, and
-- deliberately: a report about a deleted product is noise, but a record that staff hid
-- something is exactly what an audit still needs to find. The target check therefore
-- allows ZERO targets — that is the intended end state after a delete — while still
-- requiring whichever column is set to agree with `target_kind`.
--
-- `action_source` is what lets an AUTOMATIC threshold hide exist at all.
-- `platform_audit_entry.actor_user_id` is NOT NULL because the chain's premise is that
-- every entry names an accountable human, and a hide triggered by three reporters
-- names nobody. Rather than weaken that invariant, an automatic row carries no
-- moderator and no audit entry, and the check below binds all three columns to the
-- source value in both directions.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_moderation_action" (
  "id" text PRIMARY KEY NOT NULL,
  "action_kind" "commerce_moderation_action_kind" NOT NULL,
  "target_kind" "commerce_content_target_kind" NOT NULL,
  "product_id" text,
  "review_id" text,
  "question_id" text,
  "answer_id" text,
  "organization_id" text,
  "report_id" text,
  "action_source" "commerce_moderation_action_source" NOT NULL,
  "moderator_user_id" text,
  "moderator_role_snapshot" text,
  "reason_note" text NOT NULL,
  "audit_entry_id" text,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_moderation_action_target_ck" CHECK (
    num_nonnulls(product_id, review_id, question_id, answer_id, organization_id) <= 1
    AND (product_id IS NULL OR target_kind = 'product')
    AND (review_id IS NULL OR target_kind = 'review')
    AND (question_id IS NULL OR target_kind = 'question')
    AND (answer_id IS NULL OR target_kind = 'answer')
    AND (organization_id IS NULL OR target_kind = 'organization')
  ),
  CONSTRAINT "commerce_moderation_action_source_ck" CHECK (
    (action_source = 'moderator') = (moderator_user_id IS NOT NULL)
    AND (action_source = 'moderator') = (moderator_role_snapshot IS NOT NULL)
    AND (action_source = 'moderator') = (audit_entry_id IS NOT NULL)
  ),
  CONSTRAINT "commerce_moderation_action_reason_ck" CHECK (char_length(reason_note) BETWEEN 1 AND 2000),
  CONSTRAINT "commerce_moderation_action_role_ck" CHECK (
    moderator_role_snapshot IS NULL OR char_length(moderator_role_snapshot) BETWEEN 1 AND 40
  )
);--> statement-breakpoint
ALTER TABLE "commerce_moderation_action" ADD CONSTRAINT "commerce_moderation_action_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_moderation_action" ADD CONSTRAINT "commerce_moderation_action_review_id_commerce_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."commerce_review"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_moderation_action" ADD CONSTRAINT "commerce_moderation_action_question_id_commerce_product_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."commerce_product_question"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_moderation_action" ADD CONSTRAINT "commerce_moderation_action_answer_id_commerce_product_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."commerce_product_answer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_moderation_action" ADD CONSTRAINT "commerce_moderation_action_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_moderation_action" ADD CONSTRAINT "commerce_moderation_action_report_id_commerce_content_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."commerce_content_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_moderation_action" ADD CONSTRAINT "commerce_moderation_action_moderator_user_id_user_id_fk" FOREIGN KEY ("moderator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_moderation_action" ADD CONSTRAINT "commerce_moderation_action_audit_entry_id_platform_audit_entry_id_fk" FOREIGN KEY ("audit_entry_id") REFERENCES "public"."platform_audit_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_moderation_action_audit_uidx" ON "commerce_moderation_action" USING btree ("audit_entry_id") WHERE audit_entry_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_moderation_action_timeline_idx" ON "commerce_moderation_action" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "commerce_moderation_action_moderator_idx" ON "commerce_moderation_action" USING btree ("moderator_user_id","created_at") WHERE moderator_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_moderation_action_report_idx" ON "commerce_moderation_action" USING btree ("report_id") WHERE report_id IS NOT NULL;
