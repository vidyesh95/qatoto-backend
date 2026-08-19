-- Better Auth 1.7 makes `account.issuer` a required core field (see the column
-- comment in src/db/schema/_core.ts) — credential sign-in, password change and
-- every OAuth account link/unlink already read or write it on the installed
-- 1.7.0 package. Backfills existing rows, then closes the column.
--
-- HAND-WRITTEN, following the same pattern as every migration since 0055.

ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint

UPDATE "account" SET "issuer" = 'local:credential' WHERE "provider_id" = 'credential' AND "issuer" IS NULL;--> statement-breakpoint
UPDATE "account" SET "issuer" = 'https://accounts.google.com' WHERE "provider_id" = 'google' AND "issuer" IS NULL;--> statement-breakpoint
UPDATE "account" SET "issuer" = 'local:oauth:github' WHERE "provider_id" = 'github' AND "issuer" IS NULL;--> statement-breakpoint
-- Safety net for any provider_id besides the three above — none expected (passkeys
-- and anonymous sessions don't live in this table, and emailOTP sign-up is
-- disabled so it can't create its own account row), but this keeps the NOT NULL
-- below from failing outright if one ever shows up.
UPDATE "account" SET "issuer" = 'local:oauth:' || "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");
