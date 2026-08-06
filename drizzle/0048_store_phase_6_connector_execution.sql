-- Store Phase 6 — shipment legs, typed connector execution, deliverables.
-- Additive; safe to roll application back while leaving tables in place.

CREATE TYPE "public"."commerce_shipment_leg_mode" AS ENUM('air', 'sea', 'land', 'rail');--> statement-breakpoint
CREATE TYPE "public"."commerce_shipment_leg_state" AS ENUM('planned', 'booked', 'in_transit', 'arrived', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."commerce_shipment_leg_event_kind" AS ENUM('created', 'booked', 'departed', 'arrived', 'completed', 'exception', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."commerce_execution_contract_state" AS ENUM('ready', 'legacy_missing_snapshot');--> statement-breakpoint
CREATE TYPE "public"."commerce_engagement_deliverable_state" AS ENUM('planned', 'submitted', 'accepted', 'waived', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."commerce_fulfillment_command_target_kind" AS ENUM('shipment', 'shipment_leg', 'service_engagement', 'engagement_deliverable');--> statement-breakpoint

ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'shipment_leg_created';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'shipment_leg_command_executed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'service_engagement_command_executed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'engagement_deliverable_submitted';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'engagement_deliverable_reviewed';--> statement-breakpoint

ALTER TABLE "commerce_order_service_line" ADD COLUMN "source_quote_service_line_id" text;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement" ADD COLUMN "execution_contract_state" "commerce_execution_contract_state" DEFAULT 'legacy_missing_snapshot' NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_shipment" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "commerce_order_service_line" ADD CONSTRAINT "commerce_order_service_line_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement" ADD CONSTRAINT "commerce_service_engagement_version_ck" CHECK (version >= 0);--> statement-breakpoint
ALTER TABLE "commerce_shipment" ADD CONSTRAINT "commerce_shipment_version_ck" CHECK (version >= 0);--> statement-breakpoint

CREATE TABLE "commerce_shipment_leg" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"mode" "commerce_shipment_leg_mode" NOT NULL,
	"state" "commerce_shipment_leg_state" DEFAULT 'planned' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"origin_country_code" text NOT NULL,
	"origin_locality" text,
	"origin_location_identifier" text,
	"destination_country_code" text NOT NULL,
	"destination_locality" text,
	"destination_location_identifier" text,
	"logistics_engagement_id" text,
	"carrier_reference" text,
	"tracking_reference" text,
	"estimated_departure_at" timestamp,
	"estimated_arrival_at" timestamp,
	"actual_departure_at" timestamp,
	"actual_arrival_at" timestamp,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_shipment_leg_sequence_ck" CHECK (sequence >= 0),
	CONSTRAINT "commerce_shipment_leg_version_ck" CHECK (version >= 0),
	CONSTRAINT "commerce_shipment_leg_country_ck" CHECK (origin_country_code ~ '^[A-Z]{2}$' AND destination_country_code ~ '^[A-Z]{2}$'),
	CONSTRAINT "commerce_shipment_leg_location_ck" CHECK ((origin_location_identifier IS NULL OR char_length(origin_location_identifier) BETWEEN 1 AND 80)
          AND (destination_location_identifier IS NULL OR char_length(destination_location_identifier) BETWEEN 1 AND 80)
          AND (origin_locality IS NULL OR char_length(origin_locality) BETWEEN 1 AND 150)
          AND (destination_locality IS NULL OR char_length(destination_locality) BETWEEN 1 AND 150)
          AND (carrier_reference IS NULL OR char_length(carrier_reference) BETWEEN 1 AND 200)
          AND (tracking_reference IS NULL OR char_length(tracking_reference) BETWEEN 1 AND 200))
);
--> statement-breakpoint
CREATE TABLE "commerce_shipment_leg_event" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_leg_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_kind" "commerce_shipment_leg_event_kind" NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"description" text,
	"carrier_reference" text,
	"tracking_reference" text,
	"location_identifier" text,
	"evidence_document_id" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_shipment_leg_event_sequence_ck" CHECK (sequence >= 0),
	CONSTRAINT "commerce_shipment_leg_event_text_ck" CHECK ((description IS NULL OR char_length(description) BETWEEN 1 AND 2000)
          AND (carrier_reference IS NULL OR char_length(carrier_reference) BETWEEN 1 AND 200)
          AND (tracking_reference IS NULL OR char_length(tracking_reference) BETWEEN 1 AND 200)
          AND (location_identifier IS NULL OR char_length(location_identifier) BETWEEN 1 AND 80))
);
--> statement-breakpoint
CREATE TABLE "commerce_service_engagement_event" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"previous_state" "commerce_service_engagement_state",
	"next_state" "commerce_service_engagement_state" NOT NULL,
	"command_kind" text NOT NULL,
	"note" text,
	"occurred_at" timestamp NOT NULL,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_service_engagement_event_sequence_ck" CHECK (sequence >= 0),
	CONSTRAINT "commerce_service_engagement_event_text_ck" CHECK (char_length(command_kind) BETWEEN 1 AND 80
          AND (note IS NULL OR char_length(note) BETWEEN 1 AND 2000))
);
--> statement-breakpoint
CREATE TABLE "commerce_fulfillment_command" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_member_id" text NOT NULL,
	"target_kind" "commerce_fulfillment_command_target_kind" NOT NULL,
	"target_id" text NOT NULL,
	"command_kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"resulting_version" integer,
	"response_status" integer NOT NULL,
	"response_body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_fulfillment_command_text_ck" CHECK (char_length(command_kind) BETWEEN 1 AND 80
          AND char_length(idempotency_key) BETWEEN 8 AND 200
          AND char_length(request_fingerprint) = 64
          AND response_status BETWEEN 200 AND 299)
);
--> statement-breakpoint
CREATE TABLE "freight_engagement_detail" (
	"engagement_id" text PRIMARY KEY NOT NULL,
	"source_quote_service_line_id" text,
	"transport_modes" "freight_transport_mode"[] DEFAULT '{}' NOT NULL,
	"origin_country_code" text,
	"destination_country_code" text,
	"estimated_transit_days" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "freight_engagement_detail_country_ck" CHECK ((origin_country_code IS NULL OR origin_country_code ~ '^[A-Z]{2}$')
          AND (destination_country_code IS NULL OR destination_country_code ~ '^[A-Z]{2}$')),
	CONSTRAINT "freight_engagement_detail_transit_ck" CHECK (estimated_transit_days IS NULL OR estimated_transit_days >= 0)
);
--> statement-breakpoint
CREATE TABLE "customs_brokerage_engagement_detail" (
	"engagement_id" text PRIMARY KEY NOT NULL,
	"source_quote_service_line_id" text,
	"jurisdictions" text[] DEFAULT '{}' NOT NULL,
	"filing_summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customs_brokerage_engagement_detail_summary_ck" CHECK (filing_summary IS NULL OR char_length(filing_summary) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "insurance_engagement_detail" (
	"engagement_id" text PRIMARY KEY NOT NULL,
	"source_quote_service_line_id" text,
	"coverage_classes" text[] DEFAULT '{}' NOT NULL,
	"coverage_limit_minor_units" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "insurance_engagement_detail_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "insurance_engagement_detail_limit_ck" CHECK (coverage_limit_minor_units IS NULL
          OR coverage_limit_minor_units ~ '^(0|[1-9][0-9]{0,37})$')
);
--> statement-breakpoint
CREATE TABLE "inspection_engagement_detail" (
	"engagement_id" text PRIMARY KEY NOT NULL,
	"source_quote_service_line_id" text,
	"included_stages" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testing_certification_engagement_detail" (
	"engagement_id" text PRIMARY KEY NOT NULL,
	"source_quote_service_line_id" text,
	"standards" text[] DEFAULT '{}' NOT NULL,
	"laboratory_location" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_engagement_detail" (
	"engagement_id" text PRIMARY KEY NOT NULL,
	"source_quote_service_line_id" text,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"deliverables_summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_engagement_detail_summary_ck" CHECK (deliverables_summary IS NULL OR char_length(deliverables_summary) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "warehouse_engagement_detail" (
	"engagement_id" text PRIMARY KEY NOT NULL,
	"source_quote_service_line_id" text,
	"storage_types" text[] DEFAULT '{}' NOT NULL,
	"capacity_units" text,
	"temperature_controlled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foreign_exchange_engagement_detail" (
	"engagement_id" text PRIMARY KEY NOT NULL,
	"source_quote_service_line_id" text,
	"currency_pair" text NOT NULL,
	"rate_fixed_point_units" text NOT NULL,
	"rate_scale" integer NOT NULL,
	"settlement_rail" text,
	"notional_amount_minor_units" text,
	"notional_currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "foreign_exchange_engagement_detail_rate_ck" CHECK (rate_fixed_point_units ~ '^[1-9][0-9]{0,37}$' AND rate_scale BETWEEN 0 AND 12),
	CONSTRAINT "foreign_exchange_engagement_detail_pair_ck" CHECK (char_length(currency_pair) = 7 AND currency_pair ~ '^[A-Z]{3}/[A-Z]{3}$'),
	CONSTRAINT "foreign_exchange_engagement_detail_currency_ck" CHECK (notional_currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "foreign_exchange_engagement_detail_notional_ck" CHECK (notional_amount_minor_units IS NULL
          OR notional_amount_minor_units ~ '^(0|[1-9][0-9]{0,37})$')
);
--> statement-breakpoint
CREATE TABLE "commerce_engagement_deliverable" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"title" text NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"state" "commerce_engagement_deliverable_state" DEFAULT 'planned' NOT NULL,
	"due_at" timestamp,
	"submitted_at" timestamp,
	"reviewed_at" timestamp,
	"evidence_document_id" text,
	"review_note" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_engagement_deliverable_sequence_ck" CHECK (sequence >= 0),
	CONSTRAINT "commerce_engagement_deliverable_text_ck" CHECK (char_length(title) BETWEEN 1 AND 200
          AND (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 2000))
);
--> statement-breakpoint
CREATE TABLE "commerce_engagement_deliverable_event" (
	"id" text PRIMARY KEY NOT NULL,
	"deliverable_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"previous_state" "commerce_engagement_deliverable_state",
	"next_state" "commerce_engagement_deliverable_state" NOT NULL,
	"command_kind" text NOT NULL,
	"note" text,
	"occurred_at" timestamp NOT NULL,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_engagement_deliverable_event_sequence_ck" CHECK (sequence >= 0),
	CONSTRAINT "commerce_engagement_deliverable_event_text_ck" CHECK (char_length(command_kind) BETWEEN 1 AND 80
          AND (note IS NULL OR char_length(note) BETWEEN 1 AND 2000))
);
--> statement-breakpoint
CREATE TABLE "customs_brokerage_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"filing_kind" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"provider_filing_reference" text,
	"declaration_reference" text,
	"decision" text,
	CONSTRAINT "customs_brokerage_deliverable_detail_text_ck" CHECK (char_length(filing_kind) BETWEEN 1 AND 80
          AND char_length(jurisdiction) BETWEEN 1 AND 80
          AND (provider_filing_reference IS NULL OR char_length(provider_filing_reference) BETWEEN 1 AND 200)
          AND (declaration_reference IS NULL OR char_length(declaration_reference) BETWEEN 1 AND 200)
          AND (decision IS NULL OR decision IN ('cleared', 'rejected', 'pending')))
);
--> statement-breakpoint
CREATE TABLE "insurance_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"policy_reference" text NOT NULL,
	"coverage_class" text NOT NULL,
	"insured_value_minor_units" text,
	"coverage_limit_minor_units" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp,
	"effective_to" timestamp,
	CONSTRAINT "insurance_deliverable_detail_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "insurance_deliverable_detail_text_ck" CHECK (char_length(policy_reference) BETWEEN 1 AND 200
          AND char_length(coverage_class) BETWEEN 1 AND 80
          AND (insured_value_minor_units IS NULL OR insured_value_minor_units ~ '^(0|[1-9][0-9]{0,37})$')
          AND (coverage_limit_minor_units IS NULL OR coverage_limit_minor_units ~ '^(0|[1-9][0-9]{0,37})$'))
);
--> statement-breakpoint
CREATE TABLE "inspection_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"result" text NOT NULL,
	"findings_summary" text,
	"inspected_quantity" integer,
	"inspected_at" timestamp,
	CONSTRAINT "inspection_deliverable_detail_result_ck" CHECK (result IN ('passed', 'conditional', 'failed')
          AND char_length(stage) BETWEEN 1 AND 80
          AND (findings_summary IS NULL OR char_length(findings_summary) BETWEEN 1 AND 4000)
          AND (inspected_quantity IS NULL OR inspected_quantity > 0))
);
--> statement-breakpoint
CREATE TABLE "testing_certification_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"standard" text NOT NULL,
	"specimen_reference" text,
	"result" text NOT NULL,
	"laboratory_location" text,
	"reported_at" timestamp,
	CONSTRAINT "testing_certification_deliverable_detail_result_ck" CHECK (result IN ('passed', 'failed', 'inconclusive')
          AND char_length(standard) BETWEEN 1 AND 120
          AND (specimen_reference IS NULL OR char_length(specimen_reference) BETWEEN 1 AND 200)
          AND (laboratory_location IS NULL OR char_length(laboratory_location) BETWEEN 1 AND 200))
);
--> statement-breakpoint
CREATE TABLE "warehouse_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"movement_kind" text NOT NULL,
	"quantity_units" text NOT NULL,
	"quantity_scale" integer NOT NULL,
	"unit_label" text NOT NULL,
	"facility_identifier" text,
	"occurred_at" timestamp,
	CONSTRAINT "warehouse_deliverable_detail_movement_ck" CHECK (movement_kind IN ('receipt', 'putaway', 'pick', 'release', 'adjustment')
          AND quantity_units ~ '^(0|[1-9][0-9]{0,37})$'
          AND quantity_scale BETWEEN 0 AND 12
          AND char_length(unit_label) BETWEEN 1 AND 40
          AND (facility_identifier IS NULL OR char_length(facility_identifier) BETWEEN 1 AND 120))
);
--> statement-breakpoint
CREATE TABLE "marketing_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"deliverable_kind" text NOT NULL,
	"channel" text NOT NULL,
	"artifact_url" text,
	"metrics_summary" text,
	"published_at" timestamp,
	CONSTRAINT "marketing_deliverable_detail_text_ck" CHECK (char_length(deliverable_kind) BETWEEN 1 AND 80
          AND char_length(channel) BETWEEN 1 AND 80
          AND (artifact_url IS NULL OR char_length(artifact_url) BETWEEN 1 AND 2000)
          AND (metrics_summary IS NULL OR char_length(metrics_summary) BETWEEN 1 AND 4000))
);
--> statement-breakpoint
CREATE TABLE "foreign_exchange_deliverable_detail" (
	"deliverable_id" text PRIMARY KEY NOT NULL,
	"currency_pair" text NOT NULL,
	"rate_fixed_point_units" text NOT NULL,
	"rate_scale" integer NOT NULL,
	"sell_amount_minor_units" text NOT NULL,
	"buy_amount_minor_units" text NOT NULL,
	"sell_currency" text NOT NULL,
	"buy_currency" text NOT NULL,
	"provider_execution_reference" text,
	"confirmation_state" text DEFAULT 'provider_confirmed' NOT NULL,
	CONSTRAINT "foreign_exchange_deliverable_detail_rate_ck" CHECK (rate_fixed_point_units ~ '^[1-9][0-9]{0,37}$' AND rate_scale BETWEEN 0 AND 12),
	CONSTRAINT "foreign_exchange_deliverable_detail_pair_ck" CHECK (char_length(currency_pair) = 7 AND currency_pair ~ '^[A-Z]{3}/[A-Z]{3}$'
          AND sell_currency ~ '^[A-Z]{3}$' AND buy_currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "foreign_exchange_deliverable_detail_amounts_ck" CHECK (sell_amount_minor_units ~ '^(0|[1-9][0-9]{0,37})$'
          AND buy_amount_minor_units ~ '^(0|[1-9][0-9]{0,37})$'
          AND confirmation_state IN ('provider_confirmed')
          AND (provider_execution_reference IS NULL OR char_length(provider_execution_reference) BETWEEN 1 AND 200))
);
--> statement-breakpoint

ALTER TABLE "commerce_shipment_leg" ADD CONSTRAINT "commerce_shipment_leg_shipment_id_commerce_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."commerce_shipment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_leg" ADD CONSTRAINT "commerce_shipment_leg_logistics_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("logistics_engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_leg" ADD CONSTRAINT "commerce_shipment_leg_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_leg_event" ADD CONSTRAINT "commerce_shipment_leg_event_shipment_leg_id_commerce_shipment_leg_id_fk" FOREIGN KEY ("shipment_leg_id") REFERENCES "public"."commerce_shipment_leg"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_leg_event" ADD CONSTRAINT "commerce_shipment_leg_event_evidence_document_id_commerce_encrypted_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."commerce_encrypted_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_shipment_leg_event" ADD CONSTRAINT "commerce_shipment_leg_event_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement_event" ADD CONSTRAINT "commerce_service_engagement_event_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_service_engagement_event" ADD CONSTRAINT "commerce_service_engagement_event_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_fulfillment_command" ADD CONSTRAINT "commerce_fulfillment_command_actor_organization_id_commerce_organization_id_fk" FOREIGN KEY ("actor_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_fulfillment_command" ADD CONSTRAINT "commerce_fulfillment_command_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_fulfillment_command" ADD CONSTRAINT "commerce_fulfillment_command_actor_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "freight_engagement_detail" ADD CONSTRAINT "freight_engagement_detail_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_engagement_detail" ADD CONSTRAINT "freight_engagement_detail_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_brokerage_engagement_detail" ADD CONSTRAINT "customs_brokerage_engagement_detail_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_brokerage_engagement_detail" ADD CONSTRAINT "customs_brokerage_engagement_detail_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_engagement_detail" ADD CONSTRAINT "insurance_engagement_detail_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_engagement_detail" ADD CONSTRAINT "insurance_engagement_detail_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_engagement_detail" ADD CONSTRAINT "inspection_engagement_detail_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_engagement_detail" ADD CONSTRAINT "inspection_engagement_detail_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_certification_engagement_detail" ADD CONSTRAINT "testing_certification_engagement_detail_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_certification_engagement_detail" ADD CONSTRAINT "testing_certification_engagement_detail_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_engagement_detail" ADD CONSTRAINT "marketing_engagement_detail_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_engagement_detail" ADD CONSTRAINT "marketing_engagement_detail_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_engagement_detail" ADD CONSTRAINT "warehouse_engagement_detail_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_engagement_detail" ADD CONSTRAINT "warehouse_engagement_detail_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_exchange_engagement_detail" ADD CONSTRAINT "foreign_exchange_engagement_detail_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_exchange_engagement_detail" ADD CONSTRAINT "foreign_exchange_engagement_detail_source_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("source_quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "commerce_engagement_deliverable" ADD CONSTRAINT "commerce_engagement_deliverable_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_engagement_deliverable" ADD CONSTRAINT "commerce_engagement_deliverable_evidence_document_id_commerce_encrypted_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."commerce_encrypted_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_engagement_deliverable" ADD CONSTRAINT "commerce_engagement_deliverable_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_engagement_deliverable_event" ADD CONSTRAINT "commerce_engagement_deliverable_event_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_engagement_deliverable_event" ADD CONSTRAINT "commerce_engagement_deliverable_event_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_brokerage_deliverable_detail" ADD CONSTRAINT "customs_brokerage_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_deliverable_detail" ADD CONSTRAINT "insurance_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_deliverable_detail" ADD CONSTRAINT "inspection_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_certification_deliverable_detail" ADD CONSTRAINT "testing_certification_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_deliverable_detail" ADD CONSTRAINT "warehouse_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_deliverable_detail" ADD CONSTRAINT "marketing_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_exchange_deliverable_detail" ADD CONSTRAINT "foreign_exchange_deliverable_detail_deliverable_id_commerce_engagement_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."commerce_engagement_deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "commerce_shipment_leg_sequence_uidx" ON "commerce_shipment_leg" USING btree ("shipment_id","sequence");--> statement-breakpoint
CREATE INDEX "commerce_shipment_leg_shipment_idx" ON "commerce_shipment_leg" USING btree ("shipment_id","id");--> statement-breakpoint
CREATE INDEX "commerce_shipment_leg_engagement_idx" ON "commerce_shipment_leg" USING btree ("logistics_engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_shipment_leg_event_sequence_uidx" ON "commerce_shipment_leg_event" USING btree ("shipment_leg_id","sequence");--> statement-breakpoint
CREATE INDEX "commerce_shipment_leg_event_leg_idx" ON "commerce_shipment_leg_event" USING btree ("shipment_leg_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_service_engagement_event_sequence_uidx" ON "commerce_service_engagement_event" USING btree ("engagement_id","sequence");--> statement-breakpoint
CREATE INDEX "commerce_service_engagement_event_engagement_idx" ON "commerce_service_engagement_event" USING btree ("engagement_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_fulfillment_command_idempotency_uidx" ON "commerce_fulfillment_command" USING btree ("actor_organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "commerce_fulfillment_command_target_idx" ON "commerce_fulfillment_command" USING btree ("target_kind","target_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_engagement_deliverable_sequence_uidx" ON "commerce_engagement_deliverable" USING btree ("engagement_id","sequence");--> statement-breakpoint
CREATE INDEX "commerce_engagement_deliverable_engagement_idx" ON "commerce_engagement_deliverable" USING btree ("engagement_id","state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_engagement_deliverable_event_sequence_uidx" ON "commerce_engagement_deliverable_event" USING btree ("deliverable_id","sequence");--> statement-breakpoint

-- Append-only event / command tables.
CREATE TRIGGER commerce_shipment_leg_event_append_only
BEFORE UPDATE OR DELETE ON "commerce_shipment_leg_event"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_shipment_leg_event_no_truncate
BEFORE TRUNCATE ON "commerce_shipment_leg_event"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_service_engagement_event_append_only
BEFORE UPDATE OR DELETE ON "commerce_service_engagement_event"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_service_engagement_event_no_truncate
BEFORE TRUNCATE ON "commerce_service_engagement_event"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_fulfillment_command_append_only
BEFORE UPDATE OR DELETE ON "commerce_fulfillment_command"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_fulfillment_command_no_truncate
BEFORE TRUNCATE ON "commerce_fulfillment_command"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_engagement_deliverable_event_append_only
BEFORE UPDATE OR DELETE ON "commerce_engagement_deliverable_event"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_engagement_deliverable_event_no_truncate
BEFORE TRUNCATE ON "commerce_engagement_deliverable_event"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

-- Immutable engagement execution details (corrections require a new engagement).
CREATE TRIGGER freight_engagement_detail_append_only
BEFORE UPDATE OR DELETE ON "freight_engagement_detail"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER customs_brokerage_engagement_detail_append_only
BEFORE UPDATE OR DELETE ON "customs_brokerage_engagement_detail"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER insurance_engagement_detail_append_only
BEFORE UPDATE OR DELETE ON "insurance_engagement_detail"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER inspection_engagement_detail_append_only
BEFORE UPDATE OR DELETE ON "inspection_engagement_detail"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER testing_certification_engagement_detail_append_only
BEFORE UPDATE OR DELETE ON "testing_certification_engagement_detail"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER marketing_engagement_detail_append_only
BEFORE UPDATE OR DELETE ON "marketing_engagement_detail"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER warehouse_engagement_detail_append_only
BEFORE UPDATE OR DELETE ON "warehouse_engagement_detail"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER foreign_exchange_engagement_detail_append_only
BEFORE UPDATE OR DELETE ON "foreign_exchange_engagement_detail"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

-- Backfill: copy accepted typed quote details into engagement snapshots where possible.
-- Freight / logistics
INSERT INTO "freight_engagement_detail" (
  "engagement_id", "source_quote_service_line_id", "transport_modes",
  "origin_country_code", "destination_country_code", "estimated_transit_days"
)
SELECT se.id, qsl.id, COALESCE(fq.transport_modes, '{}'),
       fq.origin_country_code, fq.destination_country_code, fq.estimated_transit_days
  FROM commerce_service_engagement AS se
  INNER JOIN commerce_order AS o ON o.id = se.order_id
  INNER JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
  INNER JOIN commerce_quote_revision AS qr
    ON qr.quote_id = q.id AND qr.revision_number = q.accepted_revision_number
  INNER JOIN commerce_quote_service_line AS qsl
    ON qsl.revision_id = qr.id
   AND qsl.provider_kind = se.provider_kind
   AND qsl.title_snapshot = se.title_snapshot
   AND qsl.scope_snapshot = se.scope_snapshot
  INNER JOIN freight_quote_service_detail AS fq ON fq.quote_service_line_id = qsl.id
 WHERE se.provider_kind IN ('freight_forwarder', 'logistics_operator')
   AND o.source = 'accepted_quote'
ON CONFLICT ("engagement_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "customs_brokerage_engagement_detail" (
  "engagement_id", "source_quote_service_line_id", "jurisdictions", "filing_summary"
)
SELECT se.id, qsl.id, COALESCE(cq.jurisdictions, '{}'), cq.filing_summary
  FROM commerce_service_engagement AS se
  INNER JOIN commerce_order AS o ON o.id = se.order_id
  INNER JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
  INNER JOIN commerce_quote_revision AS qr
    ON qr.quote_id = q.id AND qr.revision_number = q.accepted_revision_number
  INNER JOIN commerce_quote_service_line AS qsl
    ON qsl.revision_id = qr.id
   AND qsl.provider_kind = se.provider_kind
   AND qsl.title_snapshot = se.title_snapshot
   AND qsl.scope_snapshot = se.scope_snapshot
  INNER JOIN customs_brokerage_quote_service_detail AS cq ON cq.quote_service_line_id = qsl.id
 WHERE se.provider_kind = 'customs_broker'
   AND o.source = 'accepted_quote'
ON CONFLICT ("engagement_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "insurance_engagement_detail" (
  "engagement_id", "source_quote_service_line_id", "coverage_classes",
  "coverage_limit_minor_units", "currency"
)
SELECT se.id, qsl.id, COALESCE(iq.coverage_classes, '{}'),
       CASE WHEN iq.coverage_limit_in_cents IS NULL THEN NULL ELSE iq.coverage_limit_in_cents::text END,
       iq.currency
  FROM commerce_service_engagement AS se
  INNER JOIN commerce_order AS o ON o.id = se.order_id
  INNER JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
  INNER JOIN commerce_quote_revision AS qr
    ON qr.quote_id = q.id AND qr.revision_number = q.accepted_revision_number
  INNER JOIN commerce_quote_service_line AS qsl
    ON qsl.revision_id = qr.id
   AND qsl.provider_kind = se.provider_kind
   AND qsl.title_snapshot = se.title_snapshot
   AND qsl.scope_snapshot = se.scope_snapshot
  INNER JOIN insurance_quote_service_detail AS iq ON iq.quote_service_line_id = qsl.id
 WHERE se.provider_kind = 'insurance_provider'
   AND o.source = 'accepted_quote'
ON CONFLICT ("engagement_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "inspection_engagement_detail" (
  "engagement_id", "source_quote_service_line_id", "included_stages"
)
SELECT se.id, qsl.id, COALESCE(iq.included_stages, '{}')
  FROM commerce_service_engagement AS se
  INNER JOIN commerce_order AS o ON o.id = se.order_id
  INNER JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
  INNER JOIN commerce_quote_revision AS qr
    ON qr.quote_id = q.id AND qr.revision_number = q.accepted_revision_number
  INNER JOIN commerce_quote_service_line AS qsl
    ON qsl.revision_id = qr.id
   AND qsl.provider_kind = se.provider_kind
   AND qsl.title_snapshot = se.title_snapshot
   AND qsl.scope_snapshot = se.scope_snapshot
  INNER JOIN inspection_quote_service_detail AS iq ON iq.quote_service_line_id = qsl.id
 WHERE se.provider_kind = 'inspection_agency'
   AND o.source = 'accepted_quote'
ON CONFLICT ("engagement_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "testing_certification_engagement_detail" (
  "engagement_id", "source_quote_service_line_id", "standards", "laboratory_location"
)
SELECT se.id, qsl.id, COALESCE(tq.standards, '{}'), tq.laboratory_location
  FROM commerce_service_engagement AS se
  INNER JOIN commerce_order AS o ON o.id = se.order_id
  INNER JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
  INNER JOIN commerce_quote_revision AS qr
    ON qr.quote_id = q.id AND qr.revision_number = q.accepted_revision_number
  INNER JOIN commerce_quote_service_line AS qsl
    ON qsl.revision_id = qr.id
   AND qsl.provider_kind = se.provider_kind
   AND qsl.title_snapshot = se.title_snapshot
   AND qsl.scope_snapshot = se.scope_snapshot
  INNER JOIN testing_certification_quote_service_detail AS tq ON tq.quote_service_line_id = qsl.id
 WHERE se.provider_kind = 'testing_certification_lab'
   AND o.source = 'accepted_quote'
ON CONFLICT ("engagement_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "marketing_engagement_detail" (
  "engagement_id", "source_quote_service_line_id", "channels", "deliverables_summary"
)
SELECT se.id, qsl.id, COALESCE(mq.channels, '{}'), mq.deliverables_summary
  FROM commerce_service_engagement AS se
  INNER JOIN commerce_order AS o ON o.id = se.order_id
  INNER JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
  INNER JOIN commerce_quote_revision AS qr
    ON qr.quote_id = q.id AND qr.revision_number = q.accepted_revision_number
  INNER JOIN commerce_quote_service_line AS qsl
    ON qsl.revision_id = qr.id
   AND qsl.provider_kind = se.provider_kind
   AND qsl.title_snapshot = se.title_snapshot
   AND qsl.scope_snapshot = se.scope_snapshot
  INNER JOIN marketing_quote_service_detail AS mq ON mq.quote_service_line_id = qsl.id
 WHERE se.provider_kind = 'marketing_agency'
   AND o.source = 'accepted_quote'
ON CONFLICT ("engagement_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "warehouse_engagement_detail" (
  "engagement_id", "source_quote_service_line_id", "storage_types",
  "capacity_units", "temperature_controlled"
)
SELECT se.id, qsl.id, COALESCE(wq.storage_types, '{}'), wq.capacity_units, wq.temperature_controlled
  FROM commerce_service_engagement AS se
  INNER JOIN commerce_order AS o ON o.id = se.order_id
  INNER JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
  INNER JOIN commerce_quote_revision AS qr
    ON qr.quote_id = q.id AND qr.revision_number = q.accepted_revision_number
  INNER JOIN commerce_quote_service_line AS qsl
    ON qsl.revision_id = qr.id
   AND qsl.provider_kind = se.provider_kind
   AND qsl.title_snapshot = se.title_snapshot
   AND qsl.scope_snapshot = se.scope_snapshot
  INNER JOIN warehouse_quote_service_detail AS wq ON wq.quote_service_line_id = qsl.id
 WHERE se.provider_kind = 'warehouse_provider'
   AND o.source = 'accepted_quote'
ON CONFLICT ("engagement_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "foreign_exchange_engagement_detail" (
  "engagement_id", "source_quote_service_line_id", "currency_pair",
  "rate_fixed_point_units", "rate_scale", "settlement_rail",
  "notional_amount_minor_units", "notional_currency"
)
SELECT se.id, qsl.id, fx.currency_pair,
       fx.rate_fixed_point::text, fx.rate_scale, fx.settlement_rail,
       CASE WHEN fx.notional_amount_in_cents IS NULL THEN NULL ELSE fx.notional_amount_in_cents::text END,
       fx.notional_currency
  FROM commerce_service_engagement AS se
  INNER JOIN commerce_order AS o ON o.id = se.order_id
  INNER JOIN commerce_quote AS q ON q.id = o.accepted_quote_id
  INNER JOIN commerce_quote_revision AS qr
    ON qr.quote_id = q.id AND qr.revision_number = q.accepted_revision_number
  INNER JOIN commerce_quote_service_line AS qsl
    ON qsl.revision_id = qr.id
   AND qsl.provider_kind = se.provider_kind
   AND qsl.title_snapshot = se.title_snapshot
   AND qsl.scope_snapshot = se.scope_snapshot
  INNER JOIN foreign_exchange_quote_service_detail AS fx ON fx.quote_service_line_id = qsl.id
 WHERE se.provider_kind = 'foreign_exchange_facilitator'
   AND o.source = 'accepted_quote'
ON CONFLICT ("engagement_id") DO NOTHING;--> statement-breakpoint

-- Mark engagements that received a typed snapshot as ready.
UPDATE commerce_service_engagement AS se
   SET execution_contract_state = 'ready'
 WHERE EXISTS (SELECT 1 FROM freight_engagement_detail d WHERE d.engagement_id = se.id)
    OR EXISTS (SELECT 1 FROM customs_brokerage_engagement_detail d WHERE d.engagement_id = se.id)
    OR EXISTS (SELECT 1 FROM insurance_engagement_detail d WHERE d.engagement_id = se.id)
    OR EXISTS (SELECT 1 FROM inspection_engagement_detail d WHERE d.engagement_id = se.id)
    OR EXISTS (SELECT 1 FROM testing_certification_engagement_detail d WHERE d.engagement_id = se.id)
    OR EXISTS (SELECT 1 FROM marketing_engagement_detail d WHERE d.engagement_id = se.id)
    OR EXISTS (SELECT 1 FROM warehouse_engagement_detail d WHERE d.engagement_id = se.id)
    OR EXISTS (SELECT 1 FROM foreign_exchange_engagement_detail d WHERE d.engagement_id = se.id);--> statement-breakpoint
