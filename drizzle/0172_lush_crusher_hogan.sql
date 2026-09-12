ALTER TABLE "showcase_launch" DROP CONSTRAINT "showcase_launch_cost_range_ck";--> statement-breakpoint
ALTER TABLE "teardown" DROP CONSTRAINT "teardown_cost_range_ck";--> statement-breakpoint
ALTER TABLE "teardown" DROP CONSTRAINT "teardown_repairability_ck";--> statement-breakpoint
ALTER TABLE "teardown" DROP CONSTRAINT "teardown_telemetry_ck";--> statement-breakpoint
ALTER TABLE "teardown" DROP CONSTRAINT "teardown_store_product_class_ck";--> statement-breakpoint
ALTER TABLE "teardown" DROP CONSTRAINT "teardown_walkthrough_video_ck";--> statement-breakpoint
ALTER TABLE "teardown_assembly" DROP CONSTRAINT "teardown_assembly_kind_shape_ck";--> statement-breakpoint
ALTER TABLE "teardown_fastener" DROP CONSTRAINT "teardown_fastener_supplier_ck";--> statement-breakpoint
ALTER TABLE "teardown_material_element" DROP CONSTRAINT "teardown_material_element_range_ck";--> statement-breakpoint
ALTER TABLE "teardown_part" DROP CONSTRAINT "teardown_part_arm_shape_ck";--> statement-breakpoint
ALTER TABLE "showcase_launch" ADD CONSTRAINT "showcase_launch_cost_range_ck" CHECK ((bill_of_materials_minimum_cents IS NULL
           AND bill_of_materials_maximum_cents IS NULL
           AND bill_of_materials_currency IS NULL)
          OR (bill_of_materials_minimum_cents IS NOT NULL
              AND bill_of_materials_maximum_cents IS NOT NULL
              AND bill_of_materials_currency IS NOT NULL
              AND bill_of_materials_currency = 'USD'
              AND bill_of_materials_minimum_cents >= 0
              AND bill_of_materials_maximum_cents >= bill_of_materials_minimum_cents
              AND bill_of_materials_maximum_cents <= 100000000));--> statement-breakpoint
ALTER TABLE "teardown" ADD CONSTRAINT "teardown_cost_range_ck" CHECK ((bill_of_materials_minimum_cents IS NULL
           AND bill_of_materials_maximum_cents IS NULL
           AND bill_of_materials_currency IS NULL)
          OR (bill_of_materials_minimum_cents IS NOT NULL
              AND bill_of_materials_maximum_cents IS NOT NULL
              AND bill_of_materials_currency IS NOT NULL
              AND bill_of_materials_currency = 'USD'
              AND bill_of_materials_minimum_cents >= 0
              AND bill_of_materials_maximum_cents >= bill_of_materials_minimum_cents
              AND bill_of_materials_maximum_cents <= 100000000));--> statement-breakpoint
ALTER TABLE "teardown" ADD CONSTRAINT "teardown_repairability_ck" CHECK ((repairability_fastener_uniformity_score IS NULL
           AND repairability_fastener_uniformity_note IS NULL
           AND repairability_tool_accessibility_score IS NULL
           AND repairability_tool_accessibility_note IS NULL
           AND repairability_disassembly_step_count_score IS NULL
           AND repairability_disassembly_step_count_note IS NULL
           AND repairability_modular_independence_score IS NULL
           AND repairability_modular_independence_note IS NULL
           AND repairability_overall_score IS NULL)
          OR (repairability_fastener_uniformity_score IS NOT NULL
              AND repairability_fastener_uniformity_score BETWEEN 0 AND 10
              AND repairability_fastener_uniformity_note IS NOT NULL
              AND repairability_tool_accessibility_score IS NOT NULL
              AND repairability_tool_accessibility_score BETWEEN 0 AND 10
              AND repairability_tool_accessibility_note IS NOT NULL
              AND repairability_disassembly_step_count_score IS NOT NULL
              AND repairability_disassembly_step_count_score BETWEEN 0 AND 10
              AND repairability_disassembly_step_count_note IS NOT NULL
              AND repairability_modular_independence_score IS NOT NULL
              AND repairability_modular_independence_score BETWEEN 0 AND 10
              AND repairability_modular_independence_note IS NOT NULL
              AND repairability_overall_score IS NOT NULL
              AND repairability_overall_score BETWEEN 0 AND 10));--> statement-breakpoint
ALTER TABLE "teardown" ADD CONSTRAINT "teardown_telemetry_ck" CHECK ((telemetry_factor_of_safety IS NULL
           AND telemetry_peak_von_mises_stress_megapascals IS NULL
           AND telemetry_max_displacement_micrometres IS NULL
           AND telemetry_thermal_delta_kelvin IS NULL
           AND telemetry_rated_load_newtons IS NULL
           AND telemetry_source IS NULL)
          OR (telemetry_factor_of_safety IS NOT NULL
              AND telemetry_factor_of_safety > 0
              AND telemetry_peak_von_mises_stress_megapascals IS NOT NULL
              AND telemetry_peak_von_mises_stress_megapascals >= 0
              AND telemetry_max_displacement_micrometres IS NOT NULL
              AND telemetry_max_displacement_micrometres >= 0
              AND telemetry_thermal_delta_kelvin IS NOT NULL
              AND telemetry_rated_load_newtons IS NOT NULL
              AND telemetry_rated_load_newtons > 0
              AND telemetry_source IS NOT NULL
              AND telemetry_source = 'author_reported'));--> statement-breakpoint
ALTER TABLE "teardown" ADD CONSTRAINT "teardown_store_product_class_ck" CHECK ((store_product_class_category_slug IS NULL AND store_product_class_label IS NULL)
          OR (store_product_class_category_slug IS NOT NULL
              AND store_product_class_category_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND store_product_class_label IS NOT NULL
              AND char_length(store_product_class_label) BETWEEN 1 AND 80));--> statement-breakpoint
ALTER TABLE "teardown" ADD CONSTRAINT "teardown_walkthrough_video_ck" CHECK ((walkthrough_video_source IS NULL
           AND walkthrough_youtube_video_id IS NULL
           AND walkthrough_poster_url IS NULL
           AND walkthrough_duration_seconds IS NULL)
          OR (walkthrough_video_source IS NOT NULL
              AND walkthrough_video_source = 'youtube'
              AND walkthrough_youtube_video_id IS NOT NULL
              AND walkthrough_youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
              AND walkthrough_poster_url IS NOT NULL
              AND (walkthrough_duration_seconds IS NULL OR walkthrough_duration_seconds > 0)));--> statement-breakpoint
ALTER TABLE "teardown_assembly" ADD CONSTRAINT "teardown_assembly_kind_shape_ck" CHECK ((kind = 'composite'
           AND model_url IS NOT NULL
           AND model_byte_size IS NOT NULL
           AND model_byte_size > 0)
          OR (kind = 'individual_parts' AND model_url IS NULL AND model_byte_size IS NULL));--> statement-breakpoint
ALTER TABLE "teardown_fastener" ADD CONSTRAINT "teardown_fastener_supplier_ck" CHECK ((supplier_label IS NULL AND supplier_url IS NULL)
          OR (supplier_label IS NOT NULL
              AND char_length(supplier_label) BETWEEN 1 AND 80
              AND supplier_url IS NOT NULL));--> statement-breakpoint
ALTER TABLE "teardown_material_element" ADD CONSTRAINT "teardown_material_element_range_ck" CHECK ((minimum_percent IS NULL AND maximum_percent IS NULL)
          OR (minimum_percent IS NOT NULL
              AND maximum_percent IS NOT NULL
              AND minimum_percent >= 0
              AND maximum_percent <= 100
              AND maximum_percent >= minimum_percent));--> statement-breakpoint
ALTER TABLE "teardown_part" ADD CONSTRAINT "teardown_part_arm_shape_ck" CHECK ((assembly_kind = 'composite'
           AND node_name IS NOT NULL
           AND model_url IS NULL
           AND model_byte_size IS NULL
           AND placement_position_x IS NULL
           AND placement_rotation_x IS NULL)
          OR (assembly_kind = 'individual_parts'
              AND node_name IS NULL
              AND model_url IS NOT NULL
              AND model_byte_size IS NOT NULL
              AND model_byte_size > 0));