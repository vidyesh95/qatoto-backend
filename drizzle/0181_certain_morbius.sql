CREATE TABLE "case_study_like" (
	"case_study_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "case_study_like_case_study_id_user_id_pk" PRIMARY KEY("case_study_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "case_study_view_session" (
	"id" text PRIMARY KEY NOT NULL,
	"case_study_id" text NOT NULL,
	"viewer_user_id" text,
	"viewer_fingerprint" text NOT NULL,
	"view_day_bucket" date NOT NULL,
	"first_seen_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "case_study_view_session_fingerprint_ck" CHECK (viewer_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "showcase_launch_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"launch_id" text NOT NULL,
	"parent_comment_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"author_user_id" text,
	"body_text" text NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_comment_depth_ck" CHECK (depth BETWEEN 0 AND 1 AND (depth = 0) = (parent_comment_id IS NULL)),
	CONSTRAINT "showcase_launch_comment_leaf_ck" CHECK (depth = 0 OR reply_count = 0),
	CONSTRAINT "showcase_launch_comment_counts_ck" CHECK (like_count >= 0 AND reply_count >= 0),
	CONSTRAINT "showcase_launch_comment_deleted_ck" CHECK (is_deleted = (deleted_at IS NOT NULL)),
	CONSTRAINT "showcase_launch_comment_body_ck" CHECK ((is_deleted = false AND char_length(body_text) BETWEEN 1 AND 2000)
          OR (is_deleted = true AND body_text = ''))
);
--> statement-breakpoint
CREATE TABLE "showcase_launch_comment_like" (
	"comment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_comment_like_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "showcase_launch_like" (
	"launch_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_like_launch_id_user_id_pk" PRIMARY KEY("launch_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "showcase_launch_upvote" (
	"launch_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_upvote_launch_id_user_id_pk" PRIMARY KEY("launch_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "showcase_launch_view_session" (
	"id" text PRIMARY KEY NOT NULL,
	"launch_id" text NOT NULL,
	"viewer_user_id" text,
	"viewer_fingerprint" text NOT NULL,
	"view_day_bucket" date NOT NULL,
	"first_seen_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_launch_view_session_fingerprint_ck" CHECK (viewer_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "teardown_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"parent_comment_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"author_user_id" text,
	"body_text" text NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_comment_depth_ck" CHECK (depth BETWEEN 0 AND 1 AND (depth = 0) = (parent_comment_id IS NULL)),
	CONSTRAINT "teardown_comment_leaf_ck" CHECK (depth = 0 OR reply_count = 0),
	CONSTRAINT "teardown_comment_counts_ck" CHECK (like_count >= 0 AND reply_count >= 0),
	CONSTRAINT "teardown_comment_deleted_ck" CHECK (is_deleted = (deleted_at IS NOT NULL)),
	CONSTRAINT "teardown_comment_body_ck" CHECK ((is_deleted = false AND char_length(body_text) BETWEEN 1 AND 2000)
          OR (is_deleted = true AND body_text = ''))
);
--> statement-breakpoint
CREATE TABLE "teardown_comment_like" (
	"comment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_comment_like_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teardown_like" (
	"teardown_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_like_teardown_id_user_id_pk" PRIMARY KEY("teardown_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teardown_save" (
	"teardown_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_save_teardown_id_user_id_pk" PRIMARY KEY("teardown_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teardown_view_session" (
	"id" text PRIMARY KEY NOT NULL,
	"teardown_id" text NOT NULL,
	"viewer_user_id" text,
	"viewer_fingerprint" text NOT NULL,
	"view_day_bucket" date NOT NULL,
	"first_seen_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "teardown_view_session_fingerprint_ck" CHECK (viewer_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "case_study_like" ADD CONSTRAINT "case_study_like_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_like" ADD CONSTRAINT "case_study_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_view_session" ADD CONSTRAINT "case_study_view_session_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_view_session" ADD CONSTRAINT "case_study_view_session_viewer_user_id_user_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_comment" ADD CONSTRAINT "showcase_launch_comment_launch_id_showcase_launch_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_comment" ADD CONSTRAINT "showcase_launch_comment_parent_comment_id_showcase_launch_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."showcase_launch_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_comment" ADD CONSTRAINT "showcase_launch_comment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_comment_like" ADD CONSTRAINT "showcase_launch_comment_like_comment_id_showcase_launch_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."showcase_launch_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_comment_like" ADD CONSTRAINT "showcase_launch_comment_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_like" ADD CONSTRAINT "showcase_launch_like_launch_id_showcase_launch_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_like" ADD CONSTRAINT "showcase_launch_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_upvote" ADD CONSTRAINT "showcase_launch_upvote_launch_id_showcase_launch_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_upvote" ADD CONSTRAINT "showcase_launch_upvote_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_view_session" ADD CONSTRAINT "showcase_launch_view_session_launch_id_showcase_launch_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."showcase_launch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showcase_launch_view_session" ADD CONSTRAINT "showcase_launch_view_session_viewer_user_id_user_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_comment" ADD CONSTRAINT "teardown_comment_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_comment" ADD CONSTRAINT "teardown_comment_parent_comment_id_teardown_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."teardown_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_comment" ADD CONSTRAINT "teardown_comment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_comment_like" ADD CONSTRAINT "teardown_comment_like_comment_id_teardown_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."teardown_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_comment_like" ADD CONSTRAINT "teardown_comment_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_like" ADD CONSTRAINT "teardown_like_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_like" ADD CONSTRAINT "teardown_like_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_save" ADD CONSTRAINT "teardown_save_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_save" ADD CONSTRAINT "teardown_save_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_view_session" ADD CONSTRAINT "teardown_view_session_teardown_id_teardown_id_fk" FOREIGN KEY ("teardown_id") REFERENCES "public"."teardown"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teardown_view_session" ADD CONSTRAINT "teardown_view_session_viewer_user_id_user_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_study_like_userId_idx" ON "case_study_like" USING btree ("user_id","case_study_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_view_session_unq" ON "case_study_view_session" USING btree ("case_study_id","viewer_fingerprint","view_day_bucket");--> statement-breakpoint
CREATE INDEX "case_study_view_session_target_idx" ON "case_study_view_session" USING btree ("case_study_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "case_study_view_session_viewer_idx" ON "case_study_view_session" USING btree ("viewer_user_id") WHERE viewer_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "showcase_launch_comment_thread_idx" ON "showcase_launch_comment" USING btree ("launch_id","created_at","id") WHERE parent_comment_id IS NULL;--> statement-breakpoint
CREATE INDEX "showcase_launch_comment_parent_idx" ON "showcase_launch_comment" USING btree ("parent_comment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "showcase_launch_comment_author_idx" ON "showcase_launch_comment" USING btree ("author_user_id","id");--> statement-breakpoint
CREATE INDEX "showcase_launch_comment_like_userId_idx" ON "showcase_launch_comment_like" USING btree ("user_id","comment_id");--> statement-breakpoint
CREATE INDEX "showcase_launch_like_userId_idx" ON "showcase_launch_like" USING btree ("user_id","launch_id");--> statement-breakpoint
CREATE INDEX "showcase_launch_upvote_userId_idx" ON "showcase_launch_upvote" USING btree ("user_id","launch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_launch_view_session_unq" ON "showcase_launch_view_session" USING btree ("launch_id","viewer_fingerprint","view_day_bucket");--> statement-breakpoint
CREATE INDEX "showcase_launch_view_session_target_idx" ON "showcase_launch_view_session" USING btree ("launch_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "showcase_launch_view_session_viewer_idx" ON "showcase_launch_view_session" USING btree ("viewer_user_id") WHERE viewer_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "teardown_comment_thread_idx" ON "teardown_comment" USING btree ("teardown_id","created_at","id") WHERE parent_comment_id IS NULL;--> statement-breakpoint
CREATE INDEX "teardown_comment_parent_idx" ON "teardown_comment" USING btree ("parent_comment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "teardown_comment_author_idx" ON "teardown_comment" USING btree ("author_user_id","id");--> statement-breakpoint
CREATE INDEX "teardown_comment_like_userId_idx" ON "teardown_comment_like" USING btree ("user_id","comment_id");--> statement-breakpoint
CREATE INDEX "teardown_like_userId_idx" ON "teardown_like" USING btree ("user_id","teardown_id");--> statement-breakpoint
CREATE INDEX "teardown_save_userId_idx" ON "teardown_save" USING btree ("user_id","created_at","teardown_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teardown_view_session_unq" ON "teardown_view_session" USING btree ("teardown_id","viewer_fingerprint","view_day_bucket");--> statement-breakpoint
CREATE INDEX "teardown_view_session_target_idx" ON "teardown_view_session" USING btree ("teardown_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "teardown_view_session_viewer_idx" ON "teardown_view_session" USING btree ("viewer_user_id") WHERE viewer_user_id IS NOT NULL;