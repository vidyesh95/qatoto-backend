DO $commerce_current_membership_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "commerce_organization_member"
    WHERE "state" <> 'left'
    GROUP BY "organization_id", "user_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate current commerce memberships require operator resolution before migration';
  END IF;
END
$commerce_current_membership_preflight$;--> statement-breakpoint
DROP INDEX "commerce_organization_member_active_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_organization_member_current_uidx" ON "commerce_organization_member" USING btree ("organization_id","user_id") WHERE state <> 'left';--> statement-breakpoint

CREATE OR REPLACE FUNCTION commerce_enforce_member_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_member_transition$
BEGIN
  IF OLD."role" = 'owner' AND (NEW."role" IS DISTINCT FROM OLD."role" OR NEW."state" IS DISTINCT FROM OLD."state") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'owner membership cannot be changed through member transition';
  END IF;

  IF NEW."role" = 'owner' AND OLD."role" <> 'owner' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'owner role cannot be granted through member transition';
  END IF;

  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'invited' AND NEW."state" = 'active')
    OR (OLD."state" = 'active' AND NEW."state" IN ('suspended', 'left'))
    OR (OLD."state" = 'suspended' AND NEW."state" IN ('active', 'left'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'illegal commerce membership state transition';
  END IF;

  IF OLD."state" = 'left' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'left commerce membership is immutable history';
  END IF;

  RETURN NEW;
END
$commerce_member_transition$;--> statement-breakpoint

CREATE TRIGGER commerce_organization_member_enforce_transition
BEFORE UPDATE ON "commerce_organization_member"
FOR EACH ROW EXECUTE FUNCTION commerce_enforce_member_transition();--> statement-breakpoint

-- Expand-phase compatibility for old application instances. If any transition key
-- is absent, every transition key is derived from legacy server-owned columns; supplied
-- transition values are ignored. Remove this trigger only in the contract migration.
CREATE OR REPLACE FUNCTION commerce_fill_legacy_product_transition_keys()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_legacy_product_transition$
DECLARE
  derived_organization_id text := 'commerce_org_legacy_' || md5(NEW."seller_id");
  derived_category_id text;
BEGIN
  IF NEW."seller_organization_id" IS NOT NULL
     AND NEW."created_by_user_id" IS NOT NULL
     AND NEW."category_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  derived_category_id := CASE NEW."category"
    WHEN 'electronics' THEN 'commerce_category_electronics'
    WHEN 'fashion' THEN 'commerce_category_fashion'
    WHEN 'home_kitchen' THEN 'commerce_category_home_kitchen'
    WHEN 'anime_collectibles' THEN 'commerce_category_anime_collectibles'
    WHEN 'digital_goods' THEN 'commerce_category_digital_goods'
    WHEN 'books_media' THEN 'commerce_category_books_media'
    WHEN 'sports_outdoors' THEN 'commerce_category_sports_outdoors'
    WHEN 'beauty_personal_care' THEN 'commerce_category_beauty_personal_care'
    ELSE NULL
  END;
  IF derived_category_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'legacy product category has no commerce mapping';
  END IF;

  INSERT INTO "commerce_organization"
    ("id", "slug", "legal_name", "normalized_legal_name", "display_name",
     "organization_type", "trade_state", "visibility", "country_code", "created_by_user_id")
  SELECT
    derived_organization_id,
    'legacy-seller-' || md5(NEW."seller_id"),
    left(coalesce(nullif(btrim(legacy_user."name"), ''), 'Legacy seller'), 200),
    left(lower(coalesce(nullif(btrim(legacy_user."name"), ''), 'legacy seller')), 200),
    left(coalesce(nullif(btrim(legacy_user."name"), ''), 'Legacy seller'), 200),
    'sole_proprietor', 'active', 'private', 'ZZ', NEW."seller_id"
  FROM "user" AS legacy_user
  WHERE legacy_user."id" = NEW."seller_id"
  ON CONFLICT ("id") DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM "commerce_organization" WHERE "id" = derived_organization_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'legacy product seller does not exist';
  END IF;

  INSERT INTO "commerce_organization_member"
    ("id", "organization_id", "user_id", "role", "state", "invited_by_user_id", "joined_at")
  SELECT
    'commerce_member_legacy_' || md5(NEW."seller_id"),
    derived_organization_id,
    NEW."seller_id",
    'owner',
    'active',
    NEW."seller_id",
    now()
  WHERE NOT EXISTS (
    SELECT 1
    FROM "commerce_organization_member"
    WHERE "organization_id" = derived_organization_id
      AND "user_id" = NEW."seller_id"
  );

  NEW."seller_organization_id" := derived_organization_id;
  NEW."created_by_user_id" := NEW."seller_id";
  NEW."category_id" := derived_category_id;
  RETURN NEW;
END
$commerce_legacy_product_transition$;--> statement-breakpoint

CREATE TRIGGER commerce_product_fill_legacy_transition_keys
BEFORE INSERT OR UPDATE OF "seller_id", "category", "seller_organization_id", "created_by_user_id", "category_id"
ON "product"
FOR EACH ROW EXECUTE FUNCTION commerce_fill_legacy_product_transition_keys();--> statement-breakpoint

-- Close the deploy window between migration 0040's one-time backfill and this
-- compatibility trigger. The no-op legacy assignment deliberately fires the trigger.
UPDATE "product"
SET "seller_id" = "seller_id"
WHERE "seller_organization_id" IS NULL
   OR "created_by_user_id" IS NULL
   OR "category_id" IS NULL;