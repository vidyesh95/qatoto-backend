CREATE TYPE "public"."blueprint_rights_claim_kind" AS ENUM('patent', 'trade_secret', 'copyright_cad', 'trademark');--> statement-breakpoint
CREATE TYPE "public"."blueprint_rights_claim_target_kind" AS ENUM('whole_teardown', 'document', 'manufacturing_file', 'part');--> statement-breakpoint
CREATE TABLE "blueprint_rights_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"claimant_user_id" text,
	"claim_kind" "blueprint_rights_claim_kind" NOT NULL,
	"target_kind" "blueprint_rights_claim_target_kind" NOT NULL,
	"target_id" text,
	"target_title_snapshot" text NOT NULL,
	"claimant_full_name" text,
	"claimant_organization_name" text,
	"claimant_email" text,
	"relationship_to_rights_holder" text,
	"claim_substance" text,
	"sworn_at" timestamp (3) NOT NULL,
	"status" "blueprint_content_report_status" DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp (3),
	"resolution_note" text,
	"claimant_details_purged_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "blueprint_rights_claim_target_ck" CHECK ((target_kind = 'whole_teardown') = (target_id IS NULL)
          AND (target_id IS NULL OR char_length(target_id) BETWEEN 1 AND 200)
          AND char_length(target_title_snapshot) BETWEEN 1 AND 500),
	CONSTRAINT "blueprint_rights_claim_claimant_ck" CHECK ((claimant_full_name IS NULL OR char_length(claimant_full_name) BETWEEN 2 AND 200)
          AND (claimant_organization_name IS NULL OR char_length(claimant_organization_name) BETWEEN 1 AND 200)
          AND (claimant_email IS NULL OR char_length(claimant_email) BETWEEN 3 AND 320)
          AND (relationship_to_rights_holder IS NULL OR char_length(relationship_to_rights_holder) BETWEEN 3 AND 500)
          AND (claim_substance IS NULL OR char_length(claim_substance) BETWEEN 60 AND 5000)),
	CONSTRAINT "blueprint_rights_claim_resolution_ck" CHECK ((resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL)
          AND (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 2000)),
	CONSTRAINT "blueprint_rights_claim_purge_ck" CHECK ((
            claimant_details_purged_at IS NULL
            AND claimant_full_name IS NOT NULL
            AND claimant_email IS NOT NULL
            AND relationship_to_rights_holder IS NOT NULL
            AND claim_substance IS NOT NULL
          ) OR (
            claimant_details_purged_at IS NOT NULL
            AND resolved_at IS NOT NULL
            AND claimant_full_name IS NULL
            AND claimant_organization_name IS NULL
            AND claimant_email IS NULL
            AND relationship_to_rights_holder IS NULL
            AND claim_substance IS NULL
            AND resolution_note IS NULL
          ))
);
--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD COLUMN "rights_claim_id" text;--> statement-breakpoint
ALTER TABLE "blueprint_rights_claim" ADD CONSTRAINT "blueprint_rights_claim_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_rights_claim" ADD CONSTRAINT "blueprint_rights_claim_claimant_user_id_user_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_rights_claim" ADD CONSTRAINT "blueprint_rights_claim_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blueprint_rights_claim_open_claimant_target_uidx" ON "blueprint_rights_claim" USING btree ("teardown_id","claimant_user_id","target_kind",coalesce("target_id", '')) WHERE status = 'open' AND claimant_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "blueprint_rights_claim_queue_idx" ON "blueprint_rights_claim" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "blueprint_rights_claim_teardown_idx" ON "blueprint_rights_claim" USING btree ("teardown_id","status");--> statement-breakpoint
CREATE INDEX "blueprint_rights_claim_purge_idx" ON "blueprint_rights_claim" USING btree ("resolved_at") WHERE resolved_at IS NOT NULL AND claimant_details_purged_at IS NULL;--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD CONSTRAINT "blueprint_moderation_action_rights_claim_id_blueprint_rights_claim_id_fk" FOREIGN KEY ("rights_claim_id") REFERENCES "public"."blueprint_rights_claim"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blueprint_moderation_action_rights_claim_idx" ON "blueprint_moderation_action" USING btree ("rights_claim_id") WHERE rights_claim_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD CONSTRAINT "blueprint_moderation_action_answered_ck" CHECK (num_nonnulls(report_id, rights_claim_id) <= 1
          AND (rights_claim_id IS NULL OR target_kind = 'teardown'));