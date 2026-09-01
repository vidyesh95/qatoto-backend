CREATE TYPE "public"."platform_feedback_category" AS ENUM('bug', 'idea', 'other');--> statement-breakpoint
CREATE TYPE "public"."platform_feedback_status" AS ENUM('new', 'reviewed', 'closed');--> statement-breakpoint
CREATE TABLE "platform_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"category" "platform_feedback_category" NOT NULL,
	"message" text NOT NULL,
	"page_path" text NOT NULL,
	"user_agent" text,
	"status" "platform_feedback_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "platform_feedback_message_ck" CHECK (char_length(message) BETWEEN 1 AND 2000),
	CONSTRAINT "platform_feedback_page_path_ck" CHECK (char_length(page_path) BETWEEN 1 AND 300 AND left(page_path, 1) = '/'),
	CONSTRAINT "platform_feedback_user_agent_ck" CHECK (user_agent IS NULL OR char_length(user_agent) BETWEEN 1 AND 512)
);
--> statement-breakpoint
ALTER TABLE "platform_feedback" ADD CONSTRAINT "platform_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_feedback_status_createdAt_idx" ON "platform_feedback" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "platform_feedback_userId_idx" ON "platform_feedback" USING btree ("user_id");