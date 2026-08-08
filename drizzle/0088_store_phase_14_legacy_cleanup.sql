-- Store Phase 14d — retire the legacy seller column and the dead pathway item table.
--
-- ## DEPLOY THIS AFTER THE CODE THAT STOPS USING THEM, NOT WITH IT
--
-- `docs/STORE_PHASE_0_ROLLOUT.md:129` requires "a separate release after all callers have
-- stopped using them", and that is a rolling-deploy constraint rather than a formality:
-- `product.seller_id` is NOT NULL, so an old application instance still inserting a product
-- without it fails the moment this file lands. The preceding commit removes every writer and
-- reader; this one removes the columns. Ship them in that order.
--
-- ## Preconditions, checked against the live catalogue before writing this
--
--   17 products, 0 with a null seller_organization_id, created_by_user_id or category_id
--   commerce_product_fill_legacy_transition_keys — already dropped by 0063
--   store_pathway_item — 0 rows
--
-- ## What is NOT dropped here, and why
--
-- `product.category` and the `product_category` enum SURVIVE. They are on the Studio wire as
-- `PublicProduct.category`, and removing the column leaves two options, both of which need a
-- decision this repository cannot make alone: drop the field and break whatever renders it,
-- or keep it and walk the category tree to the root on every product read. The duplication is
-- real and should go, but it goes in a release that can coordinate with the frontend.

-- ---------------------------------------------------------------------------
-- store_pathway_item
-- ---------------------------------------------------------------------------
--
-- Backfilled into `store_pathway_slot` by Phase 9 and retired from every read path then;
-- `STORE_PHASE_9_ROLLOUT.md:82` kept it so a pre-Phase-9 application could still serve
-- pathways during a rollback, and promised "a later migration drops it". This is that
-- migration. Four phases have shipped since, the rollback window is long closed, and the
-- table holds no rows.
DROP TABLE IF EXISTS "store_pathway_item";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- product.seller_id
-- ---------------------------------------------------------------------------
--
-- SKU uniqueness moves from the user to the OWNING ORGANIZATION first, so the catalogue is
-- never briefly unprotected between dropping one index and creating the other.
--
-- Equivalent for every existing row, and deliberately so: Phase 0 created one private
-- organization per legacy seller, so (seller, sku) and (organization, sku) partition today's
-- catalogue identically. The organization scope is the one that is right going forward —
-- two colleagues in a selling organization must not be able to publish the same SKU twice,
-- which the user-scoped index happily allowed.
CREATE UNIQUE INDEX IF NOT EXISTS "product_organization_sku_unq"
  ON "product" USING btree ("seller_organization_id","sku");--> statement-breakpoint

DROP INDEX IF EXISTS "product_seller_sku_unq";--> statement-breakpoint
DROP INDEX IF EXISTS "product_sellerId_idx";--> statement-breakpoint

-- The drizzle model names the surviving index `product_seller_sku_unq`, so the new one is
-- renamed into that name after the old one is gone. Renaming rather than creating it under
-- the final name directly is what keeps the two indexes from colliding mid-migration.
ALTER INDEX "product_organization_sku_unq" RENAME TO "product_seller_sku_unq";--> statement-breakpoint

-- Last: the column, and with it the last FK from `product` straight to a user. Ownership is
-- the organization; `created_by_user_id` remains as attribution, which is what
-- `findUnownedProductIds` now authorizes against.
ALTER TABLE "product" DROP COLUMN IF EXISTS "seller_id";
