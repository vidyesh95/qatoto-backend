-- ⚠️ BACKFILL FIRST, OR THE TIGHTENED CHECK REFUSES THE ROWS IT WAS ALWAYS MEANT TO DESCRIBE.
-- Migration 0190 added `model_source` as nullable and wrote a CHECK whose arms compare it; with a
-- NULL source both arms evaluate to NULL, `NULL OR NULL` is NULL, and a CHECK treats NULL as
-- PASSING. So 0190 admitted every pre-existing row instead of classifying it. Every such row is a
-- seeded fixture carrying a pasted `model_url`, which is exactly `pasted_link`.
UPDATE "teardown_assembly"
   SET "model_source" = 'pasted_link'
 WHERE "model_source" IS NULL AND "model_url" IS NOT NULL;--> statement-breakpoint
UPDATE "teardown_part"
   SET "model_source" = 'pasted_link'
 WHERE "model_source" IS NULL AND "model_url" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "teardown_assembly" DROP CONSTRAINT "teardown_assembly_kind_shape_ck";--> statement-breakpoint
ALTER TABLE "teardown_part" DROP CONSTRAINT "teardown_part_arm_shape_ck";--> statement-breakpoint
ALTER TABLE "teardown_assembly" ADD CONSTRAINT "teardown_assembly_kind_shape_ck" CHECK ((kind = 'composite'
           AND model_byte_size IS NOT NULL
           AND model_byte_size > 0
           AND model_source IS NOT NULL
           AND ((model_source = 'pasted_link'
                 AND model_url IS NOT NULL
                 AND model_object_storage_key IS NULL
                 AND model_content_sha256 IS NULL)
                OR (model_source = 'uploaded'
                    AND model_url IS NULL
                    AND model_object_storage_key IS NOT NULL
                    AND model_content_sha256 IS NOT NULL)))
          OR (kind = 'individual_parts'
              AND model_url IS NULL
              AND model_byte_size IS NULL
              AND model_source IS NULL
              AND model_object_storage_key IS NULL
              AND model_content_sha256 IS NULL));--> statement-breakpoint
ALTER TABLE "teardown_part" ADD CONSTRAINT "teardown_part_arm_shape_ck" CHECK ((assembly_kind = 'composite'
           AND node_name IS NOT NULL
           AND model_url IS NULL
           AND model_byte_size IS NULL
           AND model_source IS NULL
           AND model_object_storage_key IS NULL
           AND model_content_sha256 IS NULL
           AND placement_position_x IS NULL
           AND placement_rotation_x IS NULL)
          OR (assembly_kind = 'individual_parts'
              AND node_name IS NULL
              AND model_byte_size IS NOT NULL
              AND model_byte_size > 0
              AND model_source IS NOT NULL
              AND ((model_source = 'pasted_link'
                    AND model_url IS NOT NULL
                    AND model_object_storage_key IS NULL
                    AND model_content_sha256 IS NULL)
                   OR (model_source = 'uploaded'
                       AND model_url IS NULL
                       AND model_object_storage_key IS NOT NULL
                       AND model_content_sha256 IS NOT NULL))));