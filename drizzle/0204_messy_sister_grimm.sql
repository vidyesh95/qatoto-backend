CREATE TABLE "problem_submission_photo" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text,
	"uploaded_by_user_id" text NOT NULL,
	"public_id" text NOT NULL,
	"url" text NOT NULL,
	"width_px" integer NOT NULL,
	"height_px" integer NOT NULL,
	"blur_data_url" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "problem_submission_photo_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "problem_submission_photo_url_unique" UNIQUE("url"),
	CONSTRAINT "problem_submission_photo_dimensions_ck" CHECK (width_px BETWEEN 1 AND 8192 AND height_px BETWEEN 1 AND 8192),
	CONSTRAINT "problem_submission_photo_url_ck" CHECK (char_length(url) BETWEEN 1 AND 2048
          AND url LIKE 'https://%'
          AND url !~ '[[:space:][:cntrl:]]'),
	CONSTRAINT "problem_submission_photo_blur_ck" CHECK (char_length(blur_data_url) <= 2048
          AND left(blur_data_url, 23) = ('data:image/webp' || chr(59) || 'base64,')
          AND substr(blur_data_url, 24) ~ '^[A-Za-z0-9+/]+={0,2}$')
);
--> statement-breakpoint
ALTER TABLE "problem_submission_photo" ADD CONSTRAINT "problem_submission_photo_submission_id_problem_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."problem_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_submission_photo" ADD CONSTRAINT "problem_submission_photo_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "problem_submission_photo_submission_idx" ON "problem_submission_photo" USING btree ("submission_id","created_at","id");--> statement-breakpoint
CREATE INDEX "problem_submission_photo_unclaimed_idx" ON "problem_submission_photo" USING btree ("uploaded_by_user_id","created_at") WHERE submission_id IS NULL;