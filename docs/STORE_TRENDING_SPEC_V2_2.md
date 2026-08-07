# The Anti-Fraud Trending & Ranking Engine — Production Spec v2.2

> **Status: built (STORE Phase 13, migrations `0073`–`0081`).**
>
> **There was no v2.1 in this repository.** No ranking specification, no ranking tables, no
> ranking code beyond one `trending_placeholder` switch arm returning an empty list. This
> document is therefore v2.2 in name — it incorporates the ten refinements as given — but it
> is written against the schema that actually exists, and every formula below either lands on
> a column this database has or is recorded in §2 as a Phase-2 hook with the exact input it
> is missing.
>
> That discipline is not pedantry. `docs/STORE_BACKEND_STRUCTURE.md` Appendix A exists
> because a field that reaches the wire and can never carry a value is worse than a missing
> one, and Phase 12 spent a whole release closing the last such field. A ranking spec is the
> easiest place in a codebase to reintroduce that failure at scale.

---

## 1. Executive Summary & Phasing Roadmap

### What this engine does

It answers one question — **what is rising** — for a B2B marketplace where demand is sparse,
orders are large, and the cheapest signals are the easiest to forge. It replaces nothing,
because nothing existed: `/store/search` ranked by `ts_rank_cd` alone and the trending rail
returned an empty array unconditionally.

### The four ideas it is built on

1. **Cost-to-forge sets the budget.** A save is one authenticated click; an order moves money
   and a refund reverses it. Orders and their freshness carry 60 of 100 points; engagement
   carries 10.
2. **A qualified order is the unit of demand.** Not an order — a *qualified* one, placed by an
   account old enough and credentialed enough to be expensive to obtain. The verdict is
   stamped at confirmation and frozen.
3. **Freshness is anchored to demand, not to listing age.** A two-year-old product with orders
   yesterday is trending. A product listed yesterday with no orders is not.
4. **Every unmeasurable value stays visibly unmeasured.** Null is never coalesced to zero, to
   one, or to a category average. It scores nothing on its own sub-budget, and the sub-budget
   is not redistributed.

### Phasing

| Phase | Contents | Status |
| --- | --- | --- |
| **1 — Launch** | Everything derivable from ETL-available data: account age, order value, refund and cancellation rates, category priors, subnet concentration *mechanism*, min-floor spike triggers, observe-only circuit breaker | **Shipped** (`0073`–`0081`) |
| **2 — Roadmap** | Real-time buyer↔seller graph linkage, device fingerprinting, streaming MAD, a defined `fraud_risk_score`, the verified-corporate-domain corpus, read replicas, T-Digest | **Not built.** §2 names each missing input |

**Conflict priority, as specified: fraud safety over hourly performance.** Where the two
disagree — the per-category transaction, the exact `percentile_disc`, the row locks on the
view beacon — this engine pays the latency.

### The one thing to understand before reading further

**The circuit breaker cannot fire at launch.** Refinement 9 requires all four clauses, and
the fourth, `fraud_risk_score > threshold`, has no definable input on this platform: every
component that would produce it is itself inert. The guard returns `not_evaluated` and names
the missing input rather than defaulting it true. The breaker therefore fails closed against
*itself* rather than against sellers, which is the correct direction, and it ships
observe-only so its would-fire rate is countable before it is ever allowed to fire.

---

## 2. Updated Production Specification v2.2

### A. Architecture Goals

1. Prevent click-farm, botnet, self-dealing, penny-spam, refund-abuse and supplier
   manipulation from moving a rank.
2. Preserve the transactional integrity of Search Rank — **an anti-fraud penalty must never
   make a product unfindable by its own exact title.**
3. Make Trending reflect recent demand momentum, not catalog age.
4. Solve B2B cold-start and sparse categories without surfacing fabricated statistics.
5. Do not punish legitimate corporate buyers, shared networks, low-price accessories, or
   high-volume low-conversion commodities.
6. Stay inside an hourly batch window over the whole catalog.

### B. Search Rank vs Trending Discovery Isolation

**They share no scorer, no table, and no job step, and there is no import edge between
them.**

| | Search Rank | Trending Discovery |
| --- | --- | --- |
| Question | "what matches the words I typed" | "what is rising" |
| Computed | per request, over a GIN index | hourly, in batch |
| Input | `ts_rank_cd` over the weighted tsvector | qualified demand, freshness, conversion, trust, engagement |
| Sort key | `sort=relevance` | `sort=discovery`, and the rail |
| Reads the other's value | never | never |

A blended sort is a **third, explicitly named** option or it is not offered.

The reason is not aesthetic. Multiplying a query-dependent relevance by a query-independent
batch score makes every relevance bug look like a ranking bug — and it leaks an anti-fraud
penalty into a query the buyer typed by name, so a seller penalised for subnet concentration
becomes unfindable by their own product's exact title. That is a support incident, not a
ranking outcome.

> **The invariant, stated once:** an enforcement penalty may lower a product's position in a
> discovery rail; it may never lower its position in a query the buyer typed. Exact-match
> findability is a floor.

Accordingly `store_search_document.discovery_score_points` carries the **pre-enforcement base
score**, and enforcement is applied by the rail. On seeded data the difference is visible: the
click-farm product appears fifth in `sort=discovery` by base score and is demoted in the rail
by its ×0.5 subnet multiplier.

### C. Qualified Signal Definitions

Nothing below counts unless it is *qualified*.

**Qualified buyer** — evaluated once, at order confirmation, and frozen on
`commerce_order.buyer_qualification_state`:

- the acting user's account is **at least 7 days old** at confirmation, **AND**
- at least one credential: a prior order older than 7 days, a `verified_business` email
  domain, an approved `business_registration`/`tax_registration`, or a
  registration/tax identifier on file.

**Hard disqualifiers**, short-circuiting: a sample-only order (A17 samples bypass the tier
ladder and the MOQ — they are the negation of bulk, not demand), an organization that is not
`active`, an organization on `commerce_organization_ranking_exclusion`, a better-auth
anonymous account, or a `disposable` email domain.

> **Why frozen and not recomputed.** Evaluated at read time, a buyer registering a tax
> identifier today would retroactively qualify every order it has ever placed — turning a
> fraud filter into a one-click amplifier for exactly the party it constrains.

**Qualified order** — an order whose buyer qualified, with a non-null `confirmed_at`.

**Counted view** — a `commerce_product_view_session` that cleared the 5-second dwell
threshold. Anonymous sessions count toward views (real traffic) and **never** toward
conversion (nobody to match an order to).

**Counted share** — signed-in only, one per user per product per UTC day. Anonymous shares
are recorded and never counted.

**Windows** — `W1` = days 1–7 before `asOf`; `W2` = days 8–14. Both over `confirmed_at`.

### D. Three-Tier Momentum Engine

**Tier 1 — eligibility.** No qualified order in W2 ⇒ **ineligible**, not zero-scored. The
scorer returns a union member so a caller cannot rank it by accident. A decay curve alone
would still surface a product that sold well three weeks ago and nothing since, which is
precisely what "trending" must not mean.

**Tier 2 — the base score, 100 points.**

| Component | Budget | Ladder input |
| --- | --- | --- |
| `qualifiedVelocity` | 40 | qualified orders in W1 |
| `demandFreshness` | 20 | days since the last qualified order (`atMost`) |
| `conversionQuality` | 15 | smoothed conversion, basis points |
| `sellerTrust` | 15 | split 10 measured / 5 standing — see below |
| `buyerEngagement` | 10 | distinct savers in W1 |

`sellerTrust` splits because a null measured rate must score 0 without redistributing its
budget, and 15 points of newness tax is punitive in a market where sellers are new for a long
time. `verifiedStanding` reads facts that are never null — active trade state (2), an approved
registration verification (2), a live certification (1) — so a new-but-verified seller earns 5
immediately and the remaining 10 become earnable by shipping on time.

**Tier 3 — multipliers**, all basis points, all bounded ≤ 1.0, applied after the sum and
floored:

`subnet × orderValue × refund × cancellation × enforcement`

`commerce_product_trending_snapshot_penalty_ck` asserts `final ≤ base` in the database, so a
penalty cannot promote even if the scorer is wrong.

### E. Anti-Fraud Circuit Breaker

Fires only when **all four** hold:

| Clause | Status |
| --- | --- |
| (a) dynamic spike flag | computable — min-floor now, MAD once the daily series matures |
| (b) conversion < 0.20 × category average | computable |
| (c) qualified orders < 10 **or** distinct buyers < 10 in 7d | computable |
| (d) `fraud_risk_score > threshold` | **NOT COMPUTABLE** |

Every clause is evaluated, never short-circuited, so the observe-only period can count each
independently. An unevaluated clause is never counted as passing.

Actions: `weight_reduced`, `capped`, `quarantined`, `review_queued`. **Nothing deletes or
delists** — that is a commercial action requiring a human, the call Phase 10 made when it
refused to let an automatic report hide a product. The default automatic action is
`review_queued`, which carries a ×1.0 multiplier: queueing a review is not itself a
punishment.

### F. Sparse Category / B2B Fallback

A category with fewer than **30 qualified orders in 30 days** has percentile momentum
disabled and is scored in `sparse_exploration` mode. On a young B2B catalog **this is the
common case, not the exception** — on the seeded fixtures, four of five categories are in it.

Exploration **bands by ten points, then rotates deterministically** within a band using a
stable hash of `(productId, asOf)`. It never uses `random()`, which would break the
determinism assertion. An earlier version sorted purely on the hash and put a category's
strongest product third behind two weaker ones — that is randomisation, not exploration, and
it teaches sellers that ranking is arbitrary.

`ranking_mode` is stored on every snapshot row, and the phase verifier asserts no product
with zero qualified W2 orders ever appears claiming `percentile`. That assertion exists
because the single most likely regression in this engine is someone "fixing" an empty rail by
loosening the qualified-order gate.

### G. Data Pipeline and Performance

```
02:50 UTC  rollup-commerce-product-daily-signal   → commerce_product_daily_signal
03:00 UTC  recompute-commerce-category-demand     → commerce_category_demand_snapshot
:12  hourly recompute-commerce-product-trending   → trending snapshot, ranking state,
                                                     enforcement events, search score
```

Each is a tick/real pair through pg-boss, the house contract: the tick quantizes the clock and
enqueues the real job with an explicit `asOf`, so a run is replayable from the queue and a
double cron fire inside one period dedups to one job id. `new Date()` is called in exactly one
place — the tick handler, through an injected `ClockReader`.

Minute `:12` is unoccupied at every hour (`:05`, `:18`, `:20`, `:35`, `:50` are taken); an
hourly job must not meet a nightly one 365 times a year.

**Specified but not available:** T-Digest (only `citext` is installed; exact `percentile_disc`
over the qualified sample is the specification's own permitted fallback, and cheap because a
category below the floor is in exploration anyway) and read replicas (one `Pool`, no replica
DSN).

### H. Monitoring and Governance

- Every raw input **and** every component is stored beside the total, so a ranking is
  auditable from one row rather than by re-running the job against data that has moved.
- `score_algorithm_version` on every row. Version `0` marks a pre-gate run — fewer than 14
  days of confirmation history, where W2 measured a period that did not happen — and **every
  read path refuses it**.
- Every rate stores its **sample size**. "Scored 0 because unmeasurable" and "scored 0 because
  genuinely 0%" stay distinguishable in the stored row forever.
- The would-fire rate is one query: `commerce_ranking_enforcement_event` grouped by `action`
  over `as_of`.
- Determinism: run a job twice at one `asOf` and every component must match.

### I. Human-in-the-Loop & Appeals Engine

`commerce_product_ranking_enforcement` is a **separate table from the snapshot** precisely so
a moderator's decision survives the scorer truncating and rewriting its own output every hour.

`action_source` is bound in both directions: `automatic` names nobody (because
`platform_audit_entry.actor_user_id` is NOT NULL and an automatic action has no actor —
rather than weaken that hash chain, Phase 10's `commerce_moderation_action` pattern is
reused), `moderator` must name someone. `reason` is required and length-checked: an
enforcement without an explanation is not appealable, and an unappealable suppression is how
a marketplace loses honest sellers.

---

## 3. Definitions and Data Contract

| Table | Role |
| --- | --- |
| `commerce_product_view_session` | one row per viewer per product per UTC day; the anti-replay unique index is the boundary |
| `commerce_product_daily_signal` | the per-product time series the MAD baseline is measured against |
| `commerce_category_demand_snapshot` | priors, medians, p90 gates, per `(category, currency)` |
| `commerce_product_trending_snapshot` | append-only audit history; components + inputs + multipliers |
| `commerce_product_ranking_state` | the live row a rail reads; cleared and re-set hourly |
| `commerce_product_ranking_enforcement` | current suppression; outlives the hourly run |
| `commerce_ranking_enforcement_event` | every evaluation, including `action = 'none'` |
| `store_search_document.discovery_score_points` | the denormalized **pre-enforcement** base |

**The null contract, stated once and applied everywhere:**

| Value | `null` means | It does **not** mean |
| --- | --- | --- |
| `discovery_score_points` | not scored | score 0 |
| `unique_viewer_count` | no rollup has run | no unique viewers |
| `conversion_rate_bp` | no signed-in viewers | 0% conversion |
| `seller_on_time_rate_bp` | below its sample threshold | ships late |
| `subnet_concentration_bp` | too few hashed observations | low concentration |
| `median_order_value_in_cents` | no qualified orders in that currency | orders are worthless |
| `buyer_qualification_state = 'unevaluated'` | predates Phase 13 | failed the bar |

**Money and rates:** integer cents and integer basis points, end to end. `percentile_disc`,
never `percentile_cont` — an interpolated percentile invents a value no order ever had.

**Currency:** every median is keyed by `(category, currency)`. This backend has no FX quote
anywhere (§15.7 refuses to invent one even for a pathway's set total), so a cross-currency
median would be a fabricated conversion. **No median means no penalty.**

---

## 4. Formulas and Pseudocode

```
eligible(p)          := qualified_orders_W2(p) > 0
demand_age_days(p)   := floor((asOf - last_qualified_order_at(p)) / 1 day)

base(p) := ladder_atLeast(velocity,  qualified_orders_W1(p))          -- 40
         + ladder_atMost (freshness, demand_age_days(p))              -- 20
         + ladder_atLeast(conversion, smoothed_conversion_bp(p))      -- 15
         + measured_trust(p) + verified_standing(p)                   -- 10 + 5
         + ladder_atLeast(engagement, distinct_savers_W1(p))          -- 10

smoothed(p) := confidence * observed + (1 - confidence) * prior
               where confidence = n / (n + 30),  n = signed-in counted viewers
               and prior walks: category -> parent -> global -> 5000 bp floor

subnet_mult(p)  := hashed < 20            ? NOT MEASURED (1.0)
                 : concentration <= 0.5   ? 1.0
                 : max(0.5, 1 - concentration)        -- floor, see §9
value_mult(p)   := median is null ? 1.0
                 : clamp(avg_order_value_W2 / category_median, 0.10, 1.0)
refund_mult(p)  := tiered on (observed_rate / category_p90), sample >= 10
cancel_mult(p)  := same shape

final(p) := floor(base(p) * subnet * value * refund * cancel * enforcement)
            bounded to [0, base(p)]

spike_threshold := sample < 14 ? floor
                 : max(floor, ceil(median + 2 * 1.4826 * MAD))
```

Ordering within a category:

```
percentile mode:   final DESC, qualified_orders_W1 DESC, productId ASC
exploration mode:  floor(final/10) DESC, stableHash(productId, asOf) ASC, productId ASC
```

The final tiebreak is a unique value on purpose:
`commerce_product_trending_snapshot_rank_unq` makes a tie an **insert failure**, not an
arbitrary order.

---

## 5. Edge Cases

| Case | Behaviour |
| --- | --- |
| No qualified order in W2 | Ineligible. Absent from the rail entirely |
| Product in a currency its category has no median for | No value penalty. Never a guessed median |
| Seller with no measured on-time rate | 0 of 10 measured points, budget **not** redistributed; standing still earns up to 5 |
| Fewer than 20 hashed saves | Subnet guard skipped and recorded as `not_measured` |
| Perfectly flat baseline (MAD = 0) | The min floor governs; a product does not spike by moving at all |
| Category under 30 qualified orders | `sparse_exploration`; percentile momentum disabled |
| Fewer than 14 days of `confirmed_at` history | Rows written at version `0`, refused by every read |
| Self-dealing (buyer = seller org) | Excluded; completions already refuse it structurally |
| Product suspended after the last run | Vanishes from the rail — resolution goes through the same public-eligibility path as every other rail |
| Two beacons racing on one session | `FOR UPDATE`; the counted-view transition happens once |
| Replayed settlement webhook | `coalesce(confirmed_at, …)` — the instant is not rewritten |

---

## 6. Implementation Notes

- **Pure modules** hold every arithmetic decision: `commerce-trending-score.ts`,
  `commerce-ranking-multipliers.ts`, `commerce-category-prior.ts`, `commerce-fraud-guard.ts`,
  `commerce-robust-statistics.ts`. The service reads, delegates, and writes.
- Multipliers live in a **separate module** from components, because components add and
  multipliers reduce, and mixing them is how a penalty becomes a boost in a refactor.
- Budgets are asserted to sum to 100 **at module load**, not only in a test: a table summing
  to 99 would make a perfect score unreachable and silently shift every rank.
- `node-postgres` returns `bigint` as a **string**. Row types must say so — a type that
  claims `number` makes the necessary conversion look redundant to a linter, which is exactly
  how it got removed once.
- The search-document score is protected by a trigger keyed on
  `current_setting('qatoto.ranking_writer')`. The verify script attempts a write **without**
  it and asserts nothing moved: a trigger whose body is wrong still appears in `pg_trigger`.

---

## 7. Business Validation & Monitoring Metrics

| Metric | Query shape | Healthy |
| --- | --- | --- |
| Would-fire rate | enforcement events grouped by `action` | Known before enforcement is enabled |
| Unevaluated-clause rate | `unnest(unevaluated_clauses)` | `fraud_risk_above_threshold` on ~100% at launch — expected |
| Exploration share | `ranking_mode` distribution | High early; falling as categories cross 30 |
| Prior-level distribution | `prior_level` on the demand snapshot | `default_floor` rare; if common, the taxonomy is empty |
| Sample coverage | non-null rate columns ÷ rows | Rising for subnet over months; never backfillable |
| Ranking churn | rank movement hour over hour | Stable; violent churn means a threshold is at a cliff |

---

## 8. Test Cases

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | Honest bestseller: steady qualified demand, good trust | Ranks at or near the head of its category |
| 2 | Click farm: 40 saves, 38 from one subnet | Subnet multiplier applied, enforcement event written |
| 3 | Corporate NAT: same concentration, verified domain | **Currently penalised identically** — the exemption does not exist; the floor is what bounds the damage |
| 4 | Penny spam: many tiny orders vs the category median | `value_mult` toward its 0.10 floor |
| 5 | Self-dealing: seller's own org orders its product | Excluded from velocity |
| 6 | Spike, no conversion: 900 views, no qualified orders | Ineligible; breaker records `would_fire`-shaped clauses with (d) unevaluated |
| 7 | Sparse category: under 30 qualified orders | `sparse_exploration`, never `percentile` |
| 8 | Stale surge: volume 20 days ago, nothing since | **Ineligible**, not merely decayed |
| 9 | New verified seller, no measured on-time rate | Earns standing points; measured share scores 0, not redistributed |
| 10 | Cross-currency product, no category median | No value penalty |
| 11 | Determinism: same `asOf` twice | Byte-identical components |
| 12 | Unprivileged write to `discovery_score_points` | Silently reverted; 0 rows changed |
| 13 | Pre-gate run (<14 days history) | Version `0`; rail stays empty |
| 14 | Tie on final score within a category | Broken by product id; the unique index never raises |

Scenarios 1–8 are seeded fixtures in `scripts/seed-store-ranking-dev.ts`; 9–14 are asserted by
`db:verify-store-phase-13-constraints` and the unit suites.

---

## 9. Pre-Implementation Risk Review

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | Someone "fixes" an empty rail by loosening the qualified-order gate | Exploration is the default path, `ranking_mode` is stored on every row, and the verifier asserts no percentile row without qualified W2 demand |
| 2 | The 14-day dependency treated as an ordering, not a calendar, dependency | The run writes version `0` before the gate and logs a refusal; reads filter it |
| 3 | **The subnet penalty defames a corporate NAT** | Minimum 20 hashed saves; penalty floored at 0.5 rather than the specified 0; rail-only, never search; every application is an event so the false-positive rate is countable. **This is the strongest disagreement with the ten refinements as written** |
| 4 | `ALTER TYPE … ADD VALUE` is irreversible | Both rail strategies added once, in `0073`; `trending_placeholder` kept forever so rollback is a data edit |
| 5 | `discovery_score_points` clobbered by a product edit | Trigger + verify assertion; residual risk is a raw write with the setting on, detectable via `discovery_score_computed_at` |
| 6 | A float reaches a column and breaks determinism | Basis points throughout, integer division once in SQL, `percentile_disc`, guards at every module entry |
| 7 | Snapshot growth | Top-N per category; retention on the snapshot and the daily series |
| 8 | The engine is trusted because it is thorough | It is validated on **synthetic** data. Thresholds are not evidence-based yet, and §7's metrics are what would make them so |

---

## Appendix — what v2.2 does not implement, and the exact missing input

| # | Clause | Missing input |
| --- | --- | --- |
| 1 | `Chargeback_Rate_30d` | No chargeback row exists. `payment_intent.disputed` is declared and never written. **Do not add a nullable column** — add it the day a real processor's webhook lands |
| 2 | Device fingerprinting / diversity | No device or UA column on any commerce row; storing one is a §14 privacy decision |
| 3 | High-linkage order exclusion | No table relates two accounts by any shared attribute |
| 4 | `fraud_risk_score` | Undefined, and every candidate component is itself inert |
| 5 | Internal/test/blocked exclusion | No flag exists and no process would keep one current. `commerce_organization_ranking_exclusion` ships empty |
| 6 | Verified-corporate-domain qualification **and** the §E subnet exemption | No corpus. A denylist is obtainable; an allowlist of every legitimate company domain is not |
| 7 | Category-specific half-life | No observed per-category repurchase interval. One global ladder |
| 8 | MAD baseline | Needs the daily series to accumulate. Min floors govern until then |
| 9 | T-Digest quantiles | Only `citext` installed; exact `percentile_disc` is the permitted fallback |
| 10 | Read replicas | One `Pool`, no replica DSN |
| 11 | Session quality | No join path from a commerce engagement row to a session |
| 12 | Full empirical Bayes | Estimating `k` needs between-category variance. Fixed `k = 30`, with `prior_level` recorded |
| 13 | The subnet guard as an **effective** signal | Historical IPs were never stored and are unrecoverable. The mechanism ships; the signal accumulates |
