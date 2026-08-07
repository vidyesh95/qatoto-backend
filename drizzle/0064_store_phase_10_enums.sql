-- Store Phase 10 — "the public voice": enum values and types (Appendix A8, A9, A11,
-- A12, A14).
--
-- Split out from 0065–0068 for the reason 0057 and 0059 were split: ALTER TYPE ...
-- ADD VALUE cannot run inside a transaction block in older Postgres, and a value added
-- in one transaction cannot be USED by that same transaction. `drizzle-kit migrate`
-- runs every pending file as ONE transaction, so a value added here and referenced by
-- DDL in a later pending file would fail.
--
-- THIS PHASE AVOIDS THAT SITUATION RATHER THAN NEGOTIATING WITH IT. None of the
-- ADD VALUE'd values below is referenced by any DDL in 0065–0068 — they appear only in
-- runtime INSERTs, long after migrate commits. That is a design consequence, not luck:
-- A14 originally keyed the pre-sales thread on the product, which needed partial-index
-- predicates naming a newly added enum literal, and an enum->text cast is not IMMUTABLE
-- so Postgres rejects it in an index predicate. Introducing `commerce_product_inquiry`
-- as a real resource row removed the need entirely.
--
-- CREATE TYPE has none of ADD VALUE's limits, but the new types live here too so every
-- enum change for the phase sits in one reversible-by-inspection place.
--
-- ADD VALUE is not reversible. Every statement is idempotent, but rollback means
-- disabling routes, not dropping values.

-- ---------------------------------------------------------------------------
-- A8. Review depth.
--
-- `youtube_video` rather than a `video` upload kind: this codebase has no first-party
-- video ingest. Videos are 11-character YouTube ids verified through oEmbed by the
-- shipped `verify-youtube-video` job, and inventing a second pipeline for review clips
-- would mean a new Cloudinary resource type, a duration cap, poster frames and a
-- moderation path nobody can eyeball. The wire carries both kinds from day one so the
-- frontend contract does not change if bytes ever land.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_review_media_kind" AS ENUM('photo', 'youtube_video');--> statement-breakpoint

-- Closed set, matching the three bars the ratings section renders. A free-text axis
-- would make the aggregate unbounded and force the client to invent labels for keys it
-- has never seen — the opposite call from `specificationGroup` (A3), which is free text
-- because the useful groupings for a chair and a transformer share nothing.
CREATE TYPE "public"."commerce_review_score_axis" AS ENUM('service', 'shipping', 'quality');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A9 / A12. User-generated content visibility.
--
-- FOUR values, not a reuse of `commerce_review_visibility`'s two. An author retracting
-- is not a moderation event; an automated threshold hide is not a human decision. A
-- two-value flag flattens all three into "hidden" and makes the moderation queue lie
-- about who acted. Reusing the review-NAMED type on questions would also be exactly the
-- cross-domain row-shape accident Appendix A10's rule forbids.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_ugc_visibility_state" AS ENUM('visible', 'hidden_pending_review', 'hidden_by_moderator', 'removed_by_author');--> statement-breakpoint

-- A9. Derived from the caller's standing, NEVER sent in a request body — a badge
-- asserted by the frontend is the most direct §0 violation available. Moderators
-- moderate; they do not answer, so there is no `moderator` member.
CREATE TYPE "public"."commerce_product_answer_author_kind" AS ENUM('seller', 'verified_buyer');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A11. Engagement.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_product_engagement_kind" AS ENUM('saved', 'bookmarked');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A12. Reports and moderation.
--
-- `review_reply` and `message` are deliberately ABSENT.
--   * A reply target has no table until A8's `commerce_review_reply` ships alongside
--     this migration — but the report surface for it is dark until there is a public
--     reply read, so the value is added when that surface exists rather than shipping a
--     target kind with nothing behind it.
--   * A message report means a moderator reads a private, attachment-bearing commercial
--     negotiation. That is a disclosure decision for §14, not an aggregation one. The
--     existing escalation path for harm inside a thread is a dispute.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_content_target_kind" AS ENUM('product', 'review', 'question', 'answer', 'organization');--> statement-breakpoint

-- A new reason set rather than `research_program_report_reason`. A commerce report is
-- mostly about GOODS; `plagiarism` and `misinformation` are R&D words. Sharing the type
-- would also mean adding `counterfeit` puts it on the R&D report form — the A10 rule
-- applied to an enum.
CREATE TYPE "public"."commerce_content_report_reason" AS ENUM('spam', 'counterfeit', 'prohibited_item', 'misleading_claim', 'intellectual_property', 'harassment', 'off_topic', 'other');--> statement-breakpoint
CREATE TYPE "public"."commerce_content_report_status" AS ENUM('open', 'actioned', 'dismissed');--> statement-breakpoint

CREATE TYPE "public"."commerce_moderation_action_kind" AS ENUM('content_hidden', 'content_restored', 'report_dismissed', 'product_moderation_state_changed');--> statement-breakpoint

-- The split that `platform_audit_entry.actor_user_id NOT NULL` forces.
--
-- An automated threshold hide has no human behind it, and the platform hash chain's
-- whole premise is that every entry names an accountable person. So an `automatic`
-- action is recorded in the domain table with no moderator and no audit entry, and
-- `commerce_moderation_action_source_ck` binds those columns to this value in both
-- directions. The chain keeps its invariant instead of having it quietly weakened.
CREATE TYPE "public"."commerce_moderation_action_source" AS ENUM('moderator', 'automatic');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A14. Pre-sales threads.
--
-- The thread points at a `commerce_product_inquiry` row, NOT at the product. Keying it
-- on the product would collide with `commerce_thread_resource_uidx` and produce ONE
-- THREAD PER PRODUCT ACROSS ALL BUYERS — `assertThreadParticipant` would then admit
-- every buyer organization that ever inquired and hand each of them every other
-- buyer's negotiation. That is a cross-tenant leak against §11, not a UX wart.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."commerce_thread_resource_kind" ADD VALUE IF NOT EXISTS 'product_inquiry';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Commerce organization audit event kinds.
--
-- NOTE THE OMISSION: there is no audit kind for a helpful vote, and that is a decision
-- rather than an oversight. A vote carries no commercial consequence and nothing a
-- moderator or a court would ever read; at the route's 60/min budget it would become
-- the largest table in the audit log within a month.
--
-- Audit PAYLOADS for these kinds must dodge `FORBIDDEN_PAYLOAD_KEY` in
-- commerce-organization-audit.service.ts, which matches `filename` and `object.*key`
-- and THROWS. Media payloads use mediaId / reviewId / mediaKind / position and never
-- filename, objectKey or publicId. This regex already caused one live outage
-- (`addressKind`, Phase 11).
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'review_media_attached';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'review_media_detached';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'review_reply_published';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'review_reply_withdrawn';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'product_inquiry_opened';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Platform audit event kinds (the hash-chained staff log).
--
-- Moderation decisions go here, not on the commerce organization chain, for the reason
-- research-program moderation already established: the actor is platform staff who may
-- belong to no commerce organization at all, and
-- `commerce_organization_audit_entry.organization_id` is NOT NULL.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_content_hidden';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_content_restored';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_content_report_dismissed';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_product_moderation_state_changed';
