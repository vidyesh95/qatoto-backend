ALTER TABLE "research_program_post" DROP CONSTRAINT "research_program_post_counts_ck";--> statement-breakpoint
ALTER TABLE "research_program_post" ADD COLUMN "trending_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_program_post" ADD COLUMN "trending_scored_at" timestamp;--> statement-breakpoint
CREATE INDEX "research_program_post_trending_idx" ON "research_program_post" USING btree ("program_id","track","trending_score" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE depth = 0 AND NOT is_hidden;--> statement-breakpoint
CREATE INDEX "research_program_post_reaction_created_idx" ON "research_program_post_reaction" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "research_program_post" ADD CONSTRAINT "research_program_post_counts_ck" CHECK (reaction_count >= 0 AND reply_count >= 0 AND trending_score >= 0);