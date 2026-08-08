-- Store Phase 14 — the settlement rail on the order, the memorandum flag on the journal
-- account, and the guard that binds one to the other.
--
-- ## Why the rail defaults to `internal_custody`
--
-- Because that is what every pre-Phase-14 order actually did: it posted
-- `buyer_clearing -> order_held`, which asserts that Qatoto held the buyer's money.
-- §14 has now decided against that model, but relabelling history to the rail we WISH those
-- orders had run on would make the journal disagree with the rail it claims. The value is
-- true and unflattering, which is the correct kind of default. `internal_custody` is
-- refuse-closed in production going forward and retained forever so that backing this phase
-- out is a data edit rather than a deploy — the posture `trending_placeholder` already holds.
--
-- ## Why the rail joins the immutable snapshot
--
-- How an order settles is a commercial fact of the same class as its currency and its
-- totals. If it could be updated, a confirmed unprotected order could be relabelled as
-- escrow-protected after the fact, or an escrowed one quietly downgraded — and the audit
-- trail would show neither. It is therefore computed BEFORE the INSERT at confirm and added
-- to `commerce_prevent_order_snapshot_mutation` below.
--
-- ## The account guard
--
-- Each rail permits a different set of journal accounts, and the sets are disjoint where it
-- matters. `order_held` means Qatoto is holding funds, so it is unreachable on every rail
-- except the frozen one. The four memo accounts record what a THIRD party holds, so they are
-- unreachable on `internal_custody` and on `direct_offline`. `settlement_custody_memo` is
-- further denied to `direct_processor`, because that rail settles buyer straight to seller
-- and skips the custody hop — funding goes directly to released, and a custody balance there
-- would be value nobody is holding.
--
-- `direct_offline` permits NO settlement account at all, only commission. Qatoto cannot
-- observe a wire between two banks it has no relationship with, and posting a memo entry for
-- money it did not see would assert a fact from an absence. What that rail records instead
-- is `commerce_settlement_attestation` — each party's own claim, attributed.
--
-- `seller_payable` is permitted only on the frozen rail, and nothing posts it even there. It
-- means "Qatoto owes the seller money it is holding", which under no-custody can never be
-- true: the escrow provider owes the seller, or nobody does.
--
-- EVERY COMPARISON IS ON `::text`. The account kinds this guard names were added by
-- `ALTER TYPE ... ADD VALUE` in 0082, and `drizzle-kit migrate` runs the whole phase in one
-- transaction — an enum literal would fail with "unsafe use of new value of enum type".

ALTER TABLE "commerce_order" ADD COLUMN "settlement_rail" "commerce_settlement_rail" DEFAULT 'internal_custody' NOT NULL;--> statement-breakpoint

ALTER TABLE "commerce_journal_account" ADD COLUMN "is_memorandum" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Derived from `kind` and bound to it, so it cannot drift. The point is not the column but
-- that no future balance report can sum memo value and real money into one number —
-- flattening the two is unavailable rather than discouraged, the same call Phase 12 made
-- splitting `declaredProfile` from `measuredMetrics`.
ALTER TABLE "commerce_journal_account" ADD CONSTRAINT "commerce_journal_account_memorandum_ck" CHECK (
	is_memorandum = (kind::text IN ('settlement_funding_memo', 'settlement_custody_memo',
	                                'settlement_released_memo', 'settlement_refunded_memo'))
);--> statement-breakpoint

ALTER TABLE "commerce_payment_intent" ADD COLUMN "settlement_account_ref" text;--> statement-breakpoint
ALTER TABLE "commerce_payment_intent" ADD COLUMN "application_fee_in_cents" bigint;--> statement-breakpoint

-- The `direct_processor` rail settles to the SELLER's account at the processor, with Qatoto
-- taking an application fee. Both columns are null on every other rail, and a fee without a
-- destination account would be a deduction from money we are not routing.
ALTER TABLE "commerce_payment_intent" ADD CONSTRAINT "commerce_payment_intent_settlement_account_ck" CHECK (
	(settlement_account_ref IS NULL OR char_length(settlement_account_ref) BETWEEN 1 AND 200)
	AND (application_fee_in_cents IS NULL
	     OR (application_fee_in_cents >= 0 AND application_fee_in_cents <= amount_in_cents))
	AND (application_fee_in_cents IS NULL OR settlement_account_ref IS NOT NULL)
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_settlement_rail_account_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_settlement_rail_account_guard$
DECLARE
	order_rail text;
	-- The kind column is named `kind` on the account table and `account_kind` on the line
	-- table. Reading it out of `to_jsonb(NEW)` by the name passed in TG_ARGV lets one
	-- function serve both, so the two can never disagree about the rule.
	candidate_kind text := to_jsonb(NEW) ->> TG_ARGV[0];
	permitted_kinds text[];
BEGIN
	SELECT o.settlement_rail::text
	  INTO order_rail
	  FROM commerce_order o
	 WHERE o.id = NEW.order_id;

	IF order_rail IS NULL THEN
		RETURN NEW;
	END IF;

	permitted_kinds := CASE order_rail
		WHEN 'internal_custody' THEN ARRAY[
			'buyer_clearing', 'order_held', 'seller_payable', 'platform_fee',
			'refunds_payable', 'reconciliation_suspense']
		WHEN 'direct_offline' THEN ARRAY[
			'platform_fee_receivable', 'platform_fee_earned', 'platform_fee_cash',
			'reconciliation_suspense']
		WHEN 'direct_processor' THEN ARRAY[
			'settlement_funding_memo', 'settlement_released_memo', 'settlement_refunded_memo',
			'platform_fee_receivable', 'platform_fee_earned', 'platform_fee_cash',
			'reconciliation_suspense']
		WHEN 'external_escrow' THEN ARRAY[
			'settlement_funding_memo', 'settlement_custody_memo', 'settlement_released_memo',
			'settlement_refunded_memo', 'platform_fee_receivable', 'platform_fee_earned',
			'platform_fee_cash', 'reconciliation_suspense']
	END;

	IF permitted_kinds IS NULL OR NOT (candidate_kind = ANY (permitted_kinds)) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = format(
				'commerce journal account kind %s is not permitted on the %s settlement rail',
				candidate_kind, order_rail);
	END IF;

	RETURN NEW;
END
$commerce_settlement_rail_account_guard$;--> statement-breakpoint

DROP TRIGGER IF EXISTS commerce_journal_account_rail_guard ON "commerce_journal_account";--> statement-breakpoint
CREATE TRIGGER commerce_journal_account_rail_guard
BEFORE INSERT ON "commerce_journal_account"
FOR EACH ROW EXECUTE FUNCTION commerce_settlement_rail_account_guard('kind');--> statement-breakpoint

DROP TRIGGER IF EXISTS commerce_journal_line_rail_guard ON "commerce_journal_line";--> statement-breakpoint
CREATE TRIGGER commerce_journal_line_rail_guard
BEFORE INSERT ON "commerce_journal_line"
FOR EACH ROW EXECUTE FUNCTION commerce_settlement_rail_account_guard('account_kind');--> statement-breakpoint

-- Extend the existing snapshot guard rather than adding a second one, so there stays
-- exactly one place that answers "which columns of a confirmed order are frozen".
CREATE OR REPLACE FUNCTION commerce_prevent_order_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_order_snapshot_immutable$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commerce order snapshots are immutable';
  END IF;

  IF NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.subtotal_in_cents IS DISTINCT FROM OLD.subtotal_in_cents
     OR NEW.tax_in_cents IS DISTINCT FROM OLD.tax_in_cents
     OR NEW.service_fee_in_cents IS DISTINCT FROM OLD.service_fee_in_cents
     OR NEW.shipping_in_cents IS DISTINCT FROM OLD.shipping_in_cents
     OR NEW.discount_in_cents IS DISTINCT FROM OLD.discount_in_cents
     OR NEW.total_in_cents IS DISTINCT FROM OLD.total_in_cents
     OR NEW.buyer_legal_name_snapshot IS DISTINCT FROM OLD.buyer_legal_name_snapshot
     OR NEW.counterparty_legal_name_snapshot IS DISTINCT FROM OLD.counterparty_legal_name_snapshot
     OR NEW.accepted_quote_id IS DISTINCT FROM OLD.accepted_quote_id
     OR NEW.accepted_quote_revision_id IS DISTINCT FROM OLD.accepted_quote_revision_id
     OR NEW.checkout_group_id IS DISTINCT FROM OLD.checkout_group_id
     -- Phase 14. How an order settles is as commercial a fact as what it cost, and a
     -- mutable rail would let a confirmed unprotected order be relabelled as protected.
     OR NEW.settlement_rail IS DISTINCT FROM OLD.settlement_rail
     OR NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commerce order commercial snapshot is immutable';
  END IF;

  RETURN NEW;
END
$commerce_order_snapshot_immutable$;
