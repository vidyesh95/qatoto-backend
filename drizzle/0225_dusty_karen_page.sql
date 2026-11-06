ALTER TYPE "public"."notification_kind" ADD VALUE 'daily_log_reminder';--> statement-breakpoint
CREATE TABLE "daily_log_reminder_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"time_zone" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_log_reminder_preference_time_zone_ck" CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "daily_log_reminder_send" (
	"project_member_id" text NOT NULL,
	"reminder_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_log_reminder_send_project_member_id_reminder_date_pk" PRIMARY KEY("project_member_id","reminder_date")
);
--> statement-breakpoint
ALTER TABLE "daily_log_reminder_preference" ADD CONSTRAINT "daily_log_reminder_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_log_reminder_send" ADD CONSTRAINT "daily_log_reminder_send_project_member_id_project_member_id_fk" FOREIGN KEY ("project_member_id") REFERENCES "public"."project_member"("id") ON DELETE cascade ON UPDATE no action;