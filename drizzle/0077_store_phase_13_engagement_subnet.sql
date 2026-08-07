-- Store Phase 13 — a network key on engagement rows, for the subnet concentration guard.
--
-- THE SIGNAL THIS ENABLES IS INERT AT DEPLOY, AND WILL BE FOR SOME TIME. Say it here
-- rather than let someone discover it from a multiplier that is always 1.0.
--
-- `commerce_product_engagement` stores `(product_id, user_id, engagement_kind, created_at)`
-- and nothing else. No IP, no subnet, no device, no session reference. The only raw address
-- anywhere in this database is `session.ip_address` (better-auth), and `rate_limit_bucket`
-- is a swept cache with no `created_at` at all. So the concentration ratio the spec asks
-- for — saves from the top subnet over total saves — has no input today and NO BACKFILL IS
-- POSSIBLE. The addresses behind every existing save were never recorded and are gone.
--
-- What ships is the mechanism. What accumulates is the signal.
--
-- THE RULE THE SCORER MUST HONOUR, and the verifier asserts: rows with no hash are NOT
-- evidence of low concentration. "0 of 40 saves carry a subnet" means UNMEASURED, and the
-- guard is skipped below a minimum hashed sample. Treating a null as 0 concentration would
-- silently clear every product on the platform for months and then start penalising as
-- coverage grew — a guard that appears to work and does not is worse than one that says it
-- is off. This is the null-below-threshold rule Phase 12 applied to on-time delivery,
-- applied to a fraud input.
--
-- A SALTED HASH, NEVER AN ADDRESS. /24 for IPv4 and /56 for IPv6 — the same granularity
-- `ipKeyGenerator` already uses for rate limiting — hashed with the deployment secret. A
-- network block is a weaker identifier than an IP, and the hash means this table cannot be
-- read as a location history even by someone holding it.
--
-- Additive: one nullable column, one check, one partial index. Rollback is DROP COLUMN.

ALTER TABLE "commerce_product_engagement" ADD COLUMN "subnet_hash" text;--> statement-breakpoint

ALTER TABLE "commerce_product_engagement" ADD CONSTRAINT "commerce_product_engagement_subnet_ck" CHECK (subnet_hash IS NULL OR subnet_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- Partial and product-leading: the guard asks "for THIS product, how are its saves
-- distributed across network blocks", once per scored product per hour. Every row written
-- before this migration is null forever, so indexing them buys nothing.
CREATE INDEX "commerce_product_engagement_subnet_idx" ON "commerce_product_engagement" USING btree ("product_id","subnet_hash") WHERE subnet_hash IS NOT NULL;
