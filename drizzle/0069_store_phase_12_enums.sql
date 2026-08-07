-- Store Phase 12 — seller profile depth: enum values and types (Appendix A13).
--
-- Split out from 0070–0072 for the reason 0057, 0059 and 0064 were split: ALTER TYPE ...
-- ADD VALUE cannot run inside a transaction block in older Postgres, and a value added in
-- one transaction cannot be USED by that same transaction. `drizzle-kit migrate` runs
-- every pending file as ONE transaction, so a value added here and referenced by DDL in a
-- later pending file would fail.
--
-- THIS PHASE AVOIDS THAT SITUATION RATHER THAN NEGOTIATING WITH IT, as 0064 did. Neither
-- ADD VALUE'd value below is referenced by any DDL in 0070–0072 — both appear only in
-- runtime INSERTs, long after migrate commits.
--
-- The CREATE TYPEs are different and one of them matters: 0071's
-- `commerce_organization_certification_identity_uidx` has the predicate
-- `state <> 'rejected'`, naming a literal of a type created HERE. That is legal
-- precisely because the type is NEW in this transaction — the restriction Postgres
-- enforces is on values added to a PRE-EXISTING type. It could not have been written as
-- `state::text <> 'rejected'` either way: an enum->text cast is not IMMUTABLE and
-- Postgres refuses it in an index predicate, which is the trap 0064's header describes.
--
-- ADD VALUE is not reversible. Every statement is idempotent, but rollback means
-- disabling routes, not dropping values.

-- ---------------------------------------------------------------------------
-- A13. What a seller DECLARES about itself.
--
-- Everything in this block is an unverified claim, which is why the projection keeps it
-- in its own `declaredProfile` object. A13's closing rule is the whole reason the entry
-- exists: "98.6% on-time, measured across 412 completed orders" and "founded 2009, per
-- the seller" are different kinds of statement, and the mock's flat
-- `stats: {label, value}[]` array teaches the UI to render the second as the first.
-- ---------------------------------------------------------------------------

-- Closed vocabulary rather than free text so the directory can filter on it.
-- `manufacturer_trading` is one entity doing both — the most common answer in this
-- market — not an undecided row.
CREATE TYPE "public"."commerce_seller_business_type" AS ENUM('manufacturer', 'trading_company', 'manufacturer_trading', 'agent', 'distributor');--> statement-breakpoint

CREATE TYPE "public"."commerce_organization_media_kind" AS ENUM('factory', 'office', 'warehouse', 'production_line', 'showcase');--> statement-breakpoint

-- Deliberately the same four modes as `commerce_shipment_leg_mode`, because they describe
-- the same physical world — but a SEPARATE type. A site-access row is a seller's claim
-- about its neighbourhood; a shipment leg is a booked movement. One shared type would
-- invite a join that means nothing.
CREATE TYPE "public"."commerce_site_access_mode" AS ENUM('road', 'sea', 'air', 'rail');--> statement-breakpoint

CREATE TYPE "public"."commerce_organization_capability_kind" AS ENUM('oem', 'odm', 'customization', 'in_house_inspection', 'in_house_rnd', 'sample_production');--> statement-breakpoint

CREATE TYPE "public"."commerce_visit_policy" AS ENUM('welcome', 'by_appointment', 'not_available');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A13 item 6. Certification review lifecycle.
--
-- NOTE WHAT IS NOT HERE: `expired`. Lapsing is not a state transition — it is
-- `valid_until < current_date`, evaluated at read time. An `expired` state would need a
-- nightly job to flip it and would therefore be WRONG between ticks, publishing a lapsed
-- certificate until the next run. Publishing a lapsed certificate is the exact failure
-- A13 was written to prevent, so the schema is shaped so it cannot happen rather than
-- scheduled so it usually does not. `withdrawn` stays: that one is a seller's action.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_certification_state" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The private document behind a certification claim.
--
-- Private for the same reason business registration is: a certificate scan carries
-- registration numbers, site addresses and signatures. The PUBLIC projection of an
-- approved certification is metadata only and never references this document in any
-- form — no id, no URL, no short-lived token.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."commerce_document_kind" ADD VALUE IF NOT EXISTS 'certification_evidence';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Commerce organization audit event kinds.
--
-- `certification_decided` lands on the COMMERCE ORGANIZATION chain, not the platform one,
-- even though a moderator performs it. 0064 sent content moderation to the platform chain
-- because a review or a question may have no organization behind it at all; a
-- certification always does, `actor_user_id` and `actor_member_role_snapshot` are both
-- nullable here, and `trade_state_changed` already records a moderator decision this way
-- with a null role snapshot. The certified organization's own history is where a reader
-- would look for it.
--
-- Audit PAYLOADS for these kinds must dodge `FORBIDDEN_PAYLOAD_KEY` in
-- commerce-organization-audit.service.ts, which matches `filename` and `object.*key` and
-- THROWS. So `organization_media_changed` carries mediaId / mediaKind / position, and
-- `certification_submitted` carries certificationId / standardName and NOT the evidence
-- object key. This regex already caused one live outage (`addressKind`, Phase 11), and
-- duplicating a private document's location into immutable history only widens where it
-- is written down.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'seller_profile_updated';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'organization_media_changed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'site_access_changed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'stakeholders_changed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'capabilities_changed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'certification_submitted';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'certification_decided';
