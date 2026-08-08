-- ---------------------------------------------------------------------------
-- Commerce categories become ADMIN-OWNED DATA, and sellers can ask for one.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- THREE THINGS HAPPEN HERE, and the third is the one to read carefully.
--
-- 1. `commerce_category_request` — a seller's proposal for a category that does not
--    exist yet. Its own table, NOT a fourth `commerce_category_state`. A proposal has an
--    author, a justification and a verdict; it has no place in the tree, no children and
--    no products. Keeping proposals out of `commerce_category` means no browse query can
--    ever leak unapproved user text onto the storefront by forgetting a `WHERE`, and no
--    row needs a fabricated `sibling_order` to satisfy an index that exists to order
--    things people can see.
--
-- 2. `product.pending_category_request_id` — the link that makes approval surgical. A
--    listing waiting on a category parks in `misc` and points back at its request.
--    Deciding a request rehomes the products matching THAT id and nothing else. The
--    alternative — `WHERE category_id = misc` — would drag along every seller who
--    legitimately listed something miscellaneous, which is why no code path may do it.
--
-- 3. THE ROOT SET IS REPLACED. Migration 0040 seeded eight roots named after the
--    `product_category` enum (electronics, fashion, home-kitchen, …). They were never
--    what the store browses: the storefront's own rail, its fixtures and its committed
--    art are clothes / furniture / accessories / beauty / shoes / bags / machinery /
--    jewelry. Those eight become the taxonomy; the 0040 eight are RETIRED.
--
--    RETIRED, NEVER DELETED. `product.category_id` is `ON DELETE RESTRICT` and
--    `commerce_category_demand_snapshot` cascades — deleting would either fail or take
--    history with it. A retired row already 404s publicly, so nothing leaks, and the
--    whole step is reversible by flipping `state` back.
--
--    Products sitting on a retired root are repointed to `misc` rather than guessed into
--    a new one. "electronics" is not "machinery", and a migration that invents a mapping
--    is a migration that silently recategorises a stranger's catalogue. `misc` is the
--    honest answer, and the new admin surface is where a human fixes it.
--
-- CONSEQUENCE: `product.category` LOSES ITS NOT NULL. The enum's eight values name the
-- retired set, so a listing in `clothes` has no value it could hold. Requiring one would
-- mean refusing the taxonomy the store actually browses, or stamping a lie. Rows written
-- before today keep theirs and nothing reads it to decide anything; removal is its own
-- release (STORE_BACKEND_STRUCTURE.md §4.3 step 5).
--
-- IMAGES ARE NOT SET HERE. The eight new rows land with `image_url` NULL and are filled
-- by `pnpm db:seed-commerce-categories`, which needs Cloudinary credentials. A migration
-- that could not run without a third-party account is a migration that blocks a restore.
-- ---------------------------------------------------------------------------

CREATE TYPE "commerce_category_request_state" AS ENUM ('pending', 'approved', 'rejected');
--> statement-breakpoint

-- Audit event kinds for the new surface. Added with ADD VALUE and used only at RUNTIME,
-- never as a literal later in this batch: `drizzle-kit migrate` runs the whole pending set
-- in ONE transaction, and a value added by `ALTER TYPE ... ADD VALUE` cannot be referenced
-- as a literal inside it.
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_category_created';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_category_updated';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_category_reordered';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_category_image_replaced';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_category_retired';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_category_request_approved';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_category_request_rejected';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commerce_category_request" (
  "id" text PRIMARY KEY NOT NULL,
  "requested_by_user_id" text,
  "requested_organization_id" text,
  "proposed_name" text NOT NULL,
  "proposed_parent_category_id" text,
  "justification" text,
  "state" "commerce_category_request_state" DEFAULT 'pending' NOT NULL,
  "reviewed_by_user_id" text,
  "reviewed_at" timestamp,
  "review_note" text,
  "resulting_category_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Every actor FK is `set null`: a deleted account must not pin a decided request, and the
-- verdict stays a fact about the taxonomy after its author or its reviewer is gone.
ALTER TABLE "commerce_category_request"
  ADD CONSTRAINT "commerce_category_request_requested_by_user_id_user_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_category_request"
  ADD CONSTRAINT "commerce_category_request_requested_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("requested_organization_id") REFERENCES "commerce_organization"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_category_request"
  ADD CONSTRAINT "commerce_category_request_proposed_parent_category_id_commerce_category_id_fk"
  FOREIGN KEY ("proposed_parent_category_id") REFERENCES "commerce_category"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_category_request"
  ADD CONSTRAINT "commerce_category_request_reviewed_by_user_id_user_id_fk"
  FOREIGN KEY ("reviewed_by_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_category_request"
  ADD CONSTRAINT "commerce_category_request_resulting_category_id_commerce_category_id_fk"
  FOREIGN KEY ("resulting_category_id") REFERENCES "commerce_category"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- The moderation queue's own lookup, same shape as `store_pathway_moderation_queue_idx`.
CREATE INDEX IF NOT EXISTS "commerce_category_request_queue_idx"
  ON "commerce_category_request" ("state", "created_at", "id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "commerce_category_request_requestedByUserId_idx"
  ON "commerce_category_request" ("requested_by_user_id");
--> statement-breakpoint

-- Review attribution is paired to the STATE, not to the reviewer's user id: `set null`
-- above means a decided row can legitimately lose its reviewer when that account is
-- deleted, but it can never lose the fact that it was decided.
--
-- A rejection must carry a note. An approval need not — the resulting category IS the
-- explanation, and requiring prose there would be a stricter rule than the reviewer's
-- job actually has.
ALTER TABLE "commerce_category_request"
  ADD CONSTRAINT "commerce_category_request_review_ck" CHECK (
    ("reviewed_at" IS NULL) = ("state" = 'pending')
    AND ("state" = 'approved' OR "resulting_category_id" IS NULL)
    AND ("state" <> 'rejected' OR "review_note" IS NOT NULL)
  );
--> statement-breakpoint

ALTER TABLE "commerce_category_request"
  ADD CONSTRAINT "commerce_category_request_text_ck" CHECK (
    char_length("proposed_name") BETWEEN 1 AND 120
    AND ("justification" IS NULL OR char_length("justification") BETWEEN 1 AND 2000)
    AND ("review_note" IS NULL OR char_length("review_note") BETWEEN 1 AND 2000)
  );
--> statement-breakpoint

ALTER TABLE "commerce_category_request"
  ADD CONSTRAINT "commerce_category_request_parent_ck" CHECK (
    "resulting_category_id" IS NULL
    OR "resulting_category_id" IS DISTINCT FROM "proposed_parent_category_id"
  );
--> statement-breakpoint

ALTER TABLE "product"
  ADD COLUMN IF NOT EXISTS "pending_category_request_id" text;
--> statement-breakpoint

ALTER TABLE "product"
  ADD CONSTRAINT "product_pending_category_request_id_commerce_category_request_id_fk"
  FOREIGN KEY ("pending_category_request_id") REFERENCES "commerce_category_request"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- Partial: all but a handful of listings are waiting on nothing.
CREATE INDEX IF NOT EXISTS "product_pendingCategoryRequestId_idx"
  ON "product" ("pending_category_request_id")
  WHERE "pending_category_request_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "product" ALTER COLUMN "category" DROP NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The root swap. Order is load-bearing.
-- ---------------------------------------------------------------------------

-- Vacate `sibling_order` 0..7. Shifting EVERY root by the same constant cannot collide:
-- `commerce_category_siblingOrder_uidx` is scoped to
-- `coalesce(parent_category_id, '__root__')`, so the only rows that could conflict are
-- the very rows being moved, and their relative order is preserved. This also sweeps up
-- any extra roots a dev seed created — they stay active, just past the home rail, which
-- is a thing an admin can see and fix rather than a thing this migration guesses at.
UPDATE "commerce_category"
   SET "sibling_order" = "sibling_order" + 1000
 WHERE "parent_category_id" IS NULL;
--> statement-breakpoint

UPDATE "commerce_category"
   SET "state" = 'retired'
 WHERE "id" IN (
   'commerce_category_electronics',
   'commerce_category_fashion',
   'commerce_category_home_kitchen',
   'commerce_category_anime_collectibles',
   'commerce_category_digital_goods',
   'commerce_category_books_media',
   'commerce_category_sports_outdoors',
   'commerce_category_beauty_personal_care'
 );
--> statement-breakpoint

-- `misc` sits at 100 so it is never in the first eight the home rail asks for, while
-- still being an ordinary active category anyone can browse to. `image_url` stays NULL
-- on purpose: there is no art for it, and a placeholder would assert an image that does
-- not exist.
INSERT INTO "commerce_category"
  ("id", "slug", "name", "parent_category_id", "sibling_order", "state")
VALUES
  ('commerce_category_misc', 'misc', 'Misc', NULL, 100, 'active')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- Stable ids, same contract as 0040: re-running a restored migration or comparing two
-- environments produces the same category identities, and the Cloudinary public id the
-- seed script derives from the id stays stable across re-seeds.
INSERT INTO "commerce_category"
  ("id", "slug", "name", "parent_category_id", "sibling_order", "state")
VALUES
  ('commerce_category_clothes', 'clothes', 'Clothes', NULL, 0, 'active'),
  ('commerce_category_furniture', 'furniture', 'Furniture', NULL, 1, 'active'),
  ('commerce_category_accessories', 'accessories', 'Accessories', NULL, 2, 'active'),
  ('commerce_category_beauty', 'beauty', 'Beauty', NULL, 3, 'active'),
  ('commerce_category_shoes', 'shoes', 'Shoes', NULL, 4, 'active'),
  ('commerce_category_bags', 'bags', 'Bags', NULL, 5, 'active'),
  ('commerce_category_machinery', 'machinery', 'Machinery', NULL, 6, 'active'),
  ('commerce_category_jewelry', 'jewelry', 'Jewelry', NULL, 7, 'active')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- Repoint listings off the retired roots. To `misc`, not to a guessed equivalent — see
-- the header. A listing whose category was retired is a listing nobody has categorised
-- yet, and that is exactly what `misc` means.
UPDATE "product"
   SET "category_id" = 'commerce_category_misc'
 WHERE "category_id" IN (
   'commerce_category_electronics',
   'commerce_category_fashion',
   'commerce_category_home_kitchen',
   'commerce_category_anime_collectibles',
   'commerce_category_digital_goods',
   'commerce_category_books_media',
   'commerce_category_sports_outdoors',
   'commerce_category_beauty_personal_care'
 );
--> statement-breakpoint

-- The search index mirrors `product.category_id`; leaving it pointing at a retired root
-- would make category-filtered search disagree with the catalogue until the next
-- reindex. The ranking and demand snapshots are NOT touched: they are timestamped
-- derived rows that nightly jobs replace, and rewriting them would be editing history.
UPDATE "store_search_document"
   SET "category_id" = 'commerce_category_misc'
 WHERE "category_id" IN (
   'commerce_category_electronics',
   'commerce_category_fashion',
   'commerce_category_home_kitchen',
   'commerce_category_anime_collectibles',
   'commerce_category_digital_goods',
   'commerce_category_books_media',
   'commerce_category_sports_outdoors',
   'commerce_category_beauty_personal_care'
 );
