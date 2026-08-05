# Store Phase 1 + 2 rollout

This runbook covers migrations `0043_uneven_ulik.sql` and `0044_store_search_fts.sql`
plus the Phase 1/2 application release: public `/store/*` catalog reads, merchandising,
ranked search documents, and the provider connector directory under
`/commerce/providers*`.

## Expand

Migration `0043` adds:

- public product buyer-contract columns (`public_slug`, sample policy, lead times,
  `moderation_state`, origin/unit/model fields);
- `commerce_product_specification`;
- merchandising tables (`store_hero_slide`, `store_pathway`, `store_pathway_item`,
  `store_rail`, `store_rail_placement`);
- `store_search_document` for server-side catalog search;
- provider kinds, profiles, kind links, service offerings, coverage, and typed
  offering detail tables;
- nullable `supplier.commerce_organization_id` (imports no trust state).

It also seeds the nine provider kinds and backfills active organization-owned products
with `moderation_state = approved` and a deterministic `public_slug`. Organization
`visibility` is **not** forced public.

Migration `0044` adds the generated `store_search_document.search_document` tsvector
column and GIN index used by relevance ranking.

## Deploy order

1. Apply migrations `0043` then `0044` against a production-like snapshot
   (`npm run db:migrate`).
2. Install/refresh job queues (`npm run jobs:install`) so
   `refresh-store-search-document` exists before the app enqueues it.
3. Backfill search documents for existing eligible rows:
   `npm run db:backfill-store-search-documents`.
4. Verify constraints: `npm run db:verify-store-phase-1-2-constraints`.
5. Deploy the application that mounts `/store` and `/commerce` provider routes.
6. Smoke-test public reads and one authenticated provider write with an
   `Idempotency-Key`.

Forward-fix only: do not attempt to reverse `0043`/`0044` in place. If a release must
be aborted after migrate, keep the additive schema and roll the application binary back;
search/home may be empty until the matching app is redeployed and backfill is re-run.

## Seller visibility / moderation prerequisites

Catalog rows stay invisible until **all** of the following are true:

- product `status = active`
- product `moderation_state = approved`
- product `public_slug` assigned
- seller organization `trade_state = active` and `visibility = public`
- category `state = active`

Studio `POST /products/:id/publish` assigns `publicSlug` when missing but does **not**
auto-approve moderation. Setting organization `visibility` to `public` requires
`tradeState = active` and enqueues an organization search-document refresh.

Provider offerings additionally require a non-rejected/non-suspended per-kind
verification link before public directory/search projection.

## Verification gates

- TypeScript, lint, format, unit/route tests, and `npm run build` pass.
- `GET /store/products/:slug` returns `404` for draft, pending-moderation, private-org,
  or suspended-trade listings.
- Buyer projections never include `stockQuantity`, encrypted identifiers, member IDs,
  or moderation notes.
- Category detail includes server-derived `facets`.
- `GET /store/search?query=...&sort=relevance` ranks by PostgreSQL FTS (`ts_rank_cd`)
  with deterministic `id` tie-break; `%` / `_` wildcards are escaped on ILIKE fallback.
- Pathway/rail items resolve to eligible product/offering cards; stale placements are
  dropped rather than returned as bare ids.
- Provider draft offerings are invisible on `/store/services/:slug` until moderated to
  `active` and the owning organization is public + active with an eligible kind link.
- Supplier link does not copy R&D `verificationState` onto `commerce_provider_profile`.
- Cursor pagination responses use `{ items, page: { nextCursor, hasMore } }`.
- Money fields remain integer cents with explicit currency.
- Evidence upload (`POST /commerce/providers/:organizationId/evidence`) never grants a
  verification badge directly.

## Exact commands

```bash
npm run typecheck
npm run lint
npm run fmt:check
npm test -- src/routes/store.routes.test.ts \
  src/routes/commerce-providers.routes.test.ts \
  src/services/store-catalog.service.test.ts \
  src/lib/store-cursor.test.ts
npm run build

# With DATABASE_URL configured:
npm run db:migrate
npm run jobs:install
npm run db:backfill-store-search-documents
npm run db:verify-store-phase-1-2-constraints
npm run db:verify-commerce-foundation-constraints
```

### Post-migrate SQL checks

```sql
SELECT count(*) FROM commerce_provider_kind; -- expect 9
SELECT count(*) FROM store_search_document WHERE is_eligible;
SELECT public_slug, count(*) FROM product
 WHERE public_slug IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
```

### HTTP smoke

1. `GET /store/home` → hero/categories/pathways/providerShortcuts/rails
2. `GET /store/categories/:slug` → category, children, facets, products page
3. `GET /store/search?query=solar&sort=relevance&limit=24`
4. `GET /store/products/:slug` → `404` when ineligible; no `stockQuantity`
5. `GET /store/organizations/:slug` → `404` for private org
6. Authenticated `POST /commerce/providers/:organizationId/offerings` with
   `Idempotency-Key`

## Notes

- Search refresh is asynchronous via pg-boss job `refresh-store-search-document`, with
  synchronous fallback if enqueue fails.
- Merchandising tables are not seeded by migration; home curated content stays empty
  until operators insert active hero/pathway/rail rows.
- RFQ, cart, checkout, payments, fulfillment, and trust remain Phase 3+.
