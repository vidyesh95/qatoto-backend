-- Store Phase 6 hardening — deterministic quote linkage, immutable snapshots,
-- paired monetary currencies, and normalized quote deliverable plans.
-- Additive follow-up to published migration 0048.

CREATE TABLE "commerce_quote_service_deliverable_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_service_line_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"title" text NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"due_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_quote_service_deliverable_plan_sequence_ck" CHECK (sequence >= 0),
	CONSTRAINT "commerce_quote_service_deliverable_plan_title_ck" CHECK (char_length(title) BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "commerce_quote_service_deliverable_plan" ADD CONSTRAINT "commerce_quote_service_deliverable_plan_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quote_service_deliverable_plan_sequence_uidx" ON "commerce_quote_service_deliverable_plan" USING btree ("quote_service_line_id","sequence");--> statement-breakpoint

CREATE TABLE "freight_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	CONSTRAINT "freight_deliverable_detail_summary_ck" CHECK (char_length(summary) BETWEEN 1 AND 2000)
);--> statement-breakpoint
ALTER TABLE "freight_deliverable_detail" ADD CONSTRAINT "freight_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Every immutable engagement snapshot rejects table-wide deletion as well as row mutation.
CREATE TRIGGER freight_engagement_detail_no_truncate
BEFORE TRUNCATE ON "freight_engagement_detail"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER customs_brokerage_engagement_detail_no_truncate
BEFORE TRUNCATE ON "customs_brokerage_engagement_detail"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER insurance_engagement_detail_no_truncate
BEFORE TRUNCATE ON "insurance_engagement_detail"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER inspection_engagement_detail_no_truncate
BEFORE TRUNCATE ON "inspection_engagement_detail"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER testing_certification_engagement_detail_no_truncate
BEFORE TRUNCATE ON "testing_certification_engagement_detail"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER marketing_engagement_detail_no_truncate
BEFORE TRUNCATE ON "marketing_engagement_detail"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER warehouse_engagement_detail_no_truncate
BEFORE TRUNCATE ON "warehouse_engagement_detail"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER foreign_exchange_engagement_detail_no_truncate
BEFORE TRUNCATE ON "foreign_exchange_engagement_detail"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

-- Temporarily permit this migration's deterministic correction of immutable snapshots.
ALTER TABLE "freight_engagement_detail" DISABLE TRIGGER "freight_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "customs_brokerage_engagement_detail" DISABLE TRIGGER "customs_brokerage_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "insurance_engagement_detail" DISABLE TRIGGER "insurance_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "inspection_engagement_detail" DISABLE TRIGGER "inspection_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "testing_certification_engagement_detail" DISABLE TRIGGER "testing_certification_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "marketing_engagement_detail" DISABLE TRIGGER "marketing_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "warehouse_engagement_detail" DISABLE TRIGGER "warehouse_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "foreign_exchange_engagement_detail" DISABLE TRIGGER "foreign_exchange_engagement_detail_append_only";--> statement-breakpoint

-- Resolve one accepted-revision quote line per engagement only when existing source identity
-- and stable sibling-order evidence do not disagree. Conflicts and ties remain unresolved.
CREATE TEMP TABLE "_store_phase_6_resolved_quote_service_line" ON COMMIT DROP AS
WITH eligible_engagements AS (
  SELECT engagement.id AS engagement_id,
         order_service_line.id AS order_service_line_id,
         order_service_line.provider_kind,
         order_service_line.sibling_order,
         order_service_line.source_quote_service_line_id,
         commerce_order.accepted_quote_revision_id
    FROM commerce_service_engagement AS engagement
    INNER JOIN commerce_order_service_line AS order_service_line
      ON order_service_line.id = engagement.order_service_line_id
     AND order_service_line.order_id = engagement.order_id
     AND order_service_line.provider_kind = engagement.provider_kind
    INNER JOIN commerce_order
      ON commerce_order.id = engagement.order_id
     AND commerce_order.source = 'accepted_quote'
),
candidate_quote_service_lines AS (
  SELECT eligible.engagement_id,
         eligible.order_service_line_id,
         accepted_quote_service_line.id AS quote_service_line_id
    FROM eligible_engagements AS eligible
    INNER JOIN commerce_quote_service_line AS accepted_quote_service_line
      ON accepted_quote_service_line.revision_id = eligible.accepted_quote_revision_id
     AND accepted_quote_service_line.provider_kind = eligible.provider_kind
   WHERE accepted_quote_service_line.sibling_order = eligible.sibling_order
      OR accepted_quote_service_line.id = eligible.source_quote_service_line_id
)
SELECT candidate.engagement_id,
       candidate.order_service_line_id,
       min(candidate.quote_service_line_id) AS quote_service_line_id
  FROM candidate_quote_service_lines AS candidate
 GROUP BY candidate.engagement_id, candidate.order_service_line_id
HAVING count(DISTINCT candidate.quote_service_line_id) = 1;--> statement-breakpoint

-- The order service line is authoritative. Unresolved or ambiguous legacy lines are null.
UPDATE commerce_order_service_line AS order_service_line
   SET source_quote_service_line_id = resolved.quote_service_line_id
  FROM commerce_service_engagement AS engagement
  INNER JOIN commerce_order
    ON commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote'
  LEFT JOIN "_store_phase_6_resolved_quote_service_line" AS resolved
    ON resolved.engagement_id = engagement.id
 WHERE order_service_line.id = engagement.order_service_line_id
   AND order_service_line.order_id = engagement.order_id
   AND order_service_line.source_quote_service_line_id IS DISTINCT FROM
       resolved.quote_service_line_id;--> statement-breakpoint

-- Rebuild accepted-quote snapshots from the now-authoritative source identity.
DELETE FROM freight_engagement_detail AS detail
 USING commerce_service_engagement AS engagement, commerce_order
 WHERE detail.engagement_id = engagement.id
   AND commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint
DELETE FROM customs_brokerage_engagement_detail AS detail
 USING commerce_service_engagement AS engagement, commerce_order
 WHERE detail.engagement_id = engagement.id
   AND commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint
DELETE FROM insurance_engagement_detail AS detail
 USING commerce_service_engagement AS engagement, commerce_order
 WHERE detail.engagement_id = engagement.id
   AND commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint
DELETE FROM inspection_engagement_detail AS detail
 USING commerce_service_engagement AS engagement, commerce_order
 WHERE detail.engagement_id = engagement.id
   AND commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint
DELETE FROM testing_certification_engagement_detail AS detail
 USING commerce_service_engagement AS engagement, commerce_order
 WHERE detail.engagement_id = engagement.id
   AND commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint
DELETE FROM marketing_engagement_detail AS detail
 USING commerce_service_engagement AS engagement, commerce_order
 WHERE detail.engagement_id = engagement.id
   AND commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint
DELETE FROM warehouse_engagement_detail AS detail
 USING commerce_service_engagement AS engagement, commerce_order
 WHERE detail.engagement_id = engagement.id
   AND commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint
DELETE FROM foreign_exchange_engagement_detail AS detail
 USING commerce_service_engagement AS engagement, commerce_order
 WHERE detail.engagement_id = engagement.id
   AND commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint

INSERT INTO freight_engagement_detail (
  engagement_id, source_quote_service_line_id, transport_modes,
  origin_country_code, destination_country_code, estimated_transit_days
)
SELECT engagement.id, resolved.quote_service_line_id, quote_detail.transport_modes,
       quote_detail.origin_country_code, quote_detail.destination_country_code,
       quote_detail.estimated_transit_days
  FROM "_store_phase_6_resolved_quote_service_line" AS resolved
  INNER JOIN commerce_service_engagement AS engagement
    ON engagement.id = resolved.engagement_id
   AND engagement.provider_kind IN ('freight_forwarder', 'logistics_operator')
  INNER JOIN freight_quote_service_detail AS quote_detail
    ON quote_detail.quote_service_line_id = resolved.quote_service_line_id;--> statement-breakpoint
INSERT INTO customs_brokerage_engagement_detail (
  engagement_id, source_quote_service_line_id, jurisdictions, filing_summary
)
SELECT engagement.id, resolved.quote_service_line_id, quote_detail.jurisdictions,
       quote_detail.filing_summary
  FROM "_store_phase_6_resolved_quote_service_line" AS resolved
  INNER JOIN commerce_service_engagement AS engagement
    ON engagement.id = resolved.engagement_id
   AND engagement.provider_kind = 'customs_broker'
  INNER JOIN customs_brokerage_quote_service_detail AS quote_detail
    ON quote_detail.quote_service_line_id = resolved.quote_service_line_id;--> statement-breakpoint
INSERT INTO insurance_engagement_detail (
  engagement_id, source_quote_service_line_id, coverage_classes,
  coverage_limit_minor_units, currency
)
SELECT engagement.id, resolved.quote_service_line_id, quote_detail.coverage_classes,
       quote_detail.coverage_limit_in_cents::text,
       CASE
         WHEN quote_detail.coverage_limit_in_cents IS NULL THEN NULL
         ELSE quote_detail.currency
       END
  FROM "_store_phase_6_resolved_quote_service_line" AS resolved
  INNER JOIN commerce_service_engagement AS engagement
    ON engagement.id = resolved.engagement_id
   AND engagement.provider_kind = 'insurance_provider'
  INNER JOIN insurance_quote_service_detail AS quote_detail
    ON quote_detail.quote_service_line_id = resolved.quote_service_line_id;--> statement-breakpoint
INSERT INTO inspection_engagement_detail (
  engagement_id, source_quote_service_line_id, included_stages
)
SELECT engagement.id, resolved.quote_service_line_id, quote_detail.included_stages
  FROM "_store_phase_6_resolved_quote_service_line" AS resolved
  INNER JOIN commerce_service_engagement AS engagement
    ON engagement.id = resolved.engagement_id
   AND engagement.provider_kind = 'inspection_agency'
  INNER JOIN inspection_quote_service_detail AS quote_detail
    ON quote_detail.quote_service_line_id = resolved.quote_service_line_id;--> statement-breakpoint
INSERT INTO testing_certification_engagement_detail (
  engagement_id, source_quote_service_line_id, standards, laboratory_location
)
SELECT engagement.id, resolved.quote_service_line_id, quote_detail.standards,
       quote_detail.laboratory_location
  FROM "_store_phase_6_resolved_quote_service_line" AS resolved
  INNER JOIN commerce_service_engagement AS engagement
    ON engagement.id = resolved.engagement_id
   AND engagement.provider_kind = 'testing_certification_lab'
  INNER JOIN testing_certification_quote_service_detail AS quote_detail
    ON quote_detail.quote_service_line_id = resolved.quote_service_line_id;--> statement-breakpoint
INSERT INTO marketing_engagement_detail (
  engagement_id, source_quote_service_line_id, channels, deliverables_summary
)
SELECT engagement.id, resolved.quote_service_line_id, quote_detail.channels,
       quote_detail.deliverables_summary
  FROM "_store_phase_6_resolved_quote_service_line" AS resolved
  INNER JOIN commerce_service_engagement AS engagement
    ON engagement.id = resolved.engagement_id
   AND engagement.provider_kind = 'marketing_agency'
  INNER JOIN marketing_quote_service_detail AS quote_detail
    ON quote_detail.quote_service_line_id = resolved.quote_service_line_id;--> statement-breakpoint
INSERT INTO warehouse_engagement_detail (
  engagement_id, source_quote_service_line_id, storage_types,
  capacity_units, temperature_controlled
)
SELECT engagement.id, resolved.quote_service_line_id, quote_detail.storage_types,
       quote_detail.capacity_units, quote_detail.temperature_controlled
  FROM "_store_phase_6_resolved_quote_service_line" AS resolved
  INNER JOIN commerce_service_engagement AS engagement
    ON engagement.id = resolved.engagement_id
   AND engagement.provider_kind = 'warehouse_provider'
  INNER JOIN warehouse_quote_service_detail AS quote_detail
    ON quote_detail.quote_service_line_id = resolved.quote_service_line_id;--> statement-breakpoint
INSERT INTO foreign_exchange_engagement_detail (
  engagement_id, source_quote_service_line_id, currency_pair,
  rate_fixed_point_units, rate_scale, settlement_rail,
  notional_amount_minor_units, notional_currency
)
SELECT engagement.id, resolved.quote_service_line_id, quote_detail.currency_pair,
       quote_detail.rate_fixed_point::text, quote_detail.rate_scale,
       quote_detail.settlement_rail, quote_detail.notional_amount_in_cents::text,
       CASE
         WHEN quote_detail.notional_amount_in_cents IS NULL THEN NULL
         ELSE quote_detail.notional_currency
       END
  FROM "_store_phase_6_resolved_quote_service_line" AS resolved
  INNER JOIN commerce_service_engagement AS engagement
    ON engagement.id = resolved.engagement_id
   AND engagement.provider_kind = 'foreign_exchange_facilitator'
  INNER JOIN foreign_exchange_quote_service_detail AS quote_detail
    ON quote_detail.quote_service_line_id = resolved.quote_service_line_id;--> statement-breakpoint

-- Only deterministically linked engagements with one kind-matched snapshot are ready.
UPDATE commerce_service_engagement AS engagement
   SET execution_contract_state = CASE
         WHEN EXISTS (
           SELECT 1
             FROM "_store_phase_6_resolved_quote_service_line" AS resolved
            WHERE resolved.engagement_id = engagement.id
         )
          AND (
            (
              engagement.provider_kind IN ('freight_forwarder', 'logistics_operator')
              AND EXISTS (
                SELECT 1 FROM freight_engagement_detail AS detail
                 WHERE detail.engagement_id = engagement.id
              )
            )
            OR (
              engagement.provider_kind = 'customs_broker'
              AND EXISTS (
                SELECT 1 FROM customs_brokerage_engagement_detail AS detail
                 WHERE detail.engagement_id = engagement.id
              )
            )
            OR (
              engagement.provider_kind = 'insurance_provider'
              AND EXISTS (
                SELECT 1 FROM insurance_engagement_detail AS detail
                 WHERE detail.engagement_id = engagement.id
              )
            )
            OR (
              engagement.provider_kind = 'inspection_agency'
              AND EXISTS (
                SELECT 1 FROM inspection_engagement_detail AS detail
                 WHERE detail.engagement_id = engagement.id
              )
            )
            OR (
              engagement.provider_kind = 'testing_certification_lab'
              AND EXISTS (
                SELECT 1 FROM testing_certification_engagement_detail AS detail
                 WHERE detail.engagement_id = engagement.id
              )
            )
            OR (
              engagement.provider_kind = 'marketing_agency'
              AND EXISTS (
                SELECT 1 FROM marketing_engagement_detail AS detail
                 WHERE detail.engagement_id = engagement.id
              )
            )
            OR (
              engagement.provider_kind = 'warehouse_provider'
              AND EXISTS (
                SELECT 1 FROM warehouse_engagement_detail AS detail
                 WHERE detail.engagement_id = engagement.id
              )
            )
            OR (
              engagement.provider_kind = 'foreign_exchange_facilitator'
              AND EXISTS (
                SELECT 1 FROM foreign_exchange_engagement_detail AS detail
                 WHERE detail.engagement_id = engagement.id
              )
            )
          )
         THEN 'ready'::commerce_execution_contract_state
         ELSE 'legacy_missing_snapshot'::commerce_execution_contract_state
       END
  FROM commerce_order
 WHERE commerce_order.id = engagement.order_id
   AND commerce_order.source = 'accepted_quote';--> statement-breakpoint

-- A legacy marker and an execution snapshot are mutually exclusive.
DELETE FROM freight_engagement_detail AS detail
 USING commerce_service_engagement AS engagement
 WHERE detail.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'legacy_missing_snapshot';--> statement-breakpoint
DELETE FROM customs_brokerage_engagement_detail AS detail
 USING commerce_service_engagement AS engagement
 WHERE detail.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'legacy_missing_snapshot';--> statement-breakpoint
DELETE FROM insurance_engagement_detail AS detail
 USING commerce_service_engagement AS engagement
 WHERE detail.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'legacy_missing_snapshot';--> statement-breakpoint
DELETE FROM inspection_engagement_detail AS detail
 USING commerce_service_engagement AS engagement
 WHERE detail.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'legacy_missing_snapshot';--> statement-breakpoint
DELETE FROM testing_certification_engagement_detail AS detail
 USING commerce_service_engagement AS engagement
 WHERE detail.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'legacy_missing_snapshot';--> statement-breakpoint
DELETE FROM marketing_engagement_detail AS detail
 USING commerce_service_engagement AS engagement
 WHERE detail.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'legacy_missing_snapshot';--> statement-breakpoint
DELETE FROM warehouse_engagement_detail AS detail
 USING commerce_service_engagement AS engagement
 WHERE detail.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'legacy_missing_snapshot';--> statement-breakpoint
DELETE FROM foreign_exchange_engagement_detail AS detail
 USING commerce_service_engagement AS engagement
 WHERE detail.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'legacy_missing_snapshot';--> statement-breakpoint

-- Remove misleading default currencies and enforce amount/currency pairing.
UPDATE insurance_quote_service_detail
   SET currency = NULL
 WHERE coverage_limit_in_cents IS NULL;--> statement-breakpoint
UPDATE foreign_exchange_quote_service_detail
   SET notional_currency = NULL
 WHERE notional_amount_in_cents IS NULL;--> statement-breakpoint
UPDATE insurance_engagement_detail
   SET currency = NULL
 WHERE coverage_limit_minor_units IS NULL;--> statement-breakpoint
UPDATE foreign_exchange_engagement_detail
   SET notional_currency = NULL
 WHERE notional_amount_minor_units IS NULL;--> statement-breakpoint
UPDATE insurance_deliverable_detail
   SET currency = NULL
 WHERE insured_value_minor_units IS NULL
   AND coverage_limit_minor_units IS NULL;--> statement-breakpoint

ALTER TABLE "insurance_quote_service_detail" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "insurance_quote_service_detail" ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "insurance_quote_service_detail" ADD CONSTRAINT "insurance_quote_service_detail_amount_currency_pair_ck" CHECK ((coverage_limit_in_cents IS NULL) = (currency IS NULL));--> statement-breakpoint
ALTER TABLE "insurance_quote_service_detail" ADD CONSTRAINT "insurance_quote_service_detail_currency_ck" CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "foreign_exchange_quote_service_detail" ALTER COLUMN "notional_currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "foreign_exchange_quote_service_detail" ALTER COLUMN "notional_currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "foreign_exchange_quote_service_detail" ADD CONSTRAINT "foreign_exchange_quote_service_detail_notional_currency_pair_ck" CHECK ((notional_amount_in_cents IS NULL) = (notional_currency IS NULL));--> statement-breakpoint
ALTER TABLE "insurance_engagement_detail" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "insurance_engagement_detail" ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "insurance_engagement_detail" ADD CONSTRAINT "insurance_engagement_detail_amount_currency_pair_ck" CHECK ((coverage_limit_minor_units IS NULL) = (currency IS NULL));--> statement-breakpoint
ALTER TABLE "foreign_exchange_engagement_detail" ALTER COLUMN "notional_currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "foreign_exchange_engagement_detail" ALTER COLUMN "notional_currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "foreign_exchange_engagement_detail" ADD CONSTRAINT "foreign_exchange_engagement_detail_notional_currency_pair_ck" CHECK ((notional_amount_minor_units IS NULL) = (notional_currency IS NULL));--> statement-breakpoint
ALTER TABLE "insurance_deliverable_detail" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "insurance_deliverable_detail" ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "insurance_deliverable_detail" ADD CONSTRAINT "insurance_deliverable_detail_amount_currency_pair_ck" CHECK (((insured_value_minor_units IS NOT NULL OR coverage_limit_minor_units IS NOT NULL) = (currency IS NOT NULL)));--> statement-breakpoint

ALTER TABLE "freight_engagement_detail" ENABLE TRIGGER "freight_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "customs_brokerage_engagement_detail" ENABLE TRIGGER "customs_brokerage_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "insurance_engagement_detail" ENABLE TRIGGER "insurance_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "inspection_engagement_detail" ENABLE TRIGGER "inspection_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "testing_certification_engagement_detail" ENABLE TRIGGER "testing_certification_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "marketing_engagement_detail" ENABLE TRIGGER "marketing_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "warehouse_engagement_detail" ENABLE TRIGGER "warehouse_engagement_detail_append_only";--> statement-breakpoint
ALTER TABLE "foreign_exchange_engagement_detail" ENABLE TRIGGER "foreign_exchange_engagement_detail_append_only";
