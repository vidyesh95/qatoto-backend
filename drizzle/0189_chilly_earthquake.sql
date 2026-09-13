CREATE TYPE "public"."teardown_file_source" AS ENUM('pasted_link', 'uploaded');--> statement-breakpoint
CREATE TYPE "public"."teardown_upload_format" AS ENUM('pdf', 'step', 'stl', 'dxf');--> statement-breakpoint
CREATE TABLE "teardown_submission_file_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"submission_id" text,
	"object_storage_key" text NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"format" "teardown_upload_format" NOT NULL,
	"original_file_name" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_submission_file_upload_object_storage_key_unique" UNIQUE("object_storage_key"),
	CONSTRAINT "teardown_submission_file_upload_scalars_ck" CHECK (byte_size > 0
          AND content_sha256 ~ '^[0-9a-f]{64}$'
          AND char_length(original_file_name) BETWEEN 1 AND 255),
	CONSTRAINT "teardown_submission_file_upload_key_ck" CHECK (char_length(object_storage_key) BETWEEN 1 AND 512
          AND object_storage_key !~ '[[:space:][:cntrl:]]'
          AND left(object_storage_key, 1) <> '/'
          AND object_storage_key !~ '\.\.'
          AND object_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.%-]*$')
);
--> statement-breakpoint
ALTER TABLE "teardown" DROP CONSTRAINT "teardown_slug_ck";--> statement-breakpoint
ALTER TABLE "teardown_document" DROP CONSTRAINT "teardown_document_url_ck";--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" DROP CONSTRAINT "teardown_manufacturing_file_url_ck";--> statement-breakpoint
ALTER TABLE "teardown_document" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teardown_document" ADD COLUMN "source" "teardown_file_source" DEFAULT 'pasted_link' NOT NULL;--> statement-breakpoint
ALTER TABLE "teardown_document" ADD COLUMN "object_storage_key" text;--> statement-breakpoint
ALTER TABLE "teardown_document" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ADD COLUMN "source" "teardown_file_source" DEFAULT 'pasted_link' NOT NULL;--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ADD COLUMN "object_storage_key" text;--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "teardown_submission_file_upload" ADD CONSTRAINT "teardown_submission_file_upload_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_submission_file_upload" ADD CONSTRAINT "teardown_submission_file_upload_submission_id_teardown_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."teardown_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teardown_submission_file_upload_submission_idx" ON "teardown_submission_file_upload" USING btree ("submission_id") WHERE submission_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "teardown_submission_file_upload_unclaimed_idx" ON "teardown_submission_file_upload" USING btree ("uploaded_by_user_id","created_at") WHERE submission_id IS NULL;--> statement-breakpoint
ALTER TABLE "teardown" ADD CONSTRAINT "teardown_slug_ck" CHECK (char_length(slug) BETWEEN 3 AND 120
          AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND slug NOT IN ('teardowns', 'showcase', 'case-studies', 'new', 'slugs', 'options',
                           'mine', 'uploads'));--> statement-breakpoint
ALTER TABLE "teardown_document" ADD CONSTRAINT "teardown_document_source_ck" CHECK ((source = 'pasted_link'
           AND url IS NOT NULL
           AND object_storage_key IS NULL
           AND content_sha256 IS NULL)
       OR (source = 'uploaded'
           AND url IS NULL
           AND object_storage_key IS NOT NULL
           AND content_sha256 IS NOT NULL
           AND byte_size IS NOT NULL));--> statement-breakpoint
ALTER TABLE "teardown_document" ADD CONSTRAINT "teardown_document_object_key_ck" CHECK ((object_storage_key IS NULL OR (
            char_length(object_storage_key) BETWEEN 1 AND 512
            AND object_storage_key !~ '[[:space:][:cntrl:]]'
            AND left(object_storage_key, 1) <> '/'
            AND object_storage_key !~ '\.\.'
            AND object_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.%-]*$'))
       AND (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "teardown_document" ADD CONSTRAINT "teardown_document_url_ck" CHECK (url IS NULL OR (char_length(url) BETWEEN 1 AND 2048
          AND url !~ '[[:space:][:cntrl:]]'
          AND (url LIKE 'https://%'
               OR (left(url, 1) = '/'
                   AND left(url, 2) <> '//'
                   AND left(url, 2) <> ('/' || chr(92))))));--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ADD CONSTRAINT "teardown_manufacturing_file_source_ck" CHECK ((source = 'pasted_link'
           AND url IS NOT NULL
           AND object_storage_key IS NULL
           AND content_sha256 IS NULL)
       OR (source = 'uploaded'
           AND url IS NULL
           AND object_storage_key IS NOT NULL
           AND content_sha256 IS NOT NULL
           AND byte_size IS NOT NULL));--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ADD CONSTRAINT "teardown_manufacturing_file_object_key_ck" CHECK ((object_storage_key IS NULL OR (
            char_length(object_storage_key) BETWEEN 1 AND 512
            AND object_storage_key !~ '[[:space:][:cntrl:]]'
            AND left(object_storage_key, 1) <> '/'
            AND object_storage_key !~ '\.\.'
            AND object_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.%-]*$'))
       AND (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "teardown_manufacturing_file" ADD CONSTRAINT "teardown_manufacturing_file_url_ck" CHECK (url IS NULL OR (char_length(url) BETWEEN 1 AND 2048
          AND url !~ '[[:space:][:cntrl:]]'
          AND (url LIKE 'https://%'
               OR (left(url, 1) = '/'
                   AND left(url, 2) <> '//'
                   AND left(url, 2) <> ('/' || chr(92))))));