CREATE TYPE "public"."commerce_order_source" AS ENUM('direct_checkout', 'accepted_quote');--> statement-breakpoint
CREATE TYPE "public"."commerce_order_state" AS ENUM('pending_payment', 'payment_processing', 'confirmed', 'in_fulfillment', 'partially_completed', 'completed', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."commerce_quote_status" AS ENUM('draft', 'submitted', 'superseded', 'accepted', 'declined', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."commerce_rfq_invitation_state" AS ENUM('pending', 'sent', 'read', 'responded', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."commerce_rfq_state" AS ENUM('draft', 'open', 'closed', 'awarded', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."commerce_rfq_visibility" AS ENUM('invited_only', 'matched_providers');--> statement-breakpoint
CREATE TYPE "public"."commerce_thread_participant_role" AS ENUM('buyer', 'provider', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."commerce_thread_resource_kind" AS ENUM('rfq', 'quote', 'order', 'service_engagement', 'dispute');--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'rfq_opened';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'rfq_closed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'rfq_awarded';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'quote_submitted';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'quote_accepted';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'quote_declined';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'quote_withdrawn';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'order_created_from_quote';--> statement-breakpoint
CREATE TABLE "commerce_message" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"author_organization_id" text NOT NULL,
	"author_member_id" text NOT NULL,
	"body_text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_message_body_ck" CHECK (char_length(body_text) BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "commerce_message_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"encrypted_document_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_order" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"counterparty_organization_id" text NOT NULL,
	"source" "commerce_order_source" NOT NULL,
	"state" "commerce_order_state" DEFAULT 'pending_payment' NOT NULL,
	"accepted_quote_id" text,
	"accepted_quote_revision_id" text,
	"currency" text NOT NULL,
	"subtotal_in_cents" bigint NOT NULL,
	"tax_in_cents" bigint DEFAULT 0 NOT NULL,
	"service_fee_in_cents" bigint DEFAULT 0 NOT NULL,
	"shipping_in_cents" bigint DEFAULT 0 NOT NULL,
	"discount_in_cents" bigint DEFAULT 0 NOT NULL,
	"total_in_cents" bigint NOT NULL,
	"payment_terms_snapshot" text,
	"incoterm_snapshot" text,
	"buyer_legal_name_snapshot" text NOT NULL,
	"counterparty_legal_name_snapshot" text NOT NULL,
	"buyer_address_snapshot" text,
	"counterparty_address_snapshot" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_order_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_order_money_ck" CHECK (subtotal_in_cents >= 0 AND tax_in_cents >= 0 AND service_fee_in_cents >= 0
          AND shipping_in_cents >= 0 AND discount_in_cents >= 0 AND total_in_cents >= 0
          AND total_in_cents = (subtotal_in_cents + tax_in_cents + service_fee_in_cents
              + shipping_in_cents - discount_in_cents)),
	CONSTRAINT "commerce_order_quote_source_ck" CHECK ((source = 'accepted_quote' AND accepted_quote_id IS NOT NULL
              AND accepted_quote_revision_id IS NOT NULL)
          OR (source = 'direct_checkout' AND accepted_quote_id IS NULL
              AND accepted_quote_revision_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "commerce_order_product_line" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text,
	"title_snapshot" text NOT NULL,
	"specification_snapshot" text NOT NULL,
	"quantity_ordered" integer NOT NULL,
	"quantity_reserved" integer DEFAULT 0 NOT NULL,
	"quantity_fulfilled" integer DEFAULT 0 NOT NULL,
	"quantity_cancelled" integer DEFAULT 0 NOT NULL,
	"quantity_refunded" integer DEFAULT 0 NOT NULL,
	"unit_price_in_cents" bigint NOT NULL,
	"line_total_in_cents" bigint NOT NULL,
	"sibling_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_order_product_line_qty_ck" CHECK (quantity_ordered > 0
          AND quantity_reserved >= 0 AND quantity_fulfilled >= 0
          AND quantity_cancelled >= 0 AND quantity_refunded >= 0
          AND (quantity_fulfilled + quantity_cancelled) <= quantity_ordered),
	CONSTRAINT "commerce_order_product_line_money_ck" CHECK (unit_price_in_cents >= 0
          AND line_total_in_cents = (quantity_ordered::bigint * unit_price_in_cents))
);
--> statement-breakpoint
CREATE TABLE "commerce_order_service_line" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"provider_kind" "commerce_provider_kind_slug" NOT NULL,
	"title_snapshot" text NOT NULL,
	"scope_snapshot" text NOT NULL,
	"fee_in_cents" bigint NOT NULL,
	"sibling_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_order_service_line_fee_ck" CHECK (fee_in_cents >= 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_quote" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"provider_organization_id" text NOT NULL,
	"created_by_member_id" text NOT NULL,
	"status" "commerce_quote_status" DEFAULT 'draft' NOT NULL,
	"latest_revision_number" integer DEFAULT 0 NOT NULL,
	"accepted_revision_number" integer,
	"submitted_at" timestamp,
	"accepted_at" timestamp,
	"declined_at" timestamp,
	"withdrawn_at" timestamp,
	"expired_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_quote_revision_ck" CHECK (latest_revision_number >= 0),
	CONSTRAINT "commerce_quote_accepted_revision_ck" CHECK ((status <> 'accepted' AND accepted_revision_number IS NULL AND accepted_at IS NULL)
          OR (status = 'accepted' AND accepted_revision_number IS NOT NULL
              AND accepted_revision_number > 0 AND accepted_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "commerce_quote_product_line" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"rfq_product_line_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_in_cents" bigint NOT NULL,
	"line_total_in_cents" bigint NOT NULL,
	"title_snapshot" text NOT NULL,
	"specification_snapshot" text NOT NULL,
	"lead_time_days" integer,
	"exclusions_snapshot" text,
	"sibling_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_quote_product_line_quantity_ck" CHECK (quantity > 0),
	CONSTRAINT "commerce_quote_product_line_money_ck" CHECK (unit_price_in_cents >= 0 AND line_total_in_cents = (quantity::bigint * unit_price_in_cents)),
	CONSTRAINT "commerce_quote_product_line_title_ck" CHECK (char_length(title_snapshot) BETWEEN 1 AND 200
          AND char_length(specification_snapshot) BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "commerce_quote_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"currency" text NOT NULL,
	"validity_deadline_at" timestamp NOT NULL,
	"subtotal_in_cents" bigint NOT NULL,
	"tax_in_cents" bigint DEFAULT 0 NOT NULL,
	"service_fee_in_cents" bigint DEFAULT 0 NOT NULL,
	"shipping_in_cents" bigint DEFAULT 0 NOT NULL,
	"discount_in_cents" bigint DEFAULT 0 NOT NULL,
	"total_in_cents" bigint NOT NULL,
	"payment_terms" text,
	"incoterm" text,
	"notes" text,
	"created_by_member_id" text NOT NULL,
	"submitted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_quote_revision_number_ck" CHECK (revision_number > 0),
	CONSTRAINT "commerce_quote_revision_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_quote_revision_money_ck" CHECK (subtotal_in_cents >= 0 AND tax_in_cents >= 0 AND service_fee_in_cents >= 0
          AND shipping_in_cents >= 0 AND discount_in_cents >= 0 AND total_in_cents >= 0
          AND total_in_cents = (subtotal_in_cents + tax_in_cents + service_fee_in_cents
              + shipping_in_cents - discount_in_cents)),
	CONSTRAINT "commerce_quote_revision_text_ck" CHECK ((payment_terms IS NULL OR char_length(payment_terms) <= 2000)
          AND (incoterm IS NULL OR char_length(incoterm) BETWEEN 1 AND 20)
          AND (notes IS NULL OR char_length(notes) <= 10000))
);
--> statement-breakpoint
CREATE TABLE "commerce_quote_service_line" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"rfq_service_line_id" text NOT NULL,
	"provider_kind" "commerce_provider_kind_slug" NOT NULL,
	"fee_in_cents" bigint NOT NULL,
	"title_snapshot" text NOT NULL,
	"scope_snapshot" text NOT NULL,
	"lead_time_days" integer,
	"exclusions_snapshot" text,
	"deliverable_snapshot" text,
	"sibling_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_quote_service_line_fee_ck" CHECK (fee_in_cents >= 0),
	CONSTRAINT "commerce_quote_service_line_text_ck" CHECK (char_length(title_snapshot) BETWEEN 1 AND 200
          AND char_length(scope_snapshot) BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "commerce_rfq" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"created_by_member_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"state" "commerce_rfq_state" DEFAULT 'draft' NOT NULL,
	"visibility" "commerce_rfq_visibility" DEFAULT 'invited_only' NOT NULL,
	"response_deadline_at" timestamp,
	"desired_delivery_starts_at" timestamp,
	"desired_delivery_ends_at" timestamp,
	"destination_address_id" text,
	"destination_country_code" text,
	"destination_locality" text,
	"settlement_currency" text DEFAULT 'USD' NOT NULL,
	"opened_at" timestamp,
	"closed_at" timestamp,
	"awarded_at" timestamp,
	"expired_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_rfq_title_ck" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "commerce_rfq_description_ck" CHECK (description IS NULL OR char_length(description) <= 10000),
	CONSTRAINT "commerce_rfq_currency_ck" CHECK (settlement_currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_rfq_destination_country_ck" CHECK (destination_country_code IS NULL OR destination_country_code ~ '^[A-Z]{2}$'),
	CONSTRAINT "commerce_rfq_delivery_window_ck" CHECK ((desired_delivery_starts_at IS NULL AND desired_delivery_ends_at IS NULL)
          OR (desired_delivery_starts_at IS NOT NULL AND desired_delivery_ends_at IS NOT NULL
              AND desired_delivery_ends_at >= desired_delivery_starts_at)),
	CONSTRAINT "commerce_rfq_state_timestamps_ck" CHECK ((state = 'draft' AND opened_at IS NULL AND closed_at IS NULL AND awarded_at IS NULL
              AND expired_at IS NULL AND cancelled_at IS NULL)
          OR (state = 'open' AND opened_at IS NOT NULL AND closed_at IS NULL AND awarded_at IS NULL
              AND expired_at IS NULL AND cancelled_at IS NULL)
          OR (state = 'closed' AND opened_at IS NOT NULL AND closed_at IS NOT NULL
              AND awarded_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
          OR (state = 'awarded' AND opened_at IS NOT NULL AND awarded_at IS NOT NULL
              AND expired_at IS NULL AND cancelled_at IS NULL)
          OR (state = 'expired' AND opened_at IS NOT NULL AND expired_at IS NOT NULL
              AND cancelled_at IS NULL)
          OR (state = 'cancelled' AND cancelled_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "commerce_rfq_document" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"encrypted_document_id" text NOT NULL,
	"attached_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_rfq_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"provider_organization_id" text NOT NULL,
	"state" "commerce_rfq_invitation_state" DEFAULT 'pending' NOT NULL,
	"invited_by_member_id" text NOT NULL,
	"sent_at" timestamp,
	"read_at" timestamp,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_rfq_product_line" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"product_id" text,
	"category_id" text,
	"requested_title" text NOT NULL,
	"requested_specification_snapshot" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_label" text NOT NULL,
	"sibling_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_rfq_product_line_title_ck" CHECK (char_length(requested_title) BETWEEN 1 AND 200),
	CONSTRAINT "commerce_rfq_product_line_spec_ck" CHECK (char_length(requested_specification_snapshot) BETWEEN 1 AND 10000),
	CONSTRAINT "commerce_rfq_product_line_quantity_ck" CHECK (quantity > 0),
	CONSTRAINT "commerce_rfq_product_line_unit_ck" CHECK (char_length(unit_label) BETWEEN 1 AND 40),
	CONSTRAINT "commerce_rfq_product_line_order_ck" CHECK (sibling_order >= 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_rfq_service_line" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"provider_kind" "commerce_provider_kind_slug" NOT NULL,
	"service_offering_id" text,
	"linked_product_line_id" text,
	"requirement_summary" text NOT NULL,
	"sibling_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_rfq_service_line_summary_ck" CHECK (char_length(requirement_summary) BETWEEN 1 AND 4000),
	CONSTRAINT "commerce_rfq_service_line_order_ck" CHECK (sibling_order >= 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_kind" "commerce_thread_resource_kind" NOT NULL,
	"resource_id" text NOT NULL,
	"created_by_organization_id" text NOT NULL,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_thread_participant" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"participant_role" "commerce_thread_participant_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customs_brokerage_quote_service_detail" (
	"quote_service_line_id" text PRIMARY KEY NOT NULL,
	"jurisdictions" text[] DEFAULT '{}' NOT NULL,
	"filing_summary" text
);
--> statement-breakpoint
CREATE TABLE "customs_brokerage_rfq_requirement_detail" (
	"service_line_id" text PRIMARY KEY NOT NULL,
	"jurisdictions" text[] DEFAULT '{}' NOT NULL,
	"import_required" boolean DEFAULT true NOT NULL,
	"export_required" boolean DEFAULT false NOT NULL,
	"commodity_summary" text
);
--> statement-breakpoint
CREATE TABLE "foreign_exchange_quote_service_detail" (
	"quote_service_line_id" text PRIMARY KEY NOT NULL,
	"currency_pair" text NOT NULL,
	"rate_fixed_point" bigint NOT NULL,
	"rate_scale" integer NOT NULL,
	"settlement_rail" text,
	"notional_amount_in_cents" integer,
	"notional_currency" text DEFAULT 'USD' NOT NULL,
	CONSTRAINT "foreign_exchange_quote_service_detail_rate_ck" CHECK (rate_fixed_point > 0 AND rate_scale BETWEEN 0 AND 12),
	CONSTRAINT "foreign_exchange_quote_service_detail_pair_ck" CHECK (char_length(currency_pair) BETWEEN 7 AND 7 AND currency_pair ~ '^[A-Z]{3}/[A-Z]{3}$'),
	CONSTRAINT "foreign_exchange_quote_service_detail_currency_ck" CHECK (notional_currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "foreign_exchange_rfq_requirement_detail" (
	"service_line_id" text PRIMARY KEY NOT NULL,
	"currency_pairs" text[] DEFAULT '{}' NOT NULL,
	"settlement_rails" text[] DEFAULT '{}' NOT NULL,
	"notional_amount_in_cents" integer,
	"notional_currency" text DEFAULT 'USD' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freight_quote_service_detail" (
	"quote_service_line_id" text PRIMARY KEY NOT NULL,
	"transport_modes" "freight_transport_mode"[] DEFAULT '{}' NOT NULL,
	"origin_country_code" text,
	"destination_country_code" text,
	"estimated_transit_days" integer
);
--> statement-breakpoint
CREATE TABLE "freight_rfq_requirement_detail" (
	"service_line_id" text PRIMARY KEY NOT NULL,
	"transport_modes" "freight_transport_mode"[] DEFAULT '{}' NOT NULL,
	"origin_country_code" text,
	"destination_country_code" text,
	"requires_consolidation" boolean DEFAULT false NOT NULL,
	"requires_hazardous_goods_support" boolean DEFAULT false NOT NULL,
	"cargo_description" text
);
--> statement-breakpoint
CREATE TABLE "inspection_quote_service_detail" (
	"quote_service_line_id" text PRIMARY KEY NOT NULL,
	"included_stages" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection_rfq_requirement_detail" (
	"service_line_id" text PRIMARY KEY NOT NULL,
	"pre_production" boolean DEFAULT false NOT NULL,
	"during_production" boolean DEFAULT false NOT NULL,
	"pre_shipment" boolean DEFAULT false NOT NULL,
	"loading_supervision" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_quote_service_detail" (
	"quote_service_line_id" text PRIMARY KEY NOT NULL,
	"coverage_classes" text[] DEFAULT '{}' NOT NULL,
	"coverage_limit_in_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_rfq_requirement_detail" (
	"service_line_id" text PRIMARY KEY NOT NULL,
	"cargo_coverage_classes" text[] DEFAULT '{}' NOT NULL,
	"coverage_limit_in_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_quote_service_detail" (
	"quote_service_line_id" text PRIMARY KEY NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"deliverables_summary" text
);
--> statement-breakpoint
CREATE TABLE "marketing_rfq_requirement_detail" (
	"service_line_id" text PRIMARY KEY NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"target_regions" text[] DEFAULT '{}' NOT NULL,
	"language_capabilities" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testing_certification_quote_service_detail" (
	"quote_service_line_id" text PRIMARY KEY NOT NULL,
	"standards" text[] DEFAULT '{}' NOT NULL,
	"laboratory_location" text
);
--> statement-breakpoint
CREATE TABLE "testing_certification_rfq_requirement_detail" (
	"service_line_id" text PRIMARY KEY NOT NULL,
	"standards" text[] DEFAULT '{}' NOT NULL,
	"laboratory_location_preference" text
);
--> statement-breakpoint
CREATE TABLE "warehouse_quote_service_detail" (
	"quote_service_line_id" text PRIMARY KEY NOT NULL,
	"storage_types" text[] DEFAULT '{}' NOT NULL,
	"capacity_units" text,
	"temperature_controlled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse_rfq_requirement_detail" (
	"service_line_id" text PRIMARY KEY NOT NULL,
	"storage_types" text[] DEFAULT '{}' NOT NULL,
	"temperature_controlled" boolean DEFAULT false NOT NULL,
	"bonded_status_required" boolean DEFAULT false NOT NULL,
	"capacity_units" text
);
--> statement-breakpoint
ALTER TABLE "commerce_message" ADD CONSTRAINT "commerce_message_thread_id_commerce_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."commerce_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_message" ADD CONSTRAINT "commerce_message_author_organization_id_commerce_organization_id_fk" FOREIGN KEY ("author_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_message" ADD CONSTRAINT "commerce_message_author_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_message_attachment" ADD CONSTRAINT "commerce_message_attachment_message_id_commerce_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."commerce_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_message_attachment" ADD CONSTRAINT "commerce_message_attachment_encrypted_document_id_commerce_encrypted_document_id_fk" FOREIGN KEY ("encrypted_document_id") REFERENCES "public"."commerce_encrypted_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_counterparty_organization_id_commerce_organization_id_fk" FOREIGN KEY ("counterparty_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_accepted_quote_id_commerce_quote_id_fk" FOREIGN KEY ("accepted_quote_id") REFERENCES "public"."commerce_quote"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_accepted_quote_revision_id_commerce_quote_revision_id_fk" FOREIGN KEY ("accepted_quote_revision_id") REFERENCES "public"."commerce_quote_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_product_line" ADD CONSTRAINT "commerce_order_product_line_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_product_line" ADD CONSTRAINT "commerce_order_product_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order_service_line" ADD CONSTRAINT "commerce_order_service_line_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote" ADD CONSTRAINT "commerce_quote_rfq_id_commerce_rfq_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."commerce_rfq"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote" ADD CONSTRAINT "commerce_quote_provider_organization_id_commerce_organization_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote" ADD CONSTRAINT "commerce_quote_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote_product_line" ADD CONSTRAINT "commerce_quote_product_line_revision_id_commerce_quote_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."commerce_quote_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote_product_line" ADD CONSTRAINT "commerce_quote_product_line_rfq_product_line_id_commerce_rfq_product_line_id_fk" FOREIGN KEY ("rfq_product_line_id") REFERENCES "public"."commerce_rfq_product_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote_revision" ADD CONSTRAINT "commerce_quote_revision_quote_id_commerce_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."commerce_quote"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote_revision" ADD CONSTRAINT "commerce_quote_revision_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote_service_line" ADD CONSTRAINT "commerce_quote_service_line_revision_id_commerce_quote_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."commerce_quote_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_quote_service_line" ADD CONSTRAINT "commerce_quote_service_line_rfq_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("rfq_service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq" ADD CONSTRAINT "commerce_rfq_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq" ADD CONSTRAINT "commerce_rfq_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq" ADD CONSTRAINT "commerce_rfq_destination_address_id_commerce_organization_address_id_fk" FOREIGN KEY ("destination_address_id") REFERENCES "public"."commerce_organization_address"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_document" ADD CONSTRAINT "commerce_rfq_document_rfq_id_commerce_rfq_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."commerce_rfq"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_document" ADD CONSTRAINT "commerce_rfq_document_encrypted_document_id_commerce_encrypted_document_id_fk" FOREIGN KEY ("encrypted_document_id") REFERENCES "public"."commerce_encrypted_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_document" ADD CONSTRAINT "commerce_rfq_document_attached_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("attached_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_invitation" ADD CONSTRAINT "commerce_rfq_invitation_rfq_id_commerce_rfq_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."commerce_rfq"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_invitation" ADD CONSTRAINT "commerce_rfq_invitation_provider_organization_id_commerce_organization_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_invitation" ADD CONSTRAINT "commerce_rfq_invitation_invited_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("invited_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_product_line" ADD CONSTRAINT "commerce_rfq_product_line_rfq_id_commerce_rfq_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."commerce_rfq"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_product_line" ADD CONSTRAINT "commerce_rfq_product_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_product_line" ADD CONSTRAINT "commerce_rfq_product_line_category_id_commerce_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."commerce_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_service_line" ADD CONSTRAINT "commerce_rfq_service_line_rfq_id_commerce_rfq_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."commerce_rfq"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_service_line" ADD CONSTRAINT "commerce_rfq_service_line_service_offering_id_commerce_service_offering_id_fk" FOREIGN KEY ("service_offering_id") REFERENCES "public"."commerce_service_offering"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_rfq_service_line" ADD CONSTRAINT "commerce_rfq_service_line_linked_product_line_id_commerce_rfq_product_line_id_fk" FOREIGN KEY ("linked_product_line_id") REFERENCES "public"."commerce_rfq_product_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_thread" ADD CONSTRAINT "commerce_thread_created_by_organization_id_commerce_organization_id_fk" FOREIGN KEY ("created_by_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_thread" ADD CONSTRAINT "commerce_thread_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_thread_participant" ADD CONSTRAINT "commerce_thread_participant_thread_id_commerce_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."commerce_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_thread_participant" ADD CONSTRAINT "commerce_thread_participant_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_brokerage_quote_service_detail" ADD CONSTRAINT "customs_brokerage_quote_service_detail_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customs_brokerage_rfq_requirement_detail" ADD CONSTRAINT "customs_brokerage_rfq_requirement_detail_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_exchange_quote_service_detail" ADD CONSTRAINT "foreign_exchange_quote_service_detail_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_exchange_rfq_requirement_detail" ADD CONSTRAINT "foreign_exchange_rfq_requirement_detail_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_quote_service_detail" ADD CONSTRAINT "freight_quote_service_detail_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_rfq_requirement_detail" ADD CONSTRAINT "freight_rfq_requirement_detail_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_quote_service_detail" ADD CONSTRAINT "inspection_quote_service_detail_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_rfq_requirement_detail" ADD CONSTRAINT "inspection_rfq_requirement_detail_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_quote_service_detail" ADD CONSTRAINT "insurance_quote_service_detail_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_rfq_requirement_detail" ADD CONSTRAINT "insurance_rfq_requirement_detail_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_quote_service_detail" ADD CONSTRAINT "marketing_quote_service_detail_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_rfq_requirement_detail" ADD CONSTRAINT "marketing_rfq_requirement_detail_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_certification_quote_service_detail" ADD CONSTRAINT "testing_certification_quote_service_detail_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_certification_rfq_requirement_detail" ADD CONSTRAINT "testing_certification_rfq_requirement_detail_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_quote_service_detail" ADD CONSTRAINT "warehouse_quote_service_detail_quote_service_line_id_commerce_quote_service_line_id_fk" FOREIGN KEY ("quote_service_line_id") REFERENCES "public"."commerce_quote_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_rfq_requirement_detail" ADD CONSTRAINT "warehouse_rfq_requirement_detail_service_line_id_commerce_rfq_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "public"."commerce_rfq_service_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_message_thread_idx" ON "commerce_message" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_message_attachment_uidx" ON "commerce_message_attachment" USING btree ("message_id","encrypted_document_id");--> statement-breakpoint
CREATE INDEX "commerce_message_attachment_message_idx" ON "commerce_message_attachment" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_order_accepted_quote_uidx" ON "commerce_order" USING btree ("accepted_quote_id") WHERE accepted_quote_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_order_accepted_revision_uidx" ON "commerce_order" USING btree ("accepted_quote_revision_id") WHERE accepted_quote_revision_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_order_buyer_idx" ON "commerce_order" USING btree ("buyer_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_order_counterparty_idx" ON "commerce_order" USING btree ("counterparty_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_order_product_line_order_idx" ON "commerce_order_product_line" USING btree ("order_id","sibling_order");--> statement-breakpoint
CREATE INDEX "commerce_order_service_line_order_idx" ON "commerce_order_service_line" USING btree ("order_id","sibling_order");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quote_rfq_provider_uidx" ON "commerce_quote" USING btree ("rfq_id","provider_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quote_accepted_revision_uidx" ON "commerce_quote" USING btree ("id","accepted_revision_number") WHERE status = 'accepted' AND accepted_revision_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_quote_provider_status_idx" ON "commerce_quote" USING btree ("provider_organization_id","status","id");--> statement-breakpoint
CREATE INDEX "commerce_quote_rfq_status_idx" ON "commerce_quote" USING btree ("rfq_id","status","id");--> statement-breakpoint
CREATE INDEX "commerce_quote_product_line_revision_idx" ON "commerce_quote_product_line" USING btree ("revision_id","sibling_order");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quote_product_line_rfq_uidx" ON "commerce_quote_product_line" USING btree ("revision_id","rfq_product_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quote_revision_number_uidx" ON "commerce_quote_revision" USING btree ("quote_id","revision_number");--> statement-breakpoint
CREATE INDEX "commerce_quote_revision_validity_idx" ON "commerce_quote_revision" USING btree ("validity_deadline_at","submitted_at");--> statement-breakpoint
CREATE INDEX "commerce_quote_service_line_revision_idx" ON "commerce_quote_service_line" USING btree ("revision_id","sibling_order");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_quote_service_line_rfq_uidx" ON "commerce_quote_service_line" USING btree ("revision_id","rfq_service_line_id");--> statement-breakpoint
CREATE INDEX "commerce_rfq_buyer_state_idx" ON "commerce_rfq" USING btree ("buyer_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_rfq_deadline_idx" ON "commerce_rfq" USING btree ("response_deadline_at","state");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_rfq_document_uidx" ON "commerce_rfq_document" USING btree ("rfq_id","encrypted_document_id");--> statement-breakpoint
CREATE INDEX "commerce_rfq_document_rfq_idx" ON "commerce_rfq_document" USING btree ("rfq_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_rfq_invitation_rfq_provider_uidx" ON "commerce_rfq_invitation" USING btree ("rfq_id","provider_organization_id");--> statement-breakpoint
CREATE INDEX "commerce_rfq_invitation_provider_idx" ON "commerce_rfq_invitation" USING btree ("provider_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_rfq_product_line_rfq_idx" ON "commerce_rfq_product_line" USING btree ("rfq_id","sibling_order");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_rfq_product_line_order_uidx" ON "commerce_rfq_product_line" USING btree ("rfq_id","sibling_order");--> statement-breakpoint
CREATE INDEX "commerce_rfq_service_line_rfq_idx" ON "commerce_rfq_service_line" USING btree ("rfq_id","sibling_order");--> statement-breakpoint
CREATE INDEX "commerce_rfq_service_line_kind_idx" ON "commerce_rfq_service_line" USING btree ("provider_kind","rfq_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_rfq_service_line_order_uidx" ON "commerce_rfq_service_line" USING btree ("rfq_id","sibling_order");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_thread_resource_uidx" ON "commerce_thread" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "commerce_thread_org_idx" ON "commerce_thread" USING btree ("created_by_organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_thread_participant_uidx" ON "commerce_thread_participant" USING btree ("thread_id","organization_id");--> statement-breakpoint
CREATE INDEX "commerce_thread_participant_org_idx" ON "commerce_thread_participant" USING btree ("organization_id","thread_id");;--> statement-breakpoint

-- Submitted quote revisions are immutable commercial evidence (STORE §4.7 / §8).
CREATE OR REPLACE FUNCTION commerce_prevent_submitted_quote_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_quote_revision_immutable$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'submitted quote revision is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'submitted quote revision is immutable';
  END IF;

  -- Draft revisions may only transition submitted_at from NULL → non-NULL.
  IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     AND OLD.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'submitted quote revision timestamp cannot change';
  END IF;

  IF NEW.revision_number IS DISTINCT FROM OLD.revision_number
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.validity_deadline_at IS DISTINCT FROM OLD.validity_deadline_at
     OR NEW.subtotal_in_cents IS DISTINCT FROM OLD.subtotal_in_cents
     OR NEW.tax_in_cents IS DISTINCT FROM OLD.tax_in_cents
     OR NEW.service_fee_in_cents IS DISTINCT FROM OLD.service_fee_in_cents
     OR NEW.shipping_in_cents IS DISTINCT FROM OLD.shipping_in_cents
     OR NEW.discount_in_cents IS DISTINCT FROM OLD.discount_in_cents
     OR NEW.total_in_cents IS DISTINCT FROM OLD.total_in_cents
     OR NEW.payment_terms IS DISTINCT FROM OLD.payment_terms
     OR NEW.incoterm IS DISTINCT FROM OLD.incoterm
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id THEN
    IF OLD.submitted_at IS NOT NULL OR NEW.submitted_at IS NOT NULL THEN
      -- Allow the single submit UPDATE that only sets submitted_at.
      IF NOT (
        OLD.submitted_at IS NULL
        AND NEW.submitted_at IS NOT NULL
        AND NEW.revision_number IS NOT DISTINCT FROM OLD.revision_number
        AND NEW.currency IS NOT DISTINCT FROM OLD.currency
        AND NEW.validity_deadline_at IS NOT DISTINCT FROM OLD.validity_deadline_at
        AND NEW.subtotal_in_cents IS NOT DISTINCT FROM OLD.subtotal_in_cents
        AND NEW.tax_in_cents IS NOT DISTINCT FROM OLD.tax_in_cents
        AND NEW.service_fee_in_cents IS NOT DISTINCT FROM OLD.service_fee_in_cents
        AND NEW.shipping_in_cents IS NOT DISTINCT FROM OLD.shipping_in_cents
        AND NEW.discount_in_cents IS NOT DISTINCT FROM OLD.discount_in_cents
        AND NEW.total_in_cents IS NOT DISTINCT FROM OLD.total_in_cents
        AND NEW.payment_terms IS NOT DISTINCT FROM OLD.payment_terms
        AND NEW.incoterm IS NOT DISTINCT FROM OLD.incoterm
        AND NEW.notes IS NOT DISTINCT FROM OLD.notes
        AND NEW.created_by_member_id IS NOT DISTINCT FROM OLD.created_by_member_id
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'quote revision money and terms are frozen on submit';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$commerce_quote_revision_immutable$;--> statement-breakpoint

CREATE TRIGGER commerce_quote_revision_append_only
BEFORE UPDATE OR DELETE ON "commerce_quote_revision"
FOR EACH ROW EXECUTE FUNCTION commerce_prevent_submitted_quote_revision_mutation();--> statement-breakpoint

-- Messages are append-only negotiation evidence for Phase 3 threads.
CREATE OR REPLACE FUNCTION commerce_prevent_message_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_message_immutable$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commerce messages are append-only';
END
$commerce_message_immutable$;--> statement-breakpoint

CREATE TRIGGER commerce_message_append_only
BEFORE UPDATE OR DELETE ON "commerce_message"
FOR EACH ROW EXECUTE FUNCTION commerce_prevent_message_mutation();--> statement-breakpoint

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
     OR NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commerce order commercial snapshot is immutable';
  END IF;

  RETURN NEW;
END
$commerce_order_snapshot_immutable$;--> statement-breakpoint

CREATE TRIGGER commerce_order_snapshot_append_only
BEFORE UPDATE OR DELETE ON "commerce_order"
FOR EACH ROW EXECUTE FUNCTION commerce_prevent_order_snapshot_mutation();
