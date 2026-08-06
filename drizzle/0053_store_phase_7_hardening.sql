-- Store Phase 7 hardening — bind trust records to their authoritative order,
-- completion target, and counterparty relationships.

ALTER TABLE "commerce_engagement_deliverable_event"
  ADD COLUMN "result_snapshot_json" text;--> statement-breakpoint
ALTER TABLE "commerce_engagement_deliverable_event"
  ADD COLUMN "evidence_document_id" text;--> statement-breakpoint
ALTER TABLE "commerce_engagement_deliverable_event"
  ADD CONSTRAINT "commerce_engagement_deliverable_event_evidence_document_id_fk"
  FOREIGN KEY ("evidence_document_id")
  REFERENCES "public"."commerce_encrypted_document"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_engagement_deliverable_event"
  ADD CONSTRAINT "commerce_engagement_deliverable_event_result_snapshot_ck" CHECK (
    result_snapshot_json IS NULL
    OR (
      char_length(result_snapshot_json) BETWEEN 2 AND 20000
      AND jsonb_typeof(result_snapshot_json::jsonb) = 'object'
    )
  );--> statement-breakpoint

ALTER TABLE "commerce_completion"
  DROP CONSTRAINT "commerce_completion_target_ck";--> statement-breakpoint
ALTER TABLE "commerce_completion"
  ADD CONSTRAINT "commerce_completion_target_ck" CHECK (
    (target_kind = 'product_order_line'
      AND order_product_line_id IS NOT NULL
      AND service_engagement_id IS NULL
      AND product_id IS NOT NULL)
    OR (target_kind = 'service_engagement'
      AND service_engagement_id IS NOT NULL
      AND order_product_line_id IS NULL
      AND product_id IS NULL)
  );--> statement-breakpoint
ALTER TABLE "commerce_completion"
  ADD CONSTRAINT "commerce_completion_counterparty_ck"
  CHECK (buyer_organization_id <> counterparty_organization_id);--> statement-breakpoint

ALTER TABLE "commerce_dispute"
  ADD CONSTRAINT "commerce_dispute_parties_ck" CHECK (
    opened_by_organization_id = buyer_organization_id
    AND buyer_organization_id <> counterparty_organization_id
  );--> statement-breakpoint
ALTER TABLE "commerce_dispute"
  ADD CONSTRAINT "commerce_dispute_prior_state_ck" CHECK (
    prior_order_state IN ('confirmed', 'in_fulfillment', 'partially_completed', 'completed')
  );--> statement-breakpoint
ALTER TABLE "commerce_dispute"
  ADD CONSTRAINT "commerce_dispute_prior_snapshot_ck" CHECK (
    (order_snapshot_json::jsonb->>'state') IS NOT DISTINCT FROM prior_order_state::text
  );--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM commerce_completion AS completion
      INNER JOIN commerce_order
        ON commerce_order.id = completion.order_id
      LEFT JOIN commerce_order_product_line AS product_line
        ON product_line.id = completion.order_product_line_id
      LEFT JOIN commerce_service_engagement AS engagement
        ON engagement.id = completion.service_engagement_id
     WHERE completion.buyer_organization_id <> commerce_order.buyer_organization_id
        OR (
          commerce_order.state NOT IN (
            'confirmed',
            'in_fulfillment',
            'partially_completed',
            'completed'
          )
          AND NOT (
            commerce_order.state = 'disputed'
            AND EXISTS (
              SELECT 1
                FROM commerce_dispute
               WHERE commerce_dispute.order_id = commerce_order.id
                 AND commerce_dispute.state = 'open'
                 AND commerce_dispute.prior_order_state IN (
                   'confirmed',
                   'in_fulfillment',
                   'partially_completed',
                   'completed'
                 )
            )
          )
        )
        OR (
          completion.target_kind = 'product_order_line'
          AND (
            completion.counterparty_organization_id
              <> commerce_order.counterparty_organization_id
            OR product_line.id IS NULL
            OR product_line.order_id <> completion.order_id
            OR product_line.product_id IS DISTINCT FROM completion.product_id
            OR product_line.quantity_fulfilled <= 0
            OR product_line.quantity_fulfilled + product_line.quantity_cancelled
              < product_line.quantity_ordered
          )
        )
        OR (
          completion.target_kind = 'service_engagement'
          AND (
            engagement.id IS NULL
            OR engagement.order_id <> completion.order_id
            OR engagement.buyer_organization_id <> completion.buyer_organization_id
            OR engagement.provider_organization_id
              <> completion.counterparty_organization_id
            OR engagement.state <> 'completed'
            OR engagement.execution_contract_state <> 'ready'
            OR engagement.requires_deliverable_normalization
            OR EXISTS (
              SELECT 1
                FROM commerce_engagement_deliverable AS deliverable
               WHERE deliverable.engagement_id = engagement.id
                 AND deliverable.is_required
                 AND deliverable.state NOT IN ('accepted', 'waived')
            )
          )
        )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Existing completion relationships must be repaired before Phase 7 hardening.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM commerce_review AS review
      INNER JOIN commerce_completion AS completion
        ON completion.id = review.completion_id
      INNER JOIN commerce_organization_member AS reviewer_member
        ON reviewer_member.id = review.reviewer_member_id
     WHERE review.reviewer_organization_id <> completion.buyer_organization_id
        OR review.subject_organization_id <> completion.counterparty_organization_id
        OR review.product_id IS DISTINCT FROM completion.product_id
        OR reviewer_member.organization_id <> review.reviewer_organization_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Existing review relationships must be repaired before Phase 7 hardening.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM commerce_dispute AS dispute
      INNER JOIN commerce_order
        ON commerce_order.id = dispute.order_id
      INNER JOIN commerce_organization_member AS opener_member
        ON opener_member.id = dispute.opened_by_member_id
     WHERE dispute.opened_by_organization_id <> dispute.buyer_organization_id
        OR opener_member.organization_id <> dispute.opened_by_organization_id
        OR dispute.buyer_organization_id <> commerce_order.buyer_organization_id
        OR dispute.counterparty_organization_id
          <> commerce_order.counterparty_organization_id
        OR (dispute.state = 'open' AND commerce_order.state <> 'disputed')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Existing dispute relationships must be repaired before Phase 7 hardening.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM commerce_order
     WHERE state = 'disputed'
       AND NOT EXISTS (
         SELECT 1
           FROM commerce_dispute
          WHERE commerce_dispute.order_id = commerce_order.id
            AND commerce_dispute.state = 'open'
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Orders without open disputes must be unfrozen before Phase 7 hardening.';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_validate_completion_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_buyer_organization_id text;
  authoritative_counterparty_organization_id text;
  authoritative_order_state commerce_order_state;
  authoritative_order_id text;
  authoritative_product_id text;
  authoritative_quantity_ordered integer;
  authoritative_quantity_fulfilled integer;
  authoritative_quantity_cancelled integer;
  authoritative_service_state commerce_service_engagement_state;
  authoritative_execution_contract_state commerce_execution_contract_state;
  authoritative_requires_deliverable_normalization boolean;
BEGIN
  SELECT buyer_organization_id, counterparty_organization_id, state
    INTO authoritative_buyer_organization_id,
         authoritative_counterparty_organization_id,
         authoritative_order_state
    FROM commerce_order
   WHERE id = NEW.order_id;

  IF authoritative_buyer_organization_id IS DISTINCT FROM NEW.buyer_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Completion buyer does not match the authoritative order.';
  END IF;
  IF authoritative_order_state NOT IN (
    'confirmed',
    'in_fulfillment',
    'partially_completed',
    'completed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Completion order has not cleared payment and fulfillment gates.';
  END IF;

  IF NEW.target_kind = 'product_order_line' THEN
    SELECT order_id, product_id, quantity_ordered, quantity_fulfilled, quantity_cancelled
      INTO authoritative_order_id,
           authoritative_product_id,
           authoritative_quantity_ordered,
           authoritative_quantity_fulfilled,
           authoritative_quantity_cancelled
      FROM commerce_order_product_line
     WHERE id = NEW.order_product_line_id;

    IF authoritative_order_id IS DISTINCT FROM NEW.order_id
       OR authoritative_product_id IS DISTINCT FROM NEW.product_id
       OR authoritative_counterparty_organization_id
          IS DISTINCT FROM NEW.counterparty_organization_id
       OR authoritative_quantity_fulfilled <= 0
       OR authoritative_quantity_fulfilled + authoritative_quantity_cancelled
          < authoritative_quantity_ordered THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Product completion does not match its authoritative order line.';
    END IF;
  ELSE
    SELECT order_id,
           buyer_organization_id,
           provider_organization_id,
           state,
           execution_contract_state,
           requires_deliverable_normalization
      INTO authoritative_order_id,
           authoritative_buyer_organization_id,
           authoritative_counterparty_organization_id,
           authoritative_service_state,
           authoritative_execution_contract_state,
           authoritative_requires_deliverable_normalization
      FROM commerce_service_engagement
     WHERE id = NEW.service_engagement_id;

    IF authoritative_order_id IS DISTINCT FROM NEW.order_id
       OR authoritative_buyer_organization_id IS DISTINCT FROM NEW.buyer_organization_id
       OR authoritative_counterparty_organization_id
          IS DISTINCT FROM NEW.counterparty_organization_id
       OR authoritative_service_state IS DISTINCT FROM 'completed'
       OR authoritative_execution_contract_state IS DISTINCT FROM 'ready'
       OR authoritative_requires_deliverable_normalization IS DISTINCT FROM false THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Service completion does not match a completed engagement.';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM commerce_engagement_deliverable AS deliverable
       WHERE deliverable.engagement_id = NEW.service_engagement_id
         AND deliverable.is_required
         AND deliverable.state NOT IN ('accepted', 'waived')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Service completion has incomplete required deliverables.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER commerce_completion_relationship_guard
BEFORE INSERT ON "commerce_completion"
FOR EACH ROW EXECUTE FUNCTION commerce_validate_completion_relationship();--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_validate_review_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_reviewer_organization_id text;
  authoritative_subject_organization_id text;
  authoritative_product_id text;
  reviewer_member_organization_id text;
BEGIN
  SELECT buyer_organization_id, counterparty_organization_id, product_id
    INTO authoritative_reviewer_organization_id,
         authoritative_subject_organization_id,
         authoritative_product_id
    FROM commerce_completion
   WHERE id = NEW.completion_id;
  SELECT organization_id
    INTO reviewer_member_organization_id
    FROM commerce_organization_member
   WHERE id = NEW.reviewer_member_id;

  IF authoritative_reviewer_organization_id IS DISTINCT FROM NEW.reviewer_organization_id
     OR authoritative_subject_organization_id IS DISTINCT FROM NEW.subject_organization_id
     OR authoritative_product_id IS DISTINCT FROM NEW.product_id
     OR reviewer_member_organization_id IS DISTINCT FROM NEW.reviewer_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Review does not match its completion or reviewer membership.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER commerce_review_relationship_guard
BEFORE INSERT OR UPDATE ON "commerce_review"
FOR EACH ROW EXECUTE FUNCTION commerce_validate_review_relationship();--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_validate_dispute_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_buyer_organization_id text;
  authoritative_counterparty_organization_id text;
  authoritative_order_state commerce_order_state;
  opener_member_organization_id text;
BEGIN
  SELECT buyer_organization_id, counterparty_organization_id, state
    INTO authoritative_buyer_organization_id,
         authoritative_counterparty_organization_id,
         authoritative_order_state
    FROM commerce_order
   WHERE id = NEW.order_id;
  SELECT organization_id
    INTO opener_member_organization_id
    FROM commerce_organization_member
   WHERE id = NEW.opened_by_member_id;

  IF authoritative_buyer_organization_id IS DISTINCT FROM NEW.buyer_organization_id
     OR authoritative_counterparty_organization_id
        IS DISTINCT FROM NEW.counterparty_organization_id
     OR opener_member_organization_id IS DISTINCT FROM NEW.opened_by_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Dispute does not match its authoritative order or opener membership.';
  END IF;

  IF TG_OP = 'INSERT'
     AND NEW.prior_order_state IS DISTINCT FROM authoritative_order_state THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Dispute prior state does not match the order state at opening.';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.opened_by_organization_id IS DISTINCT FROM OLD.opened_by_organization_id
       OR NEW.opened_by_member_id IS DISTINCT FROM OLD.opened_by_member_id
       OR NEW.buyer_organization_id IS DISTINCT FROM OLD.buyer_organization_id
       OR NEW.counterparty_organization_id IS DISTINCT FROM OLD.counterparty_organization_id
       OR NEW.prior_order_state IS DISTINCT FROM OLD.prior_order_state
       OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
       OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.order_snapshot_json IS DISTINCT FROM OLD.order_snapshot_json
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Dispute opening identity and snapshot fields are immutable.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER commerce_dispute_relationship_guard
BEFORE INSERT OR UPDATE ON "commerce_dispute"
FOR EACH ROW EXECUTE FUNCTION commerce_validate_dispute_relationship();--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_assert_open_dispute_freeze(target_order_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_order_state commerce_order_state;
  has_open_dispute boolean;
BEGIN
  SELECT state
    INTO target_order_state
    FROM commerce_order
   WHERE id = target_order_id;

  SELECT EXISTS (
    SELECT 1
      FROM commerce_dispute
     WHERE order_id = target_order_id
       AND state = 'open'
  ) INTO has_open_dispute;

  IF has_open_dispute AND target_order_state IS DISTINCT FROM 'disputed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An order with an open dispute must remain frozen in disputed state.';
  END IF;
  IF NOT has_open_dispute AND target_order_state IS NOT DISTINCT FROM 'disputed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An order without an open dispute cannot remain in disputed state.';
  END IF;

  RETURN;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_validate_dispute_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM commerce_assert_open_dispute_freeze(OLD.order_id);
    RETURN OLD;
  END IF;
  PERFORM commerce_assert_open_dispute_freeze(NEW.order_id);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION commerce_validate_order_dispute_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM commerce_assert_open_dispute_freeze(NEW.id);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commerce_dispute_freeze_guard
AFTER INSERT OR UPDATE OR DELETE ON "commerce_dispute"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce_validate_dispute_freeze();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commerce_order_dispute_freeze_guard
AFTER UPDATE OF state ON "commerce_order"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce_validate_order_dispute_freeze();
