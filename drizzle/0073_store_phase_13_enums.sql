-- Store Phase 13 — anti-fraud trending and ranking: enum values and types.
--
-- Split out from 0074–0081 for the reason 0057, 0059, 0064 and 0069 were split: ALTER TYPE
-- ... ADD VALUE cannot run inside a transaction block in older Postgres, and a value added
-- in one transaction cannot be USED by that same transaction. `drizzle-kit migrate` runs
-- every pending file as ONE transaction, so a value added here and referenced by DDL in a
-- later pending file would fail.
--
-- THIS PHASE AVOIDS THAT SITUATION RATHER THAN NEGOTIATING WITH IT, as 0064 and 0069 did.
-- None of the three ADD VALUE'd values below is referenced by any DDL in 0074–0081 — all
-- three appear only in runtime INSERTs and in a service-layer switch, long after migrate
-- commits.
--
-- ADD VALUE is not reversible. Every statement is idempotent, but rollback means disabling
-- routes and flipping rail rows back to `trending_placeholder`, not dropping values. That
-- is why both new rail strategies land HERE, together: a second irreversible migration to
-- add the second strategy would buy nothing and cost another one-way door.

-- ---------------------------------------------------------------------------
-- Where a product view came from.
--
-- A CLIENT-SUPPLIED LABEL, and it is safe to accept only because nothing gates on it.
-- It never selects a rate, a weight or an eligibility — it exists so an operator can ask
-- "did this spike arrive through search or through one rail?" when triaging a fraud
-- review. `unknown` is the value a caller gets for sending nothing, not an error: a view
-- with an unattributed source is still a view.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_product_view_source" AS ENUM('product_detail', 'search', 'rail', 'pathway', 'companion', 'unknown');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Whether an order's buyer cleared the trusted-buyer bar AT THE MOMENT IT CONFIRMED.
--
-- `unevaluated` is the load-bearing value and it is not a synonym for `unqualified`.
-- Every order confirmed before this phase has it, and such a row is absent from BOTH the
-- numerator and the denominator of every velocity computation — the posture
-- `promised_delivery_at` established in Phase 12 for orders that predate it. Collapsing
-- `unevaluated` into `unqualified` would state that a buyer FAILED a test that was never
-- administered, and would make every historical order evidence against its seller.
--
-- Stamped once, at confirm, and immutable thereafter. Recomputing it at read time would
-- let a buyer retroactively qualify its own past orders by verifying its business today,
-- which is the cheapest possible attack on an order-velocity ranker.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_buyer_qualification_state" AS ENUM('qualified', 'unqualified', 'unevaluated');--> statement-breakpoint

-- Why the verdict went the way it did. An ARRAY of these rides on the order, because a
-- single reason column would force a precedence rule between "old enough" and "has a tax
-- id on file" that does not exist — the bar is an AND of one age test and an OR of three
-- credentials, and a reviewer needs to see which credential answered.
CREATE TYPE "public"."commerce_buyer_qualification_reason" AS ENUM(
  'account_age_met',
  'prior_order_history',
  'verified_business_email_domain',
  'business_registration_on_file',
  'tax_identifier_on_file',
  'account_too_new',
  'no_qualifying_credential',
  'anonymous_account',
  'organization_not_active',
  'organization_ranking_excluded',
  'sample_order',
  'below_value_floor'
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Which ranking regime produced a row.
--
-- `sparse_exploration` is NOT a degraded mode to be embarrassed about — on a young B2B
-- catalog it is the COMMON case, because a category needs 30 qualified orders in 30 days
-- before a percentile means anything. Storing it on every snapshot row is what lets the
-- phase verifier assert that no product with zero qualified orders in W2 ever appears
-- claiming `percentile`, which is the specific regression that turns this engine back
-- into a popularity contest.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_ranking_mode" AS ENUM('percentile', 'sparse_exploration');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- WHICH RUNG OF THE PRIOR LADDER ANSWERED.
--
-- The whole point of hierarchical smoothing is that a category prior and a global prior
-- are different claims. A bare number cannot say which one it is, so a reader would have
-- no way to distinguish "this category's own 400 orders say 3.1%" from "we had nothing
-- and used the platform mean". `default_floor` is the last resort and its presence in a
-- row is a signal that the taxonomy above it is empty, not a normal outcome.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_category_prior_level" AS ENUM('category', 'parent_category', 'global', 'default_floor');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What reduced a score, recorded per application.
--
-- Penalties are enumerated rather than summed into one opaque multiplier so that a seller
-- appealing a suppression can be told WHICH signal fired. "Your score was multiplied by
-- 0.4" is not a reviewable statement; "38 of your 40 saves came from one network block"
-- is.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_ranking_penalty_kind" AS ENUM(
  'subnet_concentration',
  'refund_rate',
  'cancellation_rate',
  'low_order_value',
  'conversion_kill_switch'
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What the circuit breaker DID.
--
-- `none` is written on purpose and is most of the table's early life: the breaker ships
-- in observe-only mode, so the rate at which it WOULD have fired is countable before it
-- is allowed to fire. A breaker enabled on the strength of a designer's confidence rather
-- than an observed false-positive rate is how a marketplace suppresses honest sellers.
--
-- Nothing here deletes or unpublishes. Delisting a product is a commercial action that
-- requires a human, which is the same call Phase 10 made when it refused to let an
-- automatic report hide a product.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_ranking_enforcement_action" AS ENUM('none', 'weight_reduced', 'capped', 'quarantined', 'review_queued');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What we know about the email domain an order's buyer used.
--
-- ABSENCE FROM `commerce_business_email_domain` MEANS `unknown`, NEVER `verified_business`.
-- The table ships with a disposable/free-mail denylist only, because a denylist of
-- throwaway providers is obtainable and an ALLOWLIST of every legitimate company domain
-- on earth is not. So this classification can currently DENY a qualification credential
-- and can almost never GRANT one — an asymmetry the rollout doc states plainly rather
-- than papering over, because it is also why the subnet guard's corporate-NAT exemption
-- cannot be built yet.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."commerce_email_domain_classification" AS ENUM('verified_business', 'free_mail', 'disposable', 'unknown');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The two new rail strategies.
--
-- `trending_placeholder` IS DELIBERATELY LEFT IN PLACE and keeps returning an empty list.
-- Postgres cannot drop an enum value, but that is not the reason to keep it: while it
-- exists, rolling this phase back is a per-rail data edit a merchandiser can perform in
-- seconds, not a deploy. A rail only starts claiming to show what is rising when a human
-- flips it.
--
-- `recommended` is added in the same statement block because ADD VALUE is a one-way door
-- and there is no reason to walk through two of them.
-- ---------------------------------------------------------------------------
ALTER TYPE "public"."store_rail_strategy" ADD VALUE IF NOT EXISTS 'trending';--> statement-breakpoint
ALTER TYPE "public"."store_rail_strategy" ADD VALUE IF NOT EXISTS 'recommended';--> statement-breakpoint

-- A moderator resolving a ranking appeal or overriding an automatic enforcement lands on
-- the COMMERCE ORGANIZATION chain, matching `certification_decided` (0069) and
-- `trade_state_changed`: the suppressed product always has an owning organization, and
-- that organization's own history is where a reader would look for why its product fell
-- out of a rail.
--
-- AUDIT PAYLOADS for this kind must dodge `FORBIDDEN_PAYLOAD_KEY` in
-- commerce-organization-audit.service.ts, which matches `filename` and `object.*key` and
-- THROWS — the regex that took `POST /commerce/organizations/:id/addresses` down for
-- every caller in Phase 11. Carry productId / action / penaltyKinds, and never a
-- fingerprint, a subnet hash or a raw address.
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE IF NOT EXISTS 'ranking_enforcement_decided';
