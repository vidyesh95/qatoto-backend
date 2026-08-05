# Store Phase 3 rollout

This runbook covers migration `0045_tough_sunfire.sql` and the Phase 3 application
release: mixed product/service RFQs, provider invitations, immutable quote revisions,
buyer comparison, atomic quote acceptance into order snapshots, RFQ/quote negotiation
threads, and the `expire-commerce-quotes` worker.

**Status:** ready to ship after migrate + verify + smoke. Cart, inventory reservation,
direct checkout, payments, fulfillment execution, and trust metrics remain Phase 4+.

## Expand

Migration `0045` adds:

- RFQ tables (`commerce_rfq`, product/service lines, typed requirement extensions,
  invitations, document links);
- quote tables (`commerce_quote`, append-only revisions, product/service quote lines,
  typed service quote extensions including fixed-point FX rates);
- minimal quote-originated orders and immutable line snapshots
  (`commerce_order*`, `source = accepted_quote`);
- resource-scoped threads, participants, messages, and attachment metadata;
- audit event kinds for RFQ/quote/order transitions;
- append-only triggers for submitted quote revisions, messages, and order commercial
  snapshots.

## Deploy order

1. Apply migration `0045` against a production-like snapshot (`npm run db:migrate`).
2. Install/refresh job queues (`npm run jobs:install`) so `expire-commerce-quotes-tick`
   and `expire-commerce-quotes` exist before the worker schedules them.
3. Verify constraints: `npm run db:verify-store-phase-3-constraints`.
4. Deploy the application that mounts:
    - `/commerce/rfqs*`
    - `/commerce/provider/rfqs`
    - `/commerce/quotes*`
    - `/commerce/threads*`
5. Deploy/restart the worker so the hourly expiry tick is bound.
6. Smoke-test the flows below with `Idempotency-Key` on every mutating call.

Forward-only: do not reverse `0045` in place. If a release must be aborted after migrate,
keep the additive schema and roll the application binary back. Open RFQs/quotes simply
will not be reachable until the matching app is redeployed.

## Authorization prerequisites

| Action                                                    | Required active membership                        |
| --------------------------------------------------------- | ------------------------------------------------- |
| Create/open/invite/close RFQ                              | buyer, administrator, or owner                    |
| Provider RFQ queue + quote shell/revision/submit/withdraw | provider_operator, administrator, or owner        |
| Accept/decline quote                                      | buyer, administrator, or owner                    |
| Thread create/message                                     | any active member of a participating organization |

Organization ids are taken from the session active organization only. Inaccessible RFQ,
quote, order, and thread ids return `404`.

## Quote acceptance contract

`POST /commerce/quotes/:quoteId/accept` requires:

- `Idempotency-Key`
- body `{ "expectedRevision": <number> }` (strict)

Under a transaction the server locks the quote and RFQ, validates buyer authority, RFQ
`open` state, submitted latest revision, and validity deadline, then:

1. creates exactly one `accepted_quote` order with immutable money and legal-name snapshots;
2. marks the quote `accepted`;
3. marks the RFQ `awarded`;
4. declines competing submitted quotes;
5. appends audit events.

Replay of the same idempotency key returns the existing order. A stale
`expectedRevision` returns `409`. Orders are **not** payment, escrow, or assurance
claims — Phase 5 owns those words.

## Expiry worker

`expire-commerce-quotes-tick` runs hourly (`20 * * * *` UTC) and enqueues
`expire-commerce-quotes` with an explicit `asOf`. The handler:

- expires `submitted` quotes whose latest submitted revision validity deadline is past;
- expires `open` RFQs whose response deadline is past;

using guarded `UPDATE ... WHERE state = ...` predicates so retries are harmless.

## Smoke tests

Authenticated buyer org:

```http
POST /commerce/rfqs
Idempotency-Key: phase3-rfq-1
{ "title": "Need PCB assembly", "visibility": "invited_only",
  "responseDeadlineAt": "<future ISO>", "settlementCurrency": "USD",
  "productLines": [{ "requestedTitle": "Custom board",
    "requestedSpecificationSnapshot": "4-layer FR4", "quantity": 100,
    "unitLabel": "pcs", "siblingOrder": 0 }],
  "serviceLines": [] }
```

```http
POST /commerce/rfqs/:rfqId/open
Idempotency-Key: phase3-rfq-open-1
{}
```

```http
POST /commerce/rfqs/:rfqId/invitations
Idempotency-Key: phase3-rfq-invite-1
{ "providerOrganizationIds": ["<verified provider org id>"] }
```

Authenticated provider org:

```http
POST /commerce/rfqs/:rfqId/quotes
Idempotency-Key: phase3-quote-1
{}
```

```http
POST /commerce/quotes/:quoteId/revisions
Idempotency-Key: phase3-rev-1
{ "currency": "USD", "validityDeadlineAt": "<future ISO>",
  "taxInCents": 0, "serviceFeeInCents": 0, "shippingInCents": 0,
  "discountInCents": 0,
  "productLines": [{ "rfqProductLineId": "...", "quantity": 100,
    "unitPriceInCents": 250, "titleSnapshot": "Custom board",
    "specificationSnapshot": "4-layer FR4", "siblingOrder": 0 }],
  "serviceLines": [] }
```

```http
POST /commerce/quotes/:quoteId/revisions/1/submit
Idempotency-Key: phase3-rev-submit-1
```

Buyer accept:

```http
POST /commerce/quotes/:quoteId/accept
Idempotency-Key: phase3-accept-1
{ "expectedRevision": 1 }
```

Expect `201`/`200` with an order whose `source` is `accepted_quote` and
`state` is `pending_payment`. A second identical accept with the same key must replay
the same order id.

Negotiation:

```http
POST /commerce/threads
Idempotency-Key: phase3-thread-1
{ "resourceKind": "quote", "resourceId": "<quoteId>" }
```

```http
POST /commerce/threads/:threadId/messages
Idempotency-Key: phase3-msg-1
{ "bodyText": "Can you shorten lead time to 14 days?" }
```

## Verification commands

```bash
npm run db:migrate
npm run jobs:install
npm run db:verify-store-phase-3-constraints
npm run typecheck
npm run lint
npm test
npm run build
```

## Rollback

- Application rollback is safe: Phase 3 tables remain unused by Phase 1/2 surfaces.
- Do not drop `0045` tables in production after quotes/orders exist; they are commercial
  evidence.
- Worker rollback: unbound expiry queues simply stop scheduling; open RFQs past deadline
  remain open until a worker with the handler is restored.

## Out of scope (later phases)

- Phase 4: cart, inventory reservations, checkout groups, direct-checkout orders
- Phase 5: payment intents, journal, refunds, assurance language
- Phase 6: shipment legs and connector engagement execution
- Phase 7: verified reviews, disputes, provider ranking metrics
