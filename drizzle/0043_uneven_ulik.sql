CREATE TYPE "public"."commerce_provider_kind_slug" AS ENUM('freight_forwarder', 'logistics_operator', 'customs_broker', 'insurance_provider', 'inspection_agency', 'testing_certification_lab', 'marketing_agency', 'warehouse_provider', 'foreign_exchange_facilitator');--> statement-breakpoint
CREATE TYPE "public"."commerce_provider_verification_state" AS ENUM('unverified', 'documents_pending', 'verified', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."commerce_service_offering_state" AS ENUM('draft', 'pending_review', 'active', 'suspended', 'retired');--> statement-breakpoint
CREATE TYPE "public"."commerce_service_pricing_model" AS ENUM('quote_only', 'fixed_fee', 'per_unit', 'subscription');--> statement-breakpoint
CREATE TYPE "public"."freight_transport_mode" AS ENUM('air', 'sea', 'land', 'rail', 'multimodal');--> statement-breakpoint
CREATE TYPE "public"."product_moderation_state" AS ENUM('pending', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."product_sample_policy" AS ENUM('unavailable', 'paid', 'refundable');--> statement-breakpoint
CREATE TYPE "public"."store_merchandising_entity_kind" AS ENUM('product', 'category', 'organization', 'provider_offering');--> statement-breakpoint
CREATE TYPE "public"."store_merchandising_state" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."store_presentation_accent" AS ENUM('amber', 'slate', 'emerald', 'sky', 'rose');--> statement-breakpoint
CREATE TYPE "public"."store_rail_strategy" AS ENUM('curated', 'newest', 'trending_placeholder');--> statement-breakpoint
CREATE TYPE "public"."store_search_document_kind" AS ENUM('product', 'provider_offering');--> statement-breakpoint
CREATE TABLE "commerce_product_specification" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"specification_key" text NOT NULL,
	"specification_value" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_product_specification_lengths_ck" CHECK (char_length(specification_key) BETWEEN 1 AND 80
          AND char_length(specification_value) BETWEEN 1 AND 500),
	CONSTRAINT "commerce_product_specification_position_ck" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_provider_kind" (
	"slug" "commerce_provider_kind_slug" PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"summary" text,
	"sibling_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_provider_kind_label_ck" CHECK (char_length(label) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "commerce_provider_kind_link" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider_kind" "commerce_provider_kind_slug" NOT NULL,
	"verification_state" "commerce_provider_verification_state" DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_provider_profile" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"public_summary" text,
	"support_policy" text,
	"verification_state" "commerce_provider_verification_state" DEFAULT 'unverified' NOT NULL,
	"accepting_requests" boolean DEFAULT true NOT NULL,
	"service_region_summary" text,
	"average_response_time_hours" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_provider_profile_text_ck" CHECK ((public_summary IS NULL OR char_length(public_summary) <= 4000)
          AND (support_policy IS NULL OR char_length(support_policy) <= 4000)
          AND (service_region_summary IS NULL OR char_length(service_region_summary) <= 1000)),
	CONSTRAINT "commerce_provider_profile_response_ck" CHECK (average_response_time_hours IS NULL OR average_response_time_hours BETWEEN 0 AND 8760)
);
--> statement-breakpoint
CREATE TABLE "commerce_service_coverage" (
	"id" text PRIMARY KEY NOT NULL,
	"offering_id" text NOT NULL,
	"origin_country_code" text,
	"destination_country_code" text,
	"origin_region_label" text,
	"destination_region_label" text,
	"location_identifier" text,
	"supports_hazardous_goods" boolean DEFAULT false NOT NULL,
	"supports_consolidation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_service_coverage_country_ck" CHECK ((origin_country_code IS NULL OR origin_country_code ~ '^[A-Z]{2}$')
          AND (destination_country_code IS NULL OR destination_country_code ~ '^[A-Z]{2}$'))
);
--> statement-breakpoint
CREATE TABLE "commerce_service_offering" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"provider_organization_id" text NOT NULL,
	"provider_kind" "commerce_provider_kind_slug" NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"state" "commerce_service_offering_state" DEFAULT 'draft' NOT NULL,
	"pricing_model" "commerce_service_pricing_model" NOT NULL,
	"indicative_price_min_in_cents" integer,
	"indicative_price_max_in_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"minimum_lead_time_days" integer,
	"maximum_lead_time_days" integer,
	"moderated_by_user_id" text,
	"moderated_at" timestamp,
	"moderation_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_service_offering_slug_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 120),
	CONSTRAINT "commerce_service_offering_title_ck" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "commerce_service_offering_summary_ck" CHECK (summary IS NULL OR char_length(summary) <= 4000),
	CONSTRAINT "commerce_service_offering_price_ck" CHECK ((indicative_price_min_in_cents IS NULL AND indicative_price_max_in_cents IS NULL)
          OR (indicative_price_min_in_cents IS NOT NULL AND indicative_price_max_in_cents IS NOT NULL
              AND indicative_price_min_in_cents >= 0
              AND indicative_price_max_in_cents >= indicative_price_min_in_cents)),
	CONSTRAINT "commerce_service_offering_lead_ck" CHECK ((minimum_lead_time_days IS NULL AND maximum_lead_time_days IS NULL)
          OR (minimum_lead_time_days IS NOT NULL AND maximum_lead_time_days IS NOT NULL
              AND minimum_lead_time_days >= 0
              AND maximum_lead_time_days >= minimum_lead_time_days
              AND maximum_lead_time_days <= 3650)),
	CONSTRAINT "commerce_service_offering_currency_ck" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "customs_brokerage_offering_detail" (
	"offering_id" text PRIMARY KEY NOT NULL,
	"jurisdictions" text[] DEFAULT '{}' NOT NULL,
	"import_supported" boolean DEFAULT true NOT NULL,
	"export_supported" boolean DEFAULT true NOT NULL,
	"commodity_coverage_summary" text,
	CONSTRAINT "customs_brokerage_offering_detail_summary_ck" CHECK (commodity_coverage_summary IS NULL OR char_length(commodity_coverage_summary) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "foreign_exchange_offering_detail" (
	"offering_id" text PRIMARY KEY NOT NULL,
	"currency_pairs" text[] DEFAULT '{}' NOT NULL,
	"settlement_rails" text[] DEFAULT '{}' NOT NULL,
	"minimum_notional_in_cents" integer,
	"maximum_notional_in_cents" integer,
	"notional_currency" text DEFAULT 'USD' NOT NULL,
	CONSTRAINT "foreign_exchange_offering_detail_currency_ck" CHECK (notional_currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "foreign_exchange_offering_detail_notional_ck" CHECK ((minimum_notional_in_cents IS NULL AND maximum_notional_in_cents IS NULL)
          OR (minimum_notional_in_cents IS NOT NULL AND maximum_notional_in_cents IS NOT NULL
              AND minimum_notional_in_cents >= 0
              AND maximum_notional_in_cents >= minimum_notional_in_cents))
);
--> statement-breakpoint
CREATE TABLE "freight_offering_detail" (
	"offering_id" text PRIMARY KEY NOT NULL,
	"transport_modes" "freight_transport_mode"[] DEFAULT '{}' NOT NULL,
	"supports_consolidation" boolean DEFAULT false NOT NULL,
	"supports_containers" boolean DEFAULT false NOT NULL,
	"supports_hazardous_goods" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection_offering_detail" (
	"offering_id" text PRIMARY KEY NOT NULL,
	"pre_production" boolean DEFAULT false NOT NULL,
	"during_production" boolean DEFAULT false NOT NULL,
	"pre_shipment" boolean DEFAULT false NOT NULL,
	"loading_supervision" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_offering_detail" (
	"offering_id" text PRIMARY KEY NOT NULL,
	"cargo_coverage_classes" text[] DEFAULT '{}' NOT NULL,
	"coverage_limit_min_in_cents" integer,
	"coverage_limit_max_in_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exclusions_document_reference" text,
	CONSTRAINT "insurance_offering_detail_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "insurance_offering_detail_limits_ck" CHECK ((coverage_limit_min_in_cents IS NULL AND coverage_limit_max_in_cents IS NULL)
          OR (coverage_limit_min_in_cents IS NOT NULL AND coverage_limit_max_in_cents IS NOT NULL
              AND coverage_limit_min_in_cents >= 0
              AND coverage_limit_max_in_cents >= coverage_limit_min_in_cents))
);
--> statement-breakpoint
CREATE TABLE "marketing_offering_detail" (
	"offering_id" text PRIMARY KEY NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"target_regions" text[] DEFAULT '{}' NOT NULL,
	"language_capabilities" text[] DEFAULT '{}' NOT NULL,
	"engagement_model" text,
	CONSTRAINT "marketing_offering_detail_engagement_ck" CHECK (engagement_model IS NULL OR char_length(engagement_model) <= 200)
);
--> statement-breakpoint
CREATE TABLE "store_hero_slide" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"accent" "store_presentation_accent" DEFAULT 'slate' NOT NULL,
	"image_url" text,
	"link_target_kind" "store_merchandising_entity_kind",
	"link_target_id" text,
	"link_target_slug" text,
	"sibling_order" integer NOT NULL,
	"state" "store_merchandising_state" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "store_hero_slide_title_ck" CHECK (char_length(title) BETWEEN 1 AND 120),
	CONSTRAINT "store_hero_slide_subtitle_ck" CHECK (subtitle IS NULL OR char_length(subtitle) BETWEEN 1 AND 280),
	CONSTRAINT "store_hero_slide_image_ck" CHECK (image_url IS NULL OR (char_length(image_url) <= 2048 AND image_url LIKE 'https://%')),
	CONSTRAINT "store_hero_slide_window_ck" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "store_pathway" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"accent" "store_presentation_accent" DEFAULT 'slate' NOT NULL,
	"state" "store_merchandising_state" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "store_pathway_slug_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 100),
	CONSTRAINT "store_pathway_title_ck" CHECK (char_length(title) BETWEEN 1 AND 120),
	CONSTRAINT "store_pathway_summary_ck" CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 500),
	CONSTRAINT "store_pathway_window_ck" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "store_pathway_item" (
	"id" text PRIMARY KEY NOT NULL,
	"pathway_id" text NOT NULL,
	"entity_kind" "store_merchandising_entity_kind" NOT NULL,
	"entity_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "store_pathway_item_position_ck" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_rail" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"strategy" "store_rail_strategy" NOT NULL,
	"state" "store_merchandising_state" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "store_rail_slug_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 100),
	CONSTRAINT "store_rail_title_ck" CHECK (char_length(title) BETWEEN 1 AND 120),
	CONSTRAINT "store_rail_window_ck" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "store_rail_placement" (
	"id" text PRIMARY KEY NOT NULL,
	"rail_id" text NOT NULL,
	"entity_kind" "store_merchandising_entity_kind" NOT NULL,
	"entity_id" text NOT NULL,
	"position" integer NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "store_rail_placement_position_ck" CHECK (position >= 0),
	CONSTRAINT "store_rail_placement_window_ck" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "store_search_document" (
	"id" text PRIMARY KEY NOT NULL,
	"document_kind" "store_search_document_kind" NOT NULL,
	"entity_id" text NOT NULL,
	"public_slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"organization_id" text NOT NULL,
	"organization_slug" text NOT NULL,
	"organization_display_name" text NOT NULL,
	"organization_country_code" text NOT NULL,
	"category_id" text,
	"category_slug" text,
	"provider_kind" "commerce_provider_kind_slug",
	"price_in_cents" integer,
	"currency" text,
	"minimum_order_quantity" integer,
	"search_text" text NOT NULL,
	"is_eligible" boolean DEFAULT true NOT NULL,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "store_search_document_slug_ck" CHECK (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND organization_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "store_search_document_country_ck" CHECK (organization_country_code ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "testing_certification_offering_detail" (
	"offering_id" text PRIMARY KEY NOT NULL,
	"standards" text[] DEFAULT '{}' NOT NULL,
	"accreditation_bodies" text[] DEFAULT '{}' NOT NULL,
	"laboratory_locations" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse_offering_detail" (
	"offering_id" text PRIMARY KEY NOT NULL,
	"storage_types" text[] DEFAULT '{}' NOT NULL,
	"temperature_controlled" boolean DEFAULT false NOT NULL,
	"bonded_status" boolean DEFAULT false NOT NULL,
	"capacity_units" text,
	CONSTRAINT "warehouse_offering_detail_capacity_ck" CHECK (capacity_units IS NULL OR char_length(capacity_units) <= 80)
);
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "model_number" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "country_of_origin_code" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "unit_of_measure" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "sample_policy" "product_sample_policy" DEFAULT 'unavailable' NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "sample_price_in_cents" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "lead_time_min_days" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "lead_time_max_days" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "moderation_state" "product_moderation_state" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier" ADD COLUMN "commerce_organization_id" text;--> statement-breakpoint
ALTER TABLE "commerce_product_specification" ADD CONSTRAINT "commerce_product_specification_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_provider_kind_link" ADD CONSTRAINT "commerce_provider_kind_link_organization_id_commerce_provider_profile_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_provider_profile"("organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_provider_kind_link" ADD CONSTRAINT "commerce_provider_kind_link_provider_kind_commerce_provider_kind_slug_fk" FOREIGN KEY ("provider_kind") REFERENCES "public"."commerce_provider_kind"("slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_provider_profile" ADD CONSTRAINT "commerce_provider_profile_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_coverage" ADD CONSTRAINT "commerce_service_coverage_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_offering" ADD CONSTRAINT "commerce_service_offering_provider_organization_id_commerce_provider_profile_organization_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."commerce_provider_profile"("organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_offering" ADD CONSTRAINT "commerce_service_offering_provider_kind_commerce_provider_kind_slug_fk" FOREIGN KEY ("provider_kind") REFERENCES "public"."commerce_provider_kind"("slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_offering" ADD CONSTRAINT "commerce_service_offering_moderated_by_user_id_user_id_fk" FOREIGN KEY ("moderated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_brokerage_offering_detail" ADD CONSTRAINT "customs_brokerage_offering_detail_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_exchange_offering_detail" ADD CONSTRAINT "foreign_exchange_offering_detail_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_offering_detail" ADD CONSTRAINT "freight_offering_detail_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_offering_detail" ADD CONSTRAINT "inspection_offering_detail_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_offering_detail" ADD CONSTRAINT "insurance_offering_detail_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_offering_detail" ADD CONSTRAINT "marketing_offering_detail_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_pathway_item" ADD CONSTRAINT "store_pathway_item_pathway_id_store_pathway_id_fk" FOREIGN KEY ("pathway_id") REFERENCES "public"."store_pathway"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_rail_placement" ADD CONSTRAINT "store_rail_placement_rail_id_store_rail_id_fk" FOREIGN KEY ("rail_id") REFERENCES "public"."store_rail"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_search_document" ADD CONSTRAINT "store_search_document_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_search_document" ADD CONSTRAINT "store_search_document_category_id_commerce_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."commerce_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_certification_offering_detail" ADD CONSTRAINT "testing_certification_offering_detail_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_offering_detail" ADD CONSTRAINT "warehouse_offering_detail_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_product_specification_productId_idx" ON "commerce_product_specification" USING btree ("product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_specification_product_key_uidx" ON "commerce_product_specification" USING btree ("product_id","specification_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_provider_kind_order_uidx" ON "commerce_provider_kind" USING btree ("sibling_order");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_provider_kind_link_org_kind_uidx" ON "commerce_provider_kind_link" USING btree ("organization_id","provider_kind");--> statement-breakpoint
CREATE INDEX "commerce_provider_kind_link_kind_idx" ON "commerce_provider_kind_link" USING btree ("provider_kind","verification_state");--> statement-breakpoint
CREATE INDEX "commerce_provider_profile_verification_idx" ON "commerce_provider_profile" USING btree ("verification_state");--> statement-breakpoint
CREATE INDEX "commerce_service_coverage_offering_idx" ON "commerce_service_coverage" USING btree ("offering_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_service_offering_slug_uidx" ON "commerce_service_offering" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "commerce_service_offering_provider_idx" ON "commerce_service_offering" USING btree ("provider_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_service_offering_kind_state_idx" ON "commerce_service_offering" USING btree ("provider_kind","state","id");--> statement-breakpoint
CREATE INDEX "store_hero_slide_state_order_idx" ON "store_hero_slide" USING btree ("state","sibling_order","id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_pathway_slug_uidx" ON "store_pathway" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "store_pathway_state_idx" ON "store_pathway" USING btree ("state","id");--> statement-breakpoint
CREATE INDEX "store_pathway_item_pathway_idx" ON "store_pathway_item" USING btree ("pathway_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "store_pathway_item_unique_uidx" ON "store_pathway_item" USING btree ("pathway_id","entity_kind","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_rail_slug_uidx" ON "store_rail" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "store_rail_state_idx" ON "store_rail" USING btree ("state","id");--> statement-breakpoint
CREATE INDEX "store_rail_placement_rail_idx" ON "store_rail_placement" USING btree ("rail_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "store_rail_placement_unique_uidx" ON "store_rail_placement" USING btree ("rail_id","entity_kind","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_search_document_kind_entity_uidx" ON "store_search_document" USING btree ("document_kind","entity_id");--> statement-breakpoint
CREATE INDEX "store_search_document_eligible_title_idx" ON "store_search_document" USING btree ("is_eligible","title","id") WHERE is_eligible;--> statement-breakpoint
CREATE INDEX "store_search_document_organization_idx" ON "store_search_document" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "store_search_document_category_idx" ON "store_search_document" USING btree ("category_id","id");--> statement-breakpoint
CREATE INDEX "store_search_document_provider_kind_idx" ON "store_search_document" USING btree ("provider_kind","id");--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_commerce_organization_id_commerce_organization_id_fk" FOREIGN KEY ("commerce_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_moderationState_idx" ON "product" USING btree ("moderation_state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_publicSlug_uidx" ON "product" USING btree ("public_slug") WHERE public_slug IS NOT NULL;--> statement-breakpoint
CREATE INDEX "supplier_commerceOrganizationId_idx" ON "supplier" USING btree ("commerce_organization_id") WHERE commerce_organization_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_public_slug_ck" CHECK (public_slug IS NULL OR (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(public_slug) BETWEEN 3 AND 120));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_origin_ck" CHECK (country_of_origin_code IS NULL OR country_of_origin_code ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_sample_price_ck" CHECK ((sample_price_in_cents IS NULL OR sample_price_in_cents > 0)
          AND (sample_policy <> 'unavailable' OR sample_price_in_cents IS NULL));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_lead_time_ck" CHECK ((lead_time_min_days IS NULL AND lead_time_max_days IS NULL)
          OR (lead_time_min_days IS NOT NULL AND lead_time_max_days IS NOT NULL
              AND lead_time_min_days >= 0 AND lead_time_max_days >= lead_time_min_days
              AND lead_time_max_days <= 3650));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_model_unit_ck" CHECK ((model_number IS NULL OR char_length(model_number) BETWEEN 1 AND 120)
          AND (unit_of_measure IS NULL OR char_length(unit_of_measure) BETWEEN 1 AND 40));--> statement-breakpoint
INSERT INTO "commerce_provider_kind" ("slug", "label", "summary", "sibling_order") VALUES
  ('freight_forwarder', 'Freight forwarder', 'Multimodal freight coordination', 1),
  ('logistics_operator', 'Logistics operator', 'Air, sea, land, and rail operators', 2),
  ('customs_broker', 'Customs broker', 'Import and export customs brokerage', 3),
  ('insurance_provider', 'Insurance provider', 'Cargo and trade insurance', 4),
  ('inspection_agency', 'Inspection agency', 'Production and pre-shipment inspection', 5),
  ('testing_certification_lab', 'Testing and certification lab', 'Standards testing and certification', 6),
  ('marketing_agency', 'Marketing agency', 'Trade marketing and demand generation', 7),
  ('warehouse_provider', 'Warehouse provider', 'Bonded and temperature-controlled storage', 8),
  ('foreign_exchange_facilitator', 'Foreign exchange facilitator', 'Currency pairs and settlement rails', 9)
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
UPDATE "product" AS target
SET
  "moderation_state" = 'approved',
  "public_slug" = COALESCE(
    target.public_slug,
    TRIM(BOTH '-' FROM regexp_replace(
      lower(regexp_replace(COALESCE(NULLIF(trim(target.title), ''), 'product'), '[^a-z0-9]+', '-', 'g')),
      '-+',
      '-',
      'g'
    )) || '-' || substr(replace(target.id, '-', ''), 1, 8)
  )
WHERE target.status = 'active'
  AND target.seller_organization_id IS NOT NULL
  AND (target.public_slug IS NULL OR target.moderation_state = 'pending');
