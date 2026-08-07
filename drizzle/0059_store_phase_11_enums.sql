-- Store Phase 11 — enum values for buyer logistics (Appendix A15–A18).
--
-- Split out from 0060–0062 on purpose: ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction block in older Postgres, and a value added in one transaction cannot be
-- USED by that same transaction. The later files reference every value added here.
-- Same reason 0056 and 0057 were their own files.
--
-- ADD VALUE is not reversible. Every statement is idempotent via IF NOT EXISTS, but a
-- rollback means disabling routes, not dropping values.

-- ---------------------------------------------------------------------------
-- A15. The kind that did not exist.
--
-- `assertOwnedDeliveryAddress` filters on id + organization and NOT on addressKind,
-- because there has never been a kind to filter on — so a seller's registered office
-- could be a buyer's delivery address. 0060 adds the filter; this adds the value.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."commerce_organization_address_kind" ADD VALUE IF NOT EXISTS 'delivery';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Audit event kinds.
--
-- `delivery_address_revealed` is THE FIRST READ EVENT in this enum — every one of the
-- fifty-odd existing kinds records a write. That asymmetry is the point: an authorized
-- decrypt path is only better than a seller-openable snapshot if the read leaves a
-- record the buyer can see.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'delivery_address_revealed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'sample_credit_minted';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'sample_credit_consumed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'product_customization_options_replaced';--> statement-breakpoint

-- A18. Buyer-supplied artwork is a private encrypted document like verification
-- evidence, not a public Cloudinary image: it is the buyer's commercial material and
-- only the fulfilling seller may open it.
ALTER TYPE "public"."commerce_document_kind" ADD VALUE IF NOT EXISTS 'customization_artwork';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- New types (A17, A18). CREATE TYPE has none of ADD VALUE's transaction limits, but
-- it lives here so every enum change for the phase is in one reversible-by-inspection
-- place.
-- ---------------------------------------------------------------------------

-- A17. A credit is minted once by a completed refundable sample order and spent once.
-- `expired` exists so an unbounded liability can be closed out rather than lingering.
CREATE TYPE "public"."commerce_sample_credit_state" AS ENUM('available', 'consumed', 'expired');--> statement-breakpoint

-- A18. Retire, never delete: an order line references the option it was bought under,
-- so the seller withdrawing a slot must not erase what a buyer ordered.
CREATE TYPE "public"."commerce_product_customization_option_state" AS ENUM('active', 'retired');--> statement-breakpoint

-- A18. An upload slot ("your logo") and a choice slot ("packaging material") differ in
-- what the buyer supplies, which decides whether an encrypted document or a value is
-- required. Modelling them as one nullable-everything row would let both be absent.
CREATE TYPE "public"."commerce_product_customization_kind" AS ENUM('file_upload', 'choice');
