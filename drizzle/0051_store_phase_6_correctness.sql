-- Store Phase 6 correctness — payment-gated fulfillment, execution-contract
-- provenance, and fail-closed historical deliverable normalization.
-- Additive follow-up to published migrations 0048–0050.

CREATE TYPE "public"."commerce_execution_contract_provenance" AS ENUM(
  'accepted_quote',
  'operator_initialized'
);--> statement-breakpoint

ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'engagement_deliverables_normalized';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'completion_issued';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'review_created';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'dispute_opened';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'dispute_decided';--> statement-breakpoint

ALTER TABLE "commerce_service_engagement"
  ADD COLUMN "execution_contract_provenance" "commerce_execution_contract_provenance";--> statement-breakpoint
ALTER TABLE "commerce_service_engagement"
  ADD COLUMN "requires_deliverable_normalization" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Ready engagements with a quote source are accepted-quote provenance.
WITH typed_snapshots AS (
  SELECT engagement_id, source_quote_service_line_id
    FROM freight_engagement_detail
  UNION ALL
  SELECT engagement_id, source_quote_service_line_id
    FROM customs_brokerage_engagement_detail
  UNION ALL
  SELECT engagement_id, source_quote_service_line_id
    FROM insurance_engagement_detail
  UNION ALL
  SELECT engagement_id, source_quote_service_line_id
    FROM inspection_engagement_detail
  UNION ALL
  SELECT engagement_id, source_quote_service_line_id
    FROM testing_certification_engagement_detail
  UNION ALL
  SELECT engagement_id, source_quote_service_line_id
    FROM marketing_engagement_detail
  UNION ALL
  SELECT engagement_id, source_quote_service_line_id
    FROM warehouse_engagement_detail
  UNION ALL
  SELECT engagement_id, source_quote_service_line_id
    FROM foreign_exchange_engagement_detail
)
UPDATE commerce_service_engagement AS engagement
   SET execution_contract_provenance = CASE
         WHEN snapshot.source_quote_service_line_id IS NOT NULL
           THEN 'accepted_quote'::commerce_execution_contract_provenance
         ELSE 'operator_initialized'::commerce_execution_contract_provenance
       END
  FROM typed_snapshots AS snapshot
 WHERE snapshot.engagement_id = engagement.id
   AND engagement.execution_contract_state = 'ready';--> statement-breakpoint

-- Historical free-text deliverable obligations without structured plans fail closed.
UPDATE commerce_service_engagement AS engagement
   SET requires_deliverable_normalization = true
  FROM commerce_order_service_line AS order_service_line
  INNER JOIN commerce_quote_service_line AS quote_service_line
    ON quote_service_line.id = order_service_line.source_quote_service_line_id
 WHERE order_service_line.id = engagement.order_service_line_id
   AND quote_service_line.deliverable_snapshot IS NOT NULL
   AND char_length(btrim(quote_service_line.deliverable_snapshot)) > 0
   AND NOT EXISTS (
     SELECT 1
       FROM commerce_engagement_deliverable AS deliverable
      WHERE deliverable.engagement_id = engagement.id
   )
   AND NOT EXISTS (
     SELECT 1
       FROM commerce_quote_service_deliverable_plan AS deliverable_plan
      WHERE deliverable_plan.quote_service_line_id = quote_service_line.id
   );--> statement-breakpoint

ALTER TABLE "commerce_service_engagement"
  ADD CONSTRAINT "commerce_service_engagement_provenance_ck"
  CHECK (
    (execution_contract_state = 'legacy_missing_snapshot' AND execution_contract_provenance IS NULL)
    OR (execution_contract_state = 'ready' AND execution_contract_provenance IS NOT NULL)
  );
