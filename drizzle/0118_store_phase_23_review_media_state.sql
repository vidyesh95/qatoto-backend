-- ---------------------------------------------------------------------------
-- Phase 23 — the state column a dead review video needs (Appendix A40).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHAT THIS CLOSES. `attachReviewVideo` stores a well-formed YouTube id without checking the
-- video resolves, and its own docblock has admitted so since Phase 15 — that comment was already
-- corrected once, to stop crediting a verification job (`verify-youtube-video`) that operates on
-- the `video` table and has never read this one. A buyer's review therefore renders a dead
-- player indefinitely, on the surface a buyer reads to decide whether to trust a seller.
--
-- HIDE, NOT DELETE, and that was decided before this migration was written
-- (`commerce-trust.service.ts`): "a dead video HIDES ITS MEDIA ROW and leaves the review
-- standing. A buyer's testimony must not be deleted because a third-party host removed a file,
-- which rules out dropping the row and recomputing `mediaCount`." A video that returns —
-- unlisted flipped back to public — must be able to come back with it.
--
-- `media_count` COUNTS VISIBLE MEDIA from here on. That is the decision with the widest reach,
-- so it is stated where the column lives: the two attach paths and the detach path already
-- move the counter, the job moves it on hide and un-hide, and
-- `verify-store-phase-10-constraints`' `media_count = count(*)` assertion is amended in the
-- same change to count only visible rows. Without that amendment it starts failing the first
-- night this runs.
--
-- POSITIONS ARE NOT REPACKED ON A HIDE. `repackReviewMediaPositions` exists and is deliberately
-- not reused here: a hidden row keeps its slot so an un-hide restores it in place, and the
-- gallery renders around the gap. Repacking would free a sixth slot and quietly turn the
-- six-item cap into "six visible" rather than "six attached" — a different rule nobody asked
-- for, and one `commerce_review_media_position_uidx` would then let a caller exploit.
-- ---------------------------------------------------------------------------

ALTER TABLE "commerce_review_media"
  ADD COLUMN "state" "commerce_review_media_state" DEFAULT 'visible' NOT NULL;
--> statement-breakpoint

ALTER TABLE "commerce_review_media" ADD COLUMN "unavailable_at" timestamp (3);
--> statement-breakpoint

-- The two facts are one fact. A row marked unavailable with no timestamp cannot say when the
-- host dropped it, and a timestamp on a visible row is a state nobody can read.
ALTER TABLE "commerce_review_media" ADD CONSTRAINT "commerce_review_media_state_ck"
  CHECK ((state = 'unavailable_upstream') = (unavailable_at IS NOT NULL));
--> statement-breakpoint

-- A PHOTO CANNOT VANISH UPSTREAM. Its bytes are on Cloudinary, which this platform controls;
-- only a third-party embed has a host that can stop serving it. Without this a future writer
-- could mark a photo unavailable and no read would ever explain why it disappeared.
ALTER TABLE "commerce_review_media" ADD CONSTRAINT "commerce_review_media_upstream_kind_ck"
  CHECK (state = 'visible' OR media_kind = 'youtube_video');
--> statement-breakpoint

-- The public read filters on `state`, and it filters within one review's rows. Partial, because
-- an unavailable row is a rounding error against the visible ones and has no business in the
-- index the gallery scans.
CREATE INDEX IF NOT EXISTS "commerce_review_media_visible_idx"
  ON "commerce_review_media" USING btree ("review_id", "position")
  WHERE state = 'visible';
