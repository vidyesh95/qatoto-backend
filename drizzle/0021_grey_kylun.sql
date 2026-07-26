ALTER TABLE "daily_log" ALTER COLUMN "submitted_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "workshop_chat_message" ALTER COLUMN "sent_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "workshop_chat_message" ALTER COLUMN "sent_at" SET DEFAULT now();