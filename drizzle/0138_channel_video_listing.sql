-- ---------------------------------------------------------------------------
-- ONE INDEX, FOR ONE NEW SURFACE: the channel page, `GET /channels/:handle/videos`.
--
-- WHY THE PAGE EXISTS AT ALL. `VideoCard` links a creator's avatar AND name to
-- `/channel/{handle}`, and `venture-video-reel.tsx` linked the same creator to `/@{handle}` —
-- two shapes, and NEITHER route existed. Every card in every feed carried two dead links, and
-- the frontend's subscriptions list had to render creators as unclickable text to avoid joining
-- them. This index is what makes the destination servable.
--
-- WHY `video_creatorId_idx` CANNOT SERVE IT. That index is `(creator_id)` and nothing else, so a
-- newest-first page over one creator is a scan of all their videos plus a sort. It exists for the
-- foreign-key style lookups and for the comment inbox's merge, neither of which orders by time.
--
-- ⚠️ THE PREDICATE IS BYTE-IDENTICAL TO `video_feed_candidate_idx`'s, and that is required rather
-- than tidy. Postgres uses a partial index only when it can PROVE the query's WHERE implies the
-- index predicate, and that proof runs against LITERALS — `review_status = ANY($1)` does not imply
-- `review_status IN ('not_required','approved')` as far as the planner is concerned. Re-wording
-- this produces no error anywhere. It produces a sequential scan, which is the single most likely
-- way this route ships broken. `feed.service.ts`'s `candidatePoolPredicate` carries the same note.
--
-- FIVE TERMS, WHERE THE APPLICATION GATE HAS SIX. `moderation_visibility_state = 'visible'` is
-- absent here, exactly as it is absent from `video_feed_candidate_idx`: it filters ON TOP of the
-- index rather than inside it. That is not an oversight being copied — a hidden video is rare
-- enough that indexing the state buys nothing, and adding the term to only one of the two indexes
-- would break the byte-match rule above for the feed.
--
-- DESC ON BOTH SORT COLUMNS, matching `ORDER BY v.published_at DESC, v.id DESC` exactly — the same
-- order `mode=recently_uploaded` already uses. The trailing `id` is what makes the keyset cursor
-- total: two videos published in the same millisecond is rare but a cursor keyed on a non-unique
-- column silently skips whichever one loses the tie.
--
-- NOT `CONCURRENTLY`: this repo's migrations run inside a transaction, which forbids it.
--
-- RUN ORDER: one index. No tables, no columns, no constraints.
-- ---------------------------------------------------------------------------

CREATE INDEX "video_creator_recent_idx" ON "video" USING btree ("creator_id","published_at" DESC,"id" DESC) WHERE publish_status = 'published'
            AND visibility = 'public'
            AND upload_status = 'ready'
            AND is_source_verified = true
            AND review_status IN ('not_required', 'approved');
