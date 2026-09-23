/*
 * Every trigger guard raises P0001 from here on, instead of the invented codes QT001/QT002.
 *
 * WHY: a SQLSTATE this server does not recognise never reaches the client. Measured against
 * PostgreSQL 17.11 by raising each code from a DO block and reading what the driver got back:
 *
 *     QT001 -> XX000     ZZ999 -> XX000     12345 -> XX000
 *     P0001 -> P0001     22012 -> 22012     XX001 -> XX001
 *
 * So `USING ERRCODE = 'QT001'` has been arriving as XX000 (internal_error) since migration
 * 0010 — indistinguishable from a genuine backend fault. Two consequences, both real:
 * `db:verify-escrow-constraints` reported 7 false failures, and
 * anonymize-account.service.ts could not recognise an append-only refusal as permanent, so
 * it retried a write that can never succeed instead of failing the request.
 *
 * P0001 is plpgsql's own raise_exception. It survives the wire, and every migration after
 * 0017 already uses it. The distinguishing detail stays where a human reads it: the message,
 * which names the table and the operation.
 *
 * ONLY THE ERRCODE CHANGES. Each body below is copied verbatim from the migration that
 * defined it, and the bodies were diffed against pg_get_functiondef first, so this replaces
 * no drift. The triggers are deliberately untouched: CREATE OR REPLACE keeps the function
 * OID, so all 49 bindings across 25 tables survive.
 */

-- qatoto_reject_mutation (defined in 0010)
CREATE OR REPLACE FUNCTION qatoto_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'append-only table %.% rejects % (R_AND_D_BACKEND_STRUCTURE.md 4f)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
-- qatoto_member_interval_seal_only (defined in 0010)
CREATE OR REPLACE FUNCTION qatoto_member_interval_seal_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.left_at IS NOT NULL THEN
    RAISE EXCEPTION 'project_member_interval %: already sealed, intervals are immutable once closed', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.left_at IS NULL THEN
    RAISE EXCEPTION 'project_member_interval %: the only permitted UPDATE is sealing (left_at must be set)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'project_member_interval %: only left_at, ended_reason and ended_by_user_id may be written', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_fair_market_rate_lock_only (defined in 0014)
CREATE OR REPLACE FUNCTION qatoto_fair_market_rate_lock_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'member_fair_market_rate %: locked rates are immutable (R_AND_D_BACKEND_STRUCTURE.md 9.6)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  -- Once a member has ACCEPTED, the numbers they accepted are frozen. Without
  -- this a founder could accept-then-edit before locking, and the member would
  -- be bound to a rate they never saw.
  IF OLD.status <> 'proposed'
     AND (NEW.fair_market_rate_cents_per_hour IS DISTINCT FROM OLD.fair_market_rate_cents_per_hour
          OR NEW.paid_cash_rate_cents_per_hour IS DISTINCT FROM OLD.paid_cash_rate_cents_per_hour
          OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
          OR NEW.effective_from IS DISTINCT FROM OLD.effective_from) THEN
    RAISE EXCEPTION 'member_fair_market_rate %: the accepted rate, currency and effective date are frozen', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  -- Identity never moves, in any state. Re-pointing a rate at another member
  -- would re-price their whole history in one UPDATE.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'member_fair_market_rate %: identity columns are immutable', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_artifact_evidence_purge_only (defined in 0014)
CREATE OR REPLACE FUNCTION qatoto_artifact_evidence_purge_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.artifact_occurred_at IS DISTINCT FROM OLD.artifact_occurred_at
     OR NEW.signature_status IS DISTINCT FROM OLD.signature_status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'artifact_evidence %: identity and proof columns are immutable; revocation may only NULL raw_payload_json', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  -- Purging is one-way. Re-populating a payload after a revocation would restore
  -- data the member asked us to destroy.
  IF OLD.evidence_retained = false AND NEW.raw_payload_json IS NOT NULL THEN
    RAISE EXCEPTION 'artifact_evidence %: purged evidence cannot be repopulated', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_provider_webhook_event_process_only (defined in 0016)
CREATE OR REPLACE FUNCTION qatoto_provider_webhook_event_process_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
     OR NEW.provider_transfer_id IS DISTINCT FROM OLD.provider_transfer_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'provider_webhook_event %: identity and payload are immutable; only processing state may move', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_escrow_entry_balances (defined in 0016)
CREATE OR REPLACE FUNCTION qatoto_escrow_entry_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  posting_total bigint;
  posting_count integer;
BEGIN
  SELECT COALESCE(SUM(signed_amount_in_cents), 0), COUNT(*)
    INTO posting_total, posting_count
    FROM "escrow_posting"
   WHERE journal_entry_id = NEW.journal_entry_id;

  -- Double entry means TWO postings minimum. One posting summing to zero is
  -- impossible (a zero amount is already rejected by escrow_posting_amount_ck),
  -- but an entry with a single row could still arrive if that check were ever
  -- relaxed, and "money moved from nowhere to nowhere" must not be spellable.
  IF posting_count < 2 THEN
    RAISE EXCEPTION 'escrow journal entry %: double entry needs at least 2 postings, found %',
      NEW.journal_entry_id, posting_count
      USING ERRCODE = 'P0001';
  END IF;

  IF posting_total <> 0 THEN
    RAISE EXCEPTION 'escrow journal entry %: postings sum to % cents, not zero (R_AND_D_BACKEND_STRUCTURE.md 7)',
      NEW.journal_entry_id, posting_total
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- qatoto_escrow_release_decide_only (defined in 0016)
CREATE OR REPLACE FUNCTION qatoto_escrow_release_decide_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A decided release is finished. Nothing about it moves again, ever.
  IF OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'escrow_release %: a % release is immutable (R_AND_D_BACKEND_STRUCTURE.md 7)', OLD.id, OLD.status
      USING ERRCODE = 'P0001';
  END IF;

  -- THE SNAPSHOT. Frozen from the instant of the request, in every state.
  IF NEW.amount_in_cents IS DISTINCT FROM OLD.amount_in_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.milestone_id IS DISTINCT FROM OLD.milestone_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'escrow_release %: the snapshotted amount, milestone and requester are immutable', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_provider_transfer_identity_frozen (defined in 0016)
CREATE OR REPLACE FUNCTION qatoto_provider_transfer_identity_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.amount_in_cents IS DISTINCT FROM OLD.amount_in_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'provider_transfer %: idempotency key, amount, currency, direction and project are immutable', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- Settlement and failure are TERMINAL. §7: "Never trust the webhook payload's
  -- amount over our own provider_transfer row" — and never let a settled
  -- transfer be re-settled into a second balance movement either.
  IF OLD.status IN ('settled', 'failed', 'cancelled')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'provider_transfer %: % is terminal', OLD.id, OLD.status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_cash_agreement_accept_only (defined in 0017)
CREATE OR REPLACE FUNCTION qatoto_cash_agreement_accept_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Once a member has ACCEPTED, the numbers they accepted are frozen. `status`
  -- and `effective_until` stay writable: superseding an agreement with a later
  -- one has to be able to close the open interval.
  IF OLD.status <> 'proposed'
     AND (NEW.monthly_amount_in_cents IS DISTINCT FROM OLD.monthly_amount_in_cents
          OR NEW.hourly_rate_cents_per_hour IS DISTINCT FROM OLD.hourly_rate_cents_per_hour
          OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
          OR NEW.engagement_kind IS DISTINCT FROM OLD.engagement_kind
          OR NEW.effective_from IS DISTINCT FROM OLD.effective_from) THEN
    RAISE EXCEPTION 'member_cash_compensation_agreement %: the accepted amount, currency, engagement kind and effective date are frozen (R_AND_D_BACKEND_STRUCTURE.md 7A.2)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  -- Acceptance happens once and is never revoked. A cleared acceptance would
  -- un-price a period that has already been finalized against it.
  IF OLD.accepted_at IS NOT NULL
     AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
          OR NEW.accepted_by_user_id IS DISTINCT FROM OLD.accepted_by_user_id) THEN
    RAISE EXCEPTION 'member_cash_compensation_agreement %: acceptance is recorded once and never rewritten', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  -- Identity never moves, in any state. Re-pointing an agreement at another
  -- member would rewrite what two people are owed in one UPDATE.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.proposed_by_user_id IS DISTINCT FROM OLD.proposed_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'member_cash_compensation_agreement %: identity columns are immutable', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_compensation_period_freeze (defined in 0017)
CREATE OR REPLACE FUNCTION qatoto_compensation_period_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('finalized', 'superseded')
     AND (NEW.project_id IS DISTINCT FROM OLD.project_id
          OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
          OR NEW.period_start_date IS DISTINCT FROM OLD.period_start_date
          OR NEW.period_end_date IS DISTINCT FROM OLD.period_end_date
          OR NEW.time_zone IS DISTINCT FROM OLD.time_zone
          OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
          OR NEW.finalized_by_user_id IS DISTINCT FROM OLD.finalized_by_user_id
          OR NEW.statement_hash IS DISTINCT FROM OLD.statement_hash
          OR NEW.previous_statement_hash IS DISTINCT FROM OLD.previous_statement_hash
          OR NEW.hash_version IS DISTINCT FROM OLD.hash_version
          OR NEW.last_drafted_at IS DISTINCT FROM OLD.last_drafted_at) THEN
    RAISE EXCEPTION 'compensation_period %: a finalized statement is frozen — correct it by superseding, never by editing (R_AND_D_BACKEND_STRUCTURE.md 7A.5)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  -- The countersignature is the second pair of eyes and is recorded once. A
  -- clearable countersignature is not two-person control.
  IF OLD.countersigned_at IS NOT NULL
     AND (NEW.countersigned_at IS DISTINCT FROM OLD.countersigned_at
          OR NEW.countersigned_by_user_id IS DISTINCT FROM OLD.countersigned_by_user_id) THEN
    RAISE EXCEPTION 'compensation_period %: the countersignature is recorded once and never rewritten', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  -- A superseded period stays superseded, pointing at the same successor.
  IF OLD.superseded_by_period_id IS NOT NULL
     AND NEW.superseded_by_period_id IS DISTINCT FROM OLD.superseded_by_period_id THEN
    RAISE EXCEPTION 'compensation_period %: the supersede pointer is written once', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  -- Finalization is terminal in one direction only. An open period may become
  -- finalized; a finalized one may only become superseded.
  IF OLD.status = 'finalized' AND NEW.status NOT IN ('finalized', 'superseded') THEN
    RAISE EXCEPTION 'compensation_period %: a finalized period cannot be reopened', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'compensation_period %: a superseded period is terminal', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'compensation_period %: identity columns are immutable', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_compensation_line_freeze (defined in 0017)
CREATE OR REPLACE FUNCTION qatoto_compensation_line_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  parent_id text;
BEGIN
  parent_id := COALESCE(NEW.period_id, OLD.period_id);
  SELECT status INTO parent_status FROM "compensation_period" WHERE id = parent_id;

  IF parent_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'compensation_period_line %: the parent period is % — a finalized statement line is frozen (R_AND_D_BACKEND_STRUCTURE.md 7A.5)',
      COALESCE(NEW.id, OLD.id), COALESCE(parent_status, 'missing')
      USING ERRCODE = 'P0001';
  END IF;

  -- Even while open, a line never changes which period, project or member it
  -- belongs to. Re-pointing one is how a redraw silently pays the wrong person.
  IF TG_OP = 'UPDATE'
     AND (NEW.id IS DISTINCT FROM OLD.id
          OR NEW.period_id IS DISTINCT FROM OLD.period_id
          OR NEW.project_id IS DISTINCT FROM OLD.project_id
          OR NEW.member_id IS DISTINCT FROM OLD.member_id
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'compensation_period_line %: identity columns are immutable', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- qatoto_payment_record_confirm_only (defined in 0017)
CREATE OR REPLACE FUNCTION qatoto_payment_record_confirm_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.paid_amount_in_cents IS DISTINCT FROM OLD.paid_amount_in_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.paid_on_date IS DISTINCT FROM OLD.paid_on_date
     OR NEW.method_key IS DISTINCT FROM OLD.method_key
     OR NEW.reference_note IS DISTINCT FROM OLD.reference_note
     OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'compensation_payment_record %: only the member confirmation may be written after the fact (R_AND_D_BACKEND_STRUCTURE.md 7A)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.confirmed_by_member_at IS NOT NULL
     AND (NEW.confirmed_by_member_at IS DISTINCT FROM OLD.confirmed_by_member_at
          OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id) THEN
    RAISE EXCEPTION 'compensation_payment_record %: confirmation is recorded once and never cleared', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
