-- ---------------------------------------------------------------------------
-- 0025 — the PLATFORM audit chain (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 2).
--
-- WHAT THIS CLOSES. `requirePlatformCapability` gated 25 call sites and NOT ONE of
-- them recorded that a decision had been made. A moderator could approve a category,
-- merge two clusters — which `discovery-moderation.service.ts` itself calls
-- irreversible — rewrite the public supplier directory, or unpublish a cited market
-- insight, and leave no trail anywhere in the database. §4f's append-only doctrine
-- is real and is PROJECT-scoped; a taxonomy decision has no project.
--
-- TWO DIFFERENCES FROM `project_audit_entry`, both following from that:
--   * `actor_user_id` is NOT NULL. There is no nightly job that approves a category.
--   * The head is a SINGLETON, pinned by CHECK to id = 'global'. One lock for every
--     moderation decision is affordable precisely because they are few and typed by
--     hand; a project ledger could not tolerate it.
--
-- The triggers below are the guarantee, not the service. `qatoto_reject_mutation()`
-- was created in 0010 and is reused verbatim — a BEFORE UPDATE OR DELETE row trigger
-- plus a BEFORE TRUNCATE statement trigger, because a row trigger does not fire on
-- TRUNCATE. `scripts/verify-platform-audit-constraints.ts` proves both against real
-- rows, on the same argument 0014's verifier makes: an untested hand-written
-- migration is indistinguishable from an absent one.
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."platform_audit_event_kind" AS ENUM('taxonomy_category_approved', 'taxonomy_category_rejected', 'cluster_merge_approved', 'cluster_merge_rejected', 'discovery_skill_created', 'discovery_skill_updated', 'discovery_skill_deleted', 'discovery_region_created', 'discovery_region_updated', 'discovery_region_deleted', 'market_insight_created', 'market_insight_updated', 'market_insight_deleted', 'market_insight_published', 'market_insight_unpublished', 'supplier_created', 'supplier_updated', 'content_review_approved', 'content_review_rejected', 'platform_role_granted', 'platform_role_revoked');--> statement-breakpoint
CREATE TABLE "platform_audit_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_number" integer NOT NULL,
	"event_kind" "platform_audit_event_kind" NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_role_snapshot" text NOT NULL,
	"action_label" text NOT NULL,
	"target_label" text NOT NULL,
	"detail_note" text DEFAULT '' NOT NULL,
	"payload_json" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"previous_entry_hash" text,
	"entry_hash" text NOT NULL,
	"hash_algorithm_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_audit_entry_sequence_ck" CHECK (sequence_number >= 1),
	CONSTRAINT "platform_audit_entry_hash_ck" CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "platform_audit_entry_link_ck" CHECK ((sequence_number = 1) = (previous_entry_hash IS NULL)),
	CONSTRAINT "platform_audit_entry_labels_ck" CHECK (char_length(action_label) BETWEEN 1 AND 200
          AND char_length(target_label) BETWEEN 1 AND 200
          AND char_length(detail_note) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "platform_chain_head" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"last_audit_sequence_number" integer DEFAULT 0 NOT NULL,
	"head_entry_hash" text,
	"head_entry_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_chain_head_singleton_ck" CHECK (id = 'global'),
	CONSTRAINT "platform_chain_head_sequence_ck" CHECK (last_audit_sequence_number >= 0
          AND (last_audit_sequence_number = 0) = (head_entry_hash IS NULL)
          AND (head_entry_hash IS NULL OR head_entry_hash ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "platform_audit_entry" ADD CONSTRAINT "platform_audit_entry_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_audit_entry_sequence_unq" ON "platform_audit_entry" USING btree ("sequence_number");--> statement-breakpoint
CREATE INDEX "platform_audit_entry_occurredAt_idx" ON "platform_audit_entry" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "platform_audit_entry_eventKind_idx" ON "platform_audit_entry" USING btree ("event_kind","sequence_number");--> statement-breakpoint
CREATE INDEX "platform_audit_entry_actorUserId_idx" ON "platform_audit_entry" USING btree ("actor_user_id","sequence_number");

-- --- APPEND-ONLY. The hash chain (§4f, §9.9): an entry that can be edited makes
-- --- every hash after it a statement about bytes that no longer exist.
DROP TRIGGER IF EXISTS platform_audit_entry_append_only ON "platform_audit_entry";--> statement-breakpoint
CREATE TRIGGER platform_audit_entry_append_only
BEFORE UPDATE OR DELETE ON "platform_audit_entry"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();--> statement-breakpoint
-- A BEFORE UPDATE OR DELETE *row* trigger does NOT fire on TRUNCATE.
DROP TRIGGER IF EXISTS platform_audit_entry_no_truncate ON "platform_audit_entry";--> statement-breakpoint
CREATE TRIGGER platform_audit_entry_no_truncate
BEFORE TRUNCATE ON "platform_audit_entry"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();--> statement-breakpoint

-- The head row is MUTABLE by design — it carries the sequence counter and the head
-- pointer — so it gets no append-only trigger, exactly as `project_chain_head` does
-- not. It is seeded here so the first appender finds a row to lock rather than
-- racing to create one.
INSERT INTO "platform_chain_head" ("id") VALUES ('global') ON CONFLICT DO NOTHING;
