CREATE TABLE "recovery_email_otp" (
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"candidate_email" text NOT NULL,
	"otp_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_email_otp_user_id_purpose_pk" PRIMARY KEY("user_id","purpose")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "recovery_email" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "recovery_email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "recovery_email_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "recovery_email_otp" ADD CONSTRAINT "recovery_email_otp_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;