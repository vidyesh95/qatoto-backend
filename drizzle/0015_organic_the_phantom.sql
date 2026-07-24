ALTER TABLE "slice_allocation_proposal" DROP CONSTRAINT "proposal_slices_ck";--> statement-breakpoint
DROP INDEX "slice_ledger_entry_proposalId_unq";--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD COLUMN "proposed_time_slice_numerator" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD COLUMN "proposed_cash_slice_numerator" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "slice_ledger_entry_proposalId_kind_unq" ON "slice_ledger_entry" USING btree ("proposal_id","contribution_kind") WHERE proposal_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "slice_allocation_proposal" ADD CONSTRAINT "proposal_slices_ck" CHECK (proposed_slices >= 0 AND escrowed_slices >= 0 AND proposed_slice_numerator >= 0
          AND proposed_time_slice_numerator >= 0 AND proposed_cash_slice_numerator >= 0
          AND proposed_slice_numerator
              = proposed_time_slice_numerator + proposed_cash_slice_numerator);