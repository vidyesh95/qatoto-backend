# Store Phase 7 Rollout — Trust MVP

Server-issued completions, verified reviews, disputes, and privacy-safe public metrics.

**Status:** Trust MVP shipped through additive migration `0052`.

This phase does **not** add Q&A, content reports, ranking/recommendations, abuse-ops
automation, real payment processors, external connector adapters, or trade-assurance
language.

---

## What ships

- Tables: `commerce_completion`, `commerce_review`, `commerce_dispute`,
  `commerce_dispute_event`
- Immutable completion issuance from fulfilled product lines and completed engagements
- Routes:
    - `POST /commerce/completions/:completionId/reviews` (idempotent, buyer org)
    - `POST /commerce/orders/:orderId/disputes` (idempotent, buyer org; freezes order to
      `disputed` while preserving prior state)
    - `GET /commerce/admin/disputes` (`moderate_commerce`)
    - `POST /commerce/admin/disputes/:disputeId/decisions` (`moderate_commerce`; restores
      prior order state; no financial remedy)
- Public product/provider projections replace zeroed review placeholders with visible
  review aggregates; `completedOrderCount` comes from product-line completions;
  `onTimeShipmentRate` remains `null` until promised-delivery timestamps exist

---

## Preconditions

1. Migrations `0040`–`0051` applied and Phase 6 verify script green.
2. No speculative escrow/assurance claims in client copy.

---

## Deploy order

1. Apply migration `0052_store_phase_7_trust`:

    ```bash
    pnpm run db:migrate
    ```

2. Deploy API.

3. Verify constraints:

    ```bash
    pnpm run db:verify-store-phase-6-constraints
    pnpm run db:verify-store-phase-7-constraints
    ```

4. Smoke (authorized org / staff actors):

    - Complete an engagement or deliver a shipment → completion row appears
    - Buyer posts a review against the completion → unique per reviewer org
    - Self-counterparty / subject review attempts → `403`
    - Buyer opens a dispute → order moves to `disputed`; second open dispute → `409`
    - Staff with `moderate_commerce` closes/dismisses dispute → prior order state restored
    - Staff who is a party member cannot decide the dispute → `403`
    - Public product/provider cards show non-zero review aggregates when reviews exist

---

## Observability

- Audit events: `completion_issued`, `review_created`, `dispute_opened`, `dispute_decided`
- Append-only triggers on `commerce_completion` and `commerce_dispute_event`

---

## Rollback

1. Stop accepting Phase 7 trust writes (revert API deploy / gate routes).
2. Do **not** drop completion/review/dispute tables if production rows exist —
   forward-fix by disabling routes.
3. Migration reverse is only safe on empty Phase 7 tables in pre-production.

---

## Explicit non-claims

Do not display trade assurance, escrow, guaranteed settlement, or financial remedies
solely because a dispute or review row exists. Q&A, reports, ranking, and recommendations
remain deferred.
