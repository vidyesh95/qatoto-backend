ALTER TABLE "blueprint_content_report" DROP CONSTRAINT "blueprint_content_report_target_ck";--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" DROP CONSTRAINT "blueprint_moderation_action_target_ck";--> statement-breakpoint
ALTER TABLE "showcase_launch" DROP CONSTRAINT "showcase_launch_moderation_state_ck";--> statement-breakpoint
ALTER TABLE "showcase_launch" DROP CONSTRAINT "showcase_launch_decision_ck";--> statement-breakpoint
DROP INDEX "showcase_launch_title_live_uidx";--> statement-breakpoint
DROP INDEX "showcase_launch_built_from_idx";--> statement-breakpoint
DROP INDEX "showcase_launch_public_newest_idx";--> statement-breakpoint
ALTER TABLE "blueprint_content_report" ADD COLUMN "showcase_launch_id" text;--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD COLUMN "showcase_launch_id" text;--> statement-breakpoint
ALTER TABLE "blueprint_content_report" ADD CONSTRAINT "blueprint_content_report_showcase_launch_id_showcase_launch_id_fk" FOREIGN KEY ("showcase_launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD CONSTRAINT "blueprint_moderation_action_showcase_launch_id_showcase_launch_id_fk" FOREIGN KEY ("showcase_launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blueprint_content_report_showcase_reporter_uidx" ON "blueprint_content_report" USING btree ("showcase_launch_id","reporter_user_id") WHERE showcase_launch_id IS NOT NULL AND reporter_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "blueprint_moderation_action_showcase_idx" ON "blueprint_moderation_action" USING btree ("showcase_launch_id","created_at") WHERE showcase_launch_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_launch_title_live_uidx" ON "showcase_launch" USING btree ("title_normalized") WHERE moderation_state IN ('pending_review', 'published', 'flagged');--> statement-breakpoint
CREATE INDEX "showcase_launch_built_from_idx" ON "showcase_launch" USING btree ("built_from_blueprint_slug","launched_at" desc,"id") WHERE moderation_state IN ('published', 'flagged') AND built_from_blueprint_slug IS NOT NULL;--> statement-breakpoint
CREATE INDEX "showcase_launch_public_newest_idx" ON "showcase_launch" USING btree ("launched_at" desc,"id") WHERE moderation_state IN ('published', 'flagged');--> statement-breakpoint
ALTER TABLE "blueprint_content_report" ADD CONSTRAINT "blueprint_content_report_target_ck" CHECK (num_nonnulls(teardown_id, case_study_id, showcase_launch_id) = 1
          AND (target_kind = 'teardown') = (teardown_id IS NOT NULL)
          AND (target_kind = 'case_study') = (case_study_id IS NOT NULL)
          AND (target_kind = 'showcase') = (showcase_launch_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "blueprint_moderation_action" ADD CONSTRAINT "blueprint_moderation_action_target_ck" CHECK (num_nonnulls(teardown_id, case_study_id, showcase_launch_id) <= 1
          AND (teardown_id IS NULL OR target_kind = 'teardown')
          AND (case_study_id IS NULL OR target_kind = 'case_study')
          AND (showcase_launch_id IS NULL OR target_kind = 'showcase'));--> statement-breakpoint
ALTER TABLE "showcase_launch" ADD CONSTRAINT "showcase_launch_moderation_state_ck" CHECK (moderation_state IN ('pending_review', 'published', 'rejected', 'flagged'));--> statement-breakpoint
ALTER TABLE "showcase_launch" ADD CONSTRAINT "showcase_launch_decision_ck" CHECK ((moderation_state = 'pending_review') = (reviewed_at IS NULL)
          AND (reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
          AND (moderation_state <> 'pending_review' OR moderator_note IS NULL)
          AND (moderation_state <> 'rejected' OR moderator_note IS NOT NULL)
          AND (public_slug IS NOT NULL) = (moderation_state IN ('published', 'flagged')));