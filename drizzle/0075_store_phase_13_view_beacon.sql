-- Store Phase 13 — the product view beacon.
--
-- THE STORE HAS NEVER OBSERVED A VIEW. `commerce_product_stats` counts saves, bookmarks,
-- shares, questions and answers; there is no view counter, no impression row, and no
-- beacon endpoint. Every public store read is a plain GET behind `attachOptionalUser`,
-- which attaches NOTHING for an anonymous caller.
--
-- That absence is not cosmetic. A conversion rate is orders over views, so without a view
-- there is no denominator, and two of the spec's ten refinements — the MAD spike triggers
-- and the conversion kill-switch — have no input at all. Everything else in this phase
-- could be built without this table. Those two could not.
--
-- This is a DIRECT PORT of `video_view_session`, which has been carrying the same job on
-- the video side since the home-feed phase, down to the anti-replay index and the
-- fingerprint check constraint. Deliberately a port and not a shared table: a product and
-- a video share no foreign key, no eligibility rule and no retention policy, and one
-- polymorphic view table with two nullable entity columns is the shape §2.1 rejects for
-- listings and would reject here for the same reason.
--
-- WHAT THIS COSTS. It is the second unauthenticated write on the platform, and it lands on
-- the store's hottest read path. The mitigations are the unique index below (an anonymous
-- loop cannot manufacture rows, only rewrite its own), the beacon rate limiter, and the
-- fact that an anonymous row can never reach the conversion numerator.

-- ---------------------------------------------------------------------------
-- One row per viewer, per product, per UTC day.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_product_view_session" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,

  -- NULL means anonymous, AND THIS COLUMN IS THE GATE.
  --
  -- Anonymous dwell counts toward `view_count` — it is real traffic and excluding it would
  -- understate every denominator — but it never reaches the conversion numerator, because
  -- an order has a buyer organization and an anonymous session has nobody to match it to.
  -- Farming conversion therefore requires real accounts placing real orders, which is the
  -- expensive attack rather than the free one.
  --
  -- `set null` and not cascade: deleting an account must not retroactively rewrite a
  -- product's view history, exactly as `video_view_session` has it.
  "viewer_id" text,

  -- sha256 hex, derived per UTC day from BETTER_AUTH_SECRET plus either the user id
  -- (signed in) or ip + user agent (anonymous). THE RAW IP IS NEVER WRITTEN HERE.
  -- Its domain separator is `:commerceview:`, NOT the video module's `:videoview:` — a
  -- shared separator would make one person's product fingerprint collide with their video
  -- fingerprint, and the unique indexes on two tables would then key off the same value
  -- for unrelated purposes.
  "viewer_fingerprint" text NOT NULL,

  -- The UTC day, as the SAME string that went into the hash. A stored column and
  -- deliberately not generated from `first_beacon_at`: a generated column is a second
  -- derivation of the same fact, and the two disagree for any beacon crossing midnight
  -- between the hash and the insert — which silently starts a second session.
  "view_day_bucket" date NOT NULL,

  "view_source" "public"."commerce_product_view_source" DEFAULT 'unknown' NOT NULL,

  -- Salted /24 (IPv4) or /56 (IPv6) hash. Nullable, because a request behind a proxy that
  -- strips the address has no honest value here and 0 concentration would be a lie. NEVER
  -- BACKFILLABLE — see 0077.
  "subnet_hash" text,

  -- Clamped server-side against elapsed wall time between beacons. The client proposes;
  -- it does not establish.
  "dwell_seconds" integer DEFAULT 0 NOT NULL,

  -- Flips ONCE, and the transition is what increments `commerce_product_stats.view_count`.
  -- A row that never clears the dwell threshold is a bounce and is not a view.
  "is_counted_view" boolean DEFAULT false NOT NULL,

  "first_beacon_at" timestamp(3) DEFAULT now() NOT NULL,
  "last_beacon_at" timestamp(3) DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "commerce_product_view_session" ADD CONSTRAINT "commerce_product_view_session_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_view_session" ADD CONSTRAINT "commerce_product_view_session_viewer_id_user_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- THIS INDEX IS THE ANTI-REPLAY BOUNDARY, and without it every clamp above is decorative:
-- a headless loop would open a fresh session per request, and a clamp bounds what ONE
-- session may claim, not how many sessions exist.
CREATE UNIQUE INDEX "commerce_product_view_session_unq" ON "commerce_product_view_session" USING btree ("product_id","viewer_fingerprint","view_day_bucket");--> statement-breakpoint

-- The velocity scan: counted views for a product inside W1/W2.
CREATE INDEX "commerce_product_view_session_product_idx" ON "commerce_product_view_session" USING btree ("product_id","first_beacon_at");--> statement-breakpoint

-- Daily rollup, and the per-fingerprint breadth check that says whether one key is
-- touching implausibly many products.
CREATE INDEX "commerce_product_view_session_fingerprint_idx" ON "commerce_product_view_session" USING btree ("viewer_fingerprint","view_day_bucket");--> statement-breakpoint

-- Subnet concentration over views. Partial because most rows will carry no hash for a
-- long time, and indexing a column that is null for all of them buys nothing.
CREATE INDEX "commerce_product_view_session_subnet_idx" ON "commerce_product_view_session" USING btree ("subnet_hash","product_id","view_day_bucket") WHERE subnet_hash IS NOT NULL;--> statement-breakpoint

-- The conversion numerator's join: did THIS signed-in viewer, who counted as a view, go on
-- to order? Partial on both conditions because that is the only population the ratio
-- admits.
CREATE INDEX "commerce_product_view_session_viewer_idx" ON "commerce_product_view_session" USING btree ("viewer_id","product_id","first_beacon_at") WHERE viewer_id IS NOT NULL AND is_counted_view;--> statement-breakpoint

ALTER TABLE "commerce_product_view_session" ADD CONSTRAINT "commerce_product_view_session_bounds_ck" CHECK (
  dwell_seconds >= 0
  AND dwell_seconds <= 3600
  AND last_beacon_at >= first_beacon_at
);--> statement-breakpoint

-- The fingerprint and the subnet hash are both server-computed, so a row that is not 64
-- lowercase hex characters means something upstream stopped hashing. Fail at the storage
-- layer, loudly, rather than letting an unsalted value sit next to salted ones.
ALTER TABLE "commerce_product_view_session" ADD CONSTRAINT "commerce_product_view_session_fingerprint_ck" CHECK (viewer_fingerprint ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "commerce_product_view_session" ADD CONSTRAINT "commerce_product_view_session_subnet_ck" CHECK (subnet_hash IS NULL OR subnet_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The counters.
-- ---------------------------------------------------------------------------

-- Moves once per session, on the `is_counted_view` transition, in that session's own
-- transaction.
ALTER TABLE "commerce_product_stats" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- NULLABLE WITH NO DEFAULT, and that is the point. No transaction can maintain a DISTINCT
-- count incrementally, so this is written by the nightly rollup or not at all — and a
-- default of 0 would state a false denominator to every conversion computation that ran
-- before the first rollup. `video_stats.unique_viewer_count` is nullable for the identical
-- reason.
ALTER TABLE "commerce_product_stats" ADD COLUMN "unique_viewer_count" integer;--> statement-breakpoint

-- A CHECK cannot be extended in place; drop and re-add with the new columns included.
ALTER TABLE "commerce_product_stats" DROP CONSTRAINT "commerce_product_stats_counters_non_negative_ck";--> statement-breakpoint
ALTER TABLE "commerce_product_stats" ADD CONSTRAINT "commerce_product_stats_counters_non_negative_ck" CHECK (
  saved_count >= 0 AND bookmarked_count >= 0 AND share_count >= 0
  AND question_count >= 0 AND answered_question_count >= 0
  AND answered_question_count <= question_count
  AND view_count >= 0
  AND (unique_viewer_count IS NULL OR (unique_viewer_count >= 0 AND unique_viewer_count <= view_count))
);
