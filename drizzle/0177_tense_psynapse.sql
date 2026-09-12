CREATE TABLE "teardown_part_listing" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"material" text NOT NULL,
	CONSTRAINT "teardown_part_listing_position_uidx" UNIQUE("teardown_id","position"),
	CONSTRAINT "teardown_part_listing_scalars_ck" CHECK (position >= 0
          AND char_length(label) BETWEEN 1 AND 120
          AND char_length(material) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "teardown_submission" (
	"id" text PRIMARY KEY NOT NULL,
	"author_user_id" text NOT NULL,
	"title" text NOT NULL,
	"subject_product_name" text NOT NULL,
	"subject_product_name_normalized" text GENERATED ALWAYS AS (lower(regexp_replace(btrim(subject_product_name), '[[:space:]]+', ' ', 'g'))) STORED,
	"document_json" text NOT NULL,
	"document_schema_version" integer NOT NULL,
	"moderation_state" "blueprint_moderation_state" DEFAULT 'pending_review' NOT NULL,
	"moderator_note" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp (3),
	"published_teardown_id" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_submission_published_teardown_id_unique" UNIQUE("published_teardown_id"),
	CONSTRAINT "teardown_submission_moderation_state_ck" CHECK (moderation_state IN ('pending_review', 'published', 'rejected')),
	CONSTRAINT "teardown_submission_decision_ck" CHECK ((moderation_state = 'pending_review') = (reviewed_at IS NULL)
          AND (reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
          AND (moderation_state <> 'pending_review' OR moderator_note IS NULL)
          AND (moderation_state <> 'rejected' OR moderator_note IS NOT NULL)
          AND (moderation_state = 'published') = (published_teardown_id IS NOT NULL)),
	CONSTRAINT "teardown_submission_text_ck" CHECK (char_length(title) BETWEEN 8 AND 160
          AND char_length(subject_product_name) BETWEEN 1 AND 200),
	CONSTRAINT "teardown_submission_moderator_note_ck" CHECK (moderator_note IS NULL OR char_length(moderator_note) BETWEEN 1 AND 2000),
	CONSTRAINT "teardown_submission_document_ck" CHECK (char_length(document_json) BETWEEN 2 AND 262144 AND left(document_json, 1) = '{'),
	CONSTRAINT "teardown_submission_document_version_ck" CHECK (document_schema_version >= 1)
);
--> statement-breakpoint
ALTER TABLE "teardown" DROP CONSTRAINT "teardown_slug_ck";--> statement-breakpoint
ALTER TABLE "teardown_document" DROP CONSTRAINT "teardown_document_scalars_ck";--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" DROP CONSTRAINT "teardown_manufacturing_file_scalars_ck";--> statement-breakpoint
ALTER TABLE "teardown_document" ALTER COLUMN "byte_size" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ALTER COLUMN "byte_size" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teardown" ADD COLUMN "author_user_id" text;--> statement-breakpoint
ALTER TABLE "teardown_part_listing" ADD CONSTRAINT "teardown_part_listing_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_submission" ADD CONSTRAINT "teardown_submission_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_submission" ADD CONSTRAINT "teardown_submission_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_submission" ADD CONSTRAINT "teardown_submission_published_teardown_id_teardown_id_fk" FOREIGN KEY ("published_teardown_id") REFERENCES "public"."teardown"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "teardown_submission_subject_live_uidx" ON "teardown_submission" USING btree ("subject_product_name_normalized") WHERE moderation_state IN ('pending_review', 'published');--> statement-breakpoint
CREATE INDEX "teardown_submission_author_idx" ON "teardown_submission" USING btree ("author_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "teardown_submission_review_queue_idx" ON "teardown_submission" USING btree ("created_at","id") WHERE moderation_state = 'pending_review';--> statement-breakpoint
ALTER TABLE "teardown" ADD CONSTRAINT "teardown_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teardown_author_idx" ON "teardown" USING btree ("author_user_id","created_at","id");--> statement-breakpoint
ALTER TABLE "teardown" ADD CONSTRAINT "teardown_slug_ck" CHECK (char_length(slug) BETWEEN 3 AND 120
          AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND slug NOT IN ('teardowns', 'showcase', 'case-studies', 'new', 'slugs', 'options',
                           'mine'));--> statement-breakpoint
ALTER TABLE "teardown_document" ADD CONSTRAINT "teardown_document_scalars_ck" CHECK ((byte_size IS NULL OR byte_size >= 0)
          AND position >= 0
          AND (page_count IS NULL OR page_count > 0)
          AND char_length(title) BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ADD CONSTRAINT "teardown_manufacturing_file_scalars_ck" CHECK ((byte_size IS NULL OR byte_size > 0)
          AND position >= 0
          AND char_length(title) BETWEEN 1 AND 200);