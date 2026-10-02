-- 0213: Premium AI. One table, `assistant_cloud_entitlement`: which accounts may ask the AI
-- assistant through the cloud route (POST /assistant/replies, Google Gemini). Staff-granted by
-- admins holding `grant_ai_assistant_cloud` (a TypeScript capability, no enum change). Revoking
-- stamps revoked_at and keeps the row; the partial unique index allows one ACTIVE grant per user.
-- Additive only: no existing table, column or enum is touched.
CREATE TABLE "assistant_cloud_entitlement" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"granted_by_user_id" text,
	"granted_at" timestamp (3) DEFAULT now() NOT NULL,
	"note" text,
	"revoked_at" timestamp (3),
	"revoked_by_user_id" text,
	CONSTRAINT "assistant_cloud_entitlement_note_ck" CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200),
	CONSTRAINT "assistant_cloud_entitlement_revocation_ck" CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
--> statement-breakpoint
ALTER TABLE "assistant_cloud_entitlement" ADD CONSTRAINT "assistant_cloud_entitlement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_cloud_entitlement" ADD CONSTRAINT "assistant_cloud_entitlement_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_cloud_entitlement" ADD CONSTRAINT "assistant_cloud_entitlement_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_cloud_entitlement_active_user_unq" ON "assistant_cloud_entitlement" USING btree ("user_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "assistant_cloud_entitlement_grantedAt_idx" ON "assistant_cloud_entitlement" USING btree ("granted_at","id");