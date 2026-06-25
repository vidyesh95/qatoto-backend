CREATE TABLE "handle_reservations" (
	"reserved_handle" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "handle_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "handle_change_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "handle_window_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "handle_reservations" ADD CONSTRAINT "handle_reservations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handle_reservations_userId_idx" ON "handle_reservations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "handle_reservations_expiresAt_idx" ON "handle_reservations" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_handle_unique" UNIQUE("handle");