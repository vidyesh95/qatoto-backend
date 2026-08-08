-- Store Phase 14 — the outbound command outbox and the inbound event inbox.
--
-- PARALLEL TO THE PAYMENT PAIR, NOT A WIDENING OF IT. `commerce_payment_outbox.transfer_id`
-- is NOT NULL and its kind enum holds two payment-only values; `commerce_payment_webhook_event`
-- keys on the `commerce_payment_provider` enum (`fake | stripe`) and its foreign keys point
-- at payment intents and refunds. Generalising either would have meant loosening a NOT NULL
-- to admit rows that can never satisfy it, which is the same reasoning that gave Phase 10 a
-- separate `commerce_content_report` and Phase 12 a separate certification table.
--
-- A COMMAND POSTS NOTHING. Every row in the outbox is an intent — create a session, lock
-- milestones, request a release. None of them moves a memo balance. Only the provider's own
-- event does that, whether it arrives as a webhook or is pulled by the reconciler, and both
-- paths apply it through one function so there is exactly one way for money to move.
--
-- PERSIST BEFORE PROCESSING. The inbox's unique `(provider_id, provider_event_id)` is the
-- entire reason a route with no session authentication can be safe: a replayed delivery
-- collides, is recognised as already seen, and answers 200 without reprocessing. Signature
-- verification decides whether a request is heard at all; this decides whether hearing it
-- twice costs anything.

CREATE TABLE "commerce_connector_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"connector_kind" "commerce_connector_kind" NOT NULL,
	"kind" "commerce_connector_outbox_kind" NOT NULL,
	"state" "commerce_connector_outbox_state" DEFAULT 'pending' NOT NULL,
	"order_id" text,
	"escrow_session_id" text,
	"escrow_milestone_id" text,
	"idempotency_key" text NOT NULL,
	"request_payload_json" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_connector_outbox_attempt_ck" CHECK (attempt_count >= 0),
	CONSTRAINT "commerce_connector_outbox_payload_ck" CHECK (
		char_length(request_payload_json) BETWEEN 2 AND 50000
		AND request_payload_json LIKE '{%'
	)
);--> statement-breakpoint

CREATE TABLE "commerce_connector_webhook_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"connector_kind" "commerce_connector_kind" NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"order_id" text,
	"escrow_session_id" text,
	"payload_json" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processing_error" text,
	CONSTRAINT "commerce_connector_webhook_event_type_ck" CHECK (char_length(event_type) BETWEEN 1 AND 120),
	CONSTRAINT "commerce_connector_webhook_event_payload_ck" CHECK (
		char_length(payload_json) BETWEEN 2 AND 50000 AND payload_json LIKE '{%'
	)
);--> statement-breakpoint

ALTER TABLE "commerce_connector_outbox" ADD CONSTRAINT "commerce_connector_outbox_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."commerce_external_provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_connector_outbox" ADD CONSTRAINT "commerce_connector_outbox_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_connector_outbox" ADD CONSTRAINT "commerce_connector_outbox_escrow_session_fk" FOREIGN KEY ("escrow_session_id") REFERENCES "public"."commerce_external_escrow_session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_connector_outbox" ADD CONSTRAINT "commerce_connector_outbox_escrow_milestone_fk" FOREIGN KEY ("escrow_milestone_id") REFERENCES "public"."commerce_escrow_milestone"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_connector_webhook_event" ADD CONSTRAINT "commerce_connector_webhook_event_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."commerce_external_provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_connector_webhook_event" ADD CONSTRAINT "commerce_connector_webhook_event_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_connector_webhook_event" ADD CONSTRAINT "commerce_connector_webhook_event_session_fk" FOREIGN KEY ("escrow_session_id") REFERENCES "public"."commerce_external_escrow_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Ours, minted before the call, so a retried worker sends the same key and the provider
-- recognises the retry rather than opening a second session.
CREATE UNIQUE INDEX "commerce_connector_outbox_idempotency_uidx" ON "commerce_connector_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "commerce_connector_outbox_pending_idx" ON "commerce_connector_outbox" USING btree ("state","available_at","id");--> statement-breakpoint
CREATE INDEX "commerce_connector_outbox_order_idx" ON "commerce_connector_outbox" USING btree ("order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_connector_webhook_event_provider_uidx" ON "commerce_connector_webhook_event" USING btree ("provider_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "commerce_connector_webhook_event_unprocessed_idx" ON "commerce_connector_webhook_event" USING btree ("received_at","id") WHERE processed_at IS NULL;--> statement-breakpoint
CREATE INDEX "commerce_connector_webhook_event_order_idx" ON "commerce_connector_webhook_event" USING btree ("order_id","id");
