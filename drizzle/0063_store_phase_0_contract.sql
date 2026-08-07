-- Store Phase 0 — the CONTRACT migration.
--
-- Migrations 0040/0042 added `seller_organization_id`, `created_by_user_id` and
-- `category_id` to `product` as NULLABLE columns, backfilled them, and installed a
-- BEFORE trigger that derives all three from the legacy `seller_id`/`category` pair so
-- an old application instance mid-deploy could still insert a valid row.
--
-- docs/STORE_PHASE_0_ROLLOUT.md:97-116 describes this migration and gates it on five
-- preconditions. Four are satisfied in code: `products.service.ts` dual-writes all five
-- columns on create and always moves legacy `category` and `categoryId` together on
-- update. The fifth — "no new NULL transition keys for at least one release interval" —
-- is satisfied trivially: there are no products.
--
-- ORDERING IS PRESCRIBED, not chosen. The rollout doc says to remove the trigger
-- "immediately before enforcing non-null transition columns" (:114-116), and that is
-- what this file does, in one transaction: while the trigger exists, a NULL transition
-- key is repairable; once it is gone, NOT NULL is what stops one being written.
--
-- DELIBERATELY NOT IN SCOPE. `docs/STORE_PHASE_0_ROLLOUT.md:110-112` requires a separate
-- later release to remove or rename the legacy fields, and both still have live readers:
-- `product.seller_id` backs the video↔product ownership check in `videos.service.ts`,
-- and the legacy `product.category` enum is still on the public `/products/*` wire and
-- still accepted enum-only by the create/update schemas. Neither is touched here.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.

-- ---------------------------------------------------------------------------
-- Preflight. The one thing that makes the rest of this file safe.
--
-- An EXCEPTION rather than a NOTICE, unlike 0060's: a NULL transition key here is not a
-- business decision anybody can make later, it is a row that `ALTER COLUMN ... SET NOT
-- NULL` is about to reject anyway. Failing with a count and a repair query is more
-- useful than failing with `23502` and a row id.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  null_transition_key_count integer;
BEGIN
  SELECT count(*) INTO null_transition_key_count
  FROM "product"
  WHERE "seller_organization_id" IS NULL
     OR "created_by_user_id" IS NULL
     OR "category_id" IS NULL;

  IF null_transition_key_count > 0 THEN
    RAISE EXCEPTION
      'Store Phase 0 contract: % product row(s) still carry a NULL transition key. The 0042 fill trigger is still installed — UPDATE product SET seller_id = seller_id WHERE seller_organization_id IS NULL OR created_by_user_id IS NULL OR category_id IS NULL; then rerun.',
      null_transition_key_count;
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Remove the expand-phase compatibility shim.
--
-- Its whole purpose was to let an application that predates organization ownership keep
-- writing products during a rolling deploy. Nothing writes a product without all three
-- transition keys any more, and leaving it would mean a silent derive-from-legacy path
-- surviving into a schema where the columns are mandatory — a trigger that can only ever
-- mask a bug it can no longer be needed for.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "commerce_product_fill_legacy_transition_keys" ON "product";--> statement-breakpoint
DROP FUNCTION IF EXISTS commerce_fill_legacy_product_transition_keys();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Enforce what has been true since 0040's backfill.
--
-- After this, organization ownership and the category hierarchy are structural facts
-- rather than conventions the application happens to honour — which is what lets the
-- public catalog's INNER JOINs stop being the thing that quietly filters out a product
-- whose ownership was never set.
-- ---------------------------------------------------------------------------
ALTER TABLE "product" ALTER COLUMN "seller_organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ALTER COLUMN "created_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ALTER COLUMN "category_id" SET NOT NULL;
