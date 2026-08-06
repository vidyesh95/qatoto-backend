CREATE TYPE "public"."commerce_payment_provider" AS ENUM('fake', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."commerce_payment_intent_state" AS ENUM('created', 'requires_action', 'processing', 'authorized', 'settled', 'failed', 'cancelled', 'partially_refunded', 'refunded', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."commerce_provider_transfer_state" AS ENUM('created', 'submitted', 'settled', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."commerce_refund_state" AS ENUM('created', 'processing', 'settled', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."commerce_journal_account_kind" AS ENUM('buyer_clearing', 'order_held', 'seller_payable', 'platform_fee', 'refunds_payable', 'reconciliation_suspense');--> statement-breakpoint
CREATE TYPE "public"."commerce_journal_kind" AS ENUM('payment_authorized', 'payment_settled', 'payment_failed', 'payment_refunded', 'reconciliation_adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."commerce_journal_entry_settlement" AS ENUM('pending', 'settled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."commerce_payment_outbox_kind" AS ENUM('submit_payment_intent', 'submit_refund');--> statement-breakpoint
CREATE TYPE "public"."commerce_payment_outbox_state" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'payment_intent_created';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'payment_intent_settled';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'payment_intent_failed';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'payment_refund_created';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'payment_refund_settled';--> statement-breakpoint
ALTER TYPE "public"."commerce_organization_audit_event_kind" ADD VALUE 'payment_refund_failed';--> statement-breakpoint
CREATE TABLE "commerce_payment_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"counterparty_organization_id" text NOT NULL,
	"provider" "commerce_payment_provider" NOT NULL,
	"state" "commerce_payment_intent_state" DEFAULT 'created' NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_payment_ref" text,
	"failure_reason" text,
	"authorized_at" timestamp,
	"settled_at" timestamp,
	"failed_at" timestamp,
	"cancelled_at" timestamp,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_payment_intent_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_payment_intent_amount_ck" CHECK (amount_in_cents > 0),
	CONSTRAINT "commerce_payment_intent_failure_ck" CHECK (failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "commerce_provider_transfer" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent_id" text NOT NULL,
	"refund_id" text,
	"order_id" text NOT NULL,
	"provider" "commerce_payment_provider" NOT NULL,
	"direction" text NOT NULL,
	"state" "commerce_provider_transfer_state" DEFAULT 'created' NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_transfer_ref" text,
	"failure_reason" text,
	"submitted_at" timestamp,
	"settled_at" timestamp,
	"failed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_provider_transfer_direction_ck" CHECK (direction IN ('inbound', 'outbound')),
	CONSTRAINT "commerce_provider_transfer_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_provider_transfer_amount_ck" CHECK (amount_in_cents > 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_refund" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent_id" text NOT NULL,
	"order_id" text NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"provider" "commerce_payment_provider" NOT NULL,
	"state" "commerce_refund_state" DEFAULT 'created' NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_refund_ref" text,
	"reason" text,
	"failure_reason" text,
	"settled_at" timestamp,
	"failed_at" timestamp,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_refund_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_refund_amount_ck" CHECK (amount_in_cents > 0),
	CONSTRAINT "commerce_refund_reason_ck" CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "commerce_journal_account" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"kind" "commerce_journal_account_kind" NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_journal_account_currency_ck" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "commerce_journal_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"kind" "commerce_journal_kind" NOT NULL,
	"description" text NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"settlement" "commerce_journal_entry_settlement" DEFAULT 'pending' NOT NULL,
	"linked_payment_intent_id" text,
	"linked_refund_id" text,
	"linked_transfer_id" text,
	"reverses_journal_entry_id" text,
	"entry_hash" text NOT NULL,
	"previous_entry_hash" text NOT NULL,
	"hash_version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_journal_entry_sequence_ck" CHECK (sequence_number >= 1),
	CONSTRAINT "commerce_journal_entry_hash_ck" CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "commerce_journal_entry_link_ck" CHECK ((sequence_number = 1) = (previous_entry_hash = 'genesis')
          AND (previous_entry_hash = 'genesis' OR previous_entry_hash ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "commerce_journal_entry_reversal_ck" CHECK ((kind <> 'reversal') OR (reverses_journal_entry_id IS NOT NULL)),
	CONSTRAINT "commerce_journal_entry_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_journal_entry_description_ck" CHECK (char_length(description) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "commerce_journal_line" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_entry_id" text NOT NULL,
	"order_id" text NOT NULL,
	"account_id" text NOT NULL,
	"account_kind" "commerce_journal_account_kind" NOT NULL,
	"signed_amount_in_cents" bigint NOT NULL,
	"line_index" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_journal_line_index_ck" CHECK (line_index >= 0),
	CONSTRAINT "commerce_journal_line_amount_ck" CHECK (signed_amount_in_cents <> 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_payment_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "commerce_payment_outbox_kind" NOT NULL,
	"state" "commerce_payment_outbox_state" DEFAULT 'pending' NOT NULL,
	"payment_intent_id" text,
	"refund_id" text,
	"transfer_id" text NOT NULL,
	"order_id" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_payment_outbox_target_ck" CHECK ((kind = 'submit_payment_intent' AND payment_intent_id IS NOT NULL AND refund_id IS NULL)
          OR (kind = 'submit_refund' AND refund_id IS NOT NULL AND payment_intent_id IS NOT NULL)),
	CONSTRAINT "commerce_payment_outbox_attempt_ck" CHECK (attempt_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_payment_webhook_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "commerce_payment_provider" NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payment_intent_id" text,
	"transfer_id" text,
	"refund_id" text,
	"order_id" text,
	"payload_json" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processing_error" text,
	CONSTRAINT "commerce_payment_webhook_event_type_ck" CHECK (char_length(event_type) BETWEEN 1 AND 120),
	CONSTRAINT "commerce_payment_webhook_event_payload_ck" CHECK (char_length(payload_json) BETWEEN 2 AND 50000 AND payload_json LIKE '{%')
);
--> statement-breakpoint
ALTER TABLE "commerce_payment_intent" ADD CONSTRAINT "commerce_payment_intent_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_intent" ADD CONSTRAINT "commerce_payment_intent_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_intent" ADD CONSTRAINT "commerce_payment_intent_counterparty_organization_id_commerce_organization_id_fk" FOREIGN KEY ("counterparty_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_intent" ADD CONSTRAINT "commerce_payment_intent_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_provider_transfer" ADD CONSTRAINT "commerce_provider_transfer_payment_intent_id_commerce_payment_intent_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."commerce_payment_intent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_provider_transfer" ADD CONSTRAINT "commerce_provider_transfer_refund_id_commerce_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."commerce_refund"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_provider_transfer" ADD CONSTRAINT "commerce_provider_transfer_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_refund" ADD CONSTRAINT "commerce_refund_payment_intent_id_commerce_payment_intent_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."commerce_payment_intent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_refund" ADD CONSTRAINT "commerce_refund_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_refund" ADD CONSTRAINT "commerce_refund_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_refund" ADD CONSTRAINT "commerce_refund_created_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_account" ADD CONSTRAINT "commerce_journal_account_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_entry" ADD CONSTRAINT "commerce_journal_entry_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_entry" ADD CONSTRAINT "commerce_journal_entry_linked_payment_intent_id_commerce_payment_intent_id_fk" FOREIGN KEY ("linked_payment_intent_id") REFERENCES "public"."commerce_payment_intent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_entry" ADD CONSTRAINT "commerce_journal_entry_linked_refund_id_commerce_refund_id_fk" FOREIGN KEY ("linked_refund_id") REFERENCES "public"."commerce_refund"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_entry" ADD CONSTRAINT "commerce_journal_entry_linked_transfer_id_commerce_provider_transfer_id_fk" FOREIGN KEY ("linked_transfer_id") REFERENCES "public"."commerce_provider_transfer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_entry" ADD CONSTRAINT "commerce_journal_entry_reverses_journal_entry_id_commerce_journal_entry_id_fk" FOREIGN KEY ("reverses_journal_entry_id") REFERENCES "public"."commerce_journal_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_entry" ADD CONSTRAINT "commerce_journal_entry_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_line" ADD CONSTRAINT "commerce_journal_line_journal_entry_id_commerce_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."commerce_journal_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_line" ADD CONSTRAINT "commerce_journal_line_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_journal_line" ADD CONSTRAINT "commerce_journal_line_account_id_commerce_journal_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."commerce_journal_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_outbox" ADD CONSTRAINT "commerce_payment_outbox_payment_intent_id_commerce_payment_intent_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."commerce_payment_intent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_outbox" ADD CONSTRAINT "commerce_payment_outbox_refund_id_commerce_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."commerce_refund"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_outbox" ADD CONSTRAINT "commerce_payment_outbox_transfer_id_commerce_provider_transfer_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."commerce_provider_transfer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_outbox" ADD CONSTRAINT "commerce_payment_outbox_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_webhook_event" ADD CONSTRAINT "commerce_payment_webhook_event_payment_intent_id_commerce_payment_intent_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."commerce_payment_intent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_webhook_event" ADD CONSTRAINT "commerce_payment_webhook_event_transfer_id_commerce_provider_transfer_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."commerce_provider_transfer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_webhook_event" ADD CONSTRAINT "commerce_payment_webhook_event_refund_id_commerce_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."commerce_refund"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_webhook_event" ADD CONSTRAINT "commerce_payment_webhook_event_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_intent_idempotency_uidx" ON "commerce_payment_intent" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_intent_provider_ref_uidx" ON "commerce_payment_intent" USING btree ("provider","provider_payment_ref") WHERE provider_payment_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_intent_active_order_uidx" ON "commerce_payment_intent" USING btree ("order_id") WHERE state IN ('created', 'requires_action', 'processing', 'authorized', 'settled', 'partially_refunded', 'refunded', 'disputed');--> statement-breakpoint
CREATE INDEX "commerce_payment_intent_order_idx" ON "commerce_payment_intent" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "commerce_payment_intent_buyer_idx" ON "commerce_payment_intent" USING btree ("buyer_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_payment_intent_state_idx" ON "commerce_payment_intent" USING btree ("state","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_provider_transfer_idempotency_uidx" ON "commerce_provider_transfer" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_provider_transfer_provider_ref_uidx" ON "commerce_provider_transfer" USING btree ("provider","provider_transfer_ref") WHERE provider_transfer_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_provider_transfer_intent_idx" ON "commerce_provider_transfer" USING btree ("payment_intent_id","id");--> statement-breakpoint
CREATE INDEX "commerce_provider_transfer_order_idx" ON "commerce_provider_transfer" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "commerce_provider_transfer_state_idx" ON "commerce_provider_transfer" USING btree ("state","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_refund_idempotency_uidx" ON "commerce_refund" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_refund_provider_ref_uidx" ON "commerce_refund" USING btree ("provider","provider_refund_ref") WHERE provider_refund_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_refund_intent_idx" ON "commerce_refund" USING btree ("payment_intent_id","id");--> statement-breakpoint
CREATE INDEX "commerce_refund_order_idx" ON "commerce_refund" USING btree ("order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_journal_account_order_kind_uidx" ON "commerce_journal_account" USING btree ("order_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_journal_entry_order_seq_uidx" ON "commerce_journal_entry" USING btree ("order_id","sequence_number");--> statement-breakpoint
CREATE INDEX "commerce_journal_entry_order_occurred_idx" ON "commerce_journal_entry" USING btree ("order_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "commerce_journal_entry_payment_intent_idx" ON "commerce_journal_entry" USING btree ("linked_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_journal_line_entry_index_uidx" ON "commerce_journal_line" USING btree ("journal_entry_id","line_index");--> statement-breakpoint
CREATE INDEX "commerce_journal_line_account_idx" ON "commerce_journal_line" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "commerce_journal_line_order_kind_idx" ON "commerce_journal_line" USING btree ("order_id","account_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_outbox_transfer_uidx" ON "commerce_payment_outbox" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "commerce_payment_outbox_pending_idx" ON "commerce_payment_outbox" USING btree ("state","available_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_webhook_event_provider_uidx" ON "commerce_payment_webhook_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "commerce_payment_webhook_event_unprocessed_idx" ON "commerce_payment_webhook_event" USING btree ("received_at","id") WHERE processed_at IS NULL;--> statement-breakpoint

-- Append-only journal header and lines. Corrections are reversing entries.
CREATE OR REPLACE FUNCTION commerce_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_reject_mutation$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('%s is append-only', TG_TABLE_NAME);
END
$commerce_reject_mutation$;--> statement-breakpoint

CREATE TRIGGER commerce_journal_entry_append_only
BEFORE UPDATE OR DELETE ON "commerce_journal_entry"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

CREATE TRIGGER commerce_journal_entry_no_truncate
BEFORE TRUNCATE ON "commerce_journal_entry"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

CREATE TRIGGER commerce_journal_line_append_only
BEFORE UPDATE OR DELETE ON "commerce_journal_line"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

CREATE TRIGGER commerce_journal_line_no_truncate
BEFORE TRUNCATE ON "commerce_journal_line"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

CREATE TRIGGER commerce_journal_account_append_only
BEFORE UPDATE OR DELETE ON "commerce_journal_account"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

CREATE TRIGGER commerce_journal_account_no_truncate
BEFORE TRUNCATE ON "commerce_journal_account"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

-- Webhook identity/payload immutable; only processing columns may move.
CREATE OR REPLACE FUNCTION commerce_payment_webhook_event_process_only()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_payment_webhook_event_process_only$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
     OR NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id
     OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
     OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'commerce payment webhook identity and payload are immutable';
  END IF;
  RETURN NEW;
END
$commerce_payment_webhook_event_process_only$;--> statement-breakpoint

CREATE TRIGGER commerce_payment_webhook_event_process_only
BEFORE UPDATE ON "commerce_payment_webhook_event"
FOR EACH ROW EXECUTE FUNCTION commerce_payment_webhook_event_process_only();--> statement-breakpoint

CREATE TRIGGER commerce_payment_webhook_event_no_delete
BEFORE DELETE ON "commerce_payment_webhook_event"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

CREATE TRIGGER commerce_payment_webhook_event_no_truncate
BEFORE TRUNCATE ON "commerce_payment_webhook_event"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

-- Deferred zero-sum invariant for journal lines.
CREATE OR REPLACE FUNCTION commerce_journal_entry_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_journal_entry_balances$
DECLARE
  line_total bigint;
  line_count integer;
BEGIN
  SELECT COALESCE(SUM(signed_amount_in_cents), 0), COUNT(*)
    INTO line_total, line_count
    FROM "commerce_journal_line"
   WHERE journal_entry_id = NEW.journal_entry_id;

  IF line_count < 2 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('commerce journal entry %s needs at least 2 lines, found %s', NEW.journal_entry_id, line_count);
  END IF;

  IF line_total <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('commerce journal entry %s lines sum to %s cents, not zero', NEW.journal_entry_id, line_total);
  END IF;

  RETURN NULL;
END
$commerce_journal_entry_balances$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER commerce_journal_line_zero_sum
AFTER INSERT ON "commerce_journal_line"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce_journal_entry_balances();
