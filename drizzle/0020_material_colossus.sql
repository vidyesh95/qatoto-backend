CREATE TYPE "public"."project_supplier_engagement_status" AS ENUM('considering', 'contacted', 'contracted', 'ended');--> statement-breakpoint
CREATE TYPE "public"."supplier_capability_kind" AS ENUM('manufacturing', 'assembly', 'tooling', 'packaging', 'logistics', 'certification', 'design', 'sourcing');--> statement-breakpoint
CREATE TYPE "public"."supplier_contact_policy" AS ENUM('via_platform', 'direct_email', 'no_contact');--> statement-breakpoint
CREATE TYPE "public"."supplier_verification_state" AS ENUM('unverified', 'documents_pending', 'verified', 'suspended');--> statement-breakpoint
CREATE TABLE "project_supplier_engagement" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"status" "project_supplier_engagement_status" DEFAULT 'considering' NOT NULL,
	"note" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_supplier_engagement_note_ck" CHECK (note IS NULL OR char_length(note) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"region_id" text,
	"verification_state" "supplier_verification_state" DEFAULT 'unverified' NOT NULL,
	"contact_policy" "supplier_contact_policy" DEFAULT 'no_contact' NOT NULL,
	"website_url" text,
	"lead_time_days" integer,
	"minimum_order_quantity" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_slug_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "supplier_name_ck" CHECK (char_length(name) BETWEEN 1 AND 120),
	CONSTRAINT "supplier_summary_ck" CHECK (summary IS NULL OR char_length(summary) <= 2000),
	CONSTRAINT "supplier_quantities_ck" CHECK ((lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650)
          AND (minimum_order_quantity IS NULL OR minimum_order_quantity >= 0)),
	CONSTRAINT "supplier_contact_ck" CHECK (contact_policy <> 'direct_email' OR website_url IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "supplier_capability" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"kind" "supplier_capability_kind" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_capability_slug_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "supplier_capability_label_ck" CHECK (char_length(label) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "supplier_capability_link" (
	"supplier_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_capability_link_supplier_id_capability_id_pk" PRIMARY KEY("supplier_id","capability_id")
);
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "research_project_id" text;--> statement-breakpoint
ALTER TABLE "project_supplier_engagement" ADD CONSTRAINT "project_supplier_engagement_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_supplier_engagement" ADD CONSTRAINT "project_supplier_engagement_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_supplier_engagement" ADD CONSTRAINT "project_supplier_engagement_created_by_member_id_project_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_capability_link" ADD CONSTRAINT "supplier_capability_link_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_capability_link" ADD CONSTRAINT "supplier_capability_link_capability_id_supplier_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."supplier_capability"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_supplier_engagement_project_supplier_unq" ON "project_supplier_engagement" USING btree ("project_id","supplier_id");--> statement-breakpoint
CREATE INDEX "project_supplier_engagement_supplierId_idx" ON "project_supplier_engagement" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_slug_unq" ON "supplier" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "supplier_active_name_idx" ON "supplier" USING btree ("name","id") WHERE is_active;--> statement-breakpoint
CREATE INDEX "supplier_regionId_idx" ON "supplier" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "supplier_verificationState_idx" ON "supplier" USING btree ("verification_state");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_capability_slug_unq" ON "supplier_capability" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "supplier_capability_active_label_idx" ON "supplier_capability" USING btree ("label","id") WHERE is_active;--> statement-breakpoint
CREATE INDEX "supplier_capability_link_capabilityId_idx" ON "supplier_capability_link" USING btree ("capability_id");--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_research_project_id_research_project_id_fk" FOREIGN KEY ("research_project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_log_feed_idx" ON "daily_log" USING btree ("project_id","log_date","submitted_at","id") WHERE status = 'submitted';--> statement-breakpoint
CREATE INDEX "daily_log_ai_summary_chip_kind_logId_idx" ON "daily_log_ai_summary_chip" USING btree ("kind","daily_log_id");--> statement-breakpoint
CREATE INDEX "product_researchProjectId_idx" ON "product" USING btree ("research_project_id") WHERE research_project_id IS NOT NULL;