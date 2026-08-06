# Store Phase 5 Rollout — Payments and Journal

Commerce payment intents, provider transfers, refunds, and a double-entry journal
separate from the project-funding escrow ledger.

**Status:** Ready to migrate after Phases 0–4.

This phase does **not** enable trade-assurance copy, real fund custody, or a live card
processor. The `fake` adapter is development/test only and is refuse-closed in production.

---

## What ships

- Tables: `commerce_payment_intent`, `commerce_provider_transfer`, `commerce_refund`,
  `commerce_journal_account`, `commerce_journal_entry`, `commerce_journal_line`,
  `commerce_payment_outbox`, `commerce_payment_webhook_event`
- Routes:
    - `POST /commerce/orders/:orderId/payment-intents` (buyer, Idempotency-Key, 202)
    - `GET /commerce/payments/:paymentIntentId`
    - `POST /commerce/orders/:orderId/refunds` (buyer or counterparty, Idempotency-Key, 202)
- Jobs:
    - `dispatch-commerce-webhook-event` (on-demand outbox drain)
    - `reconcile-commerce-payments` (+ hourly tick at `:50`)
- Adapter seam: `src/adapters/commerce-payment-provider.adapter.ts` (`fake` only)

---

## Preconditions

1. Migrations `0040`–`0046` applied and Phase 4 verify script green.
2. Worker process running (`pnpm start:worker` / `pnpm jobs:install` after queue registration).
3. `COMMERCE_PAYMENT_PROVIDER=fake` only in development/test. Production must not accept
   payments until a real processor is configured (fake is refuse-closed).

---

## Deploy order

1. Apply migration `0047_store_phase_5_payments`:

    ```bash
    pnpm run db:migrate
    ```

2. Install/update pg-boss queues (registers new Phase 5 job names):

    ```bash
    pnpm run jobs:install
    ```

3. Deploy API and worker together so outbox rows created by the API are drained.

4. Verify constraints:

    ```bash
    pnpm run db:verify-store-phase-5-constraints
    ```

5. Smoke (non-production with fake adapter):

    - Create/confirm a checkout order → `pending_payment`
    - `POST /commerce/orders/:orderId/payment-intents` with `Idempotency-Key`
    - Expect `202` and order → `payment_processing`
    - Worker settles via fake adapter → payment `settled`, order `confirmed`
    - Journal lines for the order sum to zero
    - Replay the same Idempotency-Key → same intent, no second charge
    - `POST /commerce/orders/:orderId/refunds` for a partial amount → `partially_refunded`
    - Full remaining refund → payment `refunded`

---

## Fail-closed production behavior

| Condition                                                  | Behavior                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `NODE_ENV=production` and `COMMERCE_PAYMENT_PROVIDER=fake` | Payment create/refund returns `503 PROVIDER_UNAVAILABLE`                       |
| `COMMERCE_PAYMENT_PROVIDER=stripe`                         | `503` until a Stripe adapter is implemented                                    |
| Outbox worker down                                         | Intent/refund rows remain `created`/`processing`; hourly reconcile re-enqueues |

Never display “escrowed”, “trade assurance”, or “card charged” based solely on an order or
payment-intent row. The fake adapter moves no money.

---

## Rollback

1. Stop accepting payment/refund writes (feature flag or revert API deploy).
2. Drain or pause `dispatch-commerce-webhook-event` / `reconcile-commerce-payments` workers.
3. Do **not** drop journal tables if any production rows exist — financial history is
   append-only. Forward-fix by disabling routes.
4. Migration reverse is only safe on empty Phase 5 tables in pre-production.

---

## Invariants to re-check after deploy

- Payment amounts equal immutable `commerce_order.total_in_cents` / currency
- Refund totals never exceed the settled intent amount
- Journal entries are gapless per order and lines sum to zero
- Webhook `(provider, provider_event_id)` uniqueness makes replay harmless
- Cross-tenant payment intent GETs return `404`

---

## Explicitly not in this phase

- Real Stripe/Razorpay/Cashfree custody
- Trade-assurance language
- Seller payout / `seller_payable` release flows (journal account reserved)
- Shipment legs / connector deliverables (Phase 6)
- Disputes / reviews (Phase 7)
