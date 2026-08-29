-- STORE §20 / Phase 24 — four audit kinds for the attribute vocabulary.
--
-- ⚠️ ITS OWN MIGRATION, SEPARATE FROM `0151`, AND DELIBERATELY SO. Postgres forbids USING a
-- value added by `ALTER TYPE ... ADD VALUE` in the same transaction that added it, and drizzle
-- runs each migration in one transaction. Keeping the enum extension alone in this file means
-- nothing here can trip that rule, and the services that reference the new labels run long after
-- it has committed. `0095` records the same hazard.
--
-- NO `_deleted` MEMBER, because there is no delete route to audit: `commerce_product_attribute_value`
-- holds `attribute_id` at RESTRICT, so a definition in use cannot be removed, and the reversible
-- exit is `is_filterable = false` — an ordinary update already covered by `..._updated`.
--
-- Submitting a request records nothing, matching the category pair: there is no staff actor
-- behind a seller's proposal, and logging those would drown the entries that name an
-- accountable human.
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'commerce_category_attribute_created' BEFORE 'commerce_organization_site_audit_recorded';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'commerce_category_attribute_updated' BEFORE 'commerce_organization_site_audit_recorded';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'commerce_category_attribute_request_approved' BEFORE 'commerce_organization_site_audit_recorded';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE 'commerce_category_attribute_request_rejected' BEFORE 'commerce_organization_site_audit_recorded';