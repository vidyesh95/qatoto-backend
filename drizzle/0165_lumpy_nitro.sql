-- Reverts 0125_add_account_issuer.sql. Better Auth 1.7.0 through 1.7.2 made
-- `account.issuer` a required core field keyed with account_id; 1.7.3 reverted to the
-- 1.6 account model, recognizes an account by (provider_id, account_id), and never
-- writes issuer again. That left a NOT NULL column nothing populates, which its startup
-- schema validation rejects outright — every request 500s and no account row can be
-- inserted. See https://better-auth.com/docs/guides/1-7-upgrade-guide
--
-- The unique index moves onto the key Better Auth actually looks accounts up by, so the
-- "more than one row matches" case it refuses to resolve cannot be written in the first
-- place. Verified zero duplicate (provider_id, account_id) pairs across 73 account rows
-- before generating this. The dropped issuer values were synthetic labels 0125 invented
-- ('local:credential', 'local:oauth:github'), never provider-reported data.

DROP INDEX "account_issuer_accountId_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "issuer";
