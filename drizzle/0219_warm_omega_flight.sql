-- todo §7: terms acceptance. `user_terms_acceptance` records every acceptance (append-only,
-- retained on erasure as a legal-claims record); `user.terms_version` / `terms_accepted_at` hold the
-- latest for the session. All existing users start NULL and are asked by the in-app banner.
-- Generated; no hand edits.
CREATE TYPE "public"."user_terms_acceptance_surface" AS ENUM('email_sign_up', 'in_app_banner');--> statement-breakpoint
CREATE TABLE "user_terms_acceptance" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"terms_version" text NOT NULL,
	"acceptance_surface" "user_terms_acceptance_surface" NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_terms_acceptance_version_ck" CHECK (char_length(terms_version) BETWEEN 1 AND 32)
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "terms_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_terms_acceptance" ADD CONSTRAINT "user_terms_acceptance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_terms_acceptance_user_idx" ON "user_terms_acceptance" USING btree ("user_id","accepted_at");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_terms_acceptance_pair_ck" CHECK ((terms_version IS NULL AND terms_accepted_at IS NULL)
          OR (terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL
              AND char_length(terms_version) BETWEEN 1 AND 32));