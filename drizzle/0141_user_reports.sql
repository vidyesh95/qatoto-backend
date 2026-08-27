-- ---------------------------------------------------------------------------
-- Profile-text reporting — THE TABLES. Enums landed in 0140.
--
-- WHY THIS EXISTS AT ALL. `0139` made `user.bio` and `user_profile_link` public the moment they are
-- written, which diverges from every other public profile text in this schema — `talent_profile`
-- defaults to `private`, `community_cofounder_profile` to `draft` behind moderation. That divergence
-- is only defensible with a reactive path, and this is it. If these tables are ever dropped, the bio
-- must go back behind a gate.
--
-- ## THE THREE USER REFERENCES ARE THREE DIFFERENT DECISIONS
--
-- `reported_user_id` — `restrict`. `video_content_report` cascades on its video because "a report
-- about a deleted video is noise". A user row is never deleted here: closure is an ANONYMIZATION, so
-- a cascade would be dead code pretending to be a policy. The anonymization manifest keeps this row
-- through an erasure, and the reason matters — if requesting deletion erased the reports filed
-- against you, deletion would be a ban-evasion route.
--
-- `reporter_user_id` — `set null`. A departing reporter must not erase the report they filed; it is
-- evidence about somebody else.
--
-- `resolved_by_user_id` — `restrict`. A moderator cannot be deleted out from under a decision they
-- made.
--
-- ## ONE REPORT PER PERSON PER SUBJECT
--
-- `user_report_reporter_uidx` is partial on `reporter_user_id IS NOT NULL`, because the column is
-- nullable by the `set null` above and two erased reporters are two NULLs, which do not collide
-- anyway. It is what makes `409 ALREADY_REPORTED` honest rather than a silent second row, and what
-- stops a brigading loop inflating the queue.
--
-- ## `user_report_self_ck`
--
-- A person cannot report themselves. The service check produces the readable message; this is what
-- makes the rule true.
-- ---------------------------------------------------------------------------

CREATE TABLE "user_report" (
	"id" text PRIMARY KEY NOT NULL,
	"reported_user_id" text NOT NULL,
	"reason" "user_report_reason" NOT NULL,
	"detail_text" text,
	"reporter_user_id" text,
	"status" "user_report_status" DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp,
	"resolution_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_report_detail_ck" CHECK (detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000),
	CONSTRAINT "user_report_resolution_ck" CHECK ((resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL)),
	CONSTRAINT "user_report_self_ck" CHECK (reported_user_id <> reporter_user_id)
);--> statement-breakpoint

CREATE TABLE "user_moderation_action" (
	"id" text PRIMARY KEY NOT NULL,
	"action_kind" "user_moderation_action_kind" NOT NULL,
	"subject_user_id" text,
	"report_id" text,
	"moderator_user_id" text NOT NULL,
	"moderator_role_snapshot" text NOT NULL,
	"reason_note" text NOT NULL,
	"audit_entry_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_moderation_action_text_ck" CHECK (char_length(reason_note) BETWEEN 1 AND 2000
          AND char_length(moderator_role_snapshot) BETWEEN 1 AND 40)
);--> statement-breakpoint

ALTER TABLE "user_report" ADD CONSTRAINT "user_report_reported_user_id_user_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_report" ADD CONSTRAINT "user_report_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_report" ADD CONSTRAINT "user_report_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "user_moderation_action" ADD CONSTRAINT "user_moderation_action_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_moderation_action" ADD CONSTRAINT "user_moderation_action_report_id_user_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."user_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_moderation_action" ADD CONSTRAINT "user_moderation_action_moderator_user_id_user_id_fk" FOREIGN KEY ("moderator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "user_report_reporter_uidx" ON "user_report" USING btree ("reported_user_id","reporter_user_id") WHERE reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_report_queue_idx" ON "user_report" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "user_report_subject_idx" ON "user_report" USING btree ("reported_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_moderation_action_audit_uidx" ON "user_moderation_action" USING btree ("audit_entry_id");--> statement-breakpoint
CREATE INDEX "user_moderation_action_timeline_idx" ON "user_moderation_action" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "user_moderation_action_subject_idx" ON "user_moderation_action" USING btree ("subject_user_id","created_at");
