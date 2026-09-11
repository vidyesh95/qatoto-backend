CREATE TYPE "public"."blueprint_difficulty" AS ENUM('beginner', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."blueprint_moderation_state" AS ENUM('draft', 'pending_review', 'published', 'rejected', 'flagged', 'quarantined', 'removed');--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'showcase_launch_published' BEFORE 'commerce_content_hidden';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'showcase_launch_rejected' BEFORE 'commerce_content_hidden';--> statement-breakpoint
CREATE TABLE "showcase_launch" (
	"id" text PRIMARY KEY NOT NULL,
	"author_user_id" text NOT NULL,
	"title" text NOT NULL,
	"title_normalized" text GENERATED ALWAYS AS (lower(regexp_replace(btrim(title), '[[:space:]]+', ' ', 'g'))) STORED,
	"tagline" text NOT NULL,
	"summary" text NOT NULL,
	"write_up" text,
	"launched_at" timestamp (3) NOT NULL,
	"difficulty" "blueprint_difficulty" NOT NULL,
	"bill_of_materials_minimum_cents" integer,
	"bill_of_materials_maximum_cents" integer,
	"bill_of_materials_currency" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"built_from_blueprint_slug" text,
	"call_to_action_label" text,
	"call_to_action_url" text,
	"accepted_launch_statement_ids" text[] NOT NULL,
	"heading_image_url" text NOT NULL,
	"heading_image_public_id" text NOT NULL,
	"moderation_state" "blueprint_moderation_state" DEFAULT 'pending_review' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp (3),
	"moderator_note" text,
	"public_slug" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_heading_image_public_id_unique" UNIQUE("heading_image_public_id"),
	CONSTRAINT "showcase_launch_public_slug_unique" UNIQUE("public_slug"),
	CONSTRAINT "showcase_launch_moderation_state_ck" CHECK (moderation_state IN ('pending_review', 'published', 'rejected')),
	CONSTRAINT "showcase_launch_text_lengths_ck" CHECK (char_length(title) BETWEEN 8 AND 120
          AND char_length(tagline) BETWEEN 10 AND 80
          AND char_length(summary) BETWEEN 40 AND 1000
          AND (write_up IS NULL OR char_length(write_up) BETWEEN 1 AND 10000)),
	CONSTRAINT "showcase_launch_tags_ck" CHECK (cardinality(tags) <= 10),
	CONSTRAINT "showcase_launch_cost_range_ck" CHECK ((bill_of_materials_minimum_cents IS NULL
           AND bill_of_materials_maximum_cents IS NULL
           AND bill_of_materials_currency IS NULL)
          OR (bill_of_materials_minimum_cents IS NOT NULL
              AND bill_of_materials_maximum_cents IS NOT NULL
              AND bill_of_materials_currency = 'USD'
              AND bill_of_materials_minimum_cents >= 0
              AND bill_of_materials_maximum_cents >= bill_of_materials_minimum_cents
              AND bill_of_materials_maximum_cents <= 100000000)),
	CONSTRAINT "showcase_launch_call_to_action_ck" CHECK ((call_to_action_label IS NULL AND call_to_action_url IS NULL)
          OR (char_length(call_to_action_label) BETWEEN 1 AND 40
              AND char_length(call_to_action_url) BETWEEN 1 AND 2048
              AND call_to_action_url LIKE 'https://%'
              AND call_to_action_url !~ '[[:space:][:cntrl:]]')),
	CONSTRAINT "showcase_launch_built_from_slug_ck" CHECK (built_from_blueprint_slug IS NULL
          OR (char_length(built_from_blueprint_slug) BETWEEN 3 AND 120
              AND built_from_blueprint_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
	CONSTRAINT "showcase_launch_heading_image_url_ck" CHECK (char_length(heading_image_url) BETWEEN 1 AND 2048
          AND heading_image_url LIKE 'https://%'
          AND heading_image_url !~ '[[:space:][:cntrl:]]'),
	CONSTRAINT "showcase_launch_statements_ck" CHECK (accepted_launch_statement_ids @> ARRAY['built_it_ourselves', 'results_are_our_own']::text[]
          AND cardinality(accepted_launch_statement_ids) = 2),
	CONSTRAINT "showcase_launch_decision_ck" CHECK ((moderation_state = 'pending_review') = (reviewed_at IS NULL)
          AND (reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
          AND (moderation_state <> 'pending_review' OR moderator_note IS NULL)
          AND (moderation_state <> 'rejected' OR moderator_note IS NOT NULL)
          AND (moderation_state = 'published') = (public_slug IS NOT NULL)),
	CONSTRAINT "showcase_launch_moderator_note_ck" CHECK (moderator_note IS NULL OR char_length(moderator_note) BETWEEN 1 AND 2000),
	CONSTRAINT "showcase_launch_public_slug_ck" CHECK (public_slug IS NULL
          OR (char_length(public_slug) BETWEEN 3 AND 120
              AND public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND public_slug NOT IN ('new', 'mine', 'write-up-images')))
);
--> statement-breakpoint
CREATE TABLE "showcase_launch_team_member" (
	"id" text PRIMARY KEY NOT NULL,
	"launch_id" text NOT NULL,
	"position" integer NOT NULL,
	"display_name" text NOT NULL,
	"handle" text NOT NULL,
	"handle_normalized" text GENERATED ALWAYS AS (lower(handle)) STORED,
	"role" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_team_member_position_ck" CHECK (position BETWEEN 0 AND 11),
	CONSTRAINT "showcase_launch_team_member_text_ck" CHECK (char_length(display_name) BETWEEN 1 AND 80
          AND char_length(role) BETWEEN 1 AND 60
          AND char_length(handle) BETWEEN 1 AND 64
          AND handle ~ '^[A-Za-z0-9_.-]+$')
);
--> statement-breakpoint
CREATE TABLE "showcase_launch_write_up_image" (
	"id" text PRIMARY KEY NOT NULL,
	"launch_id" text,
	"uploaded_by_user_id" text NOT NULL,
	"public_id" text NOT NULL,
	"url" text NOT NULL,
	"width_px" integer NOT NULL,
	"height_px" integer NOT NULL,
	"blur_data_url" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_write_up_image_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "showcase_launch_write_up_image_url_unique" UNIQUE("url"),
	CONSTRAINT "showcase_launch_write_up_image_dimensions_ck" CHECK (width_px BETWEEN 1 AND 8192 AND height_px BETWEEN 1 AND 8192),
	CONSTRAINT "showcase_launch_write_up_image_url_ck" CHECK (char_length(url) BETWEEN 1 AND 2048
          AND url LIKE 'https://%'
          AND url !~ '[[:space:][:cntrl:]]'),
	CONSTRAINT "showcase_launch_write_up_image_blur_ck" CHECK (char_length(blur_data_url) <= 2048
          AND left(blur_data_url, 23) = ('data:image/webp' || chr(59) || 'base64,')
          AND substr(blur_data_url, 24) ~ '^[A-Za-z0-9+/]+={0,2}$')
);
--> statement-breakpoint
ALTER TABLE "showcase_launch" ADD CONSTRAINT "showcase_launch_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch" ADD CONSTRAINT "showcase_launch_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_team_member" ADD CONSTRAINT "showcase_launch_team_member_launch_id_showcase_launch_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_write_up_image" ADD CONSTRAINT "showcase_launch_write_up_image_launch_id_showcase_launch_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_write_up_image" ADD CONSTRAINT "showcase_launch_write_up_image_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_launch_title_live_uidx" ON "showcase_launch" USING btree ("title_normalized") WHERE moderation_state IN ('pending_review', 'published');--> statement-breakpoint
CREATE INDEX "showcase_launch_author_idx" ON "showcase_launch" USING btree ("author_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "showcase_launch_review_queue_idx" ON "showcase_launch" USING btree ("created_at","id") WHERE moderation_state = 'pending_review';--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_launch_team_member_position_uidx" ON "showcase_launch_team_member" USING btree ("launch_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_launch_team_member_handle_uidx" ON "showcase_launch_team_member" USING btree ("launch_id","handle_normalized");--> statement-breakpoint
CREATE INDEX "showcase_launch_write_up_image_launch_idx" ON "showcase_launch_write_up_image" USING btree ("launch_id");--> statement-breakpoint
CREATE INDEX "showcase_launch_write_up_image_unclaimed_idx" ON "showcase_launch_write_up_image" USING btree ("uploaded_by_user_id","created_at") WHERE launch_id IS NULL;