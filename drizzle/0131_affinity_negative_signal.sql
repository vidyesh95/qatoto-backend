-- ---------------------------------------------------------------------------
-- THE TWO NEGATIVE SIGNALS BECOME A RANKING INPUT.
--
-- "Not interested" and "don't recommend channel" have been a query-time `NOT EXISTS` since
-- 0127 and nothing else: the dismissed video disappears, and the ranker learns nothing from
-- the fact that somebody dismissed it. That makes our version of these controls a hard,
-- permanent filter where YouTube's is a soft nudge — better on reliability, worse on the
-- thing people actually notice, which is that the feed keeps serving the same kind of video.
--
-- WHY THIS NEEDS A MIGRATION AT ALL, rather than being pure job arithmetic: both snapshot
-- tables carry a CHECK asserting that the three positive components SUM EXACTLY to
-- `affinity_points`. There is nowhere in that identity to put a penalty, so subtracting one
-- makes Postgres refuse the row. The identity has to be rewritten, and a rewritten CHECK is
-- a migration.
--
-- THE PENALTY IS STORED ALREADY CLAMPED to what the positives could pay
-- (`min(rawLadderPoints, positiveTotal)` in `affinity-score.ts`). That is what keeps the new
-- identity exact for a viewer whose penalty exceeds their positive total, and it is why the
-- floor is a real zero rather than a negative score. It also means this column is the penalty
-- APPLIED, not the penalty EARNED — the raw ladder output is deliberately not persisted,
-- because a stored number that disagrees with the identity beside it is a number that will
-- eventually be read as though it did not.
--
-- BOTH COLUMNS DEFAULT TO 0, so every row already in these tables satisfies the new CHECK
-- unchanged and there is no backfill. `score_algorithm_version` stays at its default for
-- existing rows and is written as 2 by the job from here on — that column exists precisely so
-- the formula can change without invalidating history.
--
-- SAFE TO RUN WITH THE NIGHTLY JOB DISABLED OR ENABLED: the job writes with
-- `onConflictDoNothing` on (user, subject, as_of), so a re-run for the same `as_of` is a
-- no-op rather than a conflict against rows written under the old formula.
--
-- RUN ORDER: columns -> drop old constraints -> add rewritten constraints.
-- ---------------------------------------------------------------------------

ALTER TABLE "user_topic_affinity_snapshot" ADD COLUMN "negative_signal_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "user_topic_affinity_snapshot" ADD COLUMN "negative_signal_component_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "user_creator_affinity_snapshot" ADD COLUMN "negative_signal_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "user_creator_affinity_snapshot" ADD COLUMN "negative_signal_component_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "user_topic_affinity_snapshot" DROP CONSTRAINT "user_topic_affinity_snapshot_score_ck";--> statement-breakpoint

ALTER TABLE "user_creator_affinity_snapshot" DROP CONSTRAINT "user_creator_affinity_snapshot_score_ck";--> statement-breakpoint

ALTER TABLE "user_topic_affinity_snapshot" ADD CONSTRAINT "user_topic_affinity_snapshot_score_ck" CHECK (affinity_points BETWEEN 0 AND 100
          AND watch_count_component_points >= 0 AND mean_completion_component_points >= 0
          AND explicit_signal_component_points >= 0 AND negative_signal_component_points >= 0
          AND watch_count_component_points + mean_completion_component_points
              + explicit_signal_component_points - negative_signal_component_points
              = affinity_points
          AND counted_view_count >= 0
          AND mean_completion_basis_points BETWEEN 0 AND 10000
          AND explicit_signal_count >= 0
          AND negative_signal_count >= 0);--> statement-breakpoint

ALTER TABLE "user_creator_affinity_snapshot" ADD CONSTRAINT "user_creator_affinity_snapshot_score_ck" CHECK (affinity_points BETWEEN 0 AND 100
          AND watch_count_component_points >= 0 AND mean_completion_component_points >= 0
          AND explicit_signal_component_points >= 0 AND negative_signal_component_points >= 0
          AND watch_count_component_points + mean_completion_component_points
              + explicit_signal_component_points - negative_signal_component_points
              = affinity_points
          AND counted_view_count >= 0
          AND mean_completion_basis_points BETWEEN 0 AND 10000
          AND explicit_signal_count >= 0
          AND negative_signal_count >= 0);
