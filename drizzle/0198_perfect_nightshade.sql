CREATE TABLE "showcase_launch_heading_image" (
	"id" text PRIMARY KEY NOT NULL,
	"launch_id" text,
	"draft_id" text,
	"uploaded_by_user_id" text NOT NULL,
	"public_id" text NOT NULL,
	"url" text NOT NULL,
	"width_px" integer NOT NULL,
	"height_px" integer NOT NULL,
	"blur_data_url" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_heading_image_asset_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "showcase_launch_heading_image_url_unique" UNIQUE("url"),
	CONSTRAINT "showcase_launch_heading_image_dimensions_ck" CHECK (width_px BETWEEN 1 AND 8192 AND height_px BETWEEN 1 AND 8192),
	CONSTRAINT "showcase_launch_heading_image_url_ck" CHECK (char_length(url) BETWEEN 1 AND 2048
          AND url LIKE 'https://%'
          AND url !~ '[[:space:][:cntrl:]]'),
	CONSTRAINT "showcase_launch_heading_image_blur_ck" CHECK (char_length(blur_data_url) <= 2048
          AND left(blur_data_url, 23) = ('data:image/webp' || chr(59) || 'base64,')
          AND substr(blur_data_url, 24) ~ '^[A-Za-z0-9+/]+={0,2}$')
);
--> statement-breakpoint
ALTER TABLE "showcase_launch_heading_image" ADD CONSTRAINT "showcase_launch_heading_image_launch_id_showcase_launch_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_heading_image" ADD CONSTRAINT "showcase_launch_heading_image_draft_id_blueprint_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."blueprint_draft"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_heading_image" ADD CONSTRAINT "showcase_launch_heading_image_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "showcase_launch_heading_image_launch_idx" ON "showcase_launch_heading_image" USING btree ("launch_id");--> statement-breakpoint
CREATE INDEX "showcase_launch_heading_image_unclaimed_idx" ON "showcase_launch_heading_image" USING btree ("uploaded_by_user_id","created_at") WHERE launch_id IS NULL AND draft_id IS NULL;