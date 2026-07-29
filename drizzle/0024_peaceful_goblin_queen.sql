-- ---------------------------------------------------------------------------
-- 0024 — notifications (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 1).
--
-- WHAT THIS CLOSES. Every state transition concerning someone other than the actor
-- was discoverable only by that person deciding to look: an invite by opening
-- `/invites/mine`, a finalized statement of what they are owed by refreshing. Two
-- comments in `src/middleware/rate-limit.ts` already justified their limits by
-- reference to notifications that did not exist.
--
-- WHAT IT DELIBERATELY DOES NOT HAVE.
--   * No prose column. `kind` + `payload_json` of ids and integers; the client
--     renders the sentence, because server prose ships one language and one
--     currency format to three first-class clients (§1, §4d).
--   * No `jsonb`. jsonb reorders keys, and a payload that reorders is one a client
--     cannot diff and a test cannot fixture — the same call `project_audit_entry`
--     made and recorded.
--   * No append-only trigger. A notification is a courtesy, not evidence: it is
--     marked read, and it dies with its recipient. That is why `recipient_user_id`
--     is `cascade` where every audit FK is `restrict`.
--   * No per-recipient preference table. There is one channel that always applies
--     (in-app) and one that is best-effort (email); a preference matrix before
--     anyone has asked for one is a schema nobody can retire.
--
-- `email_status` distinguishes `skipped_unconfigured` from `failed` on purpose. A
-- deployment with no BREVO_API_KEY is not a delivery failure, and a row that said it
-- was would send an operator looking for an outage — the same distinction
-- `daily_log_analysis_status` draws for a missing Gemini key.
--
-- ONE MIGRATION, not two: `notification_kind` is a NEW type, and the two-migration
-- rule (0019, 0022) applies only to `ALTER TYPE … ADD VALUE`, which cannot be USED in
-- the transaction that created it. Nothing here references a value it just added.
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."notification_email_status" AS ENUM('queued', 'sent', 'skipped_unconfigured', 'failed');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('project_invite_received', 'project_invite_revoked', 'project_invite_accepted', 'project_invite_declined', 'project_application_received', 'project_application_accepted', 'project_application_declined', 'compensation_agreement_proposed', 'compensation_agreement_accepted', 'compensation_agreement_declined', 'compensation_agreement_withdrawn', 'compensation_period_finalized', 'compensation_period_countersigned', 'compensation_period_superseded', 'compensation_payment_recorded', 'compensation_payment_confirmed', 'dispute_raised', 'dispute_resolved', 'effort_claim_verdict_reached');--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_user_id" text NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"project_id" text,
	"actor_user_id" text,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"read_at" timestamp,
	"email_status" "notification_email_status" DEFAULT 'queued' NOT NULL,
	"email_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_payload_ck" CHECK (char_length(payload_json) BETWEEN 2 AND 4000 AND payload_json LIKE '{%'),
	CONSTRAINT "notification_email_sent_ck" CHECK ((email_status = 'sent') = (email_sent_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_recipientUserId_createdAt_idx" ON "notification" USING btree ("recipient_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notification_recipientUserId_unread_idx" ON "notification" USING btree ("recipient_user_id","created_at","id") WHERE read_at IS NULL;--> statement-breakpoint
CREATE INDEX "notification_projectId_idx" ON "notification" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "notification_emailStatus_idx" ON "notification" USING btree ("email_status","created_at");