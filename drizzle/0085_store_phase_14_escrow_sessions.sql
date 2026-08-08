-- Store Phase 14 — the external escrow session, its milestones, and the evidence sent to
-- prove them.
--
-- THESE THREE TABLES ARE A READ-ONLY SHADOW. The funds are at the provider; Qatoto's copy
-- exists so an order can be rendered, reconciled and disputed without a live API call. Every
-- state column here is written from a normalized provider event — a webhook, or the same
-- event pulled by the reconciler — and never from our own opinion about what should have
-- happened. Qatoto's books follow the provider and never lead it.
--
-- WHY MILESTONES ARE COPIED RATHER THAN JOINED. `commerce_escrow_milestone` duplicates the
-- amount and kind that `commerce_settlement_agreement_milestone` already holds. That is
-- deliberate: once money is locked at a provider, a later agreement revision must not be
-- able to rewrite what was locked. The agreement is the negotiation; this is the commitment,
-- and they diverge the moment somebody proposes a change to a live order.
--
-- WHY VERIFICATION POINTS AT EXISTING RECORDS. `source_kind` plus `source_id` name a
-- shipment leg event, an inspection engagement or a completion — records this schema already
-- keeps. Escrow deliberately gets no private notion of whether a thing shipped: two sources
-- of truth about fulfillment would drift, and the one the buyer sees on the order page would
-- not be the one releasing their money.
--
-- `provider_accepted` is NULL until the provider rules. We submit evidence; we do not grade
-- our own evidence.

CREATE TABLE "commerce_external_escrow_session" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_session_ref" text,
	"hosted_action_url" text,
	"state" "commerce_escrow_session_state" DEFAULT 'created' NOT NULL,
	"currency" text NOT NULL,
	"total_in_cents" bigint NOT NULL,
	"funded_at" timestamp,
	"released_at" timestamp,
	"refunded_at" timestamp,
	"cancelled_at" timestamp,
	"disputed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_external_escrow_session_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_external_escrow_session_total_ck" CHECK (total_in_cents > 0),
	-- The buyer is sent here to fund. An http:// or relative value would be a redirect
	-- into whatever a compromised provider row said, so the scheme is pinned.
	CONSTRAINT "commerce_external_escrow_session_url_ck" CHECK (
		hosted_action_url IS NULL
		OR (char_length(hosted_action_url) BETWEEN 8 AND 2000 AND hosted_action_url LIKE 'https://%')
	)
);--> statement-breakpoint

CREATE TABLE "commerce_escrow_milestone" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"agreement_milestone_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"milestone_kind" "commerce_escrow_milestone_kind" NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"state" "commerce_escrow_milestone_state" DEFAULT 'planned' NOT NULL,
	"provider_milestone_ref" text,
	"locked_at" timestamp,
	"verification_submitted_at" timestamp,
	"release_requested_at" timestamp,
	"released_at" timestamp,
	"refunded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_escrow_milestone_sequence_ck" CHECK (sequence >= 1),
	CONSTRAINT "commerce_escrow_milestone_amount_ck" CHECK (amount_in_cents > 0),
	CONSTRAINT "commerce_escrow_milestone_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	-- A terminal milestone must carry the instant it became terminal, and it cannot be
	-- both released and refunded: those are two different answers about the same money.
	CONSTRAINT "commerce_escrow_milestone_terminal_ck" CHECK (
		(state <> 'released' OR released_at IS NOT NULL)
		AND (state <> 'refunded' OR refunded_at IS NOT NULL)
		AND (released_at IS NULL OR refunded_at IS NULL)
	)
);--> statement-breakpoint

CREATE TABLE "commerce_escrow_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"milestone_id" text NOT NULL,
	"source_kind" "commerce_escrow_verification_source" NOT NULL,
	"source_id" text NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"provider_accepted" boolean,
	"provider_note" text,
	CONSTRAINT "commerce_escrow_verification_note_ck" CHECK (
		provider_note IS NULL OR char_length(provider_note) BETWEEN 1 AND 2000
	)
);--> statement-breakpoint

ALTER TABLE "commerce_external_escrow_session" ADD CONSTRAINT "commerce_external_escrow_session_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_external_escrow_session" ADD CONSTRAINT "commerce_external_escrow_session_agreement_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."commerce_settlement_agreement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_external_escrow_session" ADD CONSTRAINT "commerce_external_escrow_session_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."commerce_external_provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_escrow_milestone" ADD CONSTRAINT "commerce_escrow_milestone_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."commerce_external_escrow_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_escrow_milestone" ADD CONSTRAINT "commerce_escrow_milestone_agreement_milestone_fk" FOREIGN KEY ("agreement_milestone_id") REFERENCES "public"."commerce_settlement_agreement_milestone"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_escrow_verification" ADD CONSTRAINT "commerce_escrow_verification_milestone_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."commerce_escrow_milestone"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One session per order. A second session would be a second set of funds against one
-- commercial obligation, which is precisely the state a reconciler could never resolve.
CREATE UNIQUE INDEX "commerce_external_escrow_session_order_uidx" ON "commerce_external_escrow_session" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_external_escrow_session_provider_ref_uidx" ON "commerce_external_escrow_session" USING btree ("provider_id","provider_session_ref") WHERE provider_session_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_external_escrow_session_agreement_uidx" ON "commerce_external_escrow_session" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "commerce_external_escrow_session_state_idx" ON "commerce_external_escrow_session" USING btree ("state","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_escrow_milestone_sequence_uidx" ON "commerce_escrow_milestone" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_escrow_milestone_provider_ref_uidx" ON "commerce_escrow_milestone" USING btree ("session_id","provider_milestone_ref") WHERE provider_milestone_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_escrow_milestone_agreement_uidx" ON "commerce_escrow_milestone" USING btree ("agreement_milestone_id");--> statement-breakpoint
CREATE INDEX "commerce_escrow_milestone_state_idx" ON "commerce_escrow_milestone" USING btree ("state","id");--> statement-breakpoint
-- One verification row per (milestone, source), so resubmitting the same shipment event
-- is an upsert rather than a second claim about the same fact.
CREATE UNIQUE INDEX "commerce_escrow_verification_uidx" ON "commerce_escrow_verification" USING btree ("milestone_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX "commerce_escrow_verification_milestone_idx" ON "commerce_escrow_verification" USING btree ("milestone_id","submitted_at");
