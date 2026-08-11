-- ---------------------------------------------------------------------------
-- Phase 21 — audit kinds for the review edit window (Appendix A38).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- ENUM-ONLY, and SEPARATE FROM 0112 for the house reason: `drizzle-kit migrate` runs every
-- pending migration in ONE transaction, and a value added by `ALTER TYPE ... ADD VALUE` cannot
-- be used as a literal in that same transaction. Nothing here is used by a later migration
-- today, but splitting it means the next person to add one does not have to discover the rule.
--
-- WHY AN EDIT IS AUDITED AT ALL. `review_created` has been audited since Phase 10, and an edit
-- changes a published rating — a fact a seller's storefront is scored on. A moderator reading a
-- content report about a review needs to know whether its text is the text the buyer originally
-- posted, and `edited_at` alone says that it changed without saying from what.
-- ---------------------------------------------------------------------------

ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'review_edited';
--> statement-breakpoint

-- The seller's half. Separate from `review_edited` because the audit list filters by kind and
-- the two are different parties acting on different rows — collapsing them would make "who
-- changed the public record here" a question requiring the payload to answer.
ALTER TYPE "commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'review_reply_edited';
