-- ---------------------------------------------------------------------------
-- Watch time and activity rollups (HOME_BACKEND_STRUCTURE.md §3.3a).
--
-- HAND-WRITTEN, like every migration since 0046. The DDL below was composed by
-- `drizzle-kit export --sql`, which reads src/db/schema.ts with no database connection and
-- without consulting drizzle/meta/ — the only way to get canonical DDL in this repo, since the
-- snapshots stop at 0054 and `db:generate` therefore tries to recreate four phases of tables.
--
-- THREE TABLES, TWO GRAINS, AND ONE REASON THEY EXIST AT ALL.
--
-- `video_view_session` already carries real, server-clamped watch seconds — but one row per
-- (video, fingerprint, UTC DAY), and every row is DELETED at 90 days by `prune-engagement-data`.
-- So the data that would answer "how long have I watched this year" is destroyed a quarter of
-- the way into the year, and the data that would answer "what hour of the day is this platform
-- busy" never existed: a session row spans a whole day, so attributing its seconds to the hour
-- of its last beacon would put a three-hour evening sitting into one bucket. That histogram
-- would not be missing. It would be WRONG, and plausibly so, which is worse.
--
-- `commerce_product_daily_signal` (0080) is the precedent, and this migration copies its shape
-- deliberately: its header makes this exact argument for products, that a series whose history
-- is pruned on its sibling's schedule leaves a detector "shipped, wired, and silently returning
-- nothing".
--
-- THE NAMED COMPOSITE PRIMARY KEYS ARE THE CORRECTNESS MECHANISM, NOT DECORATION. All three
-- writers upsert:
--
--   * the beacon (`video-engagement.service.ts`) infers its target from the COLUMN LIST
--     (user_id, activity_date, activity_hour) — with no primary key spanning exactly those
--     columns Postgres raises 42P10 and every signed-in beacon 500s;
--   * the nightly rollup names the constraints LITERALLY — `ON CONFLICT ON CONSTRAINT
--     user_watch_daily_pk` and `... platform_activity_hour_daily_pk` — so a key created under
--     Postgres's generated `_pkey` name raises 42704 instead.
--
-- Neither failure is silent, which is the good case. The silent one is a unique index scoped to
-- the WRONG columns: the upsert then inserts a second row instead of accumulating, and watch
-- time multiplies by beacon count in the direction that looks like success. That is what
-- `db:verify-watch-metrics-constraints` exists to rule out — it checks these three names in
-- pg_constraint and then proves accumulation with real rows.
--
-- WHY THE HOUR COUNTER IS PER-USER RATHER THAN 24 PLATFORM ROWS. Twenty-four rows incremented
-- by every beacon on the site is a lock hotspot on the hottest write path there is. Per-user
-- rows spread that contention across the active population, and they are also the grain the
-- "who has gone quiet" segment needs. `platform_activity_hour_daily` is DERIVED from them
-- nightly, which is the cheap direction to compute in.
--
-- `platform_activity_hour_daily` CARRIES NO USER ID AND THEREFORE NO FOREIGN KEY. That is the
-- whole reason it may outlive the 90-day horizon the other two are bounded by: it is the one
-- table here that is not personal data.
--
-- `activity_hour` IS `integer`, NOT `smallint`, on both hour tables — the schema declares
-- `integer()` and the verifier asserts `information_schema.columns.data_type = 'integer'`.
-- `platform_activity_hour_daily.watched_seconds` is `bigint` where the two per-user tables use
-- `integer`: it sums an entire platform's hour, they sum one person's.
-- ---------------------------------------------------------------------------

CREATE TABLE "user_activity_hour" (
  "user_id" text NOT NULL,
  "activity_date" date NOT NULL,
  "activity_hour" integer NOT NULL,
  "watched_seconds" integer DEFAULT 0 NOT NULL,
  "beacon_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_activity_hour_pk" PRIMARY KEY("user_id","activity_date","activity_hour"),
  CONSTRAINT "user_activity_hour_bounds_ck" CHECK (activity_hour BETWEEN 0 AND 23
          AND watched_seconds >= 0
          AND beacon_count >= 0)
);--> statement-breakpoint

CREATE TABLE "user_watch_daily" (
  "user_id" text NOT NULL,
  "watch_date" date NOT NULL,
  "watched_seconds" integer DEFAULT 0 NOT NULL,
  "counted_view_count" integer DEFAULT 0 NOT NULL,
  "distinct_video_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_watch_daily_pk" PRIMARY KEY("user_id","watch_date"),
  CONSTRAINT "user_watch_daily_bounds_ck" CHECK (watched_seconds >= 0 AND counted_view_count >= 0 AND distinct_video_count >= 0)
);--> statement-breakpoint

CREATE TABLE "platform_activity_hour_daily" (
  "activity_date" date NOT NULL,
  "activity_hour" integer NOT NULL,
  "active_user_count" integer DEFAULT 0 NOT NULL,
  "watched_seconds" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "platform_activity_hour_daily_pk" PRIMARY KEY("activity_date","activity_hour"),
  CONSTRAINT "platform_activity_hour_daily_bounds_ck" CHECK (activity_hour BETWEEN 0 AND 23
          AND active_user_count >= 0
          AND watched_seconds >= 0)
);--> statement-breakpoint

-- ON DELETE CASCADE on both: a deleted account's behavioural record goes with it. There is no
-- version of "keep the watch history of a user who no longer exists" that anyone would defend.
ALTER TABLE "user_activity_hour" ADD CONSTRAINT "user_activity_hour_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "user_watch_daily" ADD CONSTRAINT "user_watch_daily_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The nightly rollup scans a whole DAY across all users, and the 90-day prune deletes by date.
-- Both start from the date; the PK already serves the per-user reads.
CREATE INDEX "user_activity_hour_date_idx" ON "user_activity_hour" USING btree ("activity_date","activity_hour");--> statement-breakpoint

-- "This user's last N days, newest first" — the shape every user-facing read has. `DESC NULLS
-- LAST` is what the schema's `.desc()` emits; `watch_date` is NOT NULL so the null ordering is
-- moot, but the form is kept identical to the export so a future diff stays quiet.
CREATE INDEX "user_watch_daily_recent_idx" ON "user_watch_daily" USING btree ("user_id","watch_date" DESC NULLS LAST);--> statement-breakpoint

-- "Everyone active between two dates" — DAU/WAU/MAU, churn and the cohort grid all scan this
-- way, date first, and none of them names a user. Also the index the 762-day prune deletes by.
CREATE INDEX "user_watch_daily_date_idx" ON "user_watch_daily" USING btree ("watch_date","user_id");
