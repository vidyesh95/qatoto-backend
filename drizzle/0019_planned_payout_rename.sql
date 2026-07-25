-- §7A catch-up, part 1 of 2 (R_AND_D_BACKEND_STRUCTURE.md §11g's closing paragraph).
--
-- HAND-WRITTEN. drizzle-kit cannot tell a rename from a drop-plus-create without an
-- interactive prompt, and answering that prompt wrong here would DELETE every founder's
-- declared milestone payout and silently replace it with a column of zeros. The snapshot
-- in drizzle/meta/0019_snapshot.json is patched to match, so the next `db:generate`
-- diffs from the correct baseline.
--
-- 1. `escrow_release_amount_in_cents` → `planned_payout_in_cents`.
--
-- The rename IS the change, not tidying. The old name said the column instructed an
-- escrow release; escrow has left this domain on legal grounds (§7A.6), nothing reads
-- this column to move money any more, and it now feeds §7A's statement as a
-- `direct_transfer` line — a plan the founder pays from their own bank and records here.
--
-- 2. The two escrow `earned_as_policy` values become UNWRITABLE.
--
-- They stay in the pgEnum so migration 0010's existing rows remain readable — dropping an
-- enum value would make historical rows unparseable — but they appear in neither branch
-- of the pairing CHECK, so no new row can carry one. They forced every cash strand
-- through an escrow release, which meant a founder who never ran a funding round here had
-- no way to record that they pay someone from their own bank account, and worse, made a
-- wage conditional on a Proof-of-Effort verdict: unlawful withholding under the FLSA,
-- national EU wage law and §18 of India's Code on Wages 2019 (§0, §7A.6 item 2).
--
-- The Zod schema refuses them first, with a typed 422. This is the database half, and
-- both halves are required: a rule with no database behind it is a convention.
--
-- SEPARATE FROM 0017 BECAUSE POSTGRES REQUIRES IT. `off_platform_payroll` and
-- `direct_transfer` were added by `ALTER TYPE … ADD VALUE` in 0017, and Postgres refuses
-- to USE an enum value in the same transaction that created it. A CHECK referencing them
-- had to wait for a later migration; that is not a style choice.

ALTER TABLE "milestone" RENAME COLUMN "escrow_release_amount_in_cents" TO "planned_payout_in_cents";--> statement-breakpoint
ALTER TABLE "milestone" DROP CONSTRAINT "milestone_amount_ck";--> statement-breakpoint
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_planned_payout_ck" CHECK (planned_payout_in_cents >= 0);--> statement-breakpoint
ALTER TABLE "open_role_compensation" DROP CONSTRAINT "open_role_compensation_policy_pairing_ck";--> statement-breakpoint
ALTER TABLE "open_role_compensation" ADD CONSTRAINT "open_role_compensation_policy_pairing_ck" CHECK (
      (kind = 'equity' AND earned_as_policy = 'slicing_pie_vesting')
      OR (kind IN ('salary','one_time')
          AND earned_as_policy IN ('off_platform_payroll','direct_transfer'))) NOT VALID;--> statement-breakpoint

-- `NOT VALID` above, deliberately, and this is the one decision in this file worth
-- arguing about.
--
-- Existing `open_role_compensation` rows may legitimately carry a retired escrow policy —
-- they were written when it was the only option, and they are the advertised offers on
-- roles people already applied to. A validating constraint would refuse to be added at
-- all, and the only ways forward would be to rewrite historical offers or to drop the
-- rule. `NOT VALID` enforces the constraint on every INSERT and UPDATE from now on while
-- leaving the existing rows alone, which is exactly "readable, never writable".
--
-- It is NOT later VALIDATEd, and that is intentional rather than an unfinished step:
-- validating it would fail for as long as one historical row survives, and those rows are
-- the record of what a founder advertised at the time.
