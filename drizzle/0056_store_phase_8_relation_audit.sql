-- Store Phase 8 — audit event kinds for the product relation graph (§15.3).
--
-- A seller declaring "this bolt fits that bicycle" and a moderator promoting that
-- claim to `moderator_curated` are both decisions with safety consequences in the
-- categories where fitment matters, so both leave an audit entry.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older Postgres
-- and cannot be rolled back; both statements are idempotent via IF NOT EXISTS.

ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'product_relations_declared';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'product_relation_verified';
