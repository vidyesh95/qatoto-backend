CREATE TYPE "public"."promotional_destination_kind" AS ENUM('internal_path', 'external_url');--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'promotional_slide_created';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'promotional_slide_updated';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'promotional_slide_reordered';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'promotional_slide_image_replaced';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'promotional_slide_deleted';--> statement-breakpoint
CREATE TABLE "promotional_slide" (
	"id" text PRIMARY KEY NOT NULL,
	"image_url" text NOT NULL,
	"image_width_px" integer NOT NULL,
	"image_height_px" integer NOT NULL,
	"alt_text" text NOT NULL,
	"destination_kind" "promotional_destination_kind" NOT NULL,
	"destination_value" text NOT NULL,
	"position" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "promotional_slide_position_ck" CHECK (position >= 0),
	CONSTRAINT "promotional_slide_alt_text_ck" CHECK (char_length(alt_text) BETWEEN 1 AND 200),
	CONSTRAINT "promotional_slide_image_url_ck" CHECK (char_length(image_url) <= 2048 AND image_url LIKE 'https://%'),
	CONSTRAINT "promotional_slide_image_dimensions_ck" CHECK (image_width_px BETWEEN 1 AND 8192 AND image_height_px BETWEEN 1 AND 8192),
	CONSTRAINT "promotional_slide_window_ck" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
	CONSTRAINT "promotional_slide_destination_ck" CHECK ((destination_kind = 'internal_path'
             AND char_length(destination_value) BETWEEN 1 AND 512
             AND destination_value LIKE '/%'
             AND destination_value NOT LIKE '//%'
             AND destination_value !~ '[[:space:][:cntrl:]]')
          OR (destination_kind = 'external_url'
             AND char_length(destination_value) BETWEEN 1 AND 2048
             AND destination_value LIKE 'https://%'
             AND destination_value !~ '[[:space:][:cntrl:]]'))
);
--> statement-breakpoint
ALTER TABLE "promotional_slide" ADD CONSTRAINT "promotional_slide_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotional_slide" ADD CONSTRAINT "promotional_slide_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promotional_slide_live_idx" ON "promotional_slide" USING btree ("position","id") WHERE is_active;--> statement-breakpoint
CREATE INDEX "promotional_slide_position_idx" ON "promotional_slide" USING btree ("position","id");