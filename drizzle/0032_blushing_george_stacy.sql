ALTER TYPE "public"."notification_kind" ADD VALUE 'platform_role_change_proposed';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'platform_role_changed';--> statement-breakpoint
CREATE TABLE "platform_role_grant_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_user_id" text NOT NULL,
	"previous_platform_role" "platform_role",
	"next_platform_role" "platform_role",
	"proposed_by_user_id" text NOT NULL,
	"proposed_at" timestamp DEFAULT now() NOT NULL,
	"propose_note" text DEFAULT '' NOT NULL,
	"countersigned_at" timestamp,
	"countersigned_by_user_id" text,
	"countersign_note" text DEFAULT '' NOT NULL,
	"cancelled_at" timestamp,
	"cancelled_by_user_id" text,
	CONSTRAINT "platform_role_grant_proposal_decision_ck" CHECK ((countersigned_at IS NULL) = (countersigned_by_user_id IS NULL)
          AND (cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)
          AND NOT (countersigned_at IS NOT NULL AND cancelled_at IS NOT NULL)),
	CONSTRAINT "platform_role_grant_proposal_four_eyes_ck" CHECK (subject_user_id <> proposed_by_user_id
          AND (countersigned_by_user_id IS NULL
               OR countersigned_by_user_id IS DISTINCT FROM proposed_by_user_id)
          AND (countersigned_by_user_id IS NULL
               OR countersigned_by_user_id IS DISTINCT FROM subject_user_id)),
	CONSTRAINT "platform_role_grant_proposal_transition_ck" CHECK (next_platform_role IS DISTINCT FROM previous_platform_role
          AND char_length(propose_note) <= 2000
          AND char_length(countersign_note) <= 2000)
);
--> statement-breakpoint
ALTER TABLE "platform_role_grant_proposal" ADD CONSTRAINT "platform_role_grant_proposal_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_grant_proposal" ADD CONSTRAINT "platform_role_grant_proposal_proposed_by_user_id_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_grant_proposal" ADD CONSTRAINT "platform_role_grant_proposal_countersigned_by_user_id_user_id_fk" FOREIGN KEY ("countersigned_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_grant_proposal" ADD CONSTRAINT "platform_role_grant_proposal_cancelled_by_user_id_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_role_grant_proposal_subject_idx" ON "platform_role_grant_proposal" USING btree ("subject_user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_role_grant_proposal_one_pending_unq" ON "platform_role_grant_proposal" USING btree ("subject_user_id") WHERE countersigned_at IS NULL AND cancelled_at IS NULL;