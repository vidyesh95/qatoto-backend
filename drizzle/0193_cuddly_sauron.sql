CREATE TYPE "public"."blueprint_draft_arm" AS ENUM('teardown', 'showcase_launch', 'case_study');--> statement-breakpoint
CREATE TABLE "blueprint_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"arm" "blueprint_draft_arm" NOT NULL,
	"label" text,
	"document_json" text NOT NULL,
	"document_schema_version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "blueprint_draft_document_ck" CHECK (char_length(document_json) BETWEEN 2 AND 262144 AND left(document_json, 1) = '{'),
	CONSTRAINT "blueprint_draft_scalars_ck" CHECK (document_schema_version >= 1
          AND revision >= 1
          AND (label IS NULL OR char_length(label) BETWEEN 1 AND 200))
);
--> statement-breakpoint
DROP INDEX "showcase_launch_write_up_image_unclaimed_idx";--> statement-breakpoint
ALTER TABLE "showcase_launch_write_up_image" ADD COLUMN "draft_id" text;--> statement-breakpoint
ALTER TABLE "blueprint_draft" ADD CONSTRAINT "blueprint_draft_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blueprint_draft_owner_idx" ON "blueprint_draft" USING btree ("owner_user_id","arm","updated_at","id");--> statement-breakpoint
CREATE INDEX "blueprint_draft_stale_idx" ON "blueprint_draft" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "showcase_launch_write_up_image" ADD CONSTRAINT "showcase_launch_write_up_image_draft_id_blueprint_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."blueprint_draft"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "showcase_launch_write_up_image_unclaimed_idx" ON "showcase_launch_write_up_image" USING btree ("uploaded_by_user_id","created_at") WHERE launch_id IS NULL AND draft_id IS NULL;