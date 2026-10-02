-- 0214: a third review visibility, `hidden_pending_review` — the reporter threshold's hide, kept
-- apart from `hidden` (a moderator's) so a report dismissal lifts only the automatic one. As of
-- 2026-10-02 no review is hidden, so nothing is backfilled. Additive: an enum value cannot be
-- dropped, so this is permanent once applied.
ALTER TYPE "public"."commerce_review_visibility" ADD VALUE IF NOT EXISTS 'hidden_pending_review';
