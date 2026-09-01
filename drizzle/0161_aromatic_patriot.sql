CREATE TYPE "public"."support_case_author_kind" AS ENUM('case_opener', 'staff');--> statement-breakpoint
CREATE TYPE "public"."support_case_category" AS ENUM('payment_problem', 'order_problem', 'account_problem', 'content_problem', 'technical_problem', 'other');--> statement-breakpoint
CREATE TYPE "public"."support_case_state" AS ENUM('open', 'awaiting_user', 'resolved', 'closed');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'support_case_opened';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'support_case_replied';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'support_case_decided';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'support_case_resolved';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'support_case_closed';--> statement-breakpoint
CREATE TABLE "support_case" (
	"id" text PRIMARY KEY NOT NULL,
	"opened_by_user_id" text NOT NULL,
	"category" "support_case_category" NOT NULL,
	"state" "support_case_state" DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"order_reference" text,
	"decided_by_user_id" text,
	"decision_note" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	CONSTRAINT "support_case_subject_ck" CHECK (char_length(subject) BETWEEN 1 AND 200),
	CONSTRAINT "support_case_description_ck" CHECK (char_length(description) BETWEEN 1 AND 4000),
	CONSTRAINT "support_case_order_reference_ck" CHECK (order_reference IS NULL OR char_length(order_reference) BETWEEN 1 AND 100),
	CONSTRAINT "support_case_decision_note_ck" CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 2000),
	CONSTRAINT "support_case_decision_ck" CHECK ((state IN ('resolved', 'closed'))
          = (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "support_case_message" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"author_kind" "support_case_author_kind" NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_message_sequence_ck" CHECK (sequence >= 1),
	CONSTRAINT "support_case_message_body_ck" CHECK (char_length(body) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_opened_by_user_id_user_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_message" ADD CONSTRAINT "support_case_message_case_id_support_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_message" ADD CONSTRAINT "support_case_message_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_case_opener_createdAt_idx" ON "support_case" USING btree ("opened_by_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "support_case_state_createdAt_idx" ON "support_case" USING btree ("state","created_at","id");--> statement-breakpoint
CREATE INDEX "support_case_category_state_idx" ON "support_case" USING btree ("category","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_case_message_sequence_uidx" ON "support_case_message" USING btree ("case_id","sequence");