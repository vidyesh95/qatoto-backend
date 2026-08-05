# Store Phase 1 + 2 rollout

This runbook covers migration `0043_uneven_ulik.sql` and the Phase 1/2 application
release: public `/store/*` catalog reads, merchandising, search documents, and the
provider connector directory under `/commerce/providers*`.

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

## Deploy order

1. Apply migration `0043` against a production-like snapshot.
2. Deploy the application that mounts `/store` and `/commerce` provider routes.
3. Smoke-test public reads and one authenticated provider write with an
   `Idempotency-Key`.

## Verification gates

- TypeScript, lint, and unit/route tests pass.
- `GET /store/products/:slug` returns `404` for draft, pending-moderation, private-org,
  or suspended-trade listings.
- Buyer projections never include `stockQuantity`, encrypted identifiers, member IDs,
  or moderation notes.
- Provider draft offerings are invisible on `/store/services/:slug` until moderated to
  `active` and the owning organization is public + active.
- Supplier link does not copy R&D `verificationState` onto `commerce_provider_profile`.
- Cursor pagination responses use `{ items, page: { nextCursor, hasMore } }`.
- Money fields remain integer cents with explicit currency.

## Notes

- Studio `POST /products/:id/publish` assigns `publicSlug` when missing but does **not**
  auto-approve moderation. Public visibility requires moderator approval plus a public
  organization.
- Setting organization `visibility` to `public` requires `tradeState = active` and
  refreshes organization search documents.
- RFQ, cart, checkout, payments, fulfillment, and trust remain Phase 3+.
