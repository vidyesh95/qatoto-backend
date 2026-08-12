# Store Phase 14 — external settlement, document scanning, and the legacy cleanup

> Migrations `0082`–`0089`. Applied. `18/18` constraint checks and `34/34` HTTP smoke checks
> pass against a live database; `1773` unit tests, typecheck and lint are green.

## What decided this phase

§14's custody question, and it was decided against the shipped ledger.

**Qatoto provides no escrow and never holds funds.** Two parties who want to trade cheaply
transact directly and carry the counterparty risk themselves — that is the default and it
stays the default. Parties who want the risk reduced discuss it in the thread they are
already using, agree on a licensed third-party provider, and opt in **together**. Qatoto is
the venue and the record-keeper, never the holder.

Three consequences followed immediately, and all three are structural rather than advisory:

- **`buyer_clearing → order_held` asserts custody that is now ruled out.** That posting is
  not merely unfunded; it is unusable. `internal_custody` is frozen, refuse-closed in
  production and kept forever so backing this phase out is a data edit rather than a deploy.
- **`seller_payable` stays unposted, and the verifier asserts that it does.** It means
  "Qatoto owes the seller money it is holding," which under no-custody can never be true. Its
  honest mirror is `platform_fee_receivable`.
- **Escrow is never auto-selected, silently applied, or silently dropped.** Its absence is
  the normal case and is legible on the wire as `hasEscrowProtection: false`.

## The rails

| Rail | Settles by | Qatoto observes | Journal |
| --- | --- | --- | --- |
| `direct_offline` | default; T/T, L/C, whatever the parties arranged | nothing | commission only; movements are party **attestations** |
| `direct_processor` | processor, buyer → seller, seller is the settlement account | processor webhooks | commission + memo funding/release |
| `external_escrow` | a licensed third party, against milestones | escrow webhooks | commission + the full memo custody chain |
| `internal_custody` | **frozen** | — | refuse-closed in production |

`direct_offline` posts **no settlement entries at all**, and that is the answer rather than a
gap. Qatoto cannot observe a wire between two banks it has no relationship with, and writing
a memo entry for money it did not see would assert a fact from an absence — the error A16
refused when it returned an empty estimate array instead of a zero.

**The `direct_processor` row of that table was a PROMISE until Phase 24 (A41), not a description.**
This phase permitted those accounts and minted the `direct_settled` entry kind for them; nothing
posted either, because `applyPaymentSettlement` still wrote the frozen rail's
`buyer_clearing → order_held` on every rail — so from this phase until Phase 24 no payment settled
at all, on any rail. Phase 24 wrote the posting, refused a payment intent on the two rails that take
none, and moved `recognizeCommission` out of the escrow service so the "commission" half of the row
is true on both rails.

## The rule the accounting rests on

`applyNormalizedEscrowEvent` is the **only** function that moves a settlement balance.
Commands do not. A release request tells the provider what we would like; it does not credit
anybody, because at that moment nothing has happened to the money.

The reconciler therefore has no apply path of its own — it polls for the event the webhook
did not bring and hands it to the same function. A poll and a webhook being two ways to move
money would disagree in precisely the case that matters, a redelivery racing a
reconciliation, and one of them would double-post.

One identity governs every rail that moves money, asserted per order by the verifier:

```
settlement_funding_memo + settlement_custody_memo
  + settlement_released_memo + settlement_refunded_memo = 0
```

## Five things the specification did not anticipate

**`ensureCommerceJournalAccounts` was a live blocker.** It created all six legacy accounts
unconditionally, which the new rail guard rejects for any order not settling through Qatoto's
own custody — every escrow order would have failed at its first posting. It is rail-aware
now, mirroring the trigger in a map that fails fast and legibly; the trigger remains the thing
that cannot be bypassed, but it can only report a constraint name from inside a rolled-back
transaction.

**A successful checkout could return 500.** `scheduleConnectorDispatch` runs after the
transaction commits, and with the new queue not yet installed `sendJob` *threw* rather than
returning a failed `Result`. The buyer received a 500 for an order that had in fact been
placed — the worst available answer, because a retry places a second one. Neither that
function nor `scheduleDocumentScan` can throw now.

**A consumed agreement permanently blocked its thread.** Spent terms are history, and the
same buyer ordering from the same seller next month is ordinary repeat business; the original
behaviour meant a thread could carry exactly one escrowed order for its entire life.

**Migration `0088` created a duplicate index and `0089` removes it.** Rescoping
`product_seller_sku_unq` onto `(seller_organization_id, sku)` looked like it preserved SKU
protection — but `0041` had already built `product_sellerOrganization_sku_unq` over exactly
those columns. `0088` is left as applied rather than edited: drizzle hashes each migration,
and rewriting one that has run invites re-application.

**The commerce foundation verifier was silently wrong**, hidden behind the missing-column
error the `seller_id` drop exposed. Its category check asserted `category_id` equals the root
derived from the legacy enum — true of every product Phase 0 backfilled, false of every
product created since, because Phase 1 requires an active leaf. 14 of 17 products read as
mismatched and all 14 were correct.

## Deploy order

```
npm run db:migrate          # 0082-0089
npm run jobs:install        # THREE new queues in 14a, TWO more in 14b, plus two crons
npm start / npm run start:worker
```

`jobs:install` is not optional. Without it the connector outbox is written and never
dispatched, so an escrow session never reaches its provider — which is exactly how the 500
above was discovered.

**`0088` must be deployed AFTER the code that stops using `product.seller_id`,** not with it.
The column is NOT NULL, so an old application instance still inserting without it fails the
moment the migration lands. The commit preceding it removes every writer and reader.

Two environment variables are new. `COMMERCE_PLATFORM_COMMISSION_BASIS_POINTS` defaults to
`0`, and zero means **nothing is posted** rather than a zero-value entry — the commission
mechanism ships in this phase and the policy does not. `COMMERCE_DOCUMENT_SCANNER` defaults
to `fake`. A provider's webhook signing secret must be in the **server's** environment; the
registry row holds the variable's name and never its value.

## Verification

```
npm run db:verify-store-phase-14-constraints    # 18/18
npm run db:smoke-store-phase-14                 # 34/34, needs a running server and worker
npm run db:verify-commerce-foundation-constraints
```

The smoke asserts refusals as hard as successes, because the refusals are the product: a
proposer cannot accept its own terms, an unsigned or tampered webhook cannot move money, a
replay cannot move it twice, and a lapsed agreement refuses a checkout rather than quietly
downgrading it.

## Phase 14b — document scanning

A18's customization artwork could never be attached to an order. Uploads land `pending_scan`,
`resolveCustomizationSelections` refuses anything not `available`, and the only promoter
required a pending verification row that artwork never has. **A product with a required
upload slot could not be checked out by anybody.** Phase 12 certificates were stuck the same
way.

Promotion is now by document rather than by walking a verification row, the scan runs on
plaintext decrypted in memory, and `unscannable` is a third verdict that leaves the document
pending for a human. Promotion means "not malware" and nothing more — a verification is still
approved by a moderator.

The scanner fake resolves in production, unlike the payment and escrow fakes. Refusing to
resolve means refusing to scan, and an unscanned document stays pending forever, which
re-breaks the very thing this fixes.

## Phase 14c — the four connector seams

`logistics`, `insurance`, `laboratory`, `foreign_exchange`: the last four files §3 named and
the repository did not have. **Seams, not integrations** — no provider is contracted, the
fakes are the only implementations, and nothing in the order or engagement state machines
calls them.

FX carries the one hard correctness rule. §4.7 forbids floating point for money and rates, so
a rate is `{units: bigint, scale}` and rounding is **down and stated**. The laboratory fake
always answers `REPORT_NOT_READY` and never a synthetic pass: a fixture answering "passed"
would be a fabricated certification, which is the one category of fake output a comment
cannot make safe.

## Still open

- **§14's assurance copy remains blocked.** Nothing here entitles the frontend to render
  `sections/trade-protection.tsx`. "An external licensed provider holds the funds for this
  order" is true and sayable; "Qatoto guarantees your money" is not, and on the default rail
  neither is anything at all.
- **Commission collection mechanics** — receivable-then-invoice, which works on every rail,
  or a processor application fee, which works only on `direct_processor`. Phase 24 made the
  ACCRUAL reach both live rails; how the receivable is collected is still undecided, and
  `settlementAccountRef` / `applicationFeeInCents` stay unset until it is.
- **`product.category` and the `product_category` enum**, which are on the Studio wire and
  need a frontend decision before the column can go.
- **Wiring the four connector seams** into the Phase 6 engagement state machines, once a
  provider is signed.
