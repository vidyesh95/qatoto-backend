# Store Phase 15 — closing Appendix A

> Migrations `0093`–`0097`. Applied. `21/21` constraint checks and `31/31` HTTP smoke
> checks pass against a live database; `1829` unit tests, typecheck and lint are green.

## What decided this phase

Appendix A's own audit. A23–A30 were written by reading the shipped backend from the
frontend side after Phase 14, and three of the eight entries turned out to describe not
missing features but **defects in features already shipped**:

- **A23.** `commerce_product_customization_option` was enforced at `checkout/prepare` and
  projected on no buyer read. A product carrying a **required** slot could not be checked
  out by anybody — `checkout/prepare` refused an order for a term the buyer had no way to
  read. It was absent from the seller's own `GET /products/:id` too, so a seller could not
  read back what `PUT /products/:id/customization-options` had just written.
- **A30.** `CreateDraftRfqSchema.documentIds` was a field no route could fill. The three
  upload routes were verification evidence, customization artwork and A21's image
  multiparts, none of which a buyer composing an RFQ can use, so any id a client invented
  came back `DOCUMENT_NOT_OWNED`. `presignPrivateCommerceDocumentDownload` had zero
  callers, so an attached document could not be opened either.
- **A28.** A buyer could file a dispute over a $200,000 order and had no route that
  answered "what is happening with it". `commerce_dispute_buyer_idx` and
  `_counterparty_idx` existed with no reader at all.

The rest were honest absences: no cross-order shipment queue (A29), no answer votes and no
viewer vote state (A24), no supplier directory and filters thinner than the platform's own
facets (A25), and two one-column gaps (A27).

## The rule that governs the read side of this phase

**A term checked at preparation must be readable before preparation, and a fact about the
CALLER belongs on the read the caller already made.**

Both halves are A11's `engagement.viewer` argument, generalized. A gate the buyer cannot
see is a defect rather than a policy (A23), and a toggle whose own state needs a second
authenticated call renders wrong on first paint and teaches a buyer that the count is not
to be trusted (A24).

Every per-viewer field added here is therefore a **nullable object, never a defaulted
`false`** — `viewer: {hasVotedHelpful} | null`. `null` means "we do not know who you are",
which on these surfaces also means "you cannot vote", because both vote tables are keyed on
the ORGANIZATION rather than the user.

## The migrations

| Migration | Adds |
| --- | --- |
| `0093` | `commerce_product_answer_vote`, `commerce_product_answer.helpful_count`, the partial helpful index, and the relationship guard trigger |
| `0094` | `product_pricing_tier.lead_time_days` with a 0..3650 CHECK |
| `0095` | the `organization` document kind, `store_search_stock_state`, five denormalized facet columns, two partial indexes |
| `0096` | four keyset indexes for the two new participant queues |
| `0097` | the `trade_attachment` document kind and the `document_downloaded` audit event |

### The constraint every enum migration here works around

`drizzle-kit migrate` runs the whole pending batch in **one transaction**, and a value
added by `ALTER TYPE ... ADD VALUE` cannot be referenced as a literal by a later statement
inside it. `0095` and `0097` both add enum values and both are written so that nothing
else in the batch names them: no partial index predicated on `document_kind =
'organization'`, no backfill INSERT. Those rows first appear at runtime.

## What the specification did not anticipate

**Five things, and the first two are bugs the new code would otherwise have created.**

**`updateOrganization` re-enqueued the search refresh only on a visibility change.** That
was right while an organization existed in search purely as an eligibility flag on its
products. A25 makes the organization its own search document carrying its display name,
legal name and summary — so a rename would have left the supplier directory advertising the
old company name indefinitely, with nothing to correct it until an unrelated visibility
edit. The trigger set is now a declared constant checked against the patch type, because
the failure mode is silent: a field added to the document without being added there goes
stale and nothing reports it.

**`assertOwnedDocuments` checked ownership but not `state = 'available'`.** Harmless only
while nothing could create a buyer document — the predicate guarded a set that was always
empty. The moment `POST /commerce/documents` exists, an RFQ could carry a file that was
unscanned or had already FAILED its scan, and then broadcast it to every invited provider.
`appendMessage` had always checked both; the two paths now agree.

**The search backfill refreshed products and offerings only.** It is extended to
organizations, and it must run them **last**, because a supplier's search text is built
from its own eligible product documents and would otherwise be assembled from the previous
generation of them. Every organization is refreshed, not only the eligible ones: a pending
or private organization needs an `is_eligible = false` row so that becoming active later
is an UPDATE rather than a first insert nothing triggers.

**A29's ETA does not live on the shipment.** `commerce_shipment` has no
`estimated_arrival_at` at all — it is on `commerce_shipment_leg`. So the window filter is
an `EXISTS` rather than a join (a join would duplicate a shipment with three legs in range
and make the page size a lie) and the projected value is `max()` across legs, because a
shipment arrives when its last leg does. `null` when no leg carries one, never a
fabricated date.

**The smoke script's first run failed every authenticated check with a flat 403**, because
it never called `/commerce/organizations/:id/activate`. Commerce routes resolve their actor
from `session.active_organization_id` and there is no auto-select. That is documented in
the Phase 14 smoke and was rediscovered here anyway, which is why it is written down again.

## Decisions worth carrying forward

**A NULL facet is EXCLUDED by an A25 filter, not admitted.** `minOrderQuantityMax` admits
NULL because "no MOQ declared" genuinely satisfies "MOQ at most 50" — the buyer may order
any quantity. The new filters are different: a document with no `stock_state` is not a
document that is in stock, and admitting it would sweep organizations and provider
offerings into a stock filter that cannot describe them.

**The denormalized `stock_state` is variant-aware, matching `mapProductCard` exactly.** A
card saying "in stock" that the stock filter disagreed with would be the worse of the two
bugs, since both now read the same column. The verifier recomputes it in SQL for every
variant-less product and all 17 live listings agree.

**A27's lead time is the SELECTED tier's, never an aggregate.**
`store-search.service.ts:501-508` and `store-catalog.service.ts:401-408` both compute the
displayed MOQ as `min()` across every tier while ignoring `variant_id`, conflating the
product ladder with variant ladders. A `min(leadTimeDays)` would inherit that and report a
band the buyer's quantity never touched, so it is resolved inside
`resolveUnitPriceInCents` — the tier the price came from is by definition the tier the
quantity fell into. A sample bypasses the ladder and so bypasses its lead time too.

**Nothing was backfilled onto the tier ladder.** Copying `lead_time_max_days` down onto
every band would manufacture a per-band declaration the seller never made. NULL already
means "the product's applies", which is what every pre-Phase-15 row means, and the verifier
asserts the migration did not invent values.

**A28 answers 404 to a non-party, never 403**, using `cancelOrder`'s predicate verbatim.
"No such dispute" and "not your dispute" must be indistinguishable or the route becomes an
oracle for which dispute ids exist, and a dispute id names two organizations and a
commercial disagreement between them. This is deliberately NOT
`evaluateDisputeOpeningRelationship`, which splits party-but-not-buyer into a 403 — only a
buyer may OPEN a dispute, but both parties may read one, and telling the counterparty is
the entire point.

**A30's download is a decrypt-and-stream, not a presigned URL.**
`presignPrivateCommerceDocumentDownload` still has no caller and this did not change that.
A signed URL is a bearer capability that outlives the authorization decision, and the
authorization here — thread participation, RFQ invitation — is exactly the revocable sort.
RFQ access is scoped to **invited** providers rather than every provider: an open RFQ is
broadcast, its drawings are not.

**A30 audits cross-organization reads and only those.** The append runs inside a
transaction and a failed append throws, so a read that could not be logged does not happen;
ids ride `targetEntityId`, never the payload, whose keys are PII-name checked. An
organization opening its own file is not audited — logging it would bury the reads that
matter under the ones that do not. All three details are `revealOrderDeliveryAddress`'s,
carried over verbatim.

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm db:migrate                      # discrete creds, not `url` — a CA cert makes url fail silently
pnpm db:verify-store-phase-15-constraints
pnpm db:backfill-store-search-documents
pnpm db:smoke-store-phase-15         # needs `pnpm dev` and `pnpm dev:worker`
```

The verifier does not try to assert a projection, which it cannot. It asserts the parts
that can rot silently: the enum members `ALTER TYPE` added (invisible to every drizzle
snapshot), the denormalized facet columns (a filter over a column the refresh job never
populates returns an empty page rather than an error), the four keyset indexes, and above
all that the answer-vote **trigger actually refuses** a real author's vote on its own
answer — presence in `pg_trigger` says nothing about the body.

The smoke script reports SKIP, not pass, for a check the seeded data cannot exercise. A
check that passes only because it asked for nothing is worse than no check.

## Still open

- **`getCategoryFacets` and `/store/search` now compute from different tables.** The facets
  aggregate over `product`; the filters read `store_search_document`. The counts and the
  `WHERE` can therefore drift, and the raw `db.execute` inside `getCategoryFacets` restates
  the eligibility predicate by hand (`store-catalog.service.ts:560-565`), which is a second
  copy of a rule that already exists twice. Moving the facets onto the search document
  would close both, and is the natural next edit.
- **A26 stays deferred.** Variants are a flat list, not attribute axes. The flat list is
  the right shape until a category actually sells on two dimensions, and building axes
  early means migrating every row that reaches an order-line snapshot for a UI nothing has
  asked for.
- **A10 stays closed and unbuilt** pending the product decision, and **A20 stays blocked**
  on §14 — trade-protection language claims a custody Qatoto does not have, and supplier
  revenue disclosure now has a decided shape (`consentedDisclosures`) but no table.
- **A dead review video still renders.** `attachReviewVideo` stores a well-formed YouTube
  id without checking the video exists, and the decided design — a dead video hides its
  media row and leaves the review standing — needs a state column on
  `commerce_review_media` that is not built.
- **`commerce_dispute_event.note_added` still has no writer.** The participant read now
  projects the timeline, so a note a party could add would have somewhere to appear; there
  is still no route that adds one.
