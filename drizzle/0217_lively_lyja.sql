-- Fix 0216: commerce_order_third_party_declaration_coverage_ck admitted an amount with no currency
-- (and a currency with no amount), because NULL > 0 and NULL ~ regex are NULL and a CHECK that
-- evaluates to NULL passes. The table held no rows when this was replaced.
ALTER TABLE "commerce_order_third_party_declaration" DROP CONSTRAINT "commerce_order_third_party_declaration_coverage_ck";--> statement-breakpoint
ALTER TABLE "commerce_order_third_party_declaration" ADD CONSTRAINT "commerce_order_third_party_declaration_coverage_ck" CHECK ((coverage_amount_in_cents IS NULL AND coverage_currency IS NULL) OR (coverage_amount_in_cents IS NOT NULL AND coverage_currency IS NOT NULL AND coverage_amount_in_cents > 0 AND coverage_currency ~ '^[A-Z]{3}$'));