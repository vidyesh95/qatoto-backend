# ESCROW_LEDGER_STRUCTURE.md — Qatoto: the entitlement ledger

> A **domain-neutral double-entry ledger** for money that moves between two parties through a
> licensed provider. It is the sibling of [BACKEND_STRUCTURE.md](BACKEND_STRUCTURE.md) (auth &
> identity), [STORE_BACKEND_STRUCTURE.md](STORE_BACKEND_STRUCTURE.md) (commerce catalog),
> [STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) (video) and
> [R_AND_D_BACKEND_STRUCTURE.md](R_AND_D_BACKEND_STRUCTURE.md) (the pipeline) — same voice, same
> layering, same envelope.
>
> **Where this came from.** This design was written as §7 of
> [R_AND_D_BACKEND_STRUCTURE.md](R_AND_D_BACKEND_STRUCTURE.md) and shipped there against
> crowdfunding pledges. That domain has since been made **fully non-custodial** — it computes what
> is owed and holds nothing (R&D §7A) — so escrow left it. The ledger itself is good and
> domain-neutral, so it is preserved here and **retargeted at the commerce domain**, where a
> buyer↔seller hold is a genuine product requirement.
>
> **Status: ⏳ not built for commerce.** No `order_*` table, route, controller, service or migration
> exists. What exists is the R&D implementation (`escrow.service.ts`, `escrow-settlement.service.ts`,
> `escrow-releases.service.ts`, `escrow-provider-adapter.service.ts`, migration 0016), which is the
> reference implementation of everything below and the thing to port.

---

## ⚠️ Read this first — Qatoto does not hold funds

**This document specifies a ledger, not a bank account.** The distinction is the whole design, and
getting it wrong is a licensing problem, not a bug.

Holding a buyer's money and paying it out to a seller later is **regulated money movement in every
jurisdiction Qatoto targets**, whether or not a fee is charged. An unpaid escrow is still an escrow.

| Jurisdiction | What custody triggers                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **US**       | State money-transmitter licensing (~49 states + DC + PR, surety bonds, multi-year process), FinCEN MSB registration (31 CFR 1010.100(ff)), a full BSA/AML program — KYC, SAR/CTR filing, OFAC screening — plus separate escrow-agent licensing in some states |
| **EU**       | A payment service under **PSD2** (Directive (EU) 2015/2366): payment-institution authorisation, own-funds and safeguarding requirements, AMLD obligations. The commercial-agent exclusion (Art. 3(b)) is read narrowly by the EBA                             |
| **India**    | RBI's Payment Aggregator authorisation — pooling and settling funds requires an escrow account at a scheduled commercial bank, net worth ₹15 crore at application and ₹25 crore by the end of the third financial year                                        |

**So the shape is: a licensed provider custodies; Qatoto's ledger mirrors.** Razorpay Route or
Cashfree Easy Split in India; Stripe Connect, Adyen for Platforms or Mangopay in the EU/US. The
provider holds the money, splits it, and is the regulated party. This ledger is the **entitlement
record** — who is owed what, why, and provably since when.

That division is stated once and holds everywhere:

> **The provider is authoritative for cash. The ledger is authoritative for entitlement. The
> suspense account is where the two are allowed to differ, in public.**

**Never** write code that takes a card number, holds a balance Qatoto controls, or pays out from an
account in Qatoto's name. If a change would make Qatoto the party holding buyer funds, it is a
licensing decision made deliberately with counsel — not a code review.

---

## 0. The one rule that governs everything

**The frontend is a hostile, untrusted presentation layer. The backend is the only source of truth.**
(Same NON-NEGOTIABLE principle as [CLAUDE.md](CLAUDE.md) §"thin client", BACKEND_STRUCTURE.md §0,
STORE §0 and R&D §0, applied to money.)

- **Identity is server-derived.** Every actor id comes from `req.user.id`, never a request body.
- **No request body ever carries a value the server owns.** Not a price, not a total, not a fee, not
  a status, not a payout destination. The client sends **ids and intent**; the server looks the real
  value up in its own rows.
- **Money never touches a float** and never leaves int4 range — `bigint` columns, integer-only
  arithmetic, one shared module so two servers compute bit-identical results.
- **Financial history is append-only and never cascades.** Deleting a user must not erase a ledger.
- **A payout destination is never client-supplied.** `destinationAccountId` in a request body is a
  wire-fraud primitive; `.strict()` rejects it. The destination resolves from the seller's
  registered provider account.

---

## 1. What it is for, in the commerce domain

A buyer pays for an order. The money must not reach the seller the instant the card clears —
otherwise there is nothing behind a dispute, a return, or a non-delivery. It is held by the provider
until a **release condition** is met, then split to the seller.

| Event                        | What the ledger records                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| Buyer checks out             | An authorization: money committed, nothing settled                          |
| Provider confirms settlement | Funds are with the provider, allocated to this order's hold                 |
| Delivery confirmed           | The hold is released to the seller's payable balance                        |
| Provider pays the seller     | The payable is discharged                                                   |
| Refund, full or partial      | A reversing entry — never an edit                                           |
| Provider and ledger disagree | A discrepancy row plus a suspense posting, so the books balance **visibly** |

---

## 2. Double-entry, not a signed single row

The naive model is one row per movement with `direction: "in" | "out"` and an amount. **Use
double-entry instead**: a journal header plus **≥ 2 signed postings whose amounts sum to zero.**

Four reasons:

1. `direction: in|out` cannot say _where_ money came from or went to — and "allocated vs released vs
   held" is literally an account-balance question.
2. Money in flight (submitted to the provider, not yet settled) has no honest single-row
   representation. With a clearing account it is simply a balance.
3. Provider-vs-ledger disagreement can be absorbed into a suspense account, so the books still
   balance while the discrepancy stays _visible_.
4. The zero-sum invariant is a machine-checkable proof that no money was conjured. A signed-amount
   table cannot offer that.

A client-facing `direction: in|out` survives as a **read projection** — the sign of the posting
against the hold account — so a simple UI does not need to understand double-entry.

## 3. The accounts

One set per **order** (the R&D implementation scoped them per project; the shape is identical).

| Account                   | Sign convention                                                    |
| ------------------------- | ------------------------------------------------------------------ |
| `buyer_clearing`          | The outside world — a source of funds, so permanently **negative** |
| `order_held`              | The pool. Positive while the hold stands                           |
| `seller_payable`          | What the seller has become entitled to but has not been paid       |
| `platform_fee`            | Retained at **zero** — see §10. Present only to keep the shape     |
| `refunds_payable`         | Owed back to the buyer                                             |
| `reconciliation_suspense` | Where a provider/ledger delta lives until a human resolves it      |

Every entry sums to zero, so the six balances sum to zero per order. That is the machine-checkable
form of "no money was conjured", and an hourly job asserts it.

> **Sign conventions must be fixed in the schema comment, not inferred.** The original §7 named six
> accounts and never fixed their signs; the implementation had to decide, and a later reader had to
> reverse-engineer the decision. Write it down where the columns are.

## 4. `escrow_journal_entry` — append-only, hash-chained

```ts
export const escrowJournalEntry = pgTable(
    "escrow_journal_entry",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        // restrict, NOT cascade — an order deletion must never erase a ledger.
        orderId: text("order_id")
            .notNull()
            .references(() => order.id, { onDelete: "restrict" }),
        // Monotonic per order from 1. A gap or reorder is immediately detectable. Allocated
        // inside the append transaction under ONE serialization point — see the note below.
        sequenceNumber: integer("sequence_number").notNull(),
        kind: escrowJournalKindEnum("kind").notNull(),
        // SERVER-COMPOSED display copy. Composed here rather than on three clients so
        // web/Kotlin/Swift cannot drift. The one deliberate display string in this domain —
        // it is prose, not a number.
        description: text("description").notNull(),
        // The business event time (provider settlement), which may lag createdAt.
        occurredAt: timestamp("occurred_at").notNull(),
        // set null, NOT cascade — deleting an order line must never delete financial history.
        linkedOrderLineId: text("linked_order_line_id").references(() => orderLine.id, {
            onDelete: "set null",
        }),
        linkedReleaseId: text("linked_release_id").references(() => escrowRelease.id, {
            onDelete: "set null",
        }),
        // Self-FK. Non-null means this entry negates an earlier one. THE ONLY CORRECTION
        // MECHANISM — nothing in this table is ever UPDATEd or DELETEd.
        reversesJournalEntryId: text("reverses_journal_entry_id"),
        // Canonical hash. Full 64-char hex; a 6-char form is display only and must never be
        // used as a key, a cache key, or an equality test — at 24 bits, collisions hit 50%
        // around 4,800 entries.
        entryHash: text("entry_hash").notNull(),
        // The prior entry's hash; the literal "genesis" at sequenceNumber 1.
        previousEntryHash: text("previous_entry_hash").notNull(),
        hashVersion: integer("hash_version").default(1).notNull(),
        // NULL for system-authored entries — most of them.
        createdByUserId: text("created_by_user_id").references(() => user.id, {
            onDelete: "set null",
        }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        // NO updatedAt column, deliberately. An append-only table has nothing to update.
    },
    (table) => [
        uniqueIndex("escrow_journal_entry_order_seq_unq").on(table.orderId, table.sequenceNumber),
        index("escrow_journal_entry_order_occurredAt_idx").on(table.orderId, table.occurredAt),
    ],
);
```

`escrow_posting` carries `signedAmountInCents: bigint("signed_amount_in_cents", { mode: "bigint" })`
— **positive into the account, negative out** — and `SUM` over one entry **must equal zero**,
asserted in the service before commit and again by an hourly job.

> **`bigint`, not `integer`.** Drizzle's `integer` is Postgres `int4`, capping at ±$21,474,836.47.
> More importantly the hash chain covers posting amounts, so widening the column later forces the
> entire historical chain to be re-derived. Get it right on day one.

**Canonical hashing** — one serialization, shared with any other chain in the codebase:

- SHA-256 over UTF-8.
- Keys emitted in a **fixed declared order**, never `JSON.stringify` insertion order.
- Integers as decimal strings; instants as ISO-8601 UTC with fixed precision; `null` explicit.
- Child collections (postings) sorted by a documented unique key before serialization.
- A `hashVersion` column on every chained row, so the algorithm can evolve without invalidating
  history.

> **The honest limit of a hash chain.** Without periodic external anchoring of the head hash to
> append-only storage under a separate credential, anyone with database write access can recompute
> the whole chain from any point forward and every verification still passes. **A hash chain is
> tamper-evident against outsiders only.** Say so in the UI; do not sell it as more.

## 5. Append-only, enforced four ways

Service-layer discipline is not enforcement. All four:

1. The application DB role has `UPDATE` and `DELETE` **revoked** on `escrow_journal_entry` and
   `escrow_posting` — hand-written SQL in the migration. This is the layer that survives a bug in
   our own code.
2. `BEFORE UPDATE OR DELETE` triggers on both tables that `RAISE EXCEPTION`.
3. No `db.update(...)` / `db.delete(...)` call against those tables exists anywhere in the service.
   The only verb is `insert`.
4. `UNIQUE(orderId, sequenceNumber)` plus the hash chain makes out-of-band tampering detectable by
   any verifier that walks the chain.

**Settlement appends; it does not edit.** A first draft of this design said settlement flips a
`settlement` column from `pending` to `settled`, then four paragraphs later revoked `UPDATE` on that
table. Both cannot hold, and the append-only rule wins because it is the one with a trigger behind
it: a settling authorization produces a `reversal` (mirroring the authorization out of the pending
bucket) plus a `settled` entry. `escrow_account` therefore carries **two balances**, pending and
settled, and "money in flight is simply a balance" becomes literally true.

**One lock, not two.** Allocating the sequence with `SELECT … FOR UPDATE` on the last entry is a
second serialization point beside whatever audit counter the domain already holds. Every money event
appends a journal entry **and** an audit entry in one transaction, so that writer would hold two
locks in an order somebody eventually gets backwards. Keep the counter and head hash on a single
per-order chain-head row and take one lock.

## 6. The money path

```text
POST /orders/:orderId/checkout        body: { paymentMethodToken }  ← provider token, never a PAN
  → server prices the order from ITS OWN rows; no amount in the body
  → creates provider_transfer with OUR randomUUID idempotency key BEFORE any provider call
  → appends `payment_authorized`, pending:
        buyer_clearing −gross · order_held +gross
  → the provider call happens in a WORKER, never in the request handler
  → 201, and nothing has settled. The pending bucket holds it.

[provider settles]
  → verify the signature BEFORE persisting; persist BEFORE processing; dedupe on
    (provider, providerEventId) by unique constraint; process in ONE transaction;
    return 200 for duplicates
  → append `reversal` (the mirror) + `payment_settled`
  → ONLY NOW does any order total or seller-facing balance move
```

`raised`/`settled` totals and `escrow_account.cachedBalanceInCents` are written by **exactly one
code path** — the settlement handler, inside the same transaction that appends the journal entry. No
controller and no user-facing service function ever touches them. That is a grep-able invariant.

**Never trust a webhook payload's amount over our own `provider_transfer` row.** The payload
identifies _which_ transfer settled, not _how much_.

Percentages are computed on read, never stored: `floor(part * 10000 / whole)` returned as
`…BasisPoints`. A stored percentage can be forged and will drift.

## 7. Release — the delivery gate and four eyes

```text
POST /orders/:orderId/escrow-releases   body: { requestNote? }   ← NO amount field
```

The amount is read from the order's own rows and **snapshotted** into `escrow_release.amountInCents`
at request time, frozen afterwards by a trigger — so nobody can edit the order between request and
approval to inflate the payout, and nobody can assert an amount at all.

Approval independently re-derives **every** gate, server-side:

- requester ≠ approver (`422 SELF_APPROVAL_FORBIDDEN`)
- the approver holds the platform escrow-audit capability, or a role they did not grant themselves
- the delivery condition is met (in R&D this was a milestone + verification verdict; in commerce it
  is delivery confirmation, or the return window elapsing with no dispute)
- no open dispute or chargeback on the order
- `order_held` balance ≥ the snapshotted amount, **re-derived from the postings** rather than read
  from the cached column

The evidence is frozen into a `verificationSnapshot` column so a later audit can prove **why**, not
merely **that**.

**Four eyes is defeated by self-granted roles.** A party cannot grant themselves the approving role,
and a role row that cannot prove who granted it has no business co-signing a payout — carry over
`roleGrantedByUserId` plus the check constraint the R&D build added.

## 8. Reconciliation

When the provider and the ledger disagree, **the ledger is not silently patched.** An hourly job
pulls provider balances, writes a `reconciliation_discrepancy` row, posts the delta into
`reconciliation_suspense` (preserving the zero-sum invariant), and alarms.

> **What reconciliation proves before a real provider is wired.** With a stub adapter there is no
> external source of truth, so the discrepancy count is trivially zero — do not read that as
> evidence the books are right. What it **does** prove hourly is the aggregate zero-sum identity
> across all accounts, which catches a posting written by anything other than the ledger service.

## 9. Remaining tables

`escrow_account`, `escrow_posting`, `escrow_release`, `provider_transfer`, `provider_webhook_event`,
`reconciliation_discrepancy`, `order_chain_head`.

`provider_webhook_event` should be **written from day one rather than reserved**, even behind a stub
adapter: record a row with `provider = 'internal_adapter'` and a deterministic event id, so the
dedupe, the persist-before-process ordering and the replay-returns-success behaviour are all
exercised on every settlement. A real provider then adds signature verification in front of
machinery that already works.

## 10. Fees and regulatory gating

**The platform fee is `0` and stays `0`.** Qatoto charges no take-rate, no subscription and no
per-seat fee to any party — buyer, seller, founder, employee or investor. `platform_fee` remains in
the account set purely so the zero-sum shape and the hash chain do not change if that decision is
ever revisited; it receives no posting, and the R&D implementation already omits a zero-value
posting entirely rather than writing a row of zeros.

Charging a fee is a **business decision that changes the legal analysis** — in several US states the
money-transmitter definition turns partly on receiving compensation for the service, and a
percentage of transaction value is the clearest form of it. Re-read the warning at the top of this
file before setting it to anything else.

Gate the whole surface at the API, not in the UI: an env-level enable flag checked before creating a
hold, before releasing one, and in any listing that would expose the surface. A disabled flow is
invisible and unusable at the HTTP layer, which makes hiding a button cosmetic rather than
load-bearing.

## 11. What already exists, and what porting means

The R&D implementation is the reference. Everything in §2–§9 is built and exercised there against a
real database — the double-entry service, the zero-sum assertion, the hash chain and its verifier,
the four-way append-only enforcement, the four-eyes release with a frozen evidence snapshot, the
provider adapter seam, the webhook-event dedupe and the reconciliation job.

Porting is a **rename plus a re-parenting**, not a redesign:

| R&D                                 | Commerce                                      |
| ----------------------------------- | --------------------------------------------- |
| `projectId`                         | `orderId`                                     |
| `provider_clearing`                 | `buyer_clearing`                              |
| `escrow_held`                       | `order_held`                                  |
| `released_to_project`               | `seller_payable`                              |
| milestone + Proof-of-Effort verdict | delivery confirmation / return window elapsed |
| `project_chain_head`                | `order_chain_head`                            |

Two things must **not** be carried over. The Proof-of-Effort verdict gate belongs to equity, not to
money owed under a contract of sale. And the R&D `platform_fee` posting path, which defaulted to 500
basis points, ships at zero here per §10.

---

## 12. Verification (when this is built)

1. `pnpm db:generate && pnpm db:migrate`, then hand-add what Drizzle cannot express: the revoked
   `UPDATE`/`DELETE` grants and the `BEFORE UPDATE OR DELETE` triggers. An untested hand-written
   migration is indistinguishable from an absent one — exercise every constraint against real rows.
2. **Zero-sum suite.** Append a few hundred entries across every kind and assert every entry sums to
   zero and every account set sums to zero. Then insert a deliberately unbalanced entry through raw
   SQL and assert the hourly job catches it.
3. **Chain suite.** Append 500 entries, verify; tamper with one row's `description` directly in SQL
   and assert the verifier returns **`409`** naming that exact sequence number — never
   `200 {valid: false}`. Delete a row and assert the gap is detected even though every surviving
   hash is self-consistent.
4. **Tampering test from the client side.** Edit an amount in DevTools and replay: there must be no
   amount field to edit on any body. Post a `destinationAccountId`, a `platformFeeInCents` and a
   `status`; each must be a `422` from `.strict()`, not a silent overwrite.
5. **Four-eyes test.** Request and approve a release as the same user → `422
SELF_APPROVAL_FORBIDDEN`. Grant yourself the approving role and retry → refused.
6. **Replay test.** Deliver the same settlement event twice; the second must return success and
   change no balance.
