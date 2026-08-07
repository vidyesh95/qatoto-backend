# Store Phase 11 Rollout — Buyer Logistics

Delivery addresses, indicative delivery estimates, orderable samples, and
seller-declared customization. Appendix A15–A18.

**Status:** Shipped through additive migrations `0059`–`0062`.

This phase does **not** add review reads, Q&A, engagement counters or content reports
(Phase 10), ranking, recommendations, real carrier integrations, or anything §14 still
blocks.

---

## The bug this phase landed on top of

`createAddress` wrote its audit entry with the payload key `addressKind`. The audit
guard tests payload **keys** against a PII-name regex that includes `address`, so the
append returned `UNSAFE_PAYLOAD`, `appendAuditOrThrow` threw, and the whole transaction
rolled back.

**`POST /commerce/organizations/:organizationId/addresses` failed at runtime for every
caller.** The route suite mocks the service, so no test saw it. The key is now `kind`,
and `commerce-organization-audit.service.test.ts` asserts the payload shape directly —
the failure mode is a runtime throw that no type or route test can catch.

If you have monitoring on 5xx responses from that route, this is what it was.

---

## What ships

### A15 — a deliverable address

- `commerce_organization_address_kind` gains `delivery`
- `commerce_order.delivery_address_id`, backfilled through the checkout group
- `assertOwnedDeliveryAddress` filters on `addressKind` and returns a distinct
  `ADDRESS_KIND_INVALID` — telling a buyer they do not own their own billing address
  answered a question nobody asked
- `MAXIMUM_ADDRESSES_PER_KIND = 10`, counted **inside** the create transaction
- `GET /commerce/orders/:orderId/delivery-address` — the authorized decrypt route

### A16 — an estimate that is not a quote

- `commerce-delivery-estimate.service.ts`, plus a route index on
  `commerce_service_coverage`
- `deliveryEstimates` on the checkout prepare response, and
  `GET /store/products/:productSlug/delivery-estimate?destinationCountryCode=..&quantity=..`
- **`shippingInCents` is still `0`, and that is the decision, not the gap**

### A17 — orderable samples

- `is_sample` on the cart line, prepare line, order line and inventory reservation
- Three expression unique indexes rewritten to carry it
- `commerce_sample_credit`, minted at completion and consumed as `discountInCents`

### A18 — customization the server enforces

- `commerce_product_customization_option` plus cart, prepare and order selection tables
- `PUT /products/:id/customization-options` (seller)
- `POST /commerce/customization-assets` (buyer, multipart)

---

## Decisions worth knowing before reading the code

**The reveal route is the only place this backend hands one organization another's
PII.** Everything else that decrypts commerce PII returns it to the organization that
owns it. Three gates carry the whole safety argument — order membership (a stranger gets
`404`, not a hint), a counterparty-operating role on the seller side, and an order state
in `confirmed | in_fulfillment | partially_completed | completed`. An unpaid order does
not reveal a home address; `disputed` is excluded because Phase 7 freezes fulfillment
there.

The audit entry is written to the **buyer's** stream, and if it cannot be written the
read rolls back. An unlogged reveal is worse than a failed one: the entire argument for
choosing a decrypt path over a seller-openable snapshot was that every read leaves a
record. `delivery_address_revealed` is the first read event in an audit enum whose fifty
other values all record writes.

**The estimate never becomes money.** It is assembled from provider coverage and the
Phase 8 package geometry, returned per currency with the offerings it came from, and
never converted between currencies. An uncovered route returns an **empty array**, not a
zero — "we do not know" and "it is free" are different answers, and the mock this
replaces rendered the second one over a hardcoded date range. A seller who never declared
package geometry produces an estimate with `hasIncompletePackageData: true` rather than a
guessed weight.

**A sample bypasses exactly two things**: the tier ladder and the minimum order quantity.
Both express bulk economics, and a sample is the negation of bulk. Purchasability, the
variant rules and stock all still apply — a sample is a real unit leaving a real shelf.

**A sample credit is spent whole or not at all**, against the same seller in the same
currency, resolved under the confirm row lock rather than from whatever the prepare
displayed. It needs no journal change: the discount lands before a payment intent exists,
so no cross-order money movement is invented, and `commerce_journal_entry` is strictly
per-order.

**Customization artwork lands `pending_scan` and cannot be attached until a scanner
promotes it to `available`.** Upload completion is not a malware verdict. A buyer
handing a seller an unscanned file is exactly the path that must not exist — so the
upload returns `202`, not `201`.

---

## Preconditions

1. Migrations `0040`–`0058` applied and the Phase 9 verify script green.
2. **`COMMERCE_PII_ENCRYPTION_SECRET` must be set.** It is optional in
   `src/config/index.ts`, so the server boots without it and `/ready` still reports
   ready outside production — but every address write returns
   `PII_ENCRYPTION_UNAVAILABLE`, which takes delivery addresses, checkout and the A15
   reveal with it. Phase 11 is what makes it load-bearing.

    Generate one and append it without printing it:

    ```bash
    echo "COMMERCE_PII_ENCRYPTION_SECRET=$(openssl rand -base64 48)" >> .env
    ```

    `-base64 48` gives 48 random bytes as 64 characters; the config floor is 32. Base64
    output needs no quoting in a dotenv file.

    **Set it before the first address is written, and then treat it as permanent.** The
    key is derived as `sha256("qatoto:commerce-pii:v1:" + secret)` and the stored envelope
    carries a key _version_, not the key — so changing the secret makes every address
    encrypted under the old one permanently unreadable, with no rollback. Rotation means
    adding a new key version and re-encrypting every envelope, not editing this line.

3. **Every buyer organization needs an address of kind `delivery`.** The `0060`
   preflight `RAISE NOTICE`s the count of organizations that have addresses but none of
   that kind; their next checkout is refused with `ADDRESS_KIND_INVALID` until one
   exists. It is a NOTICE rather than an EXCEPTION because promoting a billing address
   to a delivery address is a business decision, not a migration's.

    Inspect:

    ```sql
    SELECT organization_id, count(*) AS address_count
      FROM commerce_organization_address
     GROUP BY organization_id
    HAVING count(*) FILTER (WHERE address_kind = 'delivery') = 0;
    ```

    Promote each organization's default billing address, **only if that address really is
    where goods should go**:

    ```sql
    INSERT INTO commerce_organization_address (
      id, organization_id, address_kind, label, country_code, region_code, locality,
      postal_code, recipient_name_encrypted, address_line_one_encrypted,
      address_line_two_encrypted, phone_encrypted, is_default, created_by_user_id
    )
    SELECT gen_random_uuid()::text, organization_id, 'delivery', label, country_code,
           region_code, locality, postal_code, recipient_name_encrypted,
           address_line_one_encrypted, address_line_two_encrypted, phone_encrypted,
           true, created_by_user_id
      FROM commerce_organization_address
     WHERE address_kind = 'billing' AND is_default;
    ```

---

## Deploy order

1. Apply migrations:

    ```bash
    pnpm run db:migrate
    ```

    `0059` is enum values only and must land first — a value added by
    `ALTER TYPE ... ADD VALUE` cannot be used by the transaction that adds it, and
    `0060`–`0062` reference every value it adds.

2. Verify before exposing the routes:

    ```bash
    pnpm run db:verify-store-phase-9-constraints
    pnpm run db:verify-store-phase-11-constraints
    ```

3. Deploy the API.

4. Seed the actors and data these flows assume, then drive them:

    ```bash
    pnpm run db:seed-store-demo                  # once; idempotent
    pnpm run dev                                 # separate shell
    pnpm run db:smoke-store-phases-9-11
    ```

    The script signs in over HTTP, activates each organization, and asserts every step
    below including the refusals. The manual list is kept as the specification of what it
    checks — run it by hand when changing one flow, and by script otherwise.

5. Smoke (a buyer org, a seller org, a provider org with freight coverage):

    - `POST /commerce/organizations/:id/addresses` succeeds — the regression above. An
      eleventh address of one kind → `409 ADDRESS_LIMIT_REACHED`
    - `checkout/prepare` with a `billing` address → `422` naming the kind, not "not
      owned"; with a `delivery` address → prepare succeeds and carries
      `deliveryEstimates`
    - `checkout/confirm` → the order carries `delivery_address_id`
    - Seller `GET /commerce/orders/:id/delivery-address` → full street lines,
      `Cache-Control: no-store`, and one `delivery_address_revealed` entry on the
      **buyer's** audit stream. Same call on a `pending_payment` order → `409`. A third
      organization → `404`. A `viewer`-role member of the seller → `403`
    - `GET /store/products/:slug/delivery-estimate?destinationCountryCode=DE` → a range
      attributed to named offerings; an uncovered destination → `{ "estimates": [] }`;
      `destinationCountryCode=Germany` → `422`. Order `shippingInCents` is still `0`
    - Add a `refundable` sample and a bulk line of the same product → **two** cart
      lines, the sample priced from `samplePriceInCents` with the MOQ bypassed. A
      product whose policy is `unavailable` → `422`
    - Complete the sample order → a credit appears; the next checkout with that seller
      applies it as `discountInCents` on the order and on the group currency total, and
      a concurrent second confirm consumes it exactly once
    - Seller `PUT /products/:id/customization-options` with a logo slot at MOQ 50 → a
      cart of 20 naming that slot is refused; 50 succeeds
    - `POST /commerce/customization-assets` → `202` and `pending_scan`; attaching it
      before it is promoted → `422 DOCUMENT_NOT_OWNED`; a document owned by another
      organization → the same, deliberately indistinguishable
    - Confirm → the order line carries the customization with its slot key and label
      snapshots, and renaming the slot afterwards does not change them

---

## Observability

- New audit events: `delivery_address_revealed`, `sample_credit_minted`,
  `sample_credit_consumed`, `product_customization_options_replaced`
- `delivery_address_revealed` is the one to alert on. A seller reading many addresses
  across many orders in a short window is the abuse this route exists to make visible.

---

## Rollback

1. Stop accepting Phase 11 writes (revert the API deploy). Every column added is
   nullable or defaulted, so a pre-Phase-11 application runs unchanged against this
   schema — **except** that `assertOwnedDeliveryAddress` reverts to accepting any
   address kind, which is the A15 bug returning.
2. Do **not** drop `commerce_order_line_customization` or `commerce_sample_credit` if
   production rows exist: both hold what a buyer agreed to and what they are owed.
3. `0059` uses `ALTER TYPE ... ADD VALUE`, which Postgres cannot reverse.

---

## Compatibility notes

- **`checkout/prepare` gains `deliveryEstimates`** — additive, and an empty array where
  no provider covers the route.
- **`PUT /commerce/cart/items/:productId` gains `isSample` and `customizations`** — both
  optional, both defaulting to the pre-Phase-11 behaviour.
- **Checkout can now fail with `ADDRESS_KIND_INVALID`, `SAMPLE_NOT_AVAILABLE` and
  `CUSTOMIZATION_REJECTED`.** A client with an exhaustive error switch needs the new
  arms.
- Migrations `0059`–`0062` are hand-written, like every store-phase migration since
  `0046`.

---

## Invariants to re-check after deploy

- Every order delivery address is of kind `delivery` and belongs to that order's buyer.
- The three sample-aware uniqueness indexes mention `is_sample` **by definition text**.
- Every sample order line priced from its product's sample price.
- Sample credit consumption and state agree in both directions, and no credit is owed by
  an organization to itself.
- No cart customization names another product's slot.
- Every ordered customization asset is scanned artwork of the right kind.

All are asserted by `pnpm run db:verify-store-phase-11-constraints`.

---

## Explicit non-claims

**A delivery estimate is not a quote and not a promise.** It is a range derived from
what providers advertise, with no booking behind it, and no delivery DATE is returned at
all. §14 still blocks assurance language; "Free Delivery" over a hardcoded date range is
exactly the claim it blocks.

**`shippingInCents` remaining `0` is a decision.** No freight is being charged, so no
freight appears in a total. Charging an amount derived from an advertised price range
would put an invented number into an immutable order.

**A `pending_scan` asset is not a safe file.** It is an uploaded one. Nothing may attach
it, and nothing may hand it to a seller, until a scanner says otherwise.
