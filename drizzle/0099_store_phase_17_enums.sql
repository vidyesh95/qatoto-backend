-- ---------------------------------------------------------------------------
-- Phase 17 enums — the manufacturer directory's vocabulary, and nothing else.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHY THIS FILE HOLDS ONLY TYPES. `drizzle-kit migrate` runs the whole pending set in
-- ONE transaction, and a value added by `ALTER TYPE ... ADD VALUE` cannot be referenced
-- as a literal inside that same transaction. Migration 0100 writes CHECK constraints and
-- defaults naming these values, so the additions have to land in an earlier file. The
-- precedent is `0073_store_phase_13_enums.sql` and `0082_store_phase_14_enums.sql`.
--
-- THE CAPABILITY ENUM IS WIDENED, NOT REPLACED (STORE_BACKEND_STRUCTURE.md §16.2). The
-- shipped six and the frontend's proposed six overlap by two — `oem` and `odm` — and the
-- resolution is additive: no data migration, no rewrite of the rows Phase 12 collected,
-- and the union is what the wire carries.
--
-- `customization` AND `private_label` ARE NOT MERGED, and this is not pedantry.
-- Customization is "we will change this product for you"; private label is "we will put
-- your name on ours". A factory frequently does one and refuses the other, and a buyer
-- who cannot tell them apart writes to the wrong shop.
-- ---------------------------------------------------------------------------

ALTER TYPE "commerce_organization_capability_kind" ADD VALUE IF NOT EXISTS 'contract_manufacturing';
--> statement-breakpoint
ALTER TYPE "commerce_organization_capability_kind" ADD VALUE IF NOT EXISTS 'private_label';
--> statement-breakpoint
ALTER TYPE "commerce_organization_capability_kind" ADD VALUE IF NOT EXISTS 'tooling_and_moulds';
--> statement-breakpoint
ALTER TYPE "commerce_organization_capability_kind" ADD VALUE IF NOT EXISTS 'assembly';
--> statement-breakpoint

-- A manufacturing inquiry is one-to-one and gets its own thread, so the resource kind
-- that scopes `commerce_thread` has to know about it. Folding the conversation into an
-- RFQ thread instead would put every invited provider in the room — the reason §16.5
-- gives for keeping a one-to-one inquiry out of the RFQ shape.
ALTER TYPE "commerce_thread_resource_kind" ADD VALUE IF NOT EXISTS 'manufacturing_inquiry';
--> statement-breakpoint

-- Staff decisions only, and both of them name an accountable human, which is why they
-- belong in the platform audit chain rather than only on the row.
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_organization_site_audit_recorded';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_organization_site_audit_withdrawn';
--> statement-breakpoint

-- The organization-scoped chain. Two seller collections, the staff audit pair mirrored
-- from the platform chain above, and the inquiry state machine.
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'production_lines_changed';
--> statement-breakpoint
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'sites_changed';
--> statement-breakpoint
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'site_audit_recorded';
--> statement-breakpoint
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'site_audit_withdrawn';
--> statement-breakpoint
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'manufacturing_inquiry_created';
--> statement-breakpoint
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'manufacturing_inquiry_sent';
--> statement-breakpoint
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'manufacturing_inquiry_answered';
--> statement-breakpoint
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'manufacturing_inquiry_closed';
--> statement-breakpoint

-- THE CLOSED SIDE OF AN OPEN VOCABULARY (§16.2, conflict 2). The eight standards a buyer
-- filters on. `commerce_organization_certification.standard_name` stays free text and
-- stays the display string, because the vocabulary is the world's and no enum will ever
-- enumerate it. What the filter needs is a matchable code, so 0100 adds a NULLABLE
-- `standard_code` over this type: anything outside the eight carries NULL and still
-- renders on the detail page, it simply cannot be filtered on.
CREATE TYPE "commerce_certification_standard_code" AS ENUM (
  'iso_9001',
  'iso_14001',
  'bsci',
  'sedex_smeta',
  'gots',
  'fsc',
  'ce_marking',
  'fda_registered'
);
--> statement-breakpoint

-- A site audit is RECORDED or WITHDRAWN. There is no `expired`, for the same reason a
-- certification has no `expired` state: lapsing is a read-time comparison, and a nightly
-- job to flip a stored flag would be wrong between ticks.
CREATE TYPE "commerce_site_audit_state" AS ENUM ('recorded', 'withdrawn');
--> statement-breakpoint

-- `POST` answers `draft`, ALWAYS. Creating a draft notifies nobody, exactly as an RFQ
-- does, which is why `sent` is a separate transition with its own route.
CREATE TYPE "commerce_manufacturing_inquiry_state" AS ENUM ('draft', 'sent', 'answered', 'closed');
