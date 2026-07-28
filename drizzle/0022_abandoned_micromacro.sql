-- §7A / §11j.3 — the two events that end a cash compensation proposal.
--
-- `compensation_agreement_status` has four values and `declined` is not one of them, so a
-- member refusing terms and a founder retracting an offer BOTH write `withdrawn` — which is
-- correct, because the column's own comment defines `withdrawn` as "a proposal nobody
-- accepted", and that is exactly what each of them is. What the column cannot record is WHO
-- ended it, and that difference matters: a refusal is the member exercising a choice, a
-- retraction is the founder withdrawing an offer, and §7A.6 has to be able to tell them
-- apart. The audit kind carries it.
--
-- It is also the only durable home for the notes. `member_cash_compensation_agreement` has
-- `rationale_note` — the PROPOSAL's basis — and no column for a decline note or a withdrawal
-- reason. Both survive as `project_audit_entry.detail_note` or not at all.
--
-- ONE MIGRATION, NOT TWO, and that is a real distinction from 0019. Postgres refuses to USE
-- an enum value in the transaction that created it, which is why 0017's new
-- `compensation_earned_as_policy` values needed 0019 to write the CHECK referencing them.
-- Neither value below appears in any CHECK — they are inserted by application code at
-- runtime, long after this transaction commits — so the split does not apply here.

ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_agreement_declined' BEFORE 'compensation_period_opened';--> statement-breakpoint
ALTER TYPE "public"."project_audit_event_kind" ADD VALUE 'compensation_agreement_withdrawn' BEFORE 'compensation_period_opened';
