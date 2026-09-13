CREATE TYPE "public"."blueprint_content_target_kind" AS ENUM('teardown', 'case_study');--> statement-breakpoint
CREATE TYPE "public"."blueprint_moderation_action_kind" AS ENUM('content_flagged', 'content_quarantined', 'content_restored');--> statement-breakpoint
CREATE TABLE "blueprint_moderation_action" (
	"id" text PRIMARY KEY NOT NULL,
	"action_kind" "blueprint_moderation_action_kind" NOT NULL,
	"target_kind" "blueprint_content_target_kind" NOT NULL,
	"teardown_id" text,
	"case_study_id" text,
	"moderator_user_id" text NOT NULL,
	"moderator_role_snapshot" text NOT NULL,
	"reason_note" text NOT NULL,
	"audit_entry_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "blueprint_moderation_action_audit_entry_id_unique" UNIQUE("audit_entry_id"),
	CONSTRAINT "blueprint_moderation_action_target_ck" CHECK (num_nonnulls(teardown_id, case_study_id) <= 1
          AND (teardown_id IS NULL OR target_kind = 'teardown')
          AND (case_study_id IS NULL OR target_kind = 'case_study')),
	CONSTRAINT "blueprint_moderation_action_note_ck" CHECK (char_length(reason_note) BETWEEN 1 AND 2000),
	CONSTRAINT "blueprint_moderation_action_quarantine_arm_ck" CHECK (action_kind <> 'content_quarantined' OR target_kind = 'teardown')
);
--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD CONSTRAINT "blueprint_moderation_action_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD CONSTRAINT "blueprint_moderation_action_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD CONSTRAINT "blueprint_moderation_action_moderator_user_id_user_id_fk" FOREIGN KEY ("moderator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blueprint_moderation_action_timeline_idx" ON "blueprint_moderation_action" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "blueprint_moderation_action_moderator_idx" ON "blueprint_moderation_action" USING btree ("moderator_user_id","created_at");--> statement-breakpoint
CREATE INDEX "blueprint_moderation_action_teardown_idx" ON "blueprint_moderation_action" USING btree ("teardown_id","created_at") WHERE teardown_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "blueprint_moderation_action_case_study_idx" ON "blueprint_moderation_action" USING btree ("case_study_id","created_at") WHERE case_study_id IS NOT NULL;