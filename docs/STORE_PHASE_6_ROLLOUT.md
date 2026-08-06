# Store Phase 6 Rollout — Connector Execution

Shipment legs, typed service-engagement execution snapshots/deliverables, command
idempotency receipts, and derived order fulfillment progress.

**Status:** Shipped and hardened through additive migrations `0048`–`0050`.

This phase does **not** add external carrier/customs/insurance/lab adapters, webhooks,
outbox workers, or trade-assurance claims. Commands are operator-driven against
platform-owned evidence documents and typed contractual snapshots.

---

## What ships

- Tables: `commerce_shipment_leg`, `commerce_shipment_leg_event`,
  `commerce_service_engagement_event`, `commerce_fulfillment_command`, typed engagement
  detail tables, `commerce_engagement_deliverable` (+ events), typed deliverable detail
  tables, and normalized `commerce_quote_service_deliverable_plan`
- Columns: `commerce_shipment.version`, `commerce_service_engagement.version` +
  `execution_contract_state`, `commerce_order_service_line.source_quote_service_line_id`
- Quote handoff: every service quote line requires exactly one typed `serviceDetail`;
  accept copies the snapshot and structured contracted deliverable plans into the engagement
  execution tables (or leaves `legacy_missing_snapshot` when no deterministic typed history
  exists)
- Hardening: transaction-scoped command idempotency locks, tenant-safe logistics linkage,
  terminal-state role guards, parent shipment/order reconciliation, paired money/currency
  constraints, immutable snapshot `TRUNCATE` rejection, and typed detail/result reads
- Routes:
    - `GET /commerce/orders/:orderId/fulfillment` (derived progress; not client-writable %)
    - `GET /commerce/shipments/:shipmentId`
    - `GET /commerce/service-engagements/:engagementId`
    - `POST /commerce/orders/:orderId/shipments` (optional immutable `legs`)
    - `POST /commerce/shipment-legs/:legId/commands` (`Idempotency-Key` + `expectedVersion`)
    - `POST /commerce/service-engagements/:engagementId/commands`
    - `GET /commerce/shipment-legs/:legId/events`
    - `GET /commerce/service-engagements/:engagementId/events`
    - Phase 4 `POST /commerce/service-engagements/:engagementId/transitions` retained as a
      compatibility adapter that still enforces typed completion gates

---

## Preconditions

1. Migrations `0040`–`0047` applied and Phase 5 verify script green.
2. No speculative connector provider credentials required.

---

## Deploy order

1. Apply migrations `0048_store_phase_6_connector_execution`,
   `0049_store_phase_6_hardening`, and `0050_store_phase_6_typed_contracts`:

    ```bash
    pnpm run db:migrate
    ```

2. Deploy API (no new worker queues in this phase).

3. Verify constraints:

    ```bash
    pnpm run db:verify-store-phase-6-constraints
    ```

4. Smoke (authorized org actors):

    - Append a quote revision with typed `serviceDetail` → accept → engagement
      `execution_contract_state = ready` and matching detail row present
    - Create a shipment with optional `legs` → leg sequences unique, events append-only
    - `POST /commerce/shipment-legs/:legId/commands` with `book` → `depart` → `arrive` →
      `complete`; replay same `Idempotency-Key` + fingerprint → same response; changed body
      with same key → `409 IDEMPOTENCY_CONFLICT`
    - Stale `expectedVersion` → `409 VERSION_CONFLICT`
    - Engagement with `legacy_missing_snapshot` cannot start/complete until `initialize`
    - `complete` blocked while required deliverables are not accepted/waived
    - `GET /commerce/orders/:orderId/fulfillment` returns counts + basis points only

---

## Compatibility notes

- Phase 4 shipment event append remains for shipments **without** legs. Shipments that
  already have legs must advance via leg commands; terminal shipment events are rejected.
- Phase 4 engagement transitions remain, but `completed` fails closed when required
  deliverables are incomplete or the engagement is `legacy_missing_snapshot`.
- Progress is computed synchronously from product fulfillment, non-cancelled legs, and
  engagement states. Clients must not POST a completion percentage.

---

## Explicit non-claims

Do not display assurance that customs clearance, insurance coverage, lab certification,
FX settlement, or carrier delivery is guaranteed solely because a command or deliverable
row exists. No external provider protocol is wired in Phase 6.

---

## Rollback

1. Stop accepting Phase 6 command writes (revert API deploy / gate routes).
2. Do **not** drop append-only event/command/detail tables if production rows exist —
   forward-fix by disabling routes.
3. Migration reverse is only safe on empty Phase 6 tables in pre-production.

---

## Invariants to re-check after deploy

- Leg sequences unique per shipment; leg/engagement/deliverable events gapless by sequence
- Fulfillment command receipts unique on `(actor_organization_id, idempotency_key)`
- Typed engagement detail rows match `provider_kind`
- Accepted quote deliverable plans retain their source line and unique per-line sequence
- Optional insurance/FX amounts always carry explicit paired currencies
- `ready` engagements have a typed snapshot; `legacy_missing_snapshot` engagements do not
  invent one
- Append-only triggers reject UPDATE/DELETE/TRUNCATE on event, command, and engagement
  detail tables
