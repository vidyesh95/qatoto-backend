# STORE Phase 13 — ranking, trending and recommendations

Migrations `0073`–`0081`. Specification: [`STORE_TRENDING_SPEC_V2_2.md`](STORE_TRENDING_SPEC_V2_2.md).

## The gap this phase closes

`store-merchandising.service.ts` had a rail strategy that returned an empty list
unconditionally, and had since Phase 1. Behind it sat the larger absence: `/store/search`
ranked by `ts_rank_cd` alone — lexical relevance with no demand, no trust and no recency —
and recommendation *selection* did not exist beyond reading `commerce_product_relation`.

§12 had deferred ranking since Phase 9. This is it.

## What ships

**Signal capture (`0073`–`0078`).** A product view beacon (`commerce_product_view_session`,
ported from `video_view_session`), a view counter, salted subnet hashes on engagement and
share rows, durable `confirmed_at`/`completed_at`/`cancelled_at` on `commerce_order`, the
trusted-buyer verdict stamped at confirmation, and the email-domain and ranking-exclusion
lookups.

**Scoring (`0079`–`0080`).** Per-category demand statistics; an append-only trending
snapshot carrying every component and every raw input; the live ranking state a rail reads;
enforcement and its event log; and the per-product daily series the spike baseline is
measured against.

**Surfaces (`0081`).** `trending` and `recommended` rail strategies, `sort=discovery` on
`/store/search`, and the denormalized score with the trigger that protects it.

**Development seed.** `pnpm db:seed-store-ranking-dev` writes 120 days of backdated history
and eight named fraud fixtures, because every signal here is a time series and a fresh
database produces nothing for two weeks.

## Decisions worth knowing

**The subnet penalty has a floor of 0.5, not the specified `max(0, 1 - concentration)`.** One
procurement team behind one office NAT produces the same concentration as forty scripted
accounts, and the corpus that would separate them — verified corporate domains — cannot be
built from a denylist. On the seeded fixtures the click farm reads 0.98 and the corporate NAT
0.91, and nothing in this schema can tell them apart. Until it can, the worst this signal does
is halve a score.

**The circuit breaker cannot fire, and ships observe-only anyway.** Its fourth clause has no
definable input; the guard returns `not_evaluated` and names it. It fails closed against
itself rather than against sellers.

**Order-value medians are keyed by `(category, currency)`.** There is no FX quote anywhere in
this backend. No median means no penalty.

**Search sorts on the pre-enforcement base; the rail sorts on the final score.** An
enforcement penalty may demote a product in discovery; it may never make it unfindable by its
own exact title.

**The share counter changed meaning.** Until now anonymous callers incremented it with no
dedup of any kind — harmless only while nothing read it, which this phase changes. It is now
signed-in only, one per user per day, and `0076` reconciles the stored counter to the
surviving counted rows. **Existing products will see `shareCount` fall.**

## Preconditions

- `0072` applied.
- `BETTER_AUTH_SECRET` set — it salts both the viewer fingerprint and the subnet hash.
- pg-boss reachable; `pnpm jobs:install` must run after migrating (three new tick queues).

## Deploy order

```
pnpm db:migrate
pnpm jobs:install
pnpm start / pnpm start:worker
# development only:
pnpm db:seed-store-ranking-dev -- --i-understand-this-writes-fake-commerce-data
```

Then, and only when a human has read the top 50 per category and called them plausible, a
merchandiser flips individual rails from `trending_placeholder` to `trending`. **No migration
flips a rail.** The surface cannot start claiming to show what is rising without a human act.

## The calendar gates — dates, not orderings

In development the seed satisfies all of these immediately. **In production they are real**,
because a fresh deploy has no history:

| Gate | Unlocks |
| --- | --- |
| T+7d | a conversion denominator worth dividing by |
| **T+14d** | W2 has real `confirmed_at` rows. Before this, runs write version `0` and every read refuses them |
| T+30d | the category floor; the 30-day refund and cancellation rates |
| T+~45d | the MAD spike baseline (≥14 daily rollup points) |
| T+90d+ | a per-category half-life, needing one full B2B purchase cycle observed |

A rail that is empty during this window is **correct**. The single most likely regression in
this phase is someone "fixing" it by loosening the qualified-order gate.

## Observability

- Would-fire rate: `commerce_ranking_enforcement_event` grouped by `action` over `as_of`.
- Unevaluated clauses: `unnest(unevaluated_clauses)` — `fraud_risk_above_threshold` on
  essentially every row is expected at launch.
- Exploration share: `ranking_mode` on the snapshot. High early is normal.
- Staleness: `discovery_score_computed_at` on `store_search_document`.
- Job health: the three tick pairs dead-letter like every other job.

## Rollback

Ordered by blast radius, smallest first:

1. **Flip rails back to `trending_placeholder`.** A data edit. The rail goes empty; nothing
   else changes.
2. **Stop the jobs.** Scores freeze at their last run; `discovery_score_computed_at` shows it.
3. **Drop `0079`–`0081`.** Additive tables plus two columns and a trigger.
4. `0073`'s `ALTER TYPE … ADD VALUE` is **irreversible**. Postgres cannot drop an enum value;
   `trending_placeholder` is kept forever precisely so step 1 remains available.

## Compatibility notes

- `ProductEngagementProjection` gained `viewCount` and `uniqueViewerCount` (the latter
  nullable — no rollup yet is not zero viewers).
- `sort=discovery` is additive; `sort=relevance` is unchanged and still the default.
- `utcDayStringOf` moved to `src/lib/utc-day.ts` and is re-exported from
  `viewer-fingerprint.ts`. Existing imports are unaffected; the move was to stop a pure
  helper dragging `config` into unit tests.

## Invariants to re-check

- No product with zero qualified W2 orders appears with `ranking_mode = 'percentile'`.
- Components sum to the total; `final ≤ base`.
- Every rate is null-or-with-its-sample-size.
- `share_count = count(*) filter (where counted)`.
- An unprivileged write to `discovery_score_points` moves nothing.
- Two runs at one `asOf` produce identical components.

## Explicit non-claims

**The engine is validated on synthetic data.** The seed proves the code computes what the
specification says. It does not show the thresholds are right for real B2B buyers — a seeded
corporate-NAT fixture passing a test is evidence about the fixture.

**Thirteen clauses of the ten refinements ship as documented hooks, not behaviour.** Each is
listed with its exact missing input in the specification's appendix. The four that matter
most: there is no chargeback data anywhere, no device fingerprinting, no account-linkage
graph, and no `fraud_risk_score`.

**The subnet guard is inert and cannot be backfilled.** No address was recorded on any
commerce row before this phase, and the ones behind existing saves are gone. The mechanism
ships; the signal accumulates from deploy day forward. A null hash is *unmeasured*, never
"low concentration".

**`commerce_organization_ranking_exclusion` ships empty** apart from development seed rows.
The specification asks for internal, test and blocked orders to be excluded from velocity;
this database has no such flag and no process that would keep one current.

**A ranking position is not a quality judgement about a seller.** It is a statement about
recent qualified demand, and the null contract in the specification's §3 is what keeps it
from being read as anything more.
