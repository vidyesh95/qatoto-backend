-- ---------------------------------------------------------------------------
-- Phase 20 — lane rate cards and customs dwell (STORE_BACKEND_STRUCTURE.md §19.2, §19.3).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHAT THIS CLOSES. A16 shipped a coverage-derived delivery estimate and it stands; what
-- coverage cannot express is a CHOICE. It says a provider SERVES this lane, not what it
-- CHARGES or how long it TAKES by sea versus by air. So `delivery-sheet.tsx` sums local
-- floats, which is the client establishing a price, which §0 forbids. The missing input was
-- never an endpoint — it was data nobody had bought.
--
-- NO SEED SHIPS WITH THIS. There is no fixture price list, because a made-up rate is a claim
-- the platform would then own — §19.4's own argument, applied to its own migration. These
-- tables land empty and stay empty until somebody buys a forwarder's lane list.
--
-- WHY `provider_organization_id` POINTS AT `commerce_provider_profile` AND NOT
-- `commerce_organization`. It is what `commerce_service_offering` does, and it makes §0's
-- "providerOrganizationId is never trusted merely because it appears in a body" a STRUCTURAL
-- fact rather than a rule a service can forget to check.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "commerce_freight_rate_card" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_organization_id" text NOT NULL,
  "origin_country_code" text NOT NULL,
  "destination_country_code" text NOT NULL,
  "mode" "commerce_shipment_leg_mode" NOT NULL,
  "currency" text NOT NULL,
  "valid_from" timestamp (3) NOT NULL,
  "valid_until" timestamp (3),
  "source_forwarder_name" text NOT NULL,
  "state" "commerce_freight_rate_card_state" DEFAULT 'active' NOT NULL,
  "superseded_by_rate_card_id" text,
  "created_at" timestamp (3) DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- `restrict`: a card is the record of what a forwarder charged, and deleting the provider
-- must not silently take the price history with it.
ALTER TABLE "commerce_freight_rate_card"
  ADD CONSTRAINT "commerce_freight_rate_card_provider_organization_id_commerce_provider_profile_fk"
  FOREIGN KEY ("provider_organization_id") REFERENCES "commerce_provider_profile"("organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- `set null`, not `restrict`: the successor pointer is provenance, not an invariant worth
-- blocking a delete over. The lifecycle CHECK below keeps it honest while it lives.
ALTER TABLE "commerce_freight_rate_card"
  ADD CONSTRAINT "commerce_freight_rate_card_superseded_by_rate_card_id_commerce_freight_rate_card_fk"
  FOREIGN KEY ("superseded_by_rate_card_id") REFERENCES "commerce_freight_rate_card"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- The rating read's lane lookup. `valid_until` rides in the index because the read predicate
-- is the WINDOW, not the state — see the partial unique below.
CREATE INDEX IF NOT EXISTS "commerce_freight_rate_card_lane_idx"
  ON "commerce_freight_rate_card" ("origin_country_code", "destination_country_code", "mode", "valid_until", "id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "commerce_freight_rate_card_provider_idx"
  ON "commerce_freight_rate_card" ("provider_organization_id", "state", "id");
--> statement-breakpoint

-- AT MOST ONE ACTIVE CARD PER LANE, PER PROVIDER, PER CURRENCY.
--
-- PROVIDER AND CURRENCY BELONG IN THE KEY: §19.5's `options[]` is plural, so several
-- forwarders quoting one lane at once is the normal case, and §19.1's estimate is
-- per-currency, so a USD card and a EUR card coexist. Dropping either would make the second
-- forwarder's card unstorable.
--
-- THIS IS A WRITE INVARIANT AND NOT THE READ PREDICATE. A future-dated successor flips its
-- incumbent to `superseded` while the incumbent's window is still open, so the rating read
-- selects on the WINDOW plus `state <> 'withdrawn'`. Reading on `state = 'active'` would
-- black out a lane the moment a successor was scheduled.
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_freight_rate_card_active_uidx"
  ON "commerce_freight_rate_card" ("provider_organization_id", "origin_country_code", "destination_country_code", "mode", "currency")
  WHERE "state" = 'active';
--> statement-breakpoint

-- `origin = destination` STAYS LEGAL. §19.4's inland leg is a domestic lane with a real land
-- rate behind it; forbidding it here would delete half the journey.
ALTER TABLE "commerce_freight_rate_card"
  ADD CONSTRAINT "commerce_freight_rate_card_country_ck"
  CHECK ("origin_country_code" ~ '^[A-Z]{2}$' AND "destination_country_code" ~ '^[A-Z]{2}$');
--> statement-breakpoint

ALTER TABLE "commerce_freight_rate_card"
  ADD CONSTRAINT "commerce_freight_rate_card_currency_ck"
  CHECK ("currency" ~ '^[A-Z]{3}$');
--> statement-breakpoint

ALTER TABLE "commerce_freight_rate_card"
  ADD CONSTRAINT "commerce_freight_rate_card_window_ck"
  CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from");
--> statement-breakpoint

ALTER TABLE "commerce_freight_rate_card"
  ADD CONSTRAINT "commerce_freight_rate_card_source_ck"
  CHECK (char_length("source_forwarder_name") BETWEEN 1 AND 200);
--> statement-breakpoint

-- The lifecycle cannot be half-true. A superseded card names its successor; an active or
-- withdrawn one has none; and no card supersedes itself.
ALTER TABLE "commerce_freight_rate_card"
  ADD CONSTRAINT "commerce_freight_rate_card_lifecycle_ck"
  CHECK (("state" = 'superseded') = ("superseded_by_rate_card_id" IS NOT NULL)
         AND ("superseded_by_rate_card_id" IS NULL OR "superseded_by_rate_card_id" <> "id"));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Breaks. TRANSIT DAYS LIVE HERE, NOT ON THE CARD (§19.2): an air break and a sea break on
-- one lane have different durations by definition, and a 40 kg consignment and a 4 t
-- consignment on one lane are not the same journey.
--
-- `unit_price_in_cents` IS CENTS PER KILOGRAM OF CHARGEABLE WEIGHT. §19 never says so — it
-- is recorded here and in the schema comment because it is the one assumption that, if the
-- read half disagreed, would make the number WRONG rather than absent. The two `min_*`
-- columns are the band's FLOOR, its entry condition, and NOT its denominator.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "commerce_freight_rate_break" (
  "id" text PRIMARY KEY NOT NULL,
  "rate_card_id" text NOT NULL,
  "position" integer NOT NULL,
  "min_billable_weight_grams" bigint NOT NULL,
  "min_volume_cubic_cm" bigint NOT NULL,
  "unit_price_in_cents" integer NOT NULL,
  "minimum_charge_in_cents" bigint NOT NULL,
  "transit_days_min" integer NOT NULL,
  "transit_days_max" integer NOT NULL,
  "created_at" timestamp (3) DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- `cascade`, per §19.2. A break is meaningless without the card that scopes it to a lane, a
-- currency and a validity window; an orphan break is a price for nowhere.
ALTER TABLE "commerce_freight_rate_break"
  ADD CONSTRAINT "commerce_freight_rate_break_rate_card_id_commerce_freight_rate_card_fk"
  FOREIGN KEY ("rate_card_id") REFERENCES "commerce_freight_rate_card"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_freight_rate_break_position_uidx"
  ON "commerce_freight_rate_break" ("rate_card_id", "position");
--> statement-breakpoint

-- TWO BANDS MAY NOT SHARE A FLOOR. The ladder picks "the highest band this consignment
-- clears"; two rows with the same floor make that pick arbitrary, and an arbitrary pick is a
-- price the platform cannot explain.
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_freight_rate_break_floor_uidx"
  ON "commerce_freight_rate_break" ("rate_card_id", "min_billable_weight_grams", "min_volume_cubic_cm");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "commerce_freight_rate_break_ladder_idx"
  ON "commerce_freight_rate_break" ("rate_card_id", "min_billable_weight_grams", "id");
--> statement-breakpoint

ALTER TABLE "commerce_freight_rate_break"
  ADD CONSTRAINT "commerce_freight_rate_break_bounds_ck"
  CHECK ("position" >= 0 AND "min_billable_weight_grams" >= 0 AND "min_volume_cubic_cm" >= 0);
--> statement-breakpoint

-- A ZERO UNIT PRICE IS §19.6's FORBIDDEN ZERO — "an uncovered lane returns an empty
-- options[], never a zero". A zero MINIMUM CHARGE is legitimate: plenty of tariffs have no
-- floor, and refusing one would push admins to type `1`.
ALTER TABLE "commerce_freight_rate_break"
  ADD CONSTRAINT "commerce_freight_rate_break_price_ck"
  CHECK ("unit_price_in_cents" > 0 AND "minimum_charge_in_cents" >= 0);
--> statement-breakpoint

ALTER TABLE "commerce_freight_rate_break"
  ADD CONSTRAINT "commerce_freight_rate_break_transit_ck"
  CHECK ("transit_days_min" >= 0 AND "transit_days_max" >= "transit_days_min" AND "transit_days_max" <= 365);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Customs dwell. NOTHING MODELS THIS TODAY (§19.3): `customs_broker` exists as a provider
-- kind and its offerings carry lead times, but an offering's lead time is the BROKER's own
-- turnaround, not the PORT's.
--
-- NO `state` COLUMN, unlike the rate card. §19.3 defines none and it needs none — the window
-- IS the lifecycle, and retiring an estimate is closing its window.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "commerce_customs_dwell_estimate" (
  "id" text PRIMARY KEY NOT NULL,
  "destination_country_code" text NOT NULL,
  "origin_country_code" text,
  "commodity_scope_category_id" text,
  "clearance_days_min" integer NOT NULL,
  "clearance_days_max" integer NOT NULL,
  "source" text NOT NULL,
  "valid_from" timestamp (3) NOT NULL,
  "valid_until" timestamp (3),
  "created_at" timestamp (3) DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- `restrict`, matching `product.category_id`. §16's admin surface has no DELETE at all, only
-- retire, so this can never fire in normal operation — and if it ever does, refusing is
-- right: a dwell estimate scoped to a category nobody can name is unreadable.
ALTER TABLE "commerce_customs_dwell_estimate"
  ADD CONSTRAINT "commerce_customs_dwell_estimate_commodity_scope_category_id_commerce_category_fk"
  FOREIGN KEY ("commodity_scope_category_id") REFERENCES "commerce_category"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "commerce_customs_dwell_estimate_lane_idx"
  ON "commerce_customs_dwell_estimate" ("destination_country_code", "origin_country_code", "commodity_scope_category_id", "id");
--> statement-breakpoint

-- AT MOST ONE OPEN-ENDED ESTIMATE PER SCOPE.
--
-- `coalesce` because NULL is a VALUE here — "any origin", "any commodity" — and two rows
-- both claiming "any origin into DE, indefinitely" is exactly the ambiguity this refuses.
--
-- `WHERE valid_until IS NULL` AND NOT `valid_until > now()`: `now()` is not IMMUTABLE and
-- Postgres refuses it in an index predicate. Overlap between two CLOSED windows is checked
-- in the service and answered 409 — a full exclusion would need a `tstzrange` EXCLUDE
-- constraint and `btree_gist`, an extension this repo does not install for one table.
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_customs_dwell_estimate_live_uidx"
  ON "commerce_customs_dwell_estimate" ("destination_country_code", coalesce("origin_country_code", '__any__'), coalesce("commodity_scope_category_id", '__any__'))
  WHERE "valid_until" IS NULL;
--> statement-breakpoint

-- A DOMESTIC LANE HAS NO CUSTOMS LEG AT ALL (§19.3) — an ABSENT component, not a zero-day
-- one. A row asserting IN→IN dwell would make "not applicable" storable as "known to be
-- short", which is the A11 mistake in a new place.
ALTER TABLE "commerce_customs_dwell_estimate"
  ADD CONSTRAINT "commerce_customs_dwell_estimate_country_ck"
  CHECK ("destination_country_code" ~ '^[A-Z]{2}$'
         AND ("origin_country_code" IS NULL
              OR ("origin_country_code" ~ '^[A-Z]{2}$'
                  AND "origin_country_code" <> "destination_country_code")));
--> statement-breakpoint

ALTER TABLE "commerce_customs_dwell_estimate"
  ADD CONSTRAINT "commerce_customs_dwell_estimate_days_ck"
  CHECK ("clearance_days_min" >= 0 AND "clearance_days_max" >= "clearance_days_min" AND "clearance_days_max" <= 365);
--> statement-breakpoint

ALTER TABLE "commerce_customs_dwell_estimate"
  ADD CONSTRAINT "commerce_customs_dwell_estimate_source_ck"
  CHECK (char_length("source") BETWEEN 1 AND 200);
--> statement-breakpoint

ALTER TABLE "commerce_customs_dwell_estimate"
  ADD CONSTRAINT "commerce_customs_dwell_estimate_window_ck"
  CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from");
