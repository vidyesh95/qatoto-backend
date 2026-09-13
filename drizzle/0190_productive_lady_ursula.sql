ALTER TABLE "teardown_assembly" DROP CONSTRAINT "teardown_assembly_kind_shape_ck";--> statement-breakpoint
ALTER TABLE "teardown_part" DROP CONSTRAINT "teardown_part_arm_shape_ck";--> statement-breakpoint
ALTER TABLE "teardown_assembly" ADD COLUMN "model_source" "teardown_file_source";--> statement-breakpoint
ALTER TABLE "teardown_assembly" ADD COLUMN "model_object_storage_key" text;--> statement-breakpoint
ALTER TABLE "teardown_assembly" ADD COLUMN "model_content_sha256" text;--> statement-breakpoint
ALTER TABLE "teardown_part" ADD COLUMN "model_source" "teardown_file_source";--> statement-breakpoint
ALTER TABLE "teardown_part" ADD COLUMN "model_object_storage_key" text;--> statement-breakpoint
ALTER TABLE "teardown_part" ADD COLUMN "model_content_sha256" text;--> statement-breakpoint
ALTER TABLE "teardown_assembly" ADD CONSTRAINT "teardown_assembly_model_key_ck" CHECK ((model_object_storage_key IS NULL OR (
            char_length(model_object_storage_key) BETWEEN 1 AND 512
            AND model_object_storage_key !~ '[[:space:][:cntrl:]]'
            AND left(model_object_storage_key, 1) <> '/'
            AND model_object_storage_key !~ '\.\.'
            AND model_object_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.%-]*$'))
       AND (model_content_sha256 IS NULL OR model_content_sha256 ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "teardown_assembly" ADD CONSTRAINT "teardown_assembly_kind_shape_ck" CHECK ((kind = 'composite'
           AND model_byte_size IS NOT NULL
           AND model_byte_size > 0
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
ALTER TABLE "teardown_part" ADD CONSTRAINT "teardown_part_model_key_ck" CHECK ((model_object_storage_key IS NULL OR (
            char_length(model_object_storage_key) BETWEEN 1 AND 512
            AND model_object_storage_key !~ '[[:space:][:cntrl:]]'
            AND left(model_object_storage_key, 1) <> '/'
            AND model_object_storage_key !~ '\.\.'
            AND model_object_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.%-]*$'))
       AND (model_content_sha256 IS NULL OR model_content_sha256 ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
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
              AND ((model_source = 'pasted_link'
                    AND model_url IS NOT NULL
                    AND model_object_storage_key IS NULL
                    AND model_content_sha256 IS NULL)
                   OR (model_source = 'uploaded'
                       AND model_url IS NULL
                       AND model_object_storage_key IS NOT NULL
                       AND model_content_sha256 IS NOT NULL))));