ALTER TABLE "case_study" DROP CONSTRAINT "case_study_author_arm_ck";--> statement-breakpoint
ALTER TABLE "case_study" ADD COLUMN "author_avatar_url" text;--> statement-breakpoint
ALTER TABLE "case_study" ADD CONSTRAINT "case_study_author_avatar_url_ck" CHECK (author_avatar_url IS NULL OR (char_length(author_avatar_url) BETWEEN 1 AND 2048
          AND author_avatar_url !~ '[[:space:][:cntrl:]]'
          AND (author_avatar_url LIKE 'https://%'
               OR (left(author_avatar_url, 1) = '/'
                   AND left(author_avatar_url, 2) <> '//'
                   AND left(author_avatar_url, 2) <> ('/' || chr(92))))));--> statement-breakpoint
ALTER TABLE "case_study" ADD CONSTRAINT "case_study_author_arm_ck" CHECK ((author_user_id IS NOT NULL
           AND author_display_name IS NULL
           AND author_handle IS NULL
           AND author_avatar_url IS NULL)
          OR (author_user_id IS NULL AND author_display_name IS NOT NULL));