CREATE TYPE "public"."comtrade_sync_status" AS ENUM('succeeded', 'failed', 'skipped_unconfigured');--> statement-breakpoint
CREATE TYPE "public"."domestic_substitute_kind" AS ENUM('direct_material_substitute', 'alternative_material', 'domestic_component', 'process_change');--> statement-breakpoint
CREATE TYPE "public"."domestic_substitute_maturity" AS ENUM('lab_scale', 'pilot_scale', 'commercial', 'mature');--> statement-breakpoint
CREATE TYPE "public"."import_commodity_kind" AS ENUM('agricultural_product', 'food_product', 'mineral_ceramic', 'energy_fuel', 'chemical', 'pharmaceutical', 'plastic_rubber', 'wood_paper', 'textile_leather', 'precious_material', 'metal', 'machinery', 'electronic_subassembly', 'transport_equipment', 'precision_instrument', 'other_manufactured');--> statement-breakpoint
CREATE TYPE "public"."import_quantity_unit" AS ENUM('not_applicable', 'square_metres', 'thousand_kilowatt_hours', 'metres', 'units', 'pairs', 'litres', 'kilograms', 'cubic_metres', 'carats');--> statement-breakpoint
CREATE TYPE "public"."localization_narrative_status" AS ENUM('pending', 'generated', 'skipped_unconfigured', 'failed');--> statement-breakpoint
CREATE TYPE "public"."localization_pathway_status" AS ENUM('open', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."trade_data_origin" AS ENUM('comtrade_api', 'admin_upload', 'seeded_fixture');--> statement-breakpoint
CREATE TYPE "public"."trade_flow_kind" AS ENUM('import', 'export');--> statement-breakpoint
CREATE TYPE "public"."trade_period_kind" AS ENUM('annual', 'monthly');--> statement-breakpoint
CREATE TABLE "commodity_trade_flow" (
	"id" text PRIMARY KEY NOT NULL,
	"commodity_id" text NOT NULL,
	"reporter_region_id" text NOT NULL,
	"partner_region_id" text,
	"flow_kind" "trade_flow_kind" NOT NULL,
	"period_kind" "trade_period_kind" NOT NULL,
	"period_starts_date" date NOT NULL,
	"period_ends_date" date NOT NULL,
	"trade_value_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"net_weight_milli_kilograms" bigint,
	"quantity_milli" bigint,
	"quantity_unit" "import_quantity_unit" NOT NULL,
	"quantity_unit_code" integer NOT NULL,
	"is_reported" boolean NOT NULL,
	"is_aggregate" boolean NOT NULL,
	"is_net_weight_estimated" boolean NOT NULL,
	"is_quantity_estimated" boolean NOT NULL,
	"legacy_estimation_flag" integer,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_retrieved_at" timestamp NOT NULL,
	"data_origin" "trade_data_origin" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commodity_trade_flow_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commodity_trade_flow_period_ck" CHECK (period_ends_date > period_starts_date),
	CONSTRAINT "commodity_trade_flow_magnitudes_ck" CHECK (trade_value_in_cents >= 0
          AND (net_weight_milli_kilograms IS NULL OR net_weight_milli_kilograms >= 0)
          AND (quantity_milli IS NULL OR quantity_milli >= 0)),
	CONSTRAINT "commodity_trade_flow_estimation_ck" CHECK ((net_weight_milli_kilograms IS NOT NULL OR is_net_weight_estimated = false)
          AND (quantity_milli IS NOT NULL OR is_quantity_estimated = false)),
	CONSTRAINT "commodity_trade_flow_source_ck" CHECK (char_length(source_name) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "comtrade_sync_run" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_region_id" text NOT NULL,
	"period_year" integer NOT NULL,
	"flow_kind" "trade_flow_kind" NOT NULL,
	"status" "comtrade_sync_status" NOT NULL,
	"requested_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"rows_fetched" integer DEFAULT 0 NOT NULL,
	"rows_upserted" integer DEFAULT 0 NOT NULL,
	"error_detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "comtrade_sync_run_period_ck" CHECK (period_year BETWEEN 1962 AND 2100),
	CONSTRAINT "comtrade_sync_run_counts_ck" CHECK (rows_fetched >= 0 AND rows_upserted >= 0),
	CONSTRAINT "comtrade_sync_run_completion_ck" CHECK ((status <> 'succeeded' OR completed_at IS NOT NULL)
          AND (error_detail IS NULL OR char_length(error_detail) BETWEEN 1 AND 2000))
);
--> statement-breakpoint
CREATE TABLE "domestic_substitute_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"commodity_id" text NOT NULL,
	"region_id" text NOT NULL,
	"substitute_kind" "domestic_substitute_kind" NOT NULL,
	"substitute_label" text NOT NULL,
	"substitute_notes" text,
	"supplier_capability_id" text,
	"maturity_level" "domestic_substitute_maturity" NOT NULL,
	"evidence_source_name" text,
	"evidence_source_url" text,
	"published_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "domestic_substitute_mapping_label_ck" CHECK (char_length(substitute_label) BETWEEN 1 AND 200),
	CONSTRAINT "domestic_substitute_mapping_notes_ck" CHECK (substitute_notes IS NULL OR char_length(substitute_notes) <= 4000),
	CONSTRAINT "domestic_substitute_mapping_evidence_ck" CHECK ((evidence_source_name IS NULL OR char_length(evidence_source_name) BETWEEN 1 AND 200)
          AND (evidence_source_url IS NULL OR evidence_source_name IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "import_commodity" (
	"id" text PRIMARY KEY NOT NULL,
	"hs_code" text NOT NULL,
	"label" text NOT NULL,
	"description_text" text,
	"commodity_kind" "import_commodity_kind" NOT NULL,
	"research_category_id" text NOT NULL,
	"default_quantity_unit" "import_quantity_unit" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "import_commodity_hsCode_ck" CHECK (hs_code ~ '^[0-9]{6}$'),
	CONSTRAINT "import_commodity_label_ck" CHECK (char_length(label) BETWEEN 1 AND 400),
	CONSTRAINT "import_commodity_description_ck" CHECK (description_text IS NULL OR char_length(description_text) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "localization_assessment" (
	"id" text PRIMARY KEY NOT NULL,
	"as_of" timestamp NOT NULL,
	"window_starts_at" timestamp NOT NULL,
	"window_ends_at" timestamp NOT NULL,
	"commodity_id" text NOT NULL,
	"region_id" text NOT NULL,
	"feasibility_score_points" integer NOT NULL,
	"rank" integer NOT NULL,
	"trend_direction" "trend_direction" NOT NULL,
	"previous_feasibility_score_points" integer,
	"import_dependency_points" integer NOT NULL,
	"export_capability_points" integer NOT NULL,
	"substitute_availability_points" integer NOT NULL,
	"supplier_capacity_points" integer NOT NULL,
	"lead_time_advantage_points" integer NOT NULL,
	"observed_import_value_in_cents" bigint NOT NULL,
	"observed_export_value_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"substitute_count" integer NOT NULL,
	"matched_supplier_count" integer NOT NULL,
	"verified_supplier_count" integer NOT NULL,
	"median_supplier_lead_time_days" integer,
	"narrative_status" "localization_narrative_status" DEFAULT 'pending' NOT NULL,
	"score_algorithm_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "localization_assessment_rank_ck" CHECK (rank >= 1),
	CONSTRAINT "localization_assessment_score_ck" CHECK (feasibility_score_points BETWEEN 0 AND 100
          AND (previous_feasibility_score_points IS NULL
               OR previous_feasibility_score_points BETWEEN 0 AND 100)),
	CONSTRAINT "localization_assessment_window_ck" CHECK (window_ends_at > window_starts_at AND as_of >= window_ends_at),
	CONSTRAINT "localization_assessment_components_ck" CHECK (import_dependency_points BETWEEN 0 AND 35
          AND export_capability_points BETWEEN 0 AND 25
          AND substitute_availability_points BETWEEN 0 AND 20
          AND supplier_capacity_points BETWEEN 0 AND 12
          AND lead_time_advantage_points BETWEEN 0 AND 8
          AND import_dependency_points + export_capability_points
              + substitute_availability_points + supplier_capacity_points
              + lead_time_advantage_points = feasibility_score_points),
	CONSTRAINT "localization_assessment_inputs_ck" CHECK (observed_import_value_in_cents >= 0 AND observed_export_value_in_cents >= 0
          AND substitute_count >= 0 AND matched_supplier_count >= 0
          AND verified_supplier_count >= 0
          AND verified_supplier_count <= matched_supplier_count
          AND (median_supplier_lead_time_days IS NULL
               OR median_supplier_lead_time_days BETWEEN 0 AND 3650)
          AND currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "localization_assessment_trend_agreement_ck" CHECK (previous_feasibility_score_points IS NULL
          OR (trend_direction = 'up'
              AND feasibility_score_points > previous_feasibility_score_points)
          OR (trend_direction = 'down'
              AND feasibility_score_points < previous_feasibility_score_points)
          OR (trend_direction = 'flat'
              AND feasibility_score_points = previous_feasibility_score_points))
);
--> statement-breakpoint
CREATE TABLE "localization_pathway_suggestion" (
	"id" text PRIMARY KEY NOT NULL,
	"assessment_id" text NOT NULL,
	"title" text NOT NULL,
	"body_text" text NOT NULL,
	"status" "localization_pathway_status" DEFAULT 'open' NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text,
	"prompt_version" text NOT NULL,
	"confidence_bps" integer,
	"as_of" timestamp NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "localization_pathway_suggestion_text_ck" CHECK (char_length(title) BETWEEN 1 AND 200 AND char_length(body_text) BETWEEN 1 AND 6000),
	CONSTRAINT "localization_pathway_suggestion_confidence_ck" CHECK (confidence_bps IS NULL OR confidence_bps BETWEEN 0 AND 10000),
	CONSTRAINT "localization_pathway_suggestion_decision_ck" CHECK ((status = 'open') = (decided_at IS NULL)
          AND (decided_at IS NULL) = (decided_by_user_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE "commodity_trade_flow" ADD CONSTRAINT "commodity_trade_flow_commodity_id_import_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."import_commodity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commodity_trade_flow" ADD CONSTRAINT "commodity_trade_flow_reporter_region_id_discovery_region_id_fk" FOREIGN KEY ("reporter_region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commodity_trade_flow" ADD CONSTRAINT "commodity_trade_flow_partner_region_id_discovery_region_id_fk" FOREIGN KEY ("partner_region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comtrade_sync_run" ADD CONSTRAINT "comtrade_sync_run_reporter_region_id_discovery_region_id_fk" FOREIGN KEY ("reporter_region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domestic_substitute_mapping" ADD CONSTRAINT "domestic_substitute_mapping_commodity_id_import_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."import_commodity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domestic_substitute_mapping" ADD CONSTRAINT "domestic_substitute_mapping_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domestic_substitute_mapping" ADD CONSTRAINT "domestic_substitute_mapping_supplier_capability_id_supplier_capability_id_fk" FOREIGN KEY ("supplier_capability_id") REFERENCES "public"."supplier_capability"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domestic_substitute_mapping" ADD CONSTRAINT "domestic_substitute_mapping_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_commodity" ADD CONSTRAINT "import_commodity_research_category_id_research_category_id_fk" FOREIGN KEY ("research_category_id") REFERENCES "public"."research_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "localization_assessment" ADD CONSTRAINT "localization_assessment_commodity_id_import_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."import_commodity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "localization_assessment" ADD CONSTRAINT "localization_assessment_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "localization_pathway_suggestion" ADD CONSTRAINT "localization_pathway_suggestion_assessment_id_localization_assessment_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."localization_assessment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "localization_pathway_suggestion" ADD CONSTRAINT "localization_pathway_suggestion_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commodity_trade_flow_partnered_unq" ON "commodity_trade_flow" USING btree ("commodity_id","reporter_region_id","partner_region_id","flow_kind","period_kind","period_starts_date") WHERE partner_region_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commodity_trade_flow_aggregate_unq" ON "commodity_trade_flow" USING btree ("commodity_id","reporter_region_id","flow_kind","period_kind","period_starts_date") WHERE partner_region_id IS NULL;--> statement-breakpoint
CREATE INDEX "commodity_trade_flow_commodity_period_idx" ON "commodity_trade_flow" USING btree ("commodity_id","flow_kind","period_starts_date","id");--> statement-breakpoint
CREATE INDEX "commodity_trade_flow_reporter_period_idx" ON "commodity_trade_flow" USING btree ("reporter_region_id","period_kind","period_starts_date","flow_kind");--> statement-breakpoint
CREATE INDEX "comtrade_sync_run_cell_requestedAt_idx" ON "comtrade_sync_run" USING btree ("reporter_region_id","period_year","flow_kind","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domestic_substitute_mapping_cell_label_unq" ON "domestic_substitute_mapping" USING btree ("commodity_id","region_id","substitute_label");--> statement-breakpoint
CREATE INDEX "domestic_substitute_mapping_published_idx" ON "domestic_substitute_mapping" USING btree ("commodity_id","region_id","id") WHERE published_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "domestic_substitute_mapping_supplierCapabilityId_idx" ON "domestic_substitute_mapping" USING btree ("supplier_capability_id") WHERE supplier_capability_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "import_commodity_hsCode_unq" ON "import_commodity" USING btree ("hs_code");--> statement-breakpoint
CREATE INDEX "import_commodity_active_label_idx" ON "import_commodity" USING btree ("label","id") WHERE is_active;--> statement-breakpoint
CREATE INDEX "import_commodity_kind_idx" ON "import_commodity" USING btree ("commodity_kind");--> statement-breakpoint
CREATE INDEX "import_commodity_researchCategoryId_idx" ON "import_commodity" USING btree ("research_category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "localization_assessment_asOf_cell_unq" ON "localization_assessment" USING btree ("as_of","commodity_id","region_id");--> statement-breakpoint
CREATE UNIQUE INDEX "localization_assessment_asOf_region_rank_unq" ON "localization_assessment" USING btree ("as_of","region_id","rank");--> statement-breakpoint
CREATE INDEX "localization_assessment_cell_asOf_idx" ON "localization_assessment" USING btree ("commodity_id","region_id","as_of","id");--> statement-breakpoint
CREATE INDEX "localization_pathway_suggestion_assessment_status_idx" ON "localization_pathway_suggestion" USING btree ("assessment_id","status","id");