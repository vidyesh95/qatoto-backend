-- Store Phase 14 — every new enum, and nothing else.
--
-- THIS FILE IS ENUM-ONLY ON PURPOSE, and the reason is a trap this repository has already
-- been caught by. `drizzle-kit migrate` applies every pending migration inside ONE
-- transaction. A value introduced by `ALTER TYPE ... ADD VALUE` cannot be USED as an enum
-- literal until that transaction commits, so a later migration in the same run that writes
-- `kind = 'settlement_custody_memo'` fails with "unsafe use of new value of enum type".
--
-- Two ways out, and both are taken below:
--
--   1. A brand-new type created with CREATE TYPE is usable immediately, in the same
--      transaction, because it did not exist beforehand. Every type in section A is new,
--      so 0083-0087 may reference those values freely.
--
--   2. A value added to a PRE-EXISTING type is not. Section B extends
--      `commerce_journal_account_kind` and `commerce_journal_kind`, so any constraint,
--      trigger or index in 0083-0087 that mentions one of those values compares on
--      `::text` instead of the enum. `commerce_journal_account_memorandum_ck` in 0087 is
--      the only place this actually bites, and it is written that way.
--
-- Splitting the enums into their own release would also work and is the textbook answer.
-- It is not what this does, because a six-migration phase that needs two deploys to apply
-- is a phase somebody applies half of.

-- ---------------------------------------------------------------------------
-- A. New types. Safe to use anywhere downstream in this same run.
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."commerce_settlement_rail" AS ENUM('internal_custody', 'direct_offline', 'direct_processor', 'external_escrow');--> statement-breakpoint
CREATE TYPE "public"."commerce_connector_kind" AS ENUM('external_escrow', 'logistics', 'insurance', 'laboratory', 'foreign_exchange');--> statement-breakpoint
CREATE TYPE "public"."commerce_external_provider_state" AS ENUM('draft', 'active', 'suspended', 'retired');--> statement-breakpoint
CREATE TYPE "public"."commerce_settlement_agreement_state" AS ENUM('proposed', 'accepted', 'declined', 'withdrawn', 'superseded', 'expired', 'consumed');--> statement-breakpoint
CREATE TYPE "public"."commerce_escrow_fee_bearer" AS ENUM('buyer', 'seller', 'split');--> statement-breakpoint
CREATE TYPE "public"."commerce_escrow_milestone_kind" AS ENUM('deposit', 'shipment', 'inspection', 'delivery', 'final');--> statement-breakpoint
CREATE TYPE "public"."commerce_escrow_session_state" AS ENUM('created', 'awaiting_funding', 'funded', 'partially_released', 'released', 'refunded', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."commerce_escrow_milestone_state" AS ENUM('planned', 'locked', 'verification_pending', 'verification_failed', 'release_requested', 'released', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."commerce_escrow_verification_source" AS ENUM('order_confirmed', 'shipment_leg_event', 'inspection_engagement', 'order_completion');--> statement-breakpoint
CREATE TYPE "public"."commerce_settlement_attestation_kind" AS ENUM('payment_sent', 'payment_received');--> statement-breakpoint
CREATE TYPE "public"."commerce_connector_outbox_kind" AS ENUM('escrow_create_session', 'escrow_lock_milestones', 'escrow_submit_verification', 'escrow_request_release', 'escrow_request_refund');--> statement-breakpoint
CREATE TYPE "public"."commerce_connector_outbox_state" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."commerce_message_kind" AS ENUM('participant', 'settlement_proposed', 'settlement_accepted', 'settlement_declined', 'settlement_withdrawn');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- B. Values on existing types. NOT usable as enum literals until this transaction
--    commits — downstream migrations must compare on `::text`.
-- ---------------------------------------------------------------------------

-- The four memo accounts. Off balance sheet: they record what a third party holds, so
-- gross order value stays reconcilable without Qatoto ever claiming it as an asset.
-- Together they satisfy funding + custody + released + refunded = 0, per order, always.
ALTER TYPE "public"."commerce_journal_account_kind" ADD VALUE IF NOT EXISTS 'settlement_funding_memo';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_account_kind" ADD VALUE IF NOT EXISTS 'settlement_custody_memo';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_account_kind" ADD VALUE IF NOT EXISTS 'settlement_released_memo';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_account_kind" ADD VALUE IF NOT EXISTS 'settlement_refunded_memo';--> statement-breakpoint

-- The only real money in this phase: Qatoto's own commission. Receiving one's own revenue
-- is not custody of anyone else's funds, which is why these three are on balance sheet
-- while the four above are not. `platform_fee_earned` is a CREDIT account and runs
-- negative, exactly as `buyer_clearing` does.
ALTER TYPE "public"."commerce_journal_account_kind" ADD VALUE IF NOT EXISTS 'platform_fee_receivable';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_account_kind" ADD VALUE IF NOT EXISTS 'platform_fee_earned';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_account_kind" ADD VALUE IF NOT EXISTS 'platform_fee_cash';--> statement-breakpoint

-- Every escrow value here is posted ONLY from a normalized provider event. A release
-- REQUEST posts nothing: Qatoto's books follow the provider and never lead it.
ALTER TYPE "public"."commerce_journal_kind" ADD VALUE IF NOT EXISTS 'escrow_funded';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_kind" ADD VALUE IF NOT EXISTS 'escrow_released';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_kind" ADD VALUE IF NOT EXISTS 'escrow_refunded';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_kind" ADD VALUE IF NOT EXISTS 'direct_settled';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_kind" ADD VALUE IF NOT EXISTS 'fee_recognized';--> statement-breakpoint
ALTER TYPE "public"."commerce_journal_kind" ADD VALUE IF NOT EXISTS 'fee_collected';
