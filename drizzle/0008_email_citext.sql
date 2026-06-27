-- Make email comparisons case-insensitive so one address = one user, regardless
-- of the case a provider reports it in. Before this, `user.email` was case-
-- sensitive `text`: Google ("User@x.com") and GitHub ("user@x.com") could each
-- create a separate user, both passing the UNIQUE constraint. citext fixes both
-- the UNIQUE constraint and Better Auth's `email = ?` linking lookup at once.
--
-- ORDER MATTERS: this migration will FAIL if two existing rows now collide under
-- case-insensitive comparison (e.g. the duplicate Google/GitHub accounts). Run
-- `pnpm db:merge-duplicate-user` to merge those FIRST, then apply this migration.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "email" SET DATA TYPE citext USING "email"::citext;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "email" SET DATA TYPE citext USING "email"::citext;
