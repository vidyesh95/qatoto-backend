# Store Phase 8 Rollout — Catalog Depth and the Product Relation Graph

Product variants, media kinds, specification groups, packaging geometry, highlights,
the product relation graph, and the merchandising integrity fixes.

**Status:** Shipped through additive migrations `0054`–`0056`.

This phase does **not** add guided pathway slots (Phase 9), review reads or Q&A
(Phase 10), delivery addresses or freight estimates (Phase 11), recommendations,
ranking, or anything blocked by §14.

---

## What ships

- **Tables:** `commerce_product_variant`, `commerce_product_highlight`,
  `commerce_product_relation`
- **Columns:** packaging geometry and `units_per_package` on `product`;
  `variant_id`, `media_kind`, `alt_text`, `width_px`, `height_px` on `product_image`;
  `variant_id` on `product_pricing_tier`, `commerce_cart_product_line`,
  `commerce_inventory_reservation`, `commerce_checkout_prepare_product_line` and
  `commerce_order_product_line` (the last two also carrying a variant name
  snapshot); `specification_group` on `commerce_product_specification`;
  `starts_at`/`ends_at` on `store_pathway_item`
- **Hardening:** cart, reservation, prepare-line and image uniqueness are rewritten
  as expression indexes over `coalesce(variant_id, '')`; five relationship-guard
  triggers bind every variant reference to its own product; a cart line naming no
  variant for a variant-bearing product is refused by both the service and the
  database; hero-slide link targets are all-or-nothing, with a migration preflight
  that refuses to run against violating rows
- **Seller routes:**
    - `PUT /products/:id/variants` (idempotent, active seller org)
    - `PUT /products/:id/highlights` (idempotent, active seller org)
    - `PATCH /products/:id` accepts packaging fields and specification groups
    - `POST /products/:id/images` accepts `variantId`, `mediaKind`, `altText`
- **Relation routes:**
    - `PUT /commerce/products/:productId/relations` (idempotent, active seller org;
      always stored `seller_declared`)
    - `POST /commerce/admin/product-relations/:relationId/verify`
      (`moderate_commerce`; promotes to `moderator_curated`)
- **Public reads:** `GET /store/products/:productSlug` gains `condition`,
  `packaging`, `highlights`, `variants`, media kinds and specification groups;
  `GET /store/products/:productSlug/companions` is new; product cards gain
  `hasVariants`, `variantCount` and price/stock derived from the variant floor
- **Search:** documents index variant names and highlight titles, and carry the
  cheapest active variant price rather than the product row's

---

## Preconditions

1. Migrations `0040`–`0053` applied and the Phase 6 and Phase 7 verify scripts green.
2. No `store_hero_slide` row carries a partial link target — the `0054` preflight
   raises and aborts the migration if any does. Fix by completing the target, or by
   clearing all three columns:

    ```sql
    UPDATE store_hero_slide
       SET link_target_kind = NULL, link_target_id = NULL, link_target_slug = NULL
     WHERE NOT (
       (link_target_kind IS NULL AND link_target_id IS NULL AND link_target_slug IS NULL)
       OR (link_target_kind IS NOT NULL AND link_target_id IS NOT NULL
           AND link_target_slug IS NOT NULL)
     );
    ```

---

## Deploy order

1. Apply migrations `0054`–`0056`:

    ```bash
    pnpm run db:migrate
    ```

2. Verify constraints before exposing Phase 8 routes:

    ```bash
    pnpm run db:verify-store-phase-7-constraints
    pnpm run db:verify-store-phase-8-constraints
    ```

3. Deploy API.

4. Smoke (authorized seller org / buyer org / `moderate_commerce` staff):

    - Seller `PUT /products/:id/variants` with two variants → public detail returns
      both with their own price and stock; the card price becomes the variant floor
      and `hasVariants` is `true`
    - Buyer adds that product to the cart with no `variantId` → `422`; with one →
      priced from the variant
    - `checkout/prepare` holds stock against the variant, and a second variant of
      the same product can be held by the same prepare
    - `checkout/confirm` writes `variantId` **and** `variantNameSnapshot` on the
      order line, and decrements the variant's stock, not the product's
    - Retiring a sold variant succeeds; the order line keeps its snapshot
    - Upload a `spin_360` asset and reorder the gallery → positions re-pack with no
      unique violation, and the card image still comes from the shared gallery
    - Seller declares a relation → stored `seller_declared` even if the body claims
      otherwise (unknown key → `422`); companions group by kind and carry
      `sourceKind`; a target that is draft, suspended or unapproved → `422`
    - Staff verifies the relation → `moderator_curated` with reviewer attribution;
      a non-staff caller → `403`
    - Place a category in a rail → it renders instead of vanishing
    - A `store_pathway_item` whose window has closed is excluded from the pathway

---

## Observability

- Audit events: `product_relations_declared`, `product_relation_verified`
- Variant and relation writes enqueue `refresh-store-search-document`, because both
  the indexed price floor and the indexed variant names change with them

---

## Rollback

1. Stop accepting Phase 8 writes (revert the API deploy or gate the new routes).
   Every column added here is nullable or defaulted, so a pre-Phase-8 application
   runs unchanged against this schema.
2. Do **not** drop `commerce_product_variant` if production rows exist — order-line
   snapshots reference variants under `restrict`, and dropping them would destroy
   the record of what was bought. Forward-fix by disabling routes.
3. Migration reverse is only safe on empty Phase 8 tables in pre-production. Note
   that `0056` uses `ALTER TYPE ... ADD VALUE`, which Postgres cannot reverse.

---

## Compatibility notes

- **Migrations `0054`–`0056` are hand-written**, like every store-phase migration
  since `0046`. `drizzle-kit generate` diffs against `drizzle/meta/`, whose
  snapshots stopped at `0045`, so it re-emits every table created since. The `0054`
  snapshot committed alongside repairs that drift; future `generate` runs diff from
  it correctly.
- `commerce_cart_product_line_uidx` and
  `commerce_inventory_reservation_prepare_product_held_uidx` keep their names but
  change meaning. A name-only check would pass against the old definition, so
  `db:verify-store-phase-8-constraints` asserts each definition mentions
  `variant_id`.

---

## Invariants to re-check after deploy

- No cart line omits a variant for a product that has active variants.
- No cart line references a retired variant.
- Every order line with a `variant_id` also has a `variant_name_snapshot`.
- Every variant reference belongs to its own product, across all six referencing
  tables.
- One image claims each `(product, variant, position)`.
- `source_kind = 'moderator_curated'` exactly when reviewer attribution is present.

All six are asserted by `pnpm run db:verify-store-phase-8-constraints`.

---

## Explicit non-claims

A `seller_declared` relation is a **claim, not a verified fact** (§15.3). Do not
render seller-declared compatibility with confirmatory language, a check mark, or a
fitment guarantee — only `moderator_curated` earns that, and fitment is a safety
claim in every category where it matters. Packaging dimensions are seller-declared
and are not a freight quote; A16's delivery estimates remain unbuilt, and §14 still
blocks assurance language.
