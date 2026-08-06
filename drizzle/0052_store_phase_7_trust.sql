-- Store Phase 7 trust MVP — completions, verified reviews, and disputes.
-- Additive follow-up. Audit event kinds were pre-registered in 0051.

CREATE TYPE "public"."commerce_completion_target_kind" AS ENUM(
  'product_order_line',
  'service_engagement'
);--> statement-breakpoint
CREATE TYPE "public"."commerce_review_visibility" AS ENUM('visible', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."commerce_dispute_state" AS ENUM('open', 'closed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."commerce_dispute_event_kind" AS ENUM(
  'opened',
  'note_added',
  'closed',
  'dismissed'
);--> statement-breakpoint

CREATE TABLE "commerce_completion" (
	"id" text PRIMARY KEY NOT NULL,
	"target_kind" "commerce_completion_target_kind" NOT NULL,
	"order_id" text NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"counterparty_organization_id" text NOT NULL,
	"order_product_line_id" text,
	"service_engagement_id" text,
	"product_id" text,
	"completed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_completion_target_ck" CHECK (
	  (target_kind = 'product_order_line'
	    AND order_product_line_id IS NOT NULL
	    AND service_engagement_id IS NULL)
	  OR (target_kind = 'service_engagement'
	    AND service_engagement_id IS NOT NULL
	    AND order_product_line_id IS NULL)
	)
);--> statement-breakpoint
ALTER TABLE "commerce_completion" ADD CONSTRAINT "commerce_completion_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_completion" ADD CONSTRAINT "commerce_completion_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_completion" ADD CONSTRAINT "commerce_completion_counterparty_organization_id_commerce_organization_id_fk" FOREIGN KEY ("counterparty_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_completion" ADD CONSTRAINT "commerce_completion_order_product_line_id_commerce_order_product_line_id_fk" FOREIGN KEY ("order_product_line_id") REFERENCES "public"."commerce_order_product_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_completion" ADD CONSTRAINT "commerce_completion_service_engagement_id_commerce_service_engagement_id_fk" FOREIGN KEY ("service_engagement_id") REFERENCES "public"."commerce_service_engagement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_completion" ADD CONSTRAINT "commerce_completion_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_completion_product_line_uidx" ON "commerce_completion" USING btree ("order_product_line_id") WHERE order_product_line_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_completion_engagement_uidx" ON "commerce_completion" USING btree ("service_engagement_id") WHERE service_engagement_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_completion_buyer_idx" ON "commerce_completion" USING btree ("buyer_organization_id","completed_at");--> statement-breakpoint
CREATE INDEX "commerce_completion_counterparty_idx" ON "commerce_completion" USING btree ("counterparty_organization_id","completed_at");--> statement-breakpoint
CREATE INDEX "commerce_completion_product_idx" ON "commerce_completion" USING btree ("product_id","completed_at") WHERE product_id IS NOT NULL;--> statement-breakpoint

CREATE TABLE "commerce_review" (
	"id" text PRIMARY KEY NOT NULL,
	"completion_id" text NOT NULL,
	"reviewer_organization_id" text NOT NULL,
	"reviewer_member_id" text NOT NULL,
	"subject_organization_id" text NOT NULL,
	"product_id" text,
	"rating" integer NOT NULL,
	"body" text NOT NULL,
	"visibility" "commerce_review_visibility" DEFAULT 'visible' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_review_rating_ck" CHECK (rating BETWEEN 1 AND 5),
	CONSTRAINT "commerce_review_body_ck" CHECK (char_length(body) BETWEEN 1 AND 4000),
	CONSTRAINT "commerce_review_self_ck" CHECK (reviewer_organization_id <> subject_organization_id)
);--> statement-breakpoint
ALTER TABLE "commerce_review" ADD CONSTRAINT "commerce_review_completion_id_commerce_completion_id_fk" FOREIGN KEY ("completion_id") REFERENCES "public"."commerce_completion"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review" ADD CONSTRAINT "commerce_review_reviewer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("reviewer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review" ADD CONSTRAINT "commerce_review_reviewer_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("reviewer_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review" ADD CONSTRAINT "commerce_review_subject_organization_id_commerce_organization_id_fk" FOREIGN KEY ("subject_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review" ADD CONSTRAINT "commerce_review_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_review_completion_reviewer_uidx" ON "commerce_review" USING btree ("completion_id","reviewer_organization_id");--> statement-breakpoint
CREATE INDEX "commerce_review_subject_idx" ON "commerce_review" USING btree ("subject_organization_id","visibility");--> statement-breakpoint
CREATE INDEX "commerce_review_product_idx" ON "commerce_review" USING btree ("product_id","visibility") WHERE product_id IS NOT NULL;--> statement-breakpoint

CREATE TABLE "commerce_dispute" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"opened_by_organization_id" text NOT NULL,
	"opened_by_member_id" text NOT NULL,
	"buyer_organization_id" text NOT NULL,
	"counterparty_organization_id" text NOT NULL,
	"prior_order_state" "commerce_order_state" NOT NULL,
	"state" "commerce_dispute_state" DEFAULT 'open' NOT NULL,
	"reason_code" text NOT NULL,
	"summary" text NOT NULL,
	"order_snapshot_json" text NOT NULL,
	"decided_by_user_id" text,
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	CONSTRAINT "commerce_dispute_reason_ck" CHECK (
	  char_length(reason_code) BETWEEN 1 AND 80
	  AND char_length(summary) BETWEEN 1 AND 4000
	),
	CONSTRAINT "commerce_dispute_snapshot_ck" CHECK (
	  char_length(order_snapshot_json) BETWEEN 2 AND 20000
	  AND order_snapshot_json LIKE '{%'
	),
	CONSTRAINT "commerce_dispute_decision_ck" CHECK (
	  (state = 'open' AND decided_at IS NULL AND decided_by_user_id IS NULL)
	  OR (state IN ('closed', 'dismissed')
	      AND decided_at IS NOT NULL
	      AND decided_by_user_id IS NOT NULL)
	)
);--> statement-breakpoint
ALTER TABLE "commerce_dispute" ADD CONSTRAINT "commerce_dispute_order_id_commerce_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_dispute" ADD CONSTRAINT "commerce_dispute_opened_by_organization_id_commerce_organization_id_fk" FOREIGN KEY ("opened_by_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_dispute" ADD CONSTRAINT "commerce_dispute_opened_by_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("opened_by_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_dispute" ADD CONSTRAINT "commerce_dispute_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_dispute" ADD CONSTRAINT "commerce_dispute_counterparty_organization_id_commerce_organization_id_fk" FOREIGN KEY ("counterparty_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_dispute" ADD CONSTRAINT "commerce_dispute_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_dispute_open_order_uidx" ON "commerce_dispute" USING btree ("order_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "commerce_dispute_buyer_idx" ON "commerce_dispute" USING btree ("buyer_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_dispute_counterparty_idx" ON "commerce_dispute" USING btree ("counterparty_organization_id","state","id");--> statement-breakpoint
CREATE INDEX "commerce_dispute_state_idx" ON "commerce_dispute" USING btree ("state","created_at","id");--> statement-breakpoint

CREATE TABLE "commerce_dispute_event" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_kind" "commerce_dispute_event_kind" NOT NULL,
	"actor_user_id" text,
	"note" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_dispute_event_sequence_ck" CHECK (sequence >= 0),
	CONSTRAINT "commerce_dispute_event_note_ck" CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 4000)
);--> statement-breakpoint
ALTER TABLE "commerce_dispute_event" ADD CONSTRAINT "commerce_dispute_event_dispute_id_commerce_dispute_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."commerce_dispute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_dispute_event" ADD CONSTRAINT "commerce_dispute_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_dispute_event_sequence_uidx" ON "commerce_dispute_event" USING btree ("dispute_id","sequence");--> statement-breakpoint
CREATE INDEX "commerce_dispute_event_timeline_idx" ON "commerce_dispute_event" USING btree ("dispute_id","occurred_at");--> statement-breakpoint

CREATE TRIGGER commerce_dispute_event_append_only
BEFORE UPDATE OR DELETE ON "commerce_dispute_event"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_dispute_event_no_truncate
BEFORE TRUNCATE ON "commerce_dispute_event"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_completion_append_only
BEFORE UPDATE OR DELETE ON "commerce_completion"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint
CREATE TRIGGER commerce_completion_no_truncate
BEFORE TRUNCATE ON "commerce_completion"
FOR EACH STATEMENT EXECUTE FUNCTION commerce_reject_mutation();--> statement-breakpoint

-- Deterministic backfill: fulfilled product lines with quantityFulfilled > 0.
INSERT INTO commerce_completion (
  id,
  target_kind,
  order_id,
  buyer_organization_id,
  counterparty_organization_id,
  order_product_line_id,
  service_engagement_id,
  product_id,
  completed_at
)
SELECT
  'cmpl_pl_' || order_product_line.id,
  'product_order_line'::commerce_completion_target_kind,
  commerce_order.id,
  commerce_order.buyer_organization_id,
  commerce_order.counterparty_organization_id,
  order_product_line.id,
  NULL,
  order_product_line.product_id,
  coalesce(commerce_order.updated_at, commerce_order.created_at)
FROM commerce_order_product_line AS order_product_line
INNER JOIN commerce_order
  ON commerce_order.id = order_product_line.order_id
WHERE order_product_line.quantity_fulfilled > 0
  AND (order_product_line.quantity_fulfilled + order_product_line.quantity_cancelled)
      >= order_product_line.quantity_ordered
  AND commerce_order.buyer_organization_id <> commerce_order.counterparty_organization_id
  AND NOT EXISTS (
    SELECT 1 FROM commerce_completion AS existing
     WHERE existing.order_product_line_id = order_product_line.id
  );--> statement-breakpoint

-- Deterministic backfill: completed service engagements.
INSERT INTO commerce_completion (
  id,
  target_kind,
  order_id,
  buyer_organization_id,
  counterparty_organization_id,
  order_product_line_id,
  service_engagement_id,
  product_id,
  completed_at
)
SELECT
  'cmpl_eng_' || engagement.id,
  'service_engagement'::commerce_completion_target_kind,
  engagement.order_id,
  engagement.buyer_organization_id,
  engagement.provider_organization_id,
  NULL,
  engagement.id,
  NULL,
  coalesce(engagement.completed_at, engagement.updated_at, engagement.created_at)
FROM commerce_service_engagement AS engagement
WHERE engagement.state = 'completed'
  AND engagement.buyer_organization_id <> engagement.provider_organization_id
  AND NOT EXISTS (
    SELECT 1 FROM commerce_completion AS existing
     WHERE existing.service_engagement_id = engagement.id
  );
