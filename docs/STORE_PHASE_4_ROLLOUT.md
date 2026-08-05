# Store Phase 4 rollout

This runbook covers migration `0046_store_phase_4_checkout.sql` and the Phase 4 application
release: buyer carts, server-priced checkout preparation with held inventory, atomic
multi-seller checkout confirmation into direct-checkout orders, buyer/counterparty order
queues and cancellation, product shipments and shipment events, standalone service
engagements carried over from accepted quotes, and the `release-expired-inventory-reservations`
worker.

**Status:** ready to ship after migrate + verify + smoke. Payments, escrow, shipment legs,
connector execution, and trust metrics remain Phase 5+.

## Expand

Migration `0046` adds:

- one cart per buyer organization and its desired-quantity product lines
  (`commerce_cart`, `commerce_cart_product_line`);
- an immutable checkout-preparation snapshot with priced lines and currency totals, held
  against inventory (`commerce_checkout_prepare*`, `commerce_inventory_reservation`);
- one checkout group and one order per (seller, currency) pair created atomically on confirm
  (`commerce_checkout_group*`, `commerce_order.checkout_group_id`);
- standalone service engagements and their link back to the order/service line/shipment that
  created them (`commerce_service_engagement`, `commerce_order_service_link`), backfilled for
  every existing accepted-quote service line;
- shipments, shipment product lines, and append-only shipment events
  (`commerce_shipment`, `commerce_shipment_product_line`, `commerce_shipment_event`);
- a rewritten `commerce_order_quote_source_ck` that requires `accepted_quote` orders to carry
  no checkout group and `direct_checkout` orders to carry exactly one;
- audit event kinds for cart, checkout, order, shipment, and engagement transitions;
- an append-only trigger for shipment events, alongside the Phase 3 order-snapshot immutability
  trigger extended to also guard `checkout_group_id`.

## Deploy order

1. Apply migration `0046` against a production-like snapshot (`npm run db:migrate`).
2. Install/refresh job queues (`npm run jobs:install`) so
   `release-expired-inventory-reservations-tick` and `release-expired-inventory-reservations`
   exist before the worker schedules them.
3. Verify constraints: `npm run db:verify-store-phase-4-constraints`.
4. Deploy the application that mounts:
    - `/commerce/cart*`
    - `/commerce/checkout/prepare`, `/commerce/checkout/confirm`
    - `/commerce/orders*`, `/commerce/provider/orders`
    - `/commerce/orders/:orderId/shipments`, `/commerce/shipments/:shipmentId/events`
    - `/commerce/service-engagements*`
5. Deploy/restart the worker so the hourly inventory-release tick is bound.
6. Smoke-test the flows below with `Idempotency-Key` on every mutating call.

Forward-only: do not reverse `0046` in place. If a release must be aborted after migrate, keep
the additive schema and roll the application binary back. Open carts and checkout preparations
simply will not be reachable until the matching app is redeployed; nothing already confirmed
into an order is at risk, because confirmation is the one step that mutates stock and creates
orders atomically.

## Authorization matrix

| Action                                                 | Required active membership                         |
| ------------------------------------------------------ | -------------------------------------------------- |
| View/mutate own cart, prepare/confirm checkout         | buyer, administrator, or owner                     |
| List/view own buyer orders                             | buyer, administrator, or owner                     |
| List/view counterparty orders, create shipments/events | seller, provider_operator, administrator, or owner |
| View/cancel a specific order                           | buyer OR counterparty of that order                |
| List/transition a service engagement                   | buyer OR provider of that engagement               |

Organization ids are taken from the session active organization only — never from the request
body or params. An order, shipment, or engagement id that does not belong to the caller's
organization returns `404`, identically to a nonexistent id, so cross-tenant probing cannot
distinguish "not yours" from "does not exist."

## Cart and checkout contract

Carts store **desired quantity only** — no price or stock is authoritative until prepare time.
`PUT /commerce/cart/items/:productId` and `DELETE /commerce/cart/items/:productId` each
supersede any active checkout preparation for that cart, so a stale prepare can never be
confirmed against a cart that has since changed.

`POST /commerce/checkout/prepare` requires `Idempotency-Key` and:

1. locks the cart, re-prices every line against current product state (base price or highest
   eligible pricing tier, per `resolveUnitPriceInCents`), and holds inventory for each
   non-made-to-order line;
2. persists an immutable snapshot (`commerce_checkout_prepare*`) with a TTL
   (`COMMERCE_CHECKOUT_PREPARE_TTL_MS`);
3. replays the same snapshot on a repeated `prepareIdempotencyKey`, rather than re-pricing.

`POST /commerce/checkout/confirm` requires `Idempotency-Key` and `{ "prepareId": "..." }`
(strict). Under a transaction it re-validates every line has not gone stale — a price change
returns `409 PRICE_CHANGED` naming the product and both prices — then, only if nothing has
drifted:

1. creates exactly one `commerce_checkout_group` and one `direct_checkout` order per (seller,
   currency) pair, with immutable money and legal-name snapshots;
2. decrements stock for non-made-to-order lines, consumes the held reservations, and clears the
   confirmed cart lines;
3. appends audit events.

Replay of the same `confirmIdempotencyKey` returns the same group and orders. A prepare that
has passed its `expiresAt` is lazily marked `expired` on the next confirm attempt and returns
`409 PREPARE_EXPIRED` — prepare again. Orders are **not** payment, escrow, or assurance
claims — Phase 5 owns those words.

## Fulfillment contract

A counterparty (seller or provider) creates shipments against their own orders still in
`pending_payment`, `confirmed`, `in_fulfillment`, or `partially_completed`. Each shipment line
references an `orderProductLineId` and a quantity that must not exceed that line's remaining
unfulfilled quantity across all of this order's shipments.

Shipment events are append-only (`commerce_shipment_event_append_only` trigger). `delivered` is
the one event kind with a side effect: it increments `quantityFulfilled` on every line the
shipment carries, exactly once, and rolls the order forward to `partially_completed` or
`completed` once every line finishes.

Standalone service engagements (one per accepted-quote service line, created by migration
backfill and by Phase 3 quote acceptance going forward) move through a guarded transition
matrix: the provider drives `awaiting_provider → scheduled → in_progress`, either side may
move `in_progress`/`awaiting_buyer` to `completed`, and either side may `cancel` from a
non-terminal state. An out-of-matrix target returns `409 INVALID_STATE`.

## Inventory release worker

`release-expired-inventory-reservations-tick` runs hourly (`35 * * * *` UTC, offset from the
Phase 3 quote-expiry tick at `:20` so the two never contend) and enqueues
`release-expired-inventory-reservations` with an explicit `asOf`. The handler expires
`active` checkout preparations and `held` reservations whose persisted `expiresAt` is past,
using guarded `UPDATE ... WHERE state = ...` predicates so retries are harmless and a worker
that was down for hours loses nothing — every prepare/reservation expires exactly once,
however late this runs.

## Smoke tests

Authenticated buyer org:

```http
PUT /commerce/cart/items/:productId
Idempotency-Key: phase4-cart-set-1
{ "quantity": 100 }
```

```http
GET /commerce/cart
```

```http
POST /commerce/checkout/prepare
Idempotency-Key: phase4-prepare-1
{}
```

Expect `201` with a `prepareId`, priced `items`, and `currencyTotals`.

```http
POST /commerce/checkout/confirm
Idempotency-Key: phase4-confirm-1
{ "prepareId": "<prepareId from prepare>" }
```

Expect `201` with a `checkoutGroupId` and one `direct_checkout` order per (seller, currency)
pair, each `state: "pending_payment"`. A second identical confirm with the same key must
replay the same group and orders.

```http
GET /commerce/orders
```

Authenticated counterparty (seller/provider) org:

```http
GET /commerce/provider/orders
```

```http
POST /commerce/orders/:orderId/shipments
Idempotency-Key: phase4-shipment-1
{ "lines": [{ "orderProductLineId": "...", "quantity": 100 }], "packageCount": 1 }
```

```http
POST /commerce/shipments/:shipmentId/events
Idempotency-Key: phase4-shipment-delivered-1
{ "eventKind": "delivered" }
```

Expect the linked order to move to `partially_completed` or `completed` once every line is
delivered.

Quote-to-engagement flow (carried over from Phase 3 acceptance):

```http
GET /commerce/service-engagements
```

```http
POST /commerce/service-engagements/:engagementId/transitions
Idempotency-Key: phase4-engagement-schedule-1
{ "targetState": "scheduled" }
```

## Verification commands

```bash
npm run db:migrate
npm run jobs:install
npm run db:verify-store-phase-4-constraints
npm run typecheck
npm run lint
npm test
npm run build
```

## Rollback

- Application rollback is safe: Phase 4 tables are not read by Phase 0–3 surfaces, and the
  rewritten `commerce_order_quote_source_ck` accepts every row shape Phase 3 already writes
  (`accepted_quote` orders with `checkout_group_id IS NULL`).
- Do not drop `0046` tables in production once carts, prepares, orders, shipments, or
  engagements exist; they are commercial and operational evidence.
- Worker rollback: an unbound release queue simply stops scheduling; expired prepares and
  reservations remain `active`/`held` until a worker with the handler is restored — they do not
  silently allow overselling, because `loadPurchasableProductForCheckout` still counts every
  `held` reservation (expired or not) against available stock at the next prepare/confirm.

## Out of scope (later phases)

- Phase 5: payment intents, journal, refunds, assurance language
- Phase 6: shipment legs and connector engagement execution (customs, insurance, inspection,
  lab, warehouse, marketing, FX)
- Phase 7: verified reviews, disputes, provider ranking metrics
