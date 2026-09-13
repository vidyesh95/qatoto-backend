CREATE TABLE "blueprint_content_report" (
	"id" text PRIMARY KEY NOT NULL,
	"target_kind" "blueprint_content_target_kind" NOT NULL,
	"teardown_id" text,
	"case_study_id" text,
	"reason" "blueprint_content_report_reason" NOT NULL,
	"detail_text" text,
	"reporter_user_id" text,
	"status" "blueprint_content_report_status" DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp (3),
	"resolution_note" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "blueprint_content_report_target_ck" CHECK (num_nonnulls(teardown_id, case_study_id) = 1
          AND (target_kind = 'teardown') = (teardown_id IS NOT NULL)
          AND (target_kind = 'case_study') = (case_study_id IS NOT NULL)),
	CONSTRAINT "blueprint_content_report_detail_ck" CHECK (detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000),
	CONSTRAINT "blueprint_content_report_resolution_ck" CHECK ((resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL)
          AND (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 2000))
);
--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD COLUMN "report_id" text;--> statement-breakpoint
ALTER TABLE "blueprint_content_report" ADD CONSTRAINT "blueprint_content_report_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_content_report" ADD CONSTRAINT "blueprint_content_report_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_content_report" ADD CONSTRAINT "blueprint_content_report_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_content_report" ADD CONSTRAINT "blueprint_content_report_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blueprint_content_report_teardown_reporter_uidx" ON "blueprint_content_report" USING btree ("teardown_id","reporter_user_id") WHERE teardown_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "blueprint_content_report_case_study_reporter_uidx" ON "blueprint_content_report" USING btree ("case_study_id","reporter_user_id") WHERE case_study_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "blueprint_content_report_queue_idx" ON "blueprint_content_report" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "blueprint_content_report_target_idx" ON "blueprint_content_report" USING btree ("target_kind","status","created_at","id");--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD CONSTRAINT "blueprint_moderation_action_report_id_blueprint_content_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."blueprint_content_report"("id") ON DELETE set null ON UPDATE no action;