ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'problem_cluster_resolved' BEFORE 'discovery_skill_created';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'problem_cluster_reopened' BEFORE 'discovery_skill_created';--> statement-breakpoint
ALTER TYPE "public"."problem_cluster_status" ADD VALUE 'resolved';--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD COLUMN "resolved_by_user_id" text;--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD COLUMN "photos_removed_at" timestamp;--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD CONSTRAINT "problem_cluster_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_cluster" ADD CONSTRAINT "problem_cluster_resolved_ck" CHECK ((status::text = 'resolved') = (resolved_at IS NOT NULL AND resolution_note IS NOT NULL)
          AND (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 2000));