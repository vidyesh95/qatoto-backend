-- ---------------------------------------------------------------------------
-- Phase 23 — both incoterm columns become the enum (Appendix A40).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- ORDER MATTERS, AND NOT IN THE OBVIOUS WAY. The CHECK is dropped FIRST, before either column
-- changes type. `commerce_quote_revision_text_ck` calls `char_length(incoterm)`, and Postgres
-- validates every dependent constraint against the NEW type during `ALTER COLUMN ... TYPE` — so
-- altering first fails with `function char_length(commerce_incoterm) does not exist`, which
-- names the symptom and not the cause. Dropping first is the whole fix.
--
-- THE `USING` CLAUSE IS THE ONLY WAY TO CLEAN THE EXISTING ROWS, and that is worth stating
-- because it looks like an ordinary cast. `commerce_prevent_submitted_quote_revision_mutation`
-- (0045) is a ROW trigger on UPDATE and DELETE that refuses any write to a revision with
-- `submitted_at IS NOT NULL` — so `UPDATE commerce_quote_revision SET incoterm = NULL` is
-- impossible for exactly the rows most likely to hold a bad value. DDL does not fire row
-- triggers, so `ALTER COLUMN ... TYPE ... USING` does what no statement could.
--
-- ANYTHING THAT WAS NEVER AN INCOTERM BECOMES NULL rather than failing the migration. That is
-- the honest outcome: a revision carrying `BANANA` did not name a delivery term, and NULL is
-- what "no term stated" has always meant on this column. A bare `::commerce_incoterm` cast
-- would abort the whole migration on the first such row and leave the fix unshippable.
--
-- LOW RISK, VERIFIED BEFORE WRITING: no seed, smoke, test or fixture writes an incoterm
-- anywhere in this repository, and the column was born nullable with no backfill (0045:157), so
-- every row predating that migration is NULL by construction.
-- ---------------------------------------------------------------------------

ALTER TABLE "commerce_quote_revision" DROP CONSTRAINT "commerce_quote_revision_text_ck";
--> statement-breakpoint

ALTER TABLE "commerce_quote_revision"
  ALTER COLUMN "incoterm" TYPE "commerce_incoterm"
  USING (
    CASE
      WHEN "incoterm" IN ('EXW','FCA','CPT','CIP','DAP','DPU','DDP','FAS','FOB','CFR','CIF')
        THEN "incoterm"::"commerce_incoterm"
      ELSE NULL
    END
  );
--> statement-breakpoint

-- The snapshot, which has never had a constraint of any kind. It is written only by
-- `acceptQuote` copying the revision, so post-migration it can only ever hold a value the
-- revision already validated — but the type is what makes that true rather than merely likely.
ALTER TABLE "commerce_order"
  ALTER COLUMN "incoterm_snapshot" TYPE "commerce_incoterm"
  USING (
    CASE
      WHEN "incoterm_snapshot" IN ('EXW','FCA','CPT','CIP','DAP','DPU','DDP','FAS','FOB','CFR','CIF')
        THEN "incoterm_snapshot"::"commerce_incoterm"
      ELSE NULL
    END
  );
--> statement-breakpoint

-- Re-added WITHOUT the incoterm length clause: an enum cannot be 21 characters long, and a
-- constraint that cannot fail reads as a rule somebody still has to satisfy.
ALTER TABLE "commerce_quote_revision" ADD CONSTRAINT "commerce_quote_revision_text_ck"
  CHECK (
    (payment_terms IS NULL OR char_length(payment_terms) <= 2000)
    AND (notes IS NULL OR char_length(notes) <= 10000)
  );
