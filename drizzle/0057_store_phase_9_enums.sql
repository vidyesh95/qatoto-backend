-- Store Phase 9 — enum values for guided pathways (§15).
--
-- Split out from 0058 on purpose: ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction block in older Postgres, and a value added in one transaction cannot
-- be USED by that same transaction. 0058 references 'pending_review' and the new
-- audit event kinds, so they have to land first. Same reason 0056 was its own file.
--
-- ADD VALUE is not reversible. Every statement here is idempotent via IF NOT EXISTS,
-- but a rollback means disabling routes, not dropping values.

-- §15.5. A pathway follows draft → pending_review → active | rejected, the flow
-- commerce_service_offering already uses. `store_merchandising_state` had only
-- draft/active/retired, which cannot express "a seller proposed this and nobody has
-- looked at it yet" — and without that state a seller proposal would be publishable
-- by its own author.
ALTER TYPE "public"."store_merchandising_state" ADD VALUE IF NOT EXISTS 'pending_review';--> statement-breakpoint
ALTER TYPE "public"."store_merchandising_state" ADD VALUE IF NOT EXISTS 'rejected';--> statement-breakpoint

-- Authoring a set is an organization-scoped write like every other commerce write,
-- so it leaves the same audit trail.
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'pathway_created';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'pathway_updated';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'pathway_slots_replaced';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'pathway_candidates_replaced';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'pathway_submitted';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'pathway_moderated';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'cart_seeded_from_pathway';--> statement-breakpoint

-- §15.2. `curated` is a merchandiser's choice; `derived` is a relation-graph
-- suggestion. The distinction rides the wire for the same reason
-- commerce_product_relation.source_kind does (§15.3): a client must never render a
-- suggestion as a curatorial decision. Only `curated` rows are ever stored — derived
-- candidates are resolved at read time from the graph — but the column types the
-- projection and leaves room for a future materialization.
CREATE TYPE "public"."store_pathway_slot_candidate_source_kind" AS ENUM('curated', 'derived');
