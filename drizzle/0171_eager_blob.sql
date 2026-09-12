CREATE TYPE "public"."blueprint_document_kind" AS ENUM('schematic', 'bill_of_materials', 'assembly_guide', 'datasheet');--> statement-breakpoint
CREATE TYPE "public"."blueprint_provenance_kind" AS ENUM('licensed_open_source', 'authorized_by_manufacturer', 'community_reverse_engineered');--> statement-breakpoint
CREATE TYPE "public"."teardown_assembly_kind" AS ENUM('composite', 'individual_parts');--> statement-breakpoint
CREATE TYPE "public"."teardown_composition_analysis_method" AS ENUM('xrf', 'oes', 'eds', 'icp_oes', 'declared_not_measured', 'synthetic_example');--> statement-breakpoint
CREATE TYPE "public"."teardown_designation_source" AS ENUM('measured_spectroscopy', 'manufacturer_marking', 'public_datasheet', 'supplier_declared', 'contributor_freetext');--> statement-breakpoint
CREATE TYPE "public"."teardown_fastener_drive" AS ENUM('torx', 'hex_socket', 'phillips', 'slotted', 'adhesive', 'snap_fit', 'press_fit');--> statement-breakpoint
CREATE TYPE "public"."teardown_manufacturing_file_kind" AS ENUM('step', 'stl', 'dxf', 'gerber', 'drill', 'pick_and_place', 'bill_of_materials_csv');--> statement-breakpoint
CREATE TYPE "public"."teardown_manufacturing_method" AS ENUM('cnc_milled', 'injection_molded', 'sheet_metal', 'fdm_printed', 'pcb_assembly', 'cast', 'off_the_shelf');--> statement-breakpoint
CREATE TYPE "public"."teardown_material_class" AS ENUM('metal_alloy', 'polymer', 'elastomer', 'composite', 'ceramic', 'glass', 'laminate', 'semiconductor_package', 'coating', 'other');--> statement-breakpoint
CREATE TYPE "public"."teardown_subject_kind" AS ENUM('existing_physical_product', 'proposed_design');--> statement-breakpoint
CREATE TYPE "public"."teardown_survey_method" AS ENUM('dimensional_survey', 'empirical_teardown', 'material_spectroscopy');--> statement-breakpoint
CREATE TYPE "public"."teardown_unit_acquisition" AS ENUM('retail_purchase', 'secondary_market', 'manufacturer_supplied', 'donated_unit');--> statement-breakpoint
CREATE TABLE "teardown" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"thumbnail_url" text NOT NULL,
	"author_display_name" text NOT NULL,
	"author_handle" text,
	"author_avatar_url" text,
	"difficulty" "blueprint_difficulty" NOT NULL,
	"cad_format" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"part_count" integer,
	"subject_kind" "teardown_subject_kind" NOT NULL,
	"moderation_state" "blueprint_moderation_state" NOT NULL,
	"bill_of_materials_minimum_cents" integer,
	"bill_of_materials_maximum_cents" integer,
	"bill_of_materials_currency" text,
	"provenance_kind" "blueprint_provenance_kind" NOT NULL,
	"provenance_subject_product_name" text NOT NULL,
	"provenance_unit_acquisition" "teardown_unit_acquisition" NOT NULL,
	"provenance_survey_methods" "teardown_survey_method"[] NOT NULL,
	"provenance_surveyed_at" timestamp (3) NOT NULL,
	"provenance_licence_name" text,
	"provenance_licence_url" text,
	"provenance_authorization_note" text,
	"provenance_attestation_accepted_at" timestamp (3) NOT NULL,
	"provenance_notes" text,
	"repairability_fastener_uniformity_score" integer,
	"repairability_fastener_uniformity_note" text,
	"repairability_tool_accessibility_score" integer,
	"repairability_tool_accessibility_note" text,
	"repairability_disassembly_step_count_score" integer,
	"repairability_disassembly_step_count_note" text,
	"repairability_modular_independence_score" integer,
	"repairability_modular_independence_note" text,
	"repairability_overall_score" integer,
	"telemetry_factor_of_safety" double precision,
	"telemetry_peak_von_mises_stress_megapascals" double precision,
	"telemetry_max_displacement_micrometres" integer,
	"telemetry_thermal_delta_kelvin" double precision,
	"telemetry_rated_load_newtons" double precision,
	"telemetry_source" text,
	"store_product_class_category_slug" text,
	"store_product_class_label" text,
	"walkthrough_video_source" "video_source",
	"walkthrough_youtube_video_id" text,
	"walkthrough_poster_url" text,
	"walkthrough_duration_seconds" integer,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_slug_unique" UNIQUE("slug"),
	CONSTRAINT "teardown_moderation_state_ck" CHECK (moderation_state IN ('published', 'flagged', 'quarantined', 'pending_review')),
	CONSTRAINT "teardown_subject_kind_ck" CHECK (subject_kind = 'existing_physical_product'),
	CONSTRAINT "teardown_slug_ck" CHECK (char_length(slug) BETWEEN 3 AND 120
          AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND slug NOT IN ('teardowns', 'showcase', 'case-studies', 'new', 'slugs', 'options')),
	CONSTRAINT "teardown_text_lengths_ck" CHECK (char_length(title) BETWEEN 8 AND 160
          AND char_length(summary) BETWEEN 40 AND 2000
          AND (cad_format IS NULL OR char_length(cad_format) BETWEEN 1 AND 120)),
	CONSTRAINT "teardown_thumbnail_url_ck" CHECK (char_length(thumbnail_url) BETWEEN 1 AND 2048
          AND thumbnail_url !~ '[[:space:][:cntrl:]]'
          AND (thumbnail_url LIKE 'https://%'
               OR (left(thumbnail_url, 1) = '/'
                   AND left(thumbnail_url, 2) <> '//'
                   AND left(thumbnail_url, 2) <> ('/' || chr(92))))),
	CONSTRAINT "teardown_author_ck" CHECK (char_length(author_display_name) BETWEEN 1 AND 80
          AND (author_handle IS NULL
               OR (char_length(author_handle) BETWEEN 1 AND 64
                   AND author_handle ~ '^[A-Za-z0-9_.-]+$'))),
	CONSTRAINT "teardown_author_avatar_url_ck" CHECK (author_avatar_url IS NULL OR (char_length(author_avatar_url) BETWEEN 1 AND 2048
          AND author_avatar_url !~ '[[:space:][:cntrl:]]'
          AND (author_avatar_url LIKE 'https://%'
               OR (left(author_avatar_url, 1) = '/'
                   AND left(author_avatar_url, 2) <> '//'
                   AND left(author_avatar_url, 2) <> ('/' || chr(92)))))),
	CONSTRAINT "teardown_tags_ck" CHECK (cardinality(tags) <= 12),
	CONSTRAINT "teardown_part_count_ck" CHECK (part_count IS NULL OR part_count > 0),
	CONSTRAINT "teardown_cost_range_ck" CHECK ((bill_of_materials_minimum_cents IS NULL
           AND bill_of_materials_maximum_cents IS NULL
           AND bill_of_materials_currency IS NULL)
          OR (bill_of_materials_minimum_cents IS NOT NULL
              AND bill_of_materials_maximum_cents IS NOT NULL
              AND bill_of_materials_currency = 'USD'
              AND bill_of_materials_minimum_cents >= 0
              AND bill_of_materials_maximum_cents >= bill_of_materials_minimum_cents
              AND bill_of_materials_maximum_cents <= 100000000)),
	CONSTRAINT "teardown_provenance_permission_ck" CHECK ((provenance_kind = 'licensed_open_source'
           AND provenance_licence_name IS NOT NULL
           AND provenance_licence_url IS NOT NULL
           AND provenance_authorization_note IS NULL)
          OR (provenance_kind = 'authorized_by_manufacturer'
              AND provenance_licence_name IS NULL
              AND provenance_licence_url IS NULL
              AND provenance_authorization_note IS NOT NULL)
          OR (provenance_kind = 'community_reverse_engineered'
              AND provenance_licence_name IS NULL
              AND provenance_licence_url IS NULL
              AND provenance_authorization_note IS NULL)),
	CONSTRAINT "teardown_provenance_licence_url_ck" CHECK (provenance_licence_url IS NULL OR (char_length(provenance_licence_url) BETWEEN 1 AND 2048
          AND provenance_licence_url !~ '[[:space:][:cntrl:]]'
          AND provenance_licence_url LIKE 'https://%')),
	CONSTRAINT "teardown_provenance_survey_methods_ck" CHECK (cardinality(provenance_survey_methods) BETWEEN 1 AND 3),
	CONSTRAINT "teardown_repairability_ck" CHECK ((repairability_fastener_uniformity_score IS NULL
           AND repairability_fastener_uniformity_note IS NULL
           AND repairability_tool_accessibility_score IS NULL
           AND repairability_tool_accessibility_note IS NULL
           AND repairability_disassembly_step_count_score IS NULL
           AND repairability_disassembly_step_count_note IS NULL
           AND repairability_modular_independence_score IS NULL
           AND repairability_modular_independence_note IS NULL
           AND repairability_overall_score IS NULL)
          OR (repairability_fastener_uniformity_score BETWEEN 0 AND 10
              AND repairability_fastener_uniformity_note IS NOT NULL
              AND repairability_tool_accessibility_score BETWEEN 0 AND 10
              AND repairability_tool_accessibility_note IS NOT NULL
              AND repairability_disassembly_step_count_score BETWEEN 0 AND 10
              AND repairability_disassembly_step_count_note IS NOT NULL
              AND repairability_modular_independence_score BETWEEN 0 AND 10
              AND repairability_modular_independence_note IS NOT NULL
              AND repairability_overall_score BETWEEN 0 AND 10)),
	CONSTRAINT "teardown_telemetry_ck" CHECK ((telemetry_factor_of_safety IS NULL
           AND telemetry_peak_von_mises_stress_megapascals IS NULL
           AND telemetry_max_displacement_micrometres IS NULL
           AND telemetry_thermal_delta_kelvin IS NULL
           AND telemetry_rated_load_newtons IS NULL
           AND telemetry_source IS NULL)
          OR (telemetry_factor_of_safety > 0
              AND telemetry_peak_von_mises_stress_megapascals >= 0
              AND telemetry_max_displacement_micrometres >= 0
              AND telemetry_thermal_delta_kelvin IS NOT NULL
              AND telemetry_rated_load_newtons > 0
              AND telemetry_source = 'author_reported')),
	CONSTRAINT "teardown_store_product_class_ck" CHECK ((store_product_class_category_slug IS NULL AND store_product_class_label IS NULL)
          OR (store_product_class_category_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND char_length(store_product_class_label) BETWEEN 1 AND 80)),
	CONSTRAINT "teardown_walkthrough_video_ck" CHECK ((walkthrough_video_source IS NULL
           AND walkthrough_youtube_video_id IS NULL
           AND walkthrough_poster_url IS NULL
           AND walkthrough_duration_seconds IS NULL)
          OR (walkthrough_video_source = 'youtube'
              AND walkthrough_youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
              AND walkthrough_poster_url IS NOT NULL
              AND (walkthrough_duration_seconds IS NULL OR walkthrough_duration_seconds > 0))),
	CONSTRAINT "teardown_walkthrough_poster_url_ck" CHECK (walkthrough_poster_url IS NULL OR (char_length(walkthrough_poster_url) BETWEEN 1 AND 2048
          AND walkthrough_poster_url !~ '[[:space:][:cntrl:]]'
          AND (walkthrough_poster_url LIKE 'https://%'
               OR (left(walkthrough_poster_url, 1) = '/'
                   AND left(walkthrough_poster_url, 2) <> '//'
                   AND left(walkthrough_poster_url, 2) <> ('/' || chr(92))))))
);
--> statement-breakpoint
CREATE TABLE "teardown_assembly" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"kind" "teardown_assembly_kind" NOT NULL,
	"explosion_axis_x" double precision,
	"explosion_axis_y" double precision,
	"explosion_axis_z" double precision,
	"model_url" text,
	"model_byte_size" integer,
	CONSTRAINT "teardown_assembly_teardown_uidx" UNIQUE("teardown_id"),
	CONSTRAINT "teardown_assembly_teardown_id_uidx" UNIQUE("teardown_id","id"),
	CONSTRAINT "teardown_assembly_kind_uidx" UNIQUE("id","kind"),
	CONSTRAINT "teardown_assembly_kind_shape_ck" CHECK ((kind = 'composite' AND model_url IS NOT NULL AND model_byte_size > 0)
          OR (kind = 'individual_parts' AND model_url IS NULL AND model_byte_size IS NULL)),
	CONSTRAINT "teardown_assembly_model_url_ck" CHECK (model_url IS NULL OR (char_length(model_url) BETWEEN 1 AND 2048
          AND model_url !~ '[[:space:][:cntrl:]]'
          AND (model_url LIKE 'https://%'
               OR (left(model_url, 1) = '/'
                   AND left(model_url, 2) <> '//'
                   AND left(model_url, 2) <> ('/' || chr(92)))))),
	CONSTRAINT "teardown_assembly_explosion_axis_ck" CHECK ((explosion_axis_x IS NULL AND explosion_axis_y IS NULL AND explosion_axis_z IS NULL)
          OR (explosion_axis_x IS NOT NULL
              AND explosion_axis_y IS NOT NULL
              AND explosion_axis_z IS NOT NULL
              AND (explosion_axis_x <> 0 OR explosion_axis_y <> 0 OR explosion_axis_z <> 0)))
);
--> statement-breakpoint
CREATE TABLE "teardown_assembly_step" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"step_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"assembly_id" text,
	"focused_part_id" text,
	CONSTRAINT "teardown_assembly_step_number_uidx" UNIQUE("teardown_id","step_number"),
	CONSTRAINT "teardown_assembly_step_focus_ck" CHECK ((assembly_id IS NULL) = (focused_part_id IS NULL)),
	CONSTRAINT "teardown_assembly_step_scalars_ck" CHECK (step_number BETWEEN 1 AND 64
          AND char_length(title) BETWEEN 1 AND 200
          AND char_length(description) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "teardown_document" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" "blueprint_document_kind" NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"byte_size" integer NOT NULL,
	"page_count" integer,
	CONSTRAINT "teardown_document_url_ck" CHECK (char_length(url) BETWEEN 1 AND 2048
          AND url !~ '[[:space:][:cntrl:]]'
          AND (url LIKE 'https://%'
               OR (left(url, 1) = '/'
                   AND left(url, 2) <> '//'
                   AND left(url, 2) <> ('/' || chr(92))))),
	CONSTRAINT "teardown_document_scalars_ck" CHECK (byte_size >= 0
          AND position >= 0
          AND (page_count IS NULL OR page_count > 0)
          AND char_length(title) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "teardown_fastener" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"position" integer NOT NULL,
	"standard_code" text,
	"size_label" text NOT NULL,
	"drive" "teardown_fastener_drive" NOT NULL,
	"quantity" integer NOT NULL,
	"supplier_label" text,
	"supplier_url" text,
	CONSTRAINT "teardown_fastener_supplier_ck" CHECK ((supplier_label IS NULL AND supplier_url IS NULL)
          OR (char_length(supplier_label) BETWEEN 1 AND 80 AND supplier_url IS NOT NULL)),
	CONSTRAINT "teardown_fastener_supplier_url_ck" CHECK (supplier_url IS NULL OR (char_length(supplier_url) BETWEEN 1 AND 2048
          AND supplier_url !~ '[[:space:][:cntrl:]]'
          AND supplier_url LIKE 'https://%')),
	CONSTRAINT "teardown_fastener_scalars_ck" CHECK (quantity > 0
          AND position >= 0
          AND char_length(size_label) BETWEEN 1 AND 80
          AND (standard_code IS NULL OR char_length(standard_code) BETWEEN 1 AND 80))
);
--> statement-breakpoint
CREATE TABLE "teardown_manufacturing_file" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" "teardown_manufacturing_file_kind" NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"byte_size" integer NOT NULL,
	CONSTRAINT "teardown_manufacturing_file_url_ck" CHECK (char_length(url) BETWEEN 1 AND 2048
          AND url !~ '[[:space:][:cntrl:]]'
          AND (url LIKE 'https://%'
               OR (left(url, 1) = '/'
                   AND left(url, 2) <> '//'
                   AND left(url, 2) <> ('/' || chr(92))))),
	CONSTRAINT "teardown_manufacturing_file_scalars_ck" CHECK (byte_size > 0 AND position >= 0 AND char_length(title) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "teardown_material" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"position" integer NOT NULL,
	"applies_to_label" text NOT NULL,
	"designation" text NOT NULL,
	"designation_source" "teardown_designation_source" NOT NULL,
	"material_class" "teardown_material_class" NOT NULL,
	"process" "teardown_manufacturing_method",
	"finish" text,
	"assembly_id" text,
	"part_id" text,
	CONSTRAINT "teardown_material_part_ck" CHECK ((assembly_id IS NULL) = (part_id IS NULL)),
	CONSTRAINT "teardown_material_scalars_ck" CHECK (position >= 0
          AND char_length(applies_to_label) BETWEEN 1 AND 120
          AND char_length(designation) BETWEEN 1 AND 120
          AND (finish IS NULL OR char_length(finish) BETWEEN 1 AND 120))
);
--> statement-breakpoint
CREATE TABLE "teardown_material_element" (
	"id" text PRIMARY KEY NOT NULL,
	"material_id" text NOT NULL,
	"position" integer NOT NULL,
	"symbol" text NOT NULL,
	"minimum_percent" double precision,
	"maximum_percent" double precision,
	"analysis_method" "teardown_composition_analysis_method" NOT NULL,
	"instrument_label" text,
	"operator_note" text,
	CONSTRAINT "teardown_material_element_range_ck" CHECK ((minimum_percent IS NULL AND maximum_percent IS NULL)
          OR (minimum_percent >= 0
              AND maximum_percent <= 100
              AND maximum_percent >= minimum_percent)),
	CONSTRAINT "teardown_material_element_instrument_ck" CHECK (instrument_label IS NULL
          OR analysis_method IN ('xrf', 'oes', 'eds', 'icp_oes')),
	CONSTRAINT "teardown_material_element_scalars_ck" CHECK (position >= 0
          AND char_length(symbol) BETWEEN 1 AND 3
          AND (instrument_label IS NULL OR char_length(instrument_label) BETWEEN 1 AND 120)
          AND (operator_note IS NULL OR char_length(operator_note) BETWEEN 1 AND 400))
);
--> statement-breakpoint
CREATE TABLE "teardown_part" (
	"id" text NOT NULL,
	"assembly_id" text NOT NULL,
	"assembly_kind" "teardown_assembly_kind" NOT NULL,
	"parent_part_id" text,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"material" text NOT NULL,
	"manufacturing_method" "teardown_manufacturing_method" NOT NULL,
	"explosion_direction_x" double precision,
	"explosion_direction_y" double precision,
	"explosion_direction_z" double precision,
	"explosion_distance_mm" double precision,
	"layer_index" integer,
	"stress_rating" double precision,
	"callout_text" text,
	"node_name" text,
	"model_url" text,
	"model_byte_size" integer,
	"placement_position_x" double precision,
	"placement_position_y" double precision,
	"placement_position_z" double precision,
	"placement_rotation_x" double precision,
	"placement_rotation_y" double precision,
	"placement_rotation_z" double precision,
	CONSTRAINT "teardown_part_assembly_id_id_pk" PRIMARY KEY("assembly_id","id"),
	CONSTRAINT "teardown_part_assembly_id_uidx" UNIQUE("assembly_id","id"),
	CONSTRAINT "teardown_part_not_own_parent_ck" CHECK (parent_part_id IS NULL OR parent_part_id <> id),
	CONSTRAINT "teardown_part_arm_shape_ck" CHECK ((assembly_kind = 'composite'
           AND node_name IS NOT NULL
           AND model_url IS NULL
           AND model_byte_size IS NULL
           AND placement_position_x IS NULL
           AND placement_rotation_x IS NULL)
          OR (assembly_kind = 'individual_parts'
              AND node_name IS NULL
              AND model_url IS NOT NULL
              AND model_byte_size > 0)),
	CONSTRAINT "teardown_part_model_url_ck" CHECK (model_url IS NULL OR (char_length(model_url) BETWEEN 1 AND 2048
          AND model_url !~ '[[:space:][:cntrl:]]'
          AND (model_url LIKE 'https://%'
               OR (left(model_url, 1) = '/'
                   AND left(model_url, 2) <> '//'
                   AND left(model_url, 2) <> ('/' || chr(92)))))),
	CONSTRAINT "teardown_part_explosion_direction_ck" CHECK ((explosion_direction_x IS NULL
           AND explosion_direction_y IS NULL
           AND explosion_direction_z IS NULL)
          OR (explosion_direction_x IS NOT NULL
              AND explosion_direction_y IS NOT NULL
              AND explosion_direction_z IS NOT NULL
              AND (explosion_direction_x <> 0
                   OR explosion_direction_y <> 0
                   OR explosion_direction_z <> 0))),
	CONSTRAINT "teardown_part_placement_ck" CHECK ((placement_position_x IS NULL
           AND placement_position_y IS NULL
           AND placement_position_z IS NULL
           AND placement_rotation_x IS NULL
           AND placement_rotation_y IS NULL
           AND placement_rotation_z IS NULL)
          OR (placement_position_x IS NOT NULL
              AND placement_position_y IS NOT NULL
              AND placement_position_z IS NOT NULL
              AND placement_rotation_x IS NOT NULL
              AND placement_rotation_y IS NOT NULL
              AND placement_rotation_z IS NOT NULL)),
	CONSTRAINT "teardown_part_scalars_ck" CHECK ((explosion_distance_mm IS NULL OR explosion_distance_mm > 0)
          AND (layer_index IS NULL OR layer_index >= 0)
          AND (stress_rating IS NULL OR (stress_rating >= 0 AND stress_rating <= 1))
          AND position >= 0
          AND char_length(label) BETWEEN 1 AND 120
          AND char_length(material) BETWEEN 1 AND 120
          AND (node_name IS NULL OR char_length(node_name) BETWEEN 1 AND 120)
          AND (callout_text IS NULL OR char_length(callout_text) BETWEEN 1 AND 400))
);
--> statement-breakpoint
CREATE TABLE "teardown_stats" (
	"teardown_id" text PRIMARY KEY NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"save_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_stats_nonnegative_ck" CHECK (view_count >= 0 AND like_count >= 0 AND comment_count >= 0 AND save_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "teardown_assembly" ADD CONSTRAINT "teardown_assembly_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_assembly_step" ADD CONSTRAINT "teardown_assembly_step_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_assembly_step" ADD CONSTRAINT "teardown_assembly_step_assembly_fk" FOREIGN KEY ("teardown_id","assembly_id") REFERENCES "public"."teardown_assembly"("teardown_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_assembly_step" ADD CONSTRAINT "teardown_assembly_step_part_fk" FOREIGN KEY ("assembly_id","focused_part_id") REFERENCES "public"."teardown_part"("assembly_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_document" ADD CONSTRAINT "teardown_document_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_fastener" ADD CONSTRAINT "teardown_fastener_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ADD CONSTRAINT "teardown_manufacturing_file_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_material" ADD CONSTRAINT "teardown_material_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_material" ADD CONSTRAINT "teardown_material_assembly_fk" FOREIGN KEY ("teardown_id","assembly_id") REFERENCES "public"."teardown_assembly"("teardown_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_material" ADD CONSTRAINT "teardown_material_part_fk" FOREIGN KEY ("assembly_id","part_id") REFERENCES "public"."teardown_part"("assembly_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_material_element" ADD CONSTRAINT "teardown_material_element_material_id_teardown_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."teardown_material"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_part" ADD CONSTRAINT "teardown_part_assembly_id_teardown_assembly_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."teardown_assembly"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_part" ADD CONSTRAINT "teardown_part_assembly_kind_fk" FOREIGN KEY ("assembly_id","assembly_kind") REFERENCES "public"."teardown_assembly"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_part" ADD CONSTRAINT "teardown_part_parent_fk" FOREIGN KEY ("assembly_id","parent_part_id") REFERENCES "public"."teardown_part"("assembly_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_stats" ADD CONSTRAINT "teardown_stats_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teardown_public_newest_idx" ON "teardown" USING btree ("created_at" desc,"id") WHERE moderation_state IN ('published', 'flagged');--> statement-breakpoint
CREATE INDEX "teardown_document_teardown_idx" ON "teardown_document" USING btree ("teardown_id","position");--> statement-breakpoint
CREATE INDEX "teardown_fastener_teardown_idx" ON "teardown_fastener" USING btree ("teardown_id","position");--> statement-breakpoint
CREATE INDEX "teardown_manufacturing_file_teardown_idx" ON "teardown_manufacturing_file" USING btree ("teardown_id","position");--> statement-breakpoint
CREATE INDEX "teardown_material_teardown_idx" ON "teardown_material" USING btree ("teardown_id","position");--> statement-breakpoint
CREATE INDEX "teardown_material_element_material_idx" ON "teardown_material_element" USING btree ("material_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "teardown_part_node_name_uidx" ON "teardown_part" USING btree ("assembly_id","node_name") WHERE node_name IS NOT NULL;