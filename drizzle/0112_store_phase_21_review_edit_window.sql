-- ---------------------------------------------------------------------------
-- Phase 21 — the review edit window (STORE_BACKEND_STRUCTURE.md Appendix A38).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHAT THIS CLOSES. A review was permanent: there was no author edit and no author delete, so
-- a buyer who mistyped a rating or named the wrong product had no correction path at all. A
-- seller's reply had the OPPOSITE problem — `PUT|DELETE /commerce/reviews/:reviewId/reply` was
-- unlimited and unbounded in time, so a conciliatory public reply could be swapped or removed
-- the moment the buyer relented.
--
-- ONE MUTATION EACH, WITHIN 30 DAYS, WHICH IS ALIBABA'S RULE. Checked rather than assumed:
-- Alibaba allows a buyer to modify feedback once within 30 days of submitting it, and the
-- supplier to modify their reply once within 30 days of first replying. Amazon is far more
-- permissive — unlimited edits, and deletion at any time — and pays for it with an
-- anti-manipulation enforcement arm this platform does not have. On a marketplace where an
-- order is five figures, "delete your 1-star and I'll pay you" is a business model, so the
-- bound belongs in the data model.
--
-- WHY A COLUMN AND NOT `updated_at`. `commerce_review.updated_at` carries `$onUpdate`, and
-- `helpful_count` and `media_count` are written on every vote and every photo — so it moves for
-- reasons that have nothing to do with the author touching the text. It cannot answer "was this
-- edited?" and it cannot answer "has the one edit been spent?". `commerce_review_reply` has no
-- such counters TODAY, but giving it the same explicit column keeps the two halves symmetric and
-- survives the first counter somebody adds to it.
--
-- NO `withdrawn` VISIBILITY VALUE, and its absence is a decision. There is no author delete: a
-- buyer who wants a review gone files a content report (A12) and a moderator decides. That turns
-- "seller pays buyer to delete" into "seller must convince a moderator", which is what
-- moderation is for. `commerce_review_visibility` stays `visible | hidden`, and `hidden` stays
-- the moderator's word alone.
-- ---------------------------------------------------------------------------

-- NULL means "never edited", and it is also the has-not-spent-the-one-edit flag. Two facts on
-- one column because they are the same fact.
ALTER TABLE "commerce_review" ADD COLUMN "edited_at" timestamp (3);
--> statement-breakpoint

ALTER TABLE "commerce_review_reply" ADD COLUMN "edited_at" timestamp (3);
