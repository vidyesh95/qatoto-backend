CREATE TYPE "public"."research_category_domain" AS ENUM('infrastructure', 'water_sanitation', 'energy_utilities', 'agriculture_rural', 'transportation_mobility', 'health_care', 'housing_shelter', 'industry_manufacturing');--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'taxonomy_category_classified' BEFORE 'cluster_merge_approved';--> statement-breakpoint
ALTER TABLE "research_category" ADD COLUMN "domain" "research_category_domain";--> statement-breakpoint
ALTER TABLE "research_category" ADD COLUMN "parent_category_id" text;--> statement-breakpoint
ALTER TABLE "research_category" ADD CONSTRAINT "research_category_parent_category_id_research_category_id_fk" FOREIGN KEY ("parent_category_id") REFERENCES "public"."research_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_category_domain_idx" ON "research_category" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "research_category_parentCategoryId_idx" ON "research_category" USING btree ("parent_category_id");--> statement-breakpoint
ALTER TABLE "research_category" ADD CONSTRAINT "research_category_no_self_parent_ck" CHECK (parent_category_id IS DISTINCT FROM id);