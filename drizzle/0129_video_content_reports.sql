-- ---------------------------------------------------------------------------
-- Video content reporting — the column and the two tables. Enums are in 0128.
--
-- HAND-WRITTEN, like every migration since 0046.
--
-- THE FOURTH REPORT FORK, and the fourth is deliberate rather than an oversight. Three
-- already exist — `research_program_content_report`, `commerce_content_report`,
-- `community_content_report` — and each one records why it refused to generalize the last:
-- two queues gated by DIFFERENT capabilities in one table is "the coupling capabilities
-- exist to prevent". A commerce moderator working counterfeit listings and a content
-- moderator judging a video are not the same shift, even where the columns would match.
--
-- WHY NOT `content_review_action`, WHICH IS ALREADY THE VIDEO MODERATION LOG. This is the
-- reuse that looks obvious, and `commerce_content_report`'s own docblock predicted it
-- failing. Two columns forbid it:
--
--   `reviewer_id` is NOT NULL. Fine for the anime queue, where a human always decides.
--   `video_id` is NOT NULL with a CASCADE — so a decision disappears when its subject
--     does, which is precisely backwards for an audit. `video_moderation_action` below
--     uses SET NULL for that reason.
--
-- Nothing about the anime queue changes here; `content_review_action` keeps its two writers
-- and its meaning.
--
-- ═══ NO AUTOMATIC HIDE, AND THAT IS THE DESIGN DECISION THIS FILE EXISTS TO RECORD ═══
--
-- Commerce hides a review, question or answer once three DISTINCT reporters have flagged
-- it, counted inside the insert's own transaction. It never does that to a product, and its
-- reason is worth quoting: "delisting a seller's listing is a commercial action against
-- their livelihood and requires a human to take it."
--
-- A video is a creator's livelihood by exactly that argument. So there is no threshold, no
-- automatic path, and every hide names a moderator. Three consequences follow, and they are
-- why this schema is simpler than commerce's rather than a copy of it:
--
--   `video_moderation_action` has NO `action_source` column. There is only one source.
--   `moderator_user_id`, `moderator_role_snapshot` and `audit_entry_id` are all NOT NULL,
--     where commerce needs a nullable trio bound by a three-way biconditional CHECK to
--     keep an authorless row honest.
--   Every action is in the platform hash chain. Commerce had to keep automatic hides OUT
--     of it, because `platform_audit_entry.actor_user_id` is NOT NULL and a threshold hide
--     names nobody.
--
-- This is the community/R&D shape, not the commerce one — chosen on the merits, not copied.
--
-- ═══ ONE TARGET, SO NONE OF THE XOR MACHINERY ═══
--
-- `commerce_content_report` carries five nullable foreign keys, a `num_nonnulls(...) = 1`
-- check and five per-kind biconditionals, because one queue covers products, reviews,
-- questions, answers and organizations. This queue covers a video. `video_id` is NOT NULL
-- and there is no `target_kind` column — inventing one with a single member would be
-- ceremony, and a future second target kind is a migration, not a reason to pay now.
--
-- ═══ THE TWO CASCADE DIRECTIONS ARE OPPOSITE, ON PURPOSE ═══
--
--   report.video_id            CASCADE   a report about a deleted video is noise
--   report.reporter_user_id    SET NULL  a deleted account must not erase the report it filed
--   report.resolved_by_user_id RESTRICT  a moderator cannot be deleted out from under a
--                                        decision; account deletion is anonymization
--   action.video_id            SET NULL  a record that staff hid something must survive the
--   action.report_id           SET NULL  thing it was about — that is what an audit needs
--   action.moderator_user_id   RESTRICT  same accountability rule as the report's resolver
--   action.audit_entry_id      RESTRICT  the chain entry outlives everything
--
-- ═══ THE COLUMN IS NOT ENOUGH ON ITS OWN ═══
--
-- `video.moderation_visibility_state` only hides a video because three predicates in the
-- application filter on it, and all three were updated alongside this migration:
-- `PUBLICLY_SERVABLE` (public-video-gate.ts, which every engagement write and the watch
-- payload go through), `publicVideoPredicate()` (feed.service.ts — feed AND search) and
-- `publicVideoPredicateSql()` (spotlight.service.ts). A future read that forgets the term
-- serves hidden content and nothing fails.
--
-- `video_feed_candidate_idx` IS DELIBERATELY NOT REBUILT. Postgres uses a partial index
-- when the query's WHERE implies the index predicate, and adding a conjunct still implies
-- it. Rebuilding would take a lock that blocks every write to `video` — the index's own
-- docblock says it was built early for exactly that reason.
--
-- NOTHING TO BACKFILL. The column's default is `'visible'`, which is true of every existing
-- row, and a non-volatile default means Postgres adds it without rewriting the table.
--
-- RUN ORDER: column -> tables -> foreign keys -> indexes.
-- ---------------------------------------------------------------------------

ALTER TABLE "video" ADD COLUMN "moderation_visibility_state" "video_moderation_visibility_state" DEFAULT 'visible' NOT NULL;--> statement-breakpoint

CREATE TABLE "video_content_report" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"reason" "video_content_report_reason" NOT NULL,
	"detail_text" text,
	"reporter_user_id" text,
	"status" "video_content_report_status" DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp (3),
	"resolution_note" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_content_report_detail_ck" CHECK (detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000),
	CONSTRAINT "video_content_report_resolution_ck" CHECK ((resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL))
);--> statement-breakpoint

CREATE TABLE "video_moderation_action" (
	"id" text PRIMARY KEY NOT NULL,
	"action_kind" "video_moderation_action_kind" NOT NULL,
	"video_id" text,
	"report_id" text,
	"moderator_user_id" text NOT NULL,
	"moderator_role_snapshot" text NOT NULL,
	"reason_note" text NOT NULL,
	"audit_entry_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_moderation_action_reason_ck" CHECK (char_length(reason_note) BETWEEN 1 AND 2000),
	CONSTRAINT "video_moderation_action_role_ck" CHECK (char_length(moderator_role_snapshot) BETWEEN 1 AND 40)
);--> statement-breakpoint

ALTER TABLE "video_content_report" ADD CONSTRAINT "video_content_report_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "video_content_report" ADD CONSTRAINT "video_content_report_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "video_content_report" ADD CONSTRAINT "video_content_report_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "video_moderation_action" ADD CONSTRAINT "video_moderation_action_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "video_moderation_action" ADD CONSTRAINT "video_moderation_action_report_id_video_content_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."video_content_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "video_moderation_action" ADD CONSTRAINT "video_moderation_action_moderator_user_id_user_id_fk" FOREIGN KEY ("moderator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "video_moderation_action" ADD CONSTRAINT "video_moderation_action_audit_entry_id_platform_audit_entry_id_fk" FOREIGN KEY ("audit_entry_id") REFERENCES "public"."platform_audit_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- One report per person per video. Partial because `reporter_user_id` is nullable by the
-- SET NULL above, and NULLs do not collide in a unique index anyway — stating it keeps the
-- index off rows nothing will ever probe.
CREATE UNIQUE INDEX "video_content_report_reporter_uidx" ON "video_content_report" USING btree ("video_id","reporter_user_id") WHERE reporter_user_id IS NOT NULL;--> statement-breakpoint

-- The queue read. `id` is the tiebreak that makes the keyset cursor total; `created_at`
-- alone is not unique and a cursor over it silently skips or repeats rows.
CREATE INDEX "video_content_report_queue_idx" ON "video_content_report" USING btree ("status","created_at","id");--> statement-breakpoint

CREATE INDEX "video_content_report_videoId_idx" ON "video_content_report" USING btree ("video_id","status");--> statement-breakpoint

CREATE UNIQUE INDEX "video_moderation_action_audit_uidx" ON "video_moderation_action" USING btree ("audit_entry_id");--> statement-breakpoint

CREATE INDEX "video_moderation_action_timeline_idx" ON "video_moderation_action" USING btree ("created_at","id");--> statement-breakpoint

CREATE INDEX "video_moderation_action_video_idx" ON "video_moderation_action" USING btree ("video_id","created_at");
