ALTER TABLE "anime_hero_slide" DROP CONSTRAINT "anime_hero_slide_image_url_ck";--> statement-breakpoint
ALTER TABLE "anime_hero_slide" DROP CONSTRAINT "anime_hero_slide_destination_ck";--> statement-breakpoint
ALTER TABLE "promotional_slide" DROP CONSTRAINT "promotional_slide_destination_ck";--> statement-breakpoint
ALTER TABLE "showcase_launch" DROP CONSTRAINT "showcase_launch_tags_ck";--> statement-breakpoint
ALTER TABLE "showcase_launch" DROP CONSTRAINT "showcase_launch_statements_ck";--> statement-breakpoint
ALTER TABLE "anime_hero_slide" ADD CONSTRAINT "anime_hero_slide_image_url_ck" CHECK (char_length(image_url) BETWEEN 1 AND 2048
          AND image_url !~ '[[:space:][:cntrl:]]'
          AND (image_url LIKE 'https://%'
               OR (left(image_url, 1) = '/'
                   AND left(image_url, 2) <> '//'
                   AND left(image_url, 2) <> ('/' || chr(92)))));--> statement-breakpoint
ALTER TABLE "anime_hero_slide" ADD CONSTRAINT "anime_hero_slide_destination_ck" CHECK (destination_path IS NULL
          OR (char_length(destination_path) BETWEEN 1 AND 512
              AND left(destination_path, 1) = '/'
              AND left(destination_path, 2) <> '//'
              AND left(destination_path, 2) <> ('/' || chr(92))
              AND destination_path !~ '[[:space:][:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "promotional_slide" ADD CONSTRAINT "promotional_slide_destination_ck" CHECK ((destination_kind = 'internal_path'
             AND char_length(destination_value) BETWEEN 1 AND 512
             AND left(destination_value, 1) = '/'
             AND left(destination_value, 2) <> '//'
             AND left(destination_value, 2) <> ('/' || chr(92))
             AND destination_value !~ '[[:space:][:cntrl:]]')
          OR (destination_kind = 'external_url'
             AND char_length(destination_value) BETWEEN 1 AND 2048
             AND destination_value LIKE 'https://%'
             AND destination_value !~ '[[:space:][:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "showcase_launch" ADD CONSTRAINT "showcase_launch_tags_ck" CHECK (cardinality(tags) <= 10 AND array_position(tags, NULL) IS NULL);--> statement-breakpoint
ALTER TABLE "showcase_launch" ADD CONSTRAINT "showcase_launch_statements_ck" CHECK (accepted_launch_statement_ids @> ARRAY['built_it_ourselves', 'results_are_our_own']::text[]
          AND cardinality(accepted_launch_statement_ids) = 2
          AND array_position(accepted_launch_statement_ids, NULL) IS NULL);