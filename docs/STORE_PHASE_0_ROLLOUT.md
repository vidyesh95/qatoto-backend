# Store Phase 0 commerce-foundation rollout

This runbook covers migrations `0040_dear_surge.sql`, `0041_elite_piledriver.sql`, and
`0042_many_jasper_sitwell.sql`. Together with the Phase 0 application release, they enable private
commerce organization management and organization-based seller product authorization. Public store
profiles, provider workflows, checkout, and buyer commerce remain disabled.

## Expand

Migration `0040` adds:

- commerce organizations, memberships, private addresses, encrypted-document metadata,
  verification decisions, hierarchical categories, and immutable organization audit entries;
- nullable `session.active_organization_id`;
- nullable `product.seller_organization_id`, `product.created_by_user_id`, and
  `product.category_id`;
- supporting enums, foreign keys, checks, indexes, category-cycle enforcement,
  same-organization evidence enforcement, and append-only audit triggers.

Migration `0042` adds the rolling-deploy protections that cannot be represented in the Drizzle
schema snapshot:

- `commerce_product_fill_legacy_transition_keys` derives all three product transition keys from
  legacy `seller_id` and `category` whenever an old writer omits any one of them. It ignores any
  partially supplied transition values and provisions the deterministic legacy organization when
  a seller first writes after the original backfill. After installing the trigger, `0042` also
  re-touches any incomplete products written between `0040` and `0042`, closing that deploy window.
- `commerce_organization_member_current_uidx` permits historical `left` rows but enforces exactly
  one invited, active, or suspended membership per organization/user pair. The migration aborts
  with an operator-facing error if pre-existing current duplicates need resolution.
- `commerce_organization_member_enforce_transition` rejects illegal membership transitions and
  makes left membership history and owner membership immutable through the ordinary member flow.

The legacy `product.seller_id` and `product.category` columns remain unchanged for rolling-deploy
compatibility. Phase 0 controllers and services use the organization columns canonically, derive
organization context from the server session, and re-check an active seller membership for the
exact organization and resource. No ownership column is client writable.

Deploy the schema before deploying any application version that reads the new columns.

## Deterministic seed and backfill

Migration `0040` performs its seed and backfill in the same Drizzle migration transaction:

1. It inserts eight active root categories with stable IDs:
   `commerce_category_electronics`, `commerce_category_fashion`,
   `commerce_category_home_kitchen`, `commerce_category_anime_collectibles`,
   `commerce_category_digital_goods`, `commerce_category_books_media`,
   `commerce_category_sports_outdoors`, and
   `commerce_category_beauty_personal_care`.
2. For each distinct legacy `product.seller_id`, it creates one active, private,
   `sole_proprietor` organization. The organization ID and slug are deterministic hashes of the
   Better Auth user ID. The placeholder country is ISO user-assigned code `ZZ`; it is explicitly
   unknown and must not be treated as verified geography.
3. It creates one active owner membership linking that seller to the generated organization.
4. It migrates every product, including drafts, by copying `seller_id` to
   `created_by_user_id`, assigning the generated organization, and mapping the legacy category
   enum to its stable root category ID.
5. It selects an active organization for existing sessions when the user has an active
   membership. Users without memberships remain `NULL`.
6. A final procedural check aborts the entire migration if a product lacks any transition key,
   a migrated seller lacks an active owner membership, or the root seed is incomplete.

The migrations are additive and deterministic, but they are not intended to be run manually more than
once. Drizzle's migration journal remains the deployment authority.

## Verification gate

After applying the migration against a production-like snapshot, run:

```sh
npm run db:verify-commerce-foundation-constraints
```

The command must pass before later Phase 0 application work is deployed. It verifies table and
trigger presence, exact root IDs, complete product mappings, generated ownership, valid session
selection, rolling legacy product writes, current-membership uniqueness and transitions,
cross-organization evidence rejection, category-cycle rejection, and append-only organization
audit behavior. Runtime probes are rolled back.

Also compare these operational counts before and after migration:

```sql
SELECT count(*) FROM product;
SELECT count(DISTINCT seller_id) FROM product;
SELECT count(*) FROM commerce_organization WHERE slug LIKE 'legacy-seller-%';
SELECT count(*) FROM commerce_organization_member
WHERE role = 'owner' AND state = 'active';
SELECT count(*) FROM product
WHERE seller_organization_id IS NULL OR created_by_user_id IS NULL OR category_id IS NULL;
```

The final query must return zero. Product count must not change. On a database without
pre-existing commerce organizations, generated organization and owner-membership counts equal
the distinct legacy seller count.

## Contract phase

Do not make transition columns non-null or remove legacy fields in this migration.

A later contract migration is allowed only after:

- all product create/update paths dual-write legacy and organization/category ownership;
- every organization-scoped read and mutation authenticates the user and authorizes an active
  membership for the exact resource;
- deployed clients submit category IDs and no supported client depends solely on enum category;
- the verification command passes on every environment;
- monitoring shows no new `NULL` transition keys for at least one normal release interval.

That later migration may make `seller_organization_id`, `created_by_user_id`, and `category_id`
non-null. Removing or renaming `seller_id` and removing the legacy category enum require a
separate release after all callers have stopped using them.

The `commerce_product_fill_legacy_transition_keys` trigger is intentionally retained for the
entire expand/dual-write period. Remove it only in the contract migration, after old application
instances can no longer write and immediately before enforcing non-null transition columns.

## Rollback strategy

### Before migration commit

Any DDL, seed, or backfill failure rolls back the migration transaction. Fix the cause and rerun
through the normal Drizzle migration command.

### After migration commit, before application adoption

Prefer roll-forward. The new tables and columns are additive, private, and unused by current
product logic. Leaving them present is safer than destructive rollback.

If an emergency rollback is unavoidable:

1. Stop all application processes that could write commerce foundation rows.
2. Take a database snapshot and retain it for audit recovery.
3. Confirm no deployed code reads or writes the new columns.
4. Drop the `0042` compatibility objects first:
   `commerce_product_fill_legacy_transition_keys`,
   `commerce_organization_member_enforce_transition`,
   `commerce_fill_legacy_product_transition_keys`, and
   `commerce_enforce_member_transition`, plus
   `commerce_organization_member_current_uidx`.
5. Drop the `0040` organization-audit, category-cycle, and evidence-scope triggers and their helper
   functions.
6. Drop the `0041` organization-scoped SKU index, then the new foreign keys, transition columns,
   commerce tables in child-first order, and commerce enums.
7. Remove migration journal entries for `0042`, `0041`, and `0040` in reverse order only as part
   of the same controlled database recovery procedure. Never leave the journal claiming a
   compatibility trigger exists after dropping it.

Dropping `commerce_organization_audit_entry` destroys security evidence. Once real commerce
activity has written audit or verification records, destructive rollback is prohibited; restore
service by roll-forward migration instead.

### After application adoption

Rollback the application first to a version that uses legacy `seller_id` and `category`.
Do not reverse-copy organization data into legacy ownership automatically: organizations can have
multiple members and no single user is necessarily the seller. Preserve the additive schema and
roll forward with a corrective migration.
