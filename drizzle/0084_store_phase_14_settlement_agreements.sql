-- Store Phase 14 — negotiated settlement agreements, the milestone plan, and what the
-- unprotected rail records instead of a journal entry.
--
-- THE SHAPE IS `commerce_quote_revision`, DELIBERATELY. An escrow arrangement is a
-- negotiated commercial term, which is the same kind of object a quote revision already is:
-- append-only, one monotonic revision number per venue, immutable the moment it is accepted.
-- A counter-proposal is a NEW ROW and the previous one goes `superseded`. Nothing here is
-- ever edited in place, for the reason §2.2 gives about quotes — an edited term is a term
-- whose history cannot be shown to the party who agreed to something else.
--
-- THE VENUE IS THE THREAD. Buyer and seller discuss escrow where they are already talking,
-- so the agreement hangs off `commerce_thread` rather than off an order that does not exist
-- yet. That also means the proposal is visible in the conversation that produced it, which
-- is why `commerce_message` gains a kind discriminant below rather than having settlement
-- events encoded into body text where no client could parse them and any participant could
-- forge them.
--
-- ## Two rules made structural rather than merely enforced
--
-- `commerce_settlement_agreement_acceptor_ck` binds acceptance in BOTH directions: an
-- accepted row must name an acceptor, a non-accepted row must not, and the acceptor must be
-- the OTHER party. A proposer accepting its own proposal is not a mutual agreement, and this
-- makes it unrepresentable instead of relying on a service check that a second caller could
-- one day bypass. It is the same posture `commerce_product_relation_verified_ck` takes on
-- reviewer attribution.
--
-- `commerce_settlement_agreement_accepted_uidx` allows at most ONE live accepted agreement
-- per party pair per thread. Without it, two concurrent acceptances of two revisions would
-- both bind and checkout confirmation would have to guess which one the buyer meant.

CREATE TABLE "commerce_settlement_agreement" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"seller_organization_id" text NOT NULL,
	"proposed_by_organization_id" text NOT NULL,
	"proposed_by_member_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"supersedes_agreement_id" text,
	"external_provider_id" text NOT NULL,
	"escrow_fee_bearer" "commerce_escrow_fee_bearer" NOT NULL,
	"currency" text NOT NULL,
	"total_in_cents" bigint NOT NULL,
	"state" "commerce_settlement_agreement_state" DEFAULT 'proposed' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"accepted_by_organization_id" text,
	"accepted_by_member_id" text,
	"consumed_by_order_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_settlement_agreement_revision_ck" CHECK (revision_number >= 1),
	CONSTRAINT "commerce_settlement_agreement_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_settlement_agreement_total_ck" CHECK (total_in_cents > 0),
	CONSTRAINT "commerce_settlement_agreement_parties_ck" CHECK (
		buyer_organization_id <> seller_organization_id
		AND proposed_by_organization_id IN (buyer_organization_id, seller_organization_id)
	),
	CONSTRAINT "commerce_settlement_agreement_acceptor_ck" CHECK (
		(state IN ('accepted', 'consumed')
			AND accepted_at IS NOT NULL
			AND accepted_by_organization_id IS NOT NULL
			AND accepted_by_member_id IS NOT NULL
			AND accepted_by_organization_id <> proposed_by_organization_id
			AND accepted_by_organization_id IN (buyer_organization_id, seller_organization_id))
		OR (state NOT IN ('accepted', 'consumed')
			AND accepted_at IS NULL
			AND accepted_by_organization_id IS NULL
			AND accepted_by_member_id IS NULL)
	),
	CONSTRAINT "commerce_settlement_agreement_consumed_ck" CHECK (
		(state = 'consumed') = (consumed_by_order_id IS NOT NULL)
	)
);--> statement-breakpoint

CREATE TABLE "commerce_settlement_agreement_milestone" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"milestone_kind" "commerce_escrow_milestone_kind" NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"release_condition_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_settlement_agreement_milestone_sequence_ck" CHECK (sequence >= 1),
	CONSTRAINT "commerce_settlement_agreement_milestone_amount_ck" CHECK (amount_in_cents > 0),
	CONSTRAINT "commerce_settlement_agreement_milestone_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_settlement_agreement_milestone_note_ck" CHECK (
		release_condition_note IS NULL OR char_length(release_condition_note) BETWEEN 1 AND 2000
	)
);--> statement-breakpoint

-- What each party CLAIMS happened on the `direct_offline` rail.
--
-- Not an observation, and never posted to the journal. Qatoto cannot see a bank wire
-- between two institutions it has no relationship with, and writing a memo entry for money
-- it did not observe would assert a fact from an absence — the same error A16 refused when
-- it returned an empty delivery-estimate array rather than a zero. An attestation is
-- attributed to the organization that made it and is worth exactly what that is worth.
CREATE TABLE "commerce_settlement_attestation" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"attested_by_organization_id" text NOT NULL,
	"attested_by_member_id" text NOT NULL,
	"attestation_kind" "commerce_settlement_attestation_kind" NOT NULL,
	"amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"reference_note" text,
	"occurred_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_settlement_attestation_amount_ck" CHECK (amount_in_cents > 0),
	CONSTRAINT "commerce_settlement_attestation_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "commerce_settlement_attestation_note_ck" CHECK (
		reference_note IS NULL OR char_length(reference_note) BETWEEN 1 AND 500
	)
);--> statement-breakpoint

ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."commerce_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_buyer_org_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_seller_org_fk" FOREIGN KEY ("seller_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_proposer_org_fk" FOREIGN KEY ("proposed_by_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_proposer_member_fk" FOREIGN KEY ("proposed_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_supersedes_fk" FOREIGN KEY ("supersedes_agreement_id") REFERENCES "public"."commerce_settlement_agreement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_provider_fk" FOREIGN KEY ("external_provider_id") REFERENCES "public"."commerce_external_provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_acceptor_org_fk" FOREIGN KEY ("accepted_by_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_acceptor_member_fk" FOREIGN KEY ("accepted_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement" ADD CONSTRAINT "commerce_settlement_agreement_consumed_order_fk" FOREIGN KEY ("consumed_by_order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_agreement_milestone" ADD CONSTRAINT "commerce_settlement_agreement_milestone_agreement_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."commerce_settlement_agreement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_attestation" ADD CONSTRAINT "commerce_settlement_attestation_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_attestation" ADD CONSTRAINT "commerce_settlement_attestation_org_fk" FOREIGN KEY ("attested_by_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_settlement_attestation" ADD CONSTRAINT "commerce_settlement_attestation_member_fk" FOREIGN KEY ("attested_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "commerce_settlement_agreement_revision_uidx" ON "commerce_settlement_agreement" USING btree ("thread_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_settlement_agreement_accepted_uidx" ON "commerce_settlement_agreement" USING btree ("thread_id","buyer_organization_id","seller_organization_id") WHERE state = 'accepted';--> statement-breakpoint
CREATE INDEX "commerce_settlement_agreement_buyer_idx" ON "commerce_settlement_agreement" USING btree ("buyer_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_settlement_agreement_seller_idx" ON "commerce_settlement_agreement" USING btree ("seller_organization_id","state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_settlement_agreement_consumed_uidx" ON "commerce_settlement_agreement" USING btree ("consumed_by_order_id") WHERE consumed_by_order_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_settlement_agreement_milestone_uidx" ON "commerce_settlement_agreement_milestone" USING btree ("agreement_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_settlement_attestation_uidx" ON "commerce_settlement_attestation" USING btree ("order_id","attested_by_organization_id","attestation_kind");--> statement-breakpoint
CREATE INDEX "commerce_settlement_attestation_order_idx" ON "commerce_settlement_attestation" USING btree ("order_id","occurred_at");--> statement-breakpoint

-- The milestone plan must account for the whole order, and a CHECK cannot see sibling rows.
--
-- DEFERRED, because the rows are written one INSERT at a time and the sum is only meaningful
-- once the statement that writes them has finished. Checking eagerly would reject the first
-- milestone of every valid three-milestone plan.
--
-- It fires on the MILESTONE table rather than the agreement so that deleting a milestone is
-- caught too; an agreement whose plan silently shrank below its total would be an escrow
-- session that can never fully release.
CREATE OR REPLACE FUNCTION commerce_settlement_agreement_milestone_sum()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_settlement_agreement_milestone_sum$
DECLARE
	-- Branch on TG_OP rather than coalescing NEW and OLD. In a DELETE trigger NEW is an
	-- unassigned record, and reading a field off it raises rather than yielding NULL.
	target_agreement_id text;
	agreement_total bigint;
	agreement_currency text;
	milestone_total bigint;
	mismatched_currency integer;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target_agreement_id := OLD.agreement_id;
	ELSE
		target_agreement_id := NEW.agreement_id;
	END IF;

	SELECT a.total_in_cents, a.currency
	  INTO agreement_total, agreement_currency
	  FROM commerce_settlement_agreement a
	 WHERE a.id = target_agreement_id;

	-- The agreement went away underneath us; the cascade is deleting both.
	IF agreement_total IS NULL THEN
		RETURN NULL;
	END IF;

	-- NO STATE IS EXEMPT, including `proposed`. Because this trigger is DEFERRED it runs
	-- at COMMIT, by which point the whole plan has been written — so there is no
	-- mid-assembly window to forgive, and forgiving one would let an unbalanced proposal
	-- reach the counterparty and be rejected only at acceptance.
	SELECT coalesce(sum(m.amount_in_cents), 0),
	       count(*) FILTER (WHERE m.currency <> agreement_currency)
	  INTO milestone_total, mismatched_currency
	  FROM commerce_settlement_agreement_milestone m
	 WHERE m.agreement_id = target_agreement_id;

	IF mismatched_currency > 0 THEN
		RAISE EXCEPTION 'commerce_settlement_agreement % has milestones in a currency other than %',
			target_agreement_id, agreement_currency;
	END IF;

	IF milestone_total <> agreement_total THEN
		RAISE EXCEPTION 'commerce_settlement_agreement % milestones sum to % but the agreement total is %',
			target_agreement_id, milestone_total, agreement_total;
	END IF;

	RETURN NULL;
END
$commerce_settlement_agreement_milestone_sum$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER commerce_settlement_agreement_milestone_sum_trg
AFTER INSERT OR UPDATE OR DELETE ON "commerce_settlement_agreement_milestone"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce_settlement_agreement_milestone_sum();--> statement-breakpoint

-- A settlement proposal has to be legible in the conversation that produced it. Encoding
-- it in `body_text` would make it unparseable by any client and forgeable by any
-- participant who can type, so it gets a discriminant and a pointer instead.
--
-- Every pre-Phase-14 row is `participant`, which is exactly what a human typed, so the
-- default is honest for history rather than a backfilled guess.
ALTER TABLE "commerce_message" ADD COLUMN "message_kind" "commerce_message_kind" DEFAULT 'participant' NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_message" ADD COLUMN "settlement_agreement_id" text;--> statement-breakpoint
ALTER TABLE "commerce_message" ADD CONSTRAINT "commerce_message_settlement_agreement_fk" FOREIGN KEY ("settlement_agreement_id") REFERENCES "public"."commerce_settlement_agreement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_message" ADD CONSTRAINT "commerce_message_settlement_ck" CHECK (
	(message_kind = 'participant') = (settlement_agreement_id IS NULL)
);
