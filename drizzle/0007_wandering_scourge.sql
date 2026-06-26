DROP TABLE "recovery_email_otp" CASCADE;--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "recovery_email";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "recovery_email_verified";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "recovery_email_updated_at";