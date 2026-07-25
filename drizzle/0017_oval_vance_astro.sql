CREATE TYPE "public"."compensation_agreement_status" AS ENUM('proposed', 'active', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."compensation_payment_method_key" AS ENUM('bank_transfer', 'sepa_transfer', 'upi', 'payroll_provider', 'cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."compensation_period_line_kind" AS ENUM('cash_retainer', 'cash_hourly', 'equity_delta');--> statement-breakpoint
CREATE TYPE "public"."compensation_period_status" AS ENUM('open', 'finalized', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."engagement_kind" AS ENUM('employee', 'independent_contractor', 'unpaid_founder');--> statement-breakpoint
ALTER TYPE "public"."compensation_earned_as_policy" ADD VALUE 'off_platform_payroll';--> statement-breakpoint
ALTER TYPE "public"."compensation_earned_as_policy" ADD VALUE 'direct_transfer';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_agreement_proposed';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_agreement_accepted';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_period_opened';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_period_finalized';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_period_countersigned';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_period_superseded';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_payment_recorded';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_payment_confirmed';--> statement-breakpoint
CREATE TABLE "compensation_payment_record" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"project_id" text NOT NULL,
	"paid_amount_in_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"paid_on_date" date NOT NULL,
	"method_key" "compensation_payment_method_key" NOT NULL,
	"reference_note" text,
	"recorded_by_user_id" text NOT NULL,
	"confirmed_by_member_at" timestamp,
	"confirmed_by_user_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compensation_payment_record_amount_ck" CHECK (paid_amount_in_cents > 0),
	CONSTRAINT "compensation_payment_record_currency_ck" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "compensation_payment_record_confirm_ck" CHECK ((confirmed_by_member_at IS NULL) = (confirmed_by_user_id IS NULL)),
	CONSTRAINT "compensation_payment_record_note_ck" CHECK (reference_note IS NULL OR char_length(reference_note) BETWEEN 1 AND 500),
	CONSTRAINT "compensation_payment_record_idempotency_ck" CHECK (char_length(idempotency_key) BETWEEN 8 AND 200)
);
--> statement-breakpoint
CREATE TABLE "compensation_period" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"period_start_date" date NOT NULL,
	"period_end_date" date NOT NULL,
	"time_zone" text NOT NULL,
	"status" "compensation_period_status" DEFAULT 'open' NOT NULL,
	"last_drafted_at" timestamp,
	"finalized_at" timestamp,
	"finalized_by_user_id" text,
	"countersigned_at" timestamp,
	"countersigned_by_user_id" text,
	"countersign_note" text,
	"statement_hash" text,
	"previous_statement_hash" text,
	"hash_version" text,
	"superseded_by_period_id" text,
	"supersede_reason_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compensation_period_sequence_ck" CHECK (sequence_number >= 1),
	CONSTRAINT "compensation_period_window_ck" CHECK (period_end_date > period_start_date),
	CONSTRAINT "compensation_period_finalize_ck" CHECK ((status = 'finalized' OR status = 'superseded')
            = (statement_hash IS NOT NULL)
          AND (statement_hash IS NULL)
            = (finalized_at IS NULL AND finalized_by_user_id IS NULL
               AND previous_statement_hash IS NULL AND hash_version IS NULL)
          AND (finalized_at IS NULL) = (finalized_by_user_id IS NULL)
          AND (statement_hash IS NULL OR statement_hash ~ '^[0-9a-f]{64}$')
          AND (previous_statement_hash IS NULL
               OR previous_statement_hash = 'genesis'
               OR previous_statement_hash ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "compensation_period_countersign_ck" CHECK ((countersigned_at IS NULL) = (countersigned_by_user_id IS NULL)
          AND (countersigned_at IS NULL OR finalized_at IS NOT NULL)
          AND (countersigned_by_user_id IS NULL
               OR countersigned_by_user_id IS DISTINCT FROM finalized_by_user_id)),
	CONSTRAINT "compensation_period_supersede_ck" CHECK ((status = 'superseded') = (superseded_by_period_id IS NOT NULL)
          AND (superseded_by_period_id IS NULL OR superseded_by_period_id <> id)
          AND (superseded_by_period_id IS NULL) = (supersede_reason_note IS NULL))
);
--> statement-breakpoint
CREATE TABLE "compensation_period_line" (
	"id" text PRIMARY KEY NOT NULL,
	"period_id" text NOT NULL,
	"project_id" text NOT NULL,
	"member_id" text NOT NULL,
	"kind" "compensation_period_line_kind" NOT NULL,
	"gross_amount_in_cents" bigint,
	"currency" text,
	"effort_minutes" integer,
	"source_agreement_id" text,
	"source_rate_id" text,
	"equity_basis_points_at_start" integer,
	"equity_basis_points_at_end" integer,
	"equity_basis_points_delta" integer,
	"start_snapshot_id" text,
	"end_snapshot_id" text,
	"verification_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compensation_period_line_kind_ck" CHECK ((kind = 'equity_delta')
          = (gross_amount_in_cents IS NULL AND equity_basis_points_delta IS NOT NULL)),
	CONSTRAINT "compensation_period_line_amount_ck" CHECK ((gross_amount_in_cents IS NULL OR gross_amount_in_cents >= 0)
          AND (gross_amount_in_cents IS NULL) = (currency IS NULL)
          AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')),
	CONSTRAINT "compensation_period_line_minutes_ck" CHECK ((effort_minutes IS NOT NULL) = (kind = 'cash_hourly')
          AND (effort_minutes IS NULL OR effort_minutes >= 0)),
	CONSTRAINT "compensation_period_line_equity_ck" CHECK ((equity_basis_points_delta IS NULL)
            = (equity_basis_points_at_start IS NULL AND equity_basis_points_at_end IS NULL)
          AND (equity_basis_points_at_start IS NULL
               OR equity_basis_points_at_start BETWEEN 0 AND 10000)
          AND (equity_basis_points_at_end IS NULL
               OR equity_basis_points_at_end BETWEEN 0 AND 10000)
          AND (equity_basis_points_delta IS NULL
               OR equity_basis_points_delta
                  = equity_basis_points_at_end - equity_basis_points_at_start))
);
--> statement-breakpoint
CREATE TABLE "member_cash_compensation_agreement" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"member_id" text NOT NULL,
	"engagement_kind" "engagement_kind" NOT NULL,
	"monthly_amount_in_cents" bigint,
	"hourly_rate_cents_per_hour" bigint,
	"currency_code" text NOT NULL,
	"status" "compensation_agreement_status" DEFAULT 'proposed' NOT NULL,
	"effective_from" timestamp NOT NULL,
	"effective_until" timestamp,
	"rationale_note" text NOT NULL,
	"proposed_by_user_id" text NOT NULL,
	"accepted_at" timestamp,
	"accepted_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "member_cash_comp_agreement_basis_ck" CHECK ((monthly_amount_in_cents IS NOT NULL) <> (hourly_rate_cents_per_hour IS NOT NULL)),
	CONSTRAINT "member_cash_comp_agreement_amount_ck" CHECK ((monthly_amount_in_cents IS NULL OR monthly_amount_in_cents >= 0)
          AND (hourly_rate_cents_per_hour IS NULL OR hourly_rate_cents_per_hour >= 0)),
	CONSTRAINT "member_cash_comp_agreement_currency_ck" CHECK (currency_code ~ '^[A-Z]{3}$'),
	CONSTRAINT "member_cash_comp_agreement_rationale_ck" CHECK (char_length(rationale_note) BETWEEN 1 AND 1000),
	CONSTRAINT "member_cash_comp_agreement_window_ck" CHECK (effective_until IS NULL OR effective_until > effective_from),
	CONSTRAINT "member_cash_comp_agreement_lifecycle_ck" CHECK ((status <> 'proposed' OR accepted_at IS NULL)
          AND (status <> 'withdrawn' OR accepted_at IS NULL)
          AND (status NOT IN ('active','superseded') OR accepted_at IS NOT NULL)
          AND (accepted_at IS NULL) = (accepted_by_user_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE "project_chain_head" DROP CONSTRAINT "project_chain_head_sequence_ck";--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD COLUMN "last_compensation_sequence_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD COLUMN "compensation_head_statement_hash" text;--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD COLUMN "compensation_head_period_id" text;--> statement-breakpoint
ALTER TABLE "compensation_payment_record" ADD CONSTRAINT "compensation_payment_record_line_id_compensation_period_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."compensation_period_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_payment_record" ADD CONSTRAINT "compensation_payment_record_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_payment_record" ADD CONSTRAINT "compensation_payment_record_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_payment_record" ADD CONSTRAINT "compensation_payment_record_confirmed_by_user_id_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period" ADD CONSTRAINT "compensation_period_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period" ADD CONSTRAINT "compensation_period_finalized_by_user_id_user_id_fk" FOREIGN KEY ("finalized_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period" ADD CONSTRAINT "compensation_period_countersigned_by_user_id_user_id_fk" FOREIGN KEY ("countersigned_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period" ADD CONSTRAINT "compensation_period_superseded_by_period_id_compensation_period_id_fk" FOREIGN KEY ("superseded_by_period_id") REFERENCES "public"."compensation_period"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period_line" ADD CONSTRAINT "compensation_period_line_period_id_compensation_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."compensation_period"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period_line" ADD CONSTRAINT "compensation_period_line_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period_line" ADD CONSTRAINT "compensation_period_line_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period_line" ADD CONSTRAINT "compensation_period_line_source_agreement_id_member_cash_compensation_agreement_id_fk" FOREIGN KEY ("source_agreement_id") REFERENCES "public"."member_cash_compensation_agreement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period_line" ADD CONSTRAINT "compensation_period_line_source_rate_id_member_fair_market_rate_id_fk" FOREIGN KEY ("source_rate_id") REFERENCES "public"."member_fair_market_rate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period_line" ADD CONSTRAINT "compensation_period_line_start_snapshot_id_equity_snapshot_id_fk" FOREIGN KEY ("start_snapshot_id") REFERENCES "public"."equity_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_period_line" ADD CONSTRAINT "compensation_period_line_end_snapshot_id_equity_snapshot_id_fk" FOREIGN KEY ("end_snapshot_id") REFERENCES "public"."equity_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_cash_compensation_agreement" ADD CONSTRAINT "member_cash_compensation_agreement_project_id_research_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_cash_compensation_agreement" ADD CONSTRAINT "member_cash_compensation_agreement_member_id_project_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."project_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_cash_compensation_agreement" ADD CONSTRAINT "member_cash_compensation_agreement_proposed_by_user_id_user_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_cash_compensation_agreement" ADD CONSTRAINT "member_cash_compensation_agreement_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_payment_record_line_idempotency_unq" ON "compensation_payment_record" USING btree ("line_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "compensation_payment_record_lineId_idx" ON "compensation_payment_record" USING btree ("line_id","id");--> statement-breakpoint
CREATE INDEX "compensation_payment_record_projectId_idx" ON "compensation_payment_record" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_period_projectId_sequence_unq" ON "compensation_period" USING btree ("project_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_period_projectId_open_unq" ON "compensation_period" USING btree ("project_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "compensation_period_projectId_start_idx" ON "compensation_period" USING btree ("project_id","period_start_date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_period_line_period_member_kind_unq" ON "compensation_period_line" USING btree ("period_id","member_id","kind");--> statement-breakpoint
CREATE INDEX "compensation_period_line_memberId_idx" ON "compensation_period_line" USING btree ("member_id","id");--> statement-breakpoint
CREATE INDEX "compensation_period_line_projectId_idx" ON "compensation_period_line" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "member_cash_comp_agreement_memberId_effectiveFrom_idx" ON "member_cash_compensation_agreement" USING btree ("member_id","effective_from","id");--> statement-breakpoint
CREATE INDEX "member_cash_comp_agreement_projectId_idx" ON "member_cash_compensation_agreement" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_cash_comp_agreement_memberId_effectiveFrom_unq" ON "member_cash_compensation_agreement" USING btree ("member_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "member_cash_comp_agreement_active_unq" ON "member_cash_compensation_agreement" USING btree ("member_id") WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD CONSTRAINT "project_chain_head_compensation_hash_ck" CHECK ((compensation_head_statement_hash IS NULL
           OR compensation_head_statement_hash ~ '^[0-9a-f]{64}$')
          AND (compensation_head_statement_hash IS NULL) = (compensation_head_period_id IS NULL));--> statement-breakpoint
ALTER TABLE "project_chain_head" ADD CONSTRAINT "project_chain_head_sequence_ck" CHECK (last_audit_sequence_number >= 0 AND last_ledger_sequence_number >= 0
          AND last_escrow_sequence_number >= 0
          AND last_compensation_sequence_number >= 0);

-- ===========================================================================
-- HAND-ADDED, BELOW THIS LINE. drizzle-kit diffs only what it declared, so
-- everything here survives every later `db:generate` — the same arrangement
-- 0008 uses for citext, 0010 for the first append-only triggers, 0014 for the
-- §9 ledger and 0016 for the escrow journal.
-- R_AND_D_BACKEND_STRUCTURE.md §7A, §4f, §17 step 1.
--
-- WHY TRIGGERS AND NOT SERVICE DISCIPLINE. §7A's whole claim is that a
-- finalized statement is EVIDENCE — the artifact a labour inspector, an
-- acquirer's diligence team or an aggrieved ex-employee relies on. A record
-- that anyone with a psql prompt can quietly rewrite is not evidence of
-- anything. A rule only the application respects is not the rule.
--
-- qatoto_reject_mutation() already exists from 0010 and is CREATE OR REPLACE
-- there; the blanket tables below simply attach to it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE CASH AGREEMENT: ACCEPTED MEANS FROZEN (§7A.2).
--
-- Not blanket append-only: the row has a real lifecycle (proposed -> active ->
-- superseded) and each step legitimately writes a column. What must be
-- impossible is a NUMBER changing after someone agreed to it. Without this a
-- founder could accept-then-edit, and the member would be bound to an amount
-- they never saw — the founder-tweaks-the-spreadsheet failure mode
-- PROOF_OF_EFFORT_SPEC.md §2 exists to prevent.
--
-- This is 0014's qatoto_fair_market_rate_lock_only with the columns swapped,
-- deliberately: two shapes for the same rule is how the two drift apart.
-- ---------------------------------------------------------------------------
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
      USING ERRCODE = 'QT001';
  END IF;
  -- Acceptance happens once and is never revoked. A cleared acceptance would
  -- un-price a period that has already been finalized against it.
  IF OLD.accepted_at IS NOT NULL
     AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
          OR NEW.accepted_by_user_id IS DISTINCT FROM OLD.accepted_by_user_id) THEN
    RAISE EXCEPTION 'member_cash_compensation_agreement %: acceptance is recorded once and never rewritten', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  -- Identity never moves, in any state. Re-pointing an agreement at another
  -- member would rewrite what two people are owed in one UPDATE.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.proposed_by_user_id IS DISTINCT FROM OLD.proposed_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'member_cash_compensation_agreement %: identity columns are immutable', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS member_cash_compensation_agreement_accept_only ON "member_cash_compensation_agreement";
--> statement-breakpoint
CREATE TRIGGER member_cash_compensation_agreement_accept_only
BEFORE UPDATE ON "member_cash_compensation_agreement"
FOR EACH ROW EXECUTE FUNCTION qatoto_cash_agreement_accept_only();
--> statement-breakpoint
-- A finalized line pins source_agreement_id. The FK is `restrict` already; this
-- closes the case where no line references it yet.
DROP TRIGGER IF EXISTS member_cash_compensation_agreement_no_delete ON "member_cash_compensation_agreement";
--> statement-breakpoint
CREATE TRIGGER member_cash_compensation_agreement_no_delete
BEFORE DELETE ON "member_cash_compensation_agreement"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
-- A BEFORE UPDATE OR DELETE *row* trigger does NOT fire on TRUNCATE.
DROP TRIGGER IF EXISTS member_cash_compensation_agreement_no_truncate ON "member_cash_compensation_agreement";
--> statement-breakpoint
CREATE TRIGGER member_cash_compensation_agreement_no_truncate
BEFORE TRUNCATE ON "member_cash_compensation_agreement"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. A FINALIZED PERIOD IS FROZEN (§7A.3, §7A.5).
--
-- An OPEN period is redrawn nightly and must stay writable — that is the whole
-- point of the draft. A FINALIZED period accepts exactly three later writes:
-- the countersignature (two of them) and the supersede pointer (two of them).
-- Everything else, including the hash itself, is sealed.
--
-- CORRECTIONS SUPERSEDE; THEY NEVER EDIT. A new period is created pointing back
-- at this one, and both are in the audit chain.
-- ---------------------------------------------------------------------------
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
      USING ERRCODE = 'QT001';
  END IF;
  -- The countersignature is the second pair of eyes and is recorded once. A
  -- clearable countersignature is not two-person control.
  IF OLD.countersigned_at IS NOT NULL
     AND (NEW.countersigned_at IS DISTINCT FROM OLD.countersigned_at
          OR NEW.countersigned_by_user_id IS DISTINCT FROM OLD.countersigned_by_user_id) THEN
    RAISE EXCEPTION 'compensation_period %: the countersignature is recorded once and never rewritten', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  -- A superseded period stays superseded, pointing at the same successor.
  IF OLD.superseded_by_period_id IS NOT NULL
     AND NEW.superseded_by_period_id IS DISTINCT FROM OLD.superseded_by_period_id THEN
    RAISE EXCEPTION 'compensation_period %: the supersede pointer is written once', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  -- Finalization is terminal in one direction only. An open period may become
  -- finalized; a finalized one may only become superseded.
  IF OLD.status = 'finalized' AND NEW.status NOT IN ('finalized', 'superseded') THEN
    RAISE EXCEPTION 'compensation_period %: a finalized period cannot be reopened', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'compensation_period %: a superseded period is terminal', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'compensation_period %: identity columns are immutable', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS compensation_period_freeze ON "compensation_period";
--> statement-breakpoint
CREATE TRIGGER compensation_period_freeze
BEFORE UPDATE ON "compensation_period"
FOR EACH ROW EXECUTE FUNCTION qatoto_compensation_period_freeze();
--> statement-breakpoint
DROP TRIGGER IF EXISTS compensation_period_no_delete ON "compensation_period";
--> statement-breakpoint
CREATE TRIGGER compensation_period_no_delete
BEFORE DELETE ON "compensation_period"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS compensation_period_no_truncate ON "compensation_period";
--> statement-breakpoint
CREATE TRIGGER compensation_period_no_truncate
BEFORE TRUNCATE ON "compensation_period"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. A LINE OF A FINALIZED PERIOD IS FROZEN (§7A.3).
--
-- The rule lives on the PARENT's status, so the lookup is deliberate: this is
-- the one guard that cannot be expressed as a CHECK, because a CHECK cannot see
-- another table. An open period's lines stay fully writable — the nightly
-- redraw upserts them, and re-running it must produce byte-identical rows
-- rather than an error.
--
-- Lines are DELETE-able while the period is open, and only then: a member who
-- leaves mid-month and accrues nothing must be able to drop out of the draft
-- rather than sit in it as a zero.
-- ---------------------------------------------------------------------------
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
      USING ERRCODE = 'QT001';
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
      USING ERRCODE = 'QT001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS compensation_period_line_freeze ON "compensation_period_line";
--> statement-breakpoint
CREATE TRIGGER compensation_period_line_freeze
BEFORE UPDATE OR DELETE ON "compensation_period_line"
FOR EACH ROW EXECUTE FUNCTION qatoto_compensation_line_freeze();
--> statement-breakpoint
DROP TRIGGER IF EXISTS compensation_period_line_no_truncate ON "compensation_period_line";
--> statement-breakpoint
CREATE TRIGGER compensation_period_line_no_truncate
BEFORE TRUNCATE ON "compensation_period_line"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. A PAYMENT RECORD IS AN ATTESTATION, AND ATTESTATIONS ARE NOT EDITED.
--
-- Exactly one later write is permitted: the member's confirmation, set once and
-- never cleared. A founder who could revise "I paid you $6,000 on the 3rd"
-- after the member confirmed it would be rewriting the receipt, which is the
-- one thing this table exists to make impossible.
-- ---------------------------------------------------------------------------
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
      USING ERRCODE = 'QT001';
  END IF;
  IF OLD.confirmed_by_member_at IS NOT NULL
     AND (NEW.confirmed_by_member_at IS DISTINCT FROM OLD.confirmed_by_member_at
          OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id) THEN
    RAISE EXCEPTION 'compensation_payment_record %: confirmation is recorded once and never cleared', OLD.id
      USING ERRCODE = 'QT001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS compensation_payment_record_confirm_only ON "compensation_payment_record";
--> statement-breakpoint
CREATE TRIGGER compensation_payment_record_confirm_only
BEFORE UPDATE ON "compensation_payment_record"
FOR EACH ROW EXECUTE FUNCTION qatoto_payment_record_confirm_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS compensation_payment_record_no_delete ON "compensation_payment_record";
--> statement-breakpoint
CREATE TRIGGER compensation_payment_record_no_delete
BEFORE DELETE ON "compensation_payment_record"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS compensation_payment_record_no_truncate ON "compensation_payment_record";
--> statement-breakpoint
CREATE TRIGGER compensation_payment_record_no_truncate
BEFORE TRUNCATE ON "compensation_payment_record"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();
