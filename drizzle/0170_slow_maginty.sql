CREATE TABLE "showcase_launch_stats" (
	"launch_id" text PRIMARY KEY NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"upvote_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_stats_nonnegative_ck" CHECK (view_count >= 0 AND like_count >= 0 AND upvote_count >= 0 AND comment_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "showcase_launch_stats" ADD CONSTRAINT "showcase_launch_stats_launch_id_showcase_launch_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "showcase_launch_stats_top_idx" ON "showcase_launch_stats" USING btree ("upvote_count" desc,"launch_id");--> statement-breakpoint
CREATE INDEX "showcase_launch_public_newest_idx" ON "showcase_launch" USING btree ("launched_at" desc,"id") WHERE moderation_state = 'published';