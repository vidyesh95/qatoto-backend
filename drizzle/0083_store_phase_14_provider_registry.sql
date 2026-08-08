-- Store Phase 14 — the external provider registry.
--
-- The set of outside systems this backend may talk to: escrow holders, freight forwarders,
-- insurers, laboratories, FX facilitators. One table for all five connector kinds, because
-- what a connector needs to be reachable — coverage, currency, bounds, credentials, a
-- signing secret — does not vary by kind. What it can DO varies, and that lives in the
-- adapter, not here.
--
-- NO SECRET IS STORED. `credential_ref` and `webhook_signing_secret_ref` name the
-- environment variable that holds the secret; the value never enters the database (§11).
-- A row is therefore safe to read in a support context, which a row holding an escrow API
-- key would not be.
--
-- COVERAGE IS REACHABILITY, NOT PREFERENCE. Nothing in this table selects a provider for
-- anybody. It answers "could this provider serve IN → DE in USD at this order size", and
-- that is all. Which provider is used is settled by a mutual agreement between buyer and
-- seller (0084), never by a platform policy — Qatoto does not pick a counterparty's
-- financial intermediary for them.

CREATE TABLE "commerce_external_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_kind" "commerce_connector_kind" NOT NULL,
	"provider_slug" text NOT NULL,
	"display_name" text NOT NULL,
	"state" "commerce_external_provider_state" DEFAULT 'draft' NOT NULL,
	"credential_ref" text,
	"webhook_signing_secret_ref" text,
	"supported_country_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"supported_currencies" text[] DEFAULT '{}'::text[] NOT NULL,
	"minimum_order_in_cents" bigint,
	"maximum_order_in_cents" bigint,
	"platform_rank" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_external_provider_slug_ck" CHECK (provider_slug ~ '^[a-z][a-z0-9_]{1,60}$'),
	CONSTRAINT "commerce_external_provider_display_ck" CHECK (char_length(display_name) BETWEEN 1 AND 200),
	-- Element-wise format checks. A CHECK constraint may not contain a subquery, so
	-- `unnest` is unavailable; joining the array and matching the whole string is the
	-- shape that works without a trigger.
	CONSTRAINT "commerce_external_provider_countries_ck" CHECK (
		cardinality(supported_country_codes) = 0
		OR array_to_string(supported_country_codes, ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$'
	),
	CONSTRAINT "commerce_external_provider_currencies_ck" CHECK (
		cardinality(supported_currencies) = 0
		OR array_to_string(supported_currencies, ',') ~ '^[A-Z]{3}(,[A-Z]{3})*$'
	),
	CONSTRAINT "commerce_external_provider_bounds_ck" CHECK (
		(minimum_order_in_cents IS NULL OR minimum_order_in_cents >= 0)
		AND (maximum_order_in_cents IS NULL OR maximum_order_in_cents >= 0)
		AND (minimum_order_in_cents IS NULL OR maximum_order_in_cents IS NULL
		     OR minimum_order_in_cents <= maximum_order_in_cents)
	),
	CONSTRAINT "commerce_external_provider_rank_ck" CHECK (platform_rank >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "commerce_external_provider_slug_uidx" ON "commerce_external_provider" USING btree ("connector_kind","provider_slug");--> statement-breakpoint

-- The eligibility query's driving index. Partial on `active` because a draft, suspended or
-- retired provider is never a candidate, and `platform_rank` is in the index because it is
-- the deterministic tie-break when two providers are otherwise equally eligible.
CREATE INDEX "commerce_external_provider_active_idx" ON "commerce_external_provider" USING btree ("connector_kind","platform_rank","id") WHERE state = 'active';
