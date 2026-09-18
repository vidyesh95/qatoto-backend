--> §19.12. The five organization-audit labels a provider-authored freight rate card writes.
--> Added here rather than reusing `platform_audit_event_kind`'s staff-side
--> `commerce_freight_rate_card_created`: a forwarder pricing its own lane is not a moderation
--> decision, and the platform chain snapshots an accountable moderator's role.
--> These labels are PERMANENT. `commerce_organization_audit_entry` is append-only, so an
--> in-use `event_kind` can never be renamed.
--> Values only. Nothing in this migration USES them, so the one-transaction-per-run rule
--> (a new enum value is unusable until its transaction commits) is not tripped.
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'freight_rate_card_created';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'freight_rate_card_window_shortened';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'freight_rate_card_withdrawn';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'freight_rate_break_added';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'freight_rate_breaks_replaced';
