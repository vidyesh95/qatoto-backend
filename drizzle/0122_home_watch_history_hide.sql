-- ---------------------------------------------------------------------------
-- Watch history becomes editable — `/watch-history` remove, undo and clear.
--
-- HAND-WRITTEN, like every migration since 0046.
--
-- WHY A COLUMN AND NOT A DELETE. This is the whole design, so it is written down here
-- rather than only in the schema file.
--
-- `video_view_session_unq (video_id, viewer_fingerprint, view_day_bucket)` IS the
-- anti-replay mechanism for view counting: `recordViewBeacon` inserts with
-- `onConflictDoNothing`, so one viewer gets at most one countable session per video per
-- UTC day. `video_stats.view_count` is an INCREMENTAL counter, bumped exactly once when
-- `is_counted_view` flips, and 0035's own prune job records that the increment cannot be
-- walked back afterwards.
--
-- So a user-facing DELETE on this table would reopen the loop:
--
--     remove from history -> re-watch the same video the same day -> the unique key no
--     longer collides -> a fresh row inserts -> `is_counted_view` flips again ->
--     `view_count` increments again -> remove again.
--
-- The beacon's 60/min and 200/hour limiters bound how fast that runs; they do not close
-- it. Stamping a column instead leaves the unique key, every counter and the 90-day
-- prune exactly as they were — and a re-watch makes the row visible again on its own,
-- which is the behaviour a viewer expects from "remove from history".
--
-- The same argument is why the §8.1 outlier prune in `prune-engagement-data.ts` ZEROES
-- and clears `is_counted_view` rather than deleting. This migration follows that
-- precedent rather than inventing a second policy for the same table.
--
-- NULLABLE WITH NO DEFAULT AND NO BACKFILL. NULL means visible, which is every existing
-- row and every future one until a viewer says otherwise. Nothing to migrate.
--
-- THE INDEX IS REPLACED, NOT ADDED. `video_view_session_viewer_idx` (0035) is partial on
-- `viewer_id IS NOT NULL AND is_counted_view`, and it serves both readers of this column:
-- §4.5's already-watched exclusion and the `mode=watched` history listing. Both now also
-- filter `hidden_from_history_at IS NULL`, so that clause belongs in the predicate —
-- otherwise Postgres still uses the index but has to recheck the new condition on every
-- row it returns. Any future query wanting this index must carry all three clauses.
-- ---------------------------------------------------------------------------

ALTER TABLE "video_view_session" ADD COLUMN "hidden_from_history_at" timestamp (3);--> statement-breakpoint

DROP INDEX IF EXISTS "video_view_session_viewer_idx";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "video_view_session_viewer_idx"
  ON "video_view_session" USING btree ("viewer_id","video_id","first_beacon_at")
  WHERE viewer_id IS NOT NULL AND is_counted_view AND hidden_from_history_at IS NULL;
