ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'spotlight_slots_replaced';--> statement-breakpoint
CREATE TABLE "feed_spotlight_slot" (
	"id" text PRIMARY KEY NOT NULL,
	"position" integer NOT NULL,
	"video_id" text NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feed_spotlight_slot_position_ck" CHECK (position >= 0 AND position <= 2)
);
--> statement-breakpoint
ALTER TABLE "feed_spotlight_slot" ADD CONSTRAINT "feed_spotlight_slot_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_spotlight_slot" ADD CONSTRAINT "feed_spotlight_slot_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_spotlight_slot_position_uidx" ON "feed_spotlight_slot" USING btree ("position");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_spotlight_slot_video_uidx" ON "feed_spotlight_slot" USING btree ("video_id");