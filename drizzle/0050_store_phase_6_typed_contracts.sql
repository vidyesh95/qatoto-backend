-- Store Phase 6 typed-contract follow-up.
-- Idempotent where migration 0049 already supplied the same fresh-install shape.

CREATE TABLE IF NOT EXISTS "freight_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	CONSTRAINT "freight_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk"
	  FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id")
	  ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "freight_deliverable_detail_summary_ck"
	  CHECK (char_length(summary) BETWEEN 1 AND 2000)
);--> statement-breakpoint

UPDATE insurance_quote_service_detail
   SET currency = NULL
 WHERE coverage_limit_in_cents IS NULL;--> statement-breakpoint
UPDATE foreign_exchange_quote_service_detail
   SET notional_currency = NULL
 WHERE notional_amount_in_cents IS NULL;--> statement-breakpoint

ALTER TABLE "insurance_quote_service_detail" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "insurance_quote_service_detail" ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "foreign_exchange_quote_service_detail" ALTER COLUMN "notional_currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "foreign_exchange_quote_service_detail" ALTER COLUMN "notional_currency" DROP NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'insurance_quote_service_detail_amount_currency_pair_ck'
       AND conrelid = 'insurance_quote_service_detail'::regclass
  ) THEN
    ALTER TABLE "insurance_quote_service_detail"
      ADD CONSTRAINT "insurance_quote_service_detail_amount_currency_pair_ck"
      CHECK ((coverage_limit_in_cents IS NULL) = (currency IS NULL));
  END IF;
END
$$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'insurance_quote_service_detail_currency_ck'
       AND conrelid = 'insurance_quote_service_detail'::regclass
  ) THEN
    ALTER TABLE "insurance_quote_service_detail"
      ADD CONSTRAINT "insurance_quote_service_detail_currency_ck"
      CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
  END IF;
END
$$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'foreign_exchange_quote_service_detail_notional_currency_pair_ck'
       AND conrelid = 'foreign_exchange_quote_service_detail'::regclass
  ) THEN
    ALTER TABLE "foreign_exchange_quote_service_detail"
      ADD CONSTRAINT "foreign_exchange_quote_service_detail_notional_currency_pair_ck"
      CHECK ((notional_amount_in_cents IS NULL) = (notional_currency IS NULL));
  END IF;
END
$$;
