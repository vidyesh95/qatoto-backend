CREATE TYPE "public"."commerce_category_state" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."commerce_document_kind" AS ENUM('business_registration', 'tax_registration', 'identity', 'address_proof', 'bank_evidence', 'other');--> statement-breakpoint
CREATE TYPE "public"."commerce_document_state" AS ENUM('pending_scan', 'available', 'quarantined', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."commerce_organization_address_kind" AS ENUM('billing', 'registered', 'warehouse', 'pickup', 'return');--> statement-breakpoint
CREATE TYPE "public"."commerce_organization_audit_event_kind" AS ENUM('organization_created', 'organization_updated', 'trade_state_changed', 'visibility_changed', 'member_invited', 'member_state_changed', 'member_role_changed', 'address_changed', 'document_uploaded', 'document_state_changed', 'verification_decided');--> statement-breakpoint
CREATE TYPE "public"."commerce_organization_member_role" AS ENUM('owner', 'administrator', 'buyer', 'seller', 'provider_operator', 'finance', 'support', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."commerce_organization_member_state" AS ENUM('invited', 'active', 'suspended', 'left');--> statement-breakpoint
CREATE TYPE "public"."commerce_organization_trade_state" AS ENUM('pending', 'active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."commerce_organization_type" AS ENUM('company', 'sole_proprietor', 'cooperative', 'government', 'nonprofit');--> statement-breakpoint
CREATE TYPE "public"."commerce_organization_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TYPE "public"."commerce_verification_kind" AS ENUM('business_registration', 'tax_registration', 'identity', 'address', 'bank_account');--> statement-breakpoint
CREATE TYPE "public"."commerce_verification_state" AS ENUM('pending', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TABLE "commerce_category" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"parent_category_id" text,
	"sibling_order" integer NOT NULL,
	"state" "commerce_category_state" DEFAULT 'draft' NOT NULL,
	"image_url" text,
	"search_synonyms" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_category_slug_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 100),
	CONSTRAINT "commerce_category_shape_ck" CHECK (char_length(name) BETWEEN 1 AND 120
          AND sibling_order >= 0
          AND (image_url IS NULL OR (char_length(image_url) <= 2048 AND image_url LIKE 'https://%'))
          AND parent_category_id IS DISTINCT FROM id)
);
--> statement-breakpoint
CREATE TABLE "commerce_encrypted_document" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"document_kind" "commerce_document_kind" NOT NULL,
	"state" "commerce_document_state" DEFAULT 'pending_scan' NOT NULL,
	"storage_provider" text NOT NULL,
	"object_storage_key" text NOT NULL,
	"media_type" text NOT NULL,
	"file_byte_size" bigint NOT NULL,
	"content_sha256" text NOT NULL,
	"encryption_algorithm" text NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"encrypted_data_key" text NOT NULL,
	"initialization_vector" text NOT NULL,
	"original_file_name_encrypted" text,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_encrypted_document_size_ck" CHECK (file_byte_size > 0),
	CONSTRAINT "commerce_encrypted_document_sha_ck" CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "commerce_encrypted_document_encryption_ck" CHECK (char_length(encryption_algorithm) BETWEEN 1 AND 50
          AND encryption_key_version >= 1
          AND char_length(encrypted_data_key) >= 16
          AND char_length(initialization_vector) >= 12)
);
--> statement-breakpoint
CREATE TABLE "commerce_organization" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"normalized_legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"summary" text,
	"organization_type" "commerce_organization_type" NOT NULL,
	"trade_state" "commerce_organization_trade_state" DEFAULT 'pending' NOT NULL,
	"visibility" "commerce_organization_visibility" DEFAULT 'private' NOT NULL,
	"country_code" text NOT NULL,
	"registration_number_encrypted" text,
	"tax_identifier_encrypted" text,
	"logo_url" text,
	"website_url" text,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_organization_slug_ck" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 100),
	CONSTRAINT "commerce_organization_name_ck" CHECK (char_length(legal_name) BETWEEN 1 AND 200
          AND char_length(normalized_legal_name) BETWEEN 1 AND 200
          AND char_length(display_name) BETWEEN 1 AND 200
          AND (summary IS NULL OR char_length(summary) <= 4000)),
	CONSTRAINT "commerce_organization_country_ck" CHECK (country_code ~ '^[A-Z]{2}$'),
	CONSTRAINT "commerce_organization_url_ck" CHECK ((logo_url IS NULL OR (char_length(logo_url) <= 2048 AND logo_url LIKE 'https://%'))
          AND (website_url IS NULL OR (char_length(website_url) <= 2048 AND website_url LIKE 'https://%')))
);
--> statement-breakpoint
CREATE TABLE "commerce_organization_address" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"address_kind" "commerce_organization_address_kind" NOT NULL,
	"label" text,
	"country_code" text NOT NULL,
	"region_code" text,
	"locality" text NOT NULL,
	"postal_code" text,
	"recipient_name_encrypted" text,
	"address_line_one_encrypted" text NOT NULL,
	"address_line_two_encrypted" text,
	"phone_encrypted" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_organization_address_country_ck" CHECK (country_code ~ '^[A-Z]{2}$'),
	CONSTRAINT "commerce_organization_address_text_ck" CHECK ((label IS NULL OR char_length(label) BETWEEN 1 AND 100)
          AND char_length(locality) BETWEEN 1 AND 150
          AND (region_code IS NULL OR char_length(region_code) BETWEEN 1 AND 100)
          AND (postal_code IS NULL OR char_length(postal_code) BETWEEN 1 AND 32))
);
--> statement-breakpoint
CREATE TABLE "commerce_organization_audit_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"event_kind" "commerce_organization_audit_event_kind" NOT NULL,
	"actor_user_id" text,
	"actor_member_role_snapshot" "commerce_organization_member_role",
	"target_entity_type" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_organization_audit_entry_target_ck" CHECK (char_length(target_entity_type) BETWEEN 1 AND 80
          AND char_length(target_entity_id) BETWEEN 1 AND 200),
	CONSTRAINT "commerce_organization_audit_entry_payload_ck" CHECK (char_length(payload_json) BETWEEN 2 AND 10000 AND payload_json LIKE '{%')
);
--> statement-breakpoint
CREATE TABLE "commerce_organization_member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "commerce_organization_member_role" NOT NULL,
	"state" "commerce_organization_member_state" DEFAULT 'invited' NOT NULL,
	"invited_by_user_id" text,
	"joined_at" timestamp,
	"left_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_organization_member_dates_ck" CHECK ((state = 'invited' AND joined_at IS NULL AND left_at IS NULL)
          OR (state IN ('active', 'suspended') AND joined_at IS NOT NULL AND left_at IS NULL)
          OR (state = 'left' AND joined_at IS NOT NULL AND left_at IS NOT NULL AND left_at >= joined_at))
);
--> statement-breakpoint
CREATE TABLE "commerce_organization_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"verification_kind" "commerce_verification_kind" NOT NULL,
	"state" "commerce_verification_state" DEFAULT 'pending' NOT NULL,
	"evidence_document_id" text NOT NULL,
	"submitted_by_user_id" text NOT NULL,
	"reviewed_by_user_id" text,
	"decision_reason" text,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_organization_verification_decision_ck" CHECK ((state = 'pending' AND reviewed_by_user_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
          OR (state = 'approved' AND reviewed_by_user_id IS NOT NULL AND decision_reason IS NULL AND decided_at IS NOT NULL)
          OR (state IN ('rejected', 'superseded') AND reviewed_by_user_id IS NOT NULL
              AND decision_reason IS NOT NULL AND char_length(decision_reason) BETWEEN 1 AND 2000
              AND decided_at IS NOT NULL)),
	CONSTRAINT "commerce_organization_verification_reviewer_ck" CHECK (reviewed_by_user_id IS NULL OR reviewed_by_user_id <> submitted_by_user_id)
);
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "seller_organization_id" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
ALTER TABLE "commerce_category" ADD CONSTRAINT "commerce_category_parent_category_id_commerce_category_id_fk" FOREIGN KEY ("parent_category_id") REFERENCES "public"."commerce_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_encrypted_document" ADD CONSTRAINT "commerce_encrypted_document_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_encrypted_document" ADD CONSTRAINT "commerce_encrypted_document_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization" ADD CONSTRAINT "commerce_organization_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_address" ADD CONSTRAINT "commerce_organization_address_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_address" ADD CONSTRAINT "commerce_organization_address_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_audit_entry" ADD CONSTRAINT "commerce_organization_audit_entry_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_audit_entry" ADD CONSTRAINT "commerce_organization_audit_entry_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_member" ADD CONSTRAINT "commerce_organization_member_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_member" ADD CONSTRAINT "commerce_organization_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_member" ADD CONSTRAINT "commerce_organization_member_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_verification" ADD CONSTRAINT "commerce_organization_verification_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_verification" ADD CONSTRAINT "commerce_organization_verification_evidence_document_id_commerce_encrypted_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."commerce_encrypted_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_verification" ADD CONSTRAINT "commerce_organization_verification_submitted_by_user_id_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_verification" ADD CONSTRAINT "commerce_organization_verification_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_category_slug_uidx" ON "commerce_category" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_category_siblingOrder_uidx" ON "commerce_category" USING btree (coalesce(parent_category_id, '__root__'),"sibling_order");--> statement-breakpoint
CREATE INDEX "commerce_category_parentCategoryId_idx" ON "commerce_category" USING btree ("parent_category_id","state","sibling_order");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_encrypted_document_objectStorageKey_uidx" ON "commerce_encrypted_document" USING btree ("object_storage_key");--> statement-breakpoint
CREATE INDEX "commerce_encrypted_document_organizationId_idx" ON "commerce_encrypted_document" USING btree ("organization_id","document_kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_organization_slug_uidx" ON "commerce_organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "commerce_organization_legalName_country_idx" ON "commerce_organization" USING btree ("normalized_legal_name","country_code");--> statement-breakpoint
CREATE INDEX "commerce_organization_tradeState_idx" ON "commerce_organization" USING btree ("trade_state","id");--> statement-breakpoint
CREATE INDEX "commerce_organization_address_organizationId_idx" ON "commerce_organization_address" USING btree ("organization_id","address_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_organization_address_default_uidx" ON "commerce_organization_address" USING btree ("organization_id","address_kind") WHERE is_default = true;--> statement-breakpoint
CREATE INDEX "commerce_organization_audit_entry_timeline_idx" ON "commerce_organization_audit_entry" USING btree ("organization_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "commerce_organization_audit_entry_actorUserId_idx" ON "commerce_organization_audit_entry" USING btree ("actor_user_id","occurred_at") WHERE actor_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_organization_member_organizationId_idx" ON "commerce_organization_member" USING btree ("organization_id","state");--> statement-breakpoint
CREATE INDEX "commerce_organization_member_userId_idx" ON "commerce_organization_member" USING btree ("user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_organization_member_active_uidx" ON "commerce_organization_member" USING btree ("organization_id","user_id") WHERE state = 'active';--> statement-breakpoint
CREATE INDEX "commerce_organization_verification_organizationId_idx" ON "commerce_organization_verification" USING btree ("organization_id","verification_kind","state");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_organization_verification_pending_uidx" ON "commerce_organization_verification" USING btree ("organization_id","verification_kind") WHERE state = 'pending';--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_seller_organization_id_commerce_organization_id_fk" FOREIGN KEY ("seller_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_commerce_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."commerce_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_active_organization_id_commerce_organization_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_sellerOrganizationId_idx" ON "product" USING btree ("seller_organization_id");--> statement-breakpoint
CREATE INDEX "product_createdByUserId_idx" ON "product" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "product_categoryId_idx" ON "product" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "session_activeOrganizationId_idx" ON "session" USING btree ("active_organization_id") WHERE active_organization_id IS NOT NULL;--> statement-breakpoint

-- Stable root IDs are part of the migration contract. Re-running a restored migration
-- or comparing environments produces the same category identities.
INSERT INTO "commerce_category"
  ("id", "slug", "name", "parent_category_id", "sibling_order", "state")
VALUES
  ('commerce_category_electronics', 'electronics', 'Electronics', NULL, 0, 'active'),
  ('commerce_category_fashion', 'fashion', 'Fashion', NULL, 1, 'active'),
  ('commerce_category_home_kitchen', 'home-kitchen', 'Home & Kitchen', NULL, 2, 'active'),
  ('commerce_category_anime_collectibles', 'anime-collectibles', 'Anime Collectibles', NULL, 3, 'active'),
  ('commerce_category_digital_goods', 'digital-goods', 'Digital Goods', NULL, 4, 'active'),
  ('commerce_category_books_media', 'books-media', 'Books & Media', NULL, 5, 'active'),
  ('commerce_category_sports_outdoors', 'sports-outdoors', 'Sports & Outdoors', NULL, 6, 'active'),
  ('commerce_category_beauty_personal_care', 'beauty-personal-care', 'Beauty & Personal Care', NULL, 7, 'active')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- One deterministic, private sole-proprietor organization per distinct legacy seller.
-- md5 is used only as a stable opaque identifier suffix, never for a security digest.
INSERT INTO "commerce_organization"
  ("id", "slug", "legal_name", "normalized_legal_name", "display_name",
   "organization_type", "trade_state", "visibility", "country_code",
   "created_by_user_id")
SELECT
  'commerce_org_legacy_' || md5(legacy_seller."seller_id"),
  'legacy-seller-' || md5(legacy_seller."seller_id"),
  left(coalesce(nullif(btrim(seller_user."name"), ''), 'Legacy seller'), 200),
  left(lower(coalesce(nullif(btrim(seller_user."name"), ''), 'legacy seller')), 200),
  left(coalesce(nullif(btrim(seller_user."name"), ''), 'Legacy seller'), 200),
  'sole_proprietor',
  'active',
  'private',
  'ZZ',
  legacy_seller."seller_id"
FROM (SELECT DISTINCT "seller_id" FROM "product") AS legacy_seller
JOIN "user" AS seller_user ON seller_user."id" = legacy_seller."seller_id"
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

INSERT INTO "commerce_organization_member"
  ("id", "organization_id", "user_id", "role", "state", "invited_by_user_id", "joined_at")
SELECT
  'commerce_member_legacy_' || md5(legacy_seller."seller_id"),
  'commerce_org_legacy_' || md5(legacy_seller."seller_id"),
  legacy_seller."seller_id",
  'owner',
  'active',
  legacy_seller."seller_id",
  now()
FROM (SELECT DISTINCT "seller_id" FROM "product") AS legacy_seller
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

UPDATE "product"
SET
  "seller_organization_id" = 'commerce_org_legacy_' || md5("seller_id"),
  "created_by_user_id" = "seller_id",
  "category_id" = CASE "category"
    WHEN 'electronics' THEN 'commerce_category_electronics'
    WHEN 'fashion' THEN 'commerce_category_fashion'
    WHEN 'home_kitchen' THEN 'commerce_category_home_kitchen'
    WHEN 'anime_collectibles' THEN 'commerce_category_anime_collectibles'
    WHEN 'digital_goods' THEN 'commerce_category_digital_goods'
    WHEN 'books_media' THEN 'commerce_category_books_media'
    WHEN 'sports_outdoors' THEN 'commerce_category_sports_outdoors'
    WHEN 'beauty_personal_care' THEN 'commerce_category_beauty_personal_care'
  END
WHERE "seller_organization_id" IS NULL
   OR "created_by_user_id" IS NULL
   OR "category_id" IS NULL;--> statement-breakpoint

-- Sessions for migrated sellers receive their sole organization. Users without an
-- organization stay NULL; a future organization-selection endpoint may choose one only
-- after an active-membership check.
UPDATE "session" AS commerce_session
SET "active_organization_id" = selected_membership."organization_id"
FROM (
  SELECT "user_id", min("organization_id") AS "organization_id"
  FROM "commerce_organization_member"
  WHERE "state" = 'active'
  GROUP BY "user_id"
) AS selected_membership
WHERE commerce_session."user_id" = selected_membership."user_id"
  AND commerce_session."active_organization_id" IS NULL;--> statement-breakpoint

-- Abort atomically instead of silently completing a partial backfill.
DO $commerce_foundation_backfill$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "product"
    WHERE "seller_organization_id" IS NULL
       OR "created_by_user_id" IS NULL
       OR "category_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'commerce foundation product backfill left null transition keys';
  END IF;

  IF (SELECT count(*) FROM "commerce_category" WHERE "parent_category_id" IS NULL AND "state" = 'active') < 8 THEN
    RAISE EXCEPTION 'commerce foundation root category seed is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "product" AS migrated_product
    LEFT JOIN "commerce_organization_member" AS owner_member
      ON owner_member."organization_id" = migrated_product."seller_organization_id"
     AND owner_member."user_id" = migrated_product."seller_id"
     AND owner_member."role" = 'owner'
     AND owner_member."state" = 'active'
    WHERE owner_member."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'commerce foundation product owner membership backfill is incomplete';
  END IF;
END
$commerce_foundation_backfill$;--> statement-breakpoint

-- Category self-reference checks prevent only a one-row loop. This trigger rejects
-- longer cycles while still allowing any acyclic hierarchy depth.
CREATE OR REPLACE FUNCTION commerce_reject_category_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_category_cycle$
BEGIN
  IF NEW."parent_category_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT category."id", category."parent_category_id"
      FROM "commerce_category" AS category
      WHERE category."id" = NEW."parent_category_id"
      UNION ALL
      SELECT parent_category."id", parent_category."parent_category_id"
      FROM "commerce_category" AS parent_category
      JOIN ancestors ON ancestors."parent_category_id" = parent_category."id"
    )
    SELECT 1 FROM ancestors WHERE "id" = NEW."id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commerce category hierarchy cannot contain a cycle';
  END IF;

  RETURN NEW;
END
$commerce_category_cycle$;--> statement-breakpoint

CREATE TRIGGER commerce_category_reject_cycle
BEFORE INSERT OR UPDATE OF "parent_category_id" ON "commerce_category"
FOR EACH ROW EXECUTE FUNCTION commerce_reject_category_cycle();--> statement-breakpoint

-- A verification may reference only evidence owned by the same organization.
CREATE OR REPLACE FUNCTION commerce_require_verification_document_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $commerce_verification_document_scope$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "commerce_encrypted_document" AS evidence_document
    WHERE evidence_document."id" = NEW."evidence_document_id"
      AND evidence_document."organization_id" = NEW."organization_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'verification evidence must belong to the same commerce organization';
  END IF;

  RETURN NEW;
END
$commerce_verification_document_scope$;--> statement-breakpoint

CREATE TRIGGER commerce_organization_verification_document_scope
BEFORE INSERT OR UPDATE OF "organization_id", "evidence_document_id"
ON "commerce_organization_verification"
FOR EACH ROW EXECUTE FUNCTION commerce_require_verification_document_scope();--> statement-breakpoint

-- Organization audit rows are immutable, including against statement-level TRUNCATE.
CREATE TRIGGER commerce_organization_audit_entry_append_only
BEFORE UPDATE OR DELETE ON "commerce_organization_audit_entry"
FOR EACH ROW EXECUTE FUNCTION qatoto_reject_mutation();--> statement-breakpoint

CREATE TRIGGER commerce_organization_audit_entry_no_truncate
BEFORE TRUNCATE ON "commerce_organization_audit_entry"
FOR EACH STATEMENT EXECUTE FUNCTION qatoto_reject_mutation();