# Store Phase 9 Rollout — Guided Pathways

Slots, ranked candidates, anchored sets, computed set pricing, honest degradation,
authoring and moderation, cart seeding, and the co-occurrence derivation job.

**Status:** Shipped through additive migrations `0057`–`0058`.

This phase does **not** add review reads or Q&A (Phase 10), delivery addresses,
freight estimates, samples or customization (Phase 11), ranking, recommendations,
or anything §14 blocks.

---

## What ships

- **Tables:** `store_pathway_slot`, `store_pathway_slot_candidate`
- **Columns on `store_pathway`:** `anchor_product_id`, `hero_image_url`,
  `card_image_url`, `owner_organization_id`, `created_by_user_id`, `submitted_at`,
  `reviewed_by_user_id`, `reviewed_at`, `review_note`
- **Enum values:** `store_merchandising_state` gains `pending_review` and
  `rejected`; a new `store_pathway_slot_candidate_source_kind`; seven audit event
  kinds for pathway authoring and cart seeding
- **Guards:** a candidate must name one of its own product's ACTIVE variants when
  that product has any; a slot may only derive candidates on an anchored pathway;
  an anchor cannot be cleared while slots derive from it
- **Public reads:**
    - `GET /store/pathways` — cursor-paginated, with `cardImageUrl`, `isAnchored`
      and `slotCount`
    - `GET /store/pathways/:pathwaySlug` — **`slots` replaces `items`**: per-slot
      `state`, `chosenCandidateKey`, ranked candidates each carrying `sourceKind`,
      per-currency `currencyTotals`, and `completeness`
    - `GET /store/home` pathway cards gain `cardImageUrl` and `isAnchored`
- **Authoring routes** (`Idempotency-Key` required, user-scoped):
    - `POST /commerce/pathways`, `GET /commerce/pathways/mine`,
      `PATCH /commerce/pathways/:pathwayId`
    - `PUT /commerce/pathways/:pathwayId/slots`
    - `PUT /commerce/pathways/:pathwayId/slots/:slotId/candidates`
    - `POST /commerce/pathways/:pathwayId/submit`
- **Moderation routes** (`moderate_commerce`, checked in the service):
    - `GET /commerce/admin/pathways` — the review queue, carrying `ownCandidateShare`
    - `POST /commerce/admin/pathways/:pathwayId/moderate`
- **Cart seeding:** `POST /commerce/cart/from-pathway/:pathwaySlug`
- **Job:** `derive-product-relations`, nightly at 02:40 UTC via
  `derive-product-relations-tick`

---

## Decisions worth knowing before reading the code

**A candidate carries a `variantId`, which §15.2 does not mention.** Phase 8's A1
rule refuses a cart line naming no variant for a product that has active variants.
A candidate without one would therefore be a piece the set advertises and cannot
sell. Enforced by the authoring service and again by
`store_pathway_slot_candidate_variant_guard`.

**Derived candidates are computed, never stored.** An anchored slot names a
`derived_relation_kind`; its candidates are read from `commerce_product_relation`
at request time. A stored copy would be stale the moment a seller edits the graph,
and the nightly job already writes into that graph — one source of truth. The
`store_pathway_slot_candidate_source_ck` constraint enforces this: only `curated`
rows exist in the table.

**Authoring has two actors, one route set.** §15.5 gives a set a seller author and
a platform merchandiser, and a merchandiser may belong to no commerce organization.
`attachOptionalSellerCommerceOrganization` attaches an organization when the caller
has one and passes everyone else to a service that demands `moderate_commerce`
instead. Two consequences: idempotency on these routes is **user-scoped**, because
the organization scope 403s a caller with no organization; and a pathway with
`owner_organization_id IS NULL` is platform-curated, which is why it publishes
without a separate reviewer while a seller proposal cannot.

**A moderator may not decide their own organization's proposal**, mirroring the
dispute guard Phase 7 shipped.

**Two routes exist that §15.8 does not list.** `GET /commerce/pathways/mine` and
`GET /commerce/admin/pathways`: without them an author cannot find the draft they
need to edit and a reviewer would have to be handed an id out of band, which is how
a review step quietly stops happening.

**`store_pathway_item` is kept, not dropped.** Its product rows are backfilled into
slots and nothing reads it any more, so a pre-Phase-9 application still serves
pathways during a rollback. A later migration drops it.

---

## Preconditions

1. Migrations `0040`–`0056` applied and the Phase 7 and Phase 8 verify scripts green.
2. **No `store_pathway_item` row is a category, organization or provider offering.**
   The `0058` preflight raises and aborts if any is: a slot candidate has a real
   foreign key to `product`, and there is no truthful slot to convert a category
   placement into. Inspect and fix:

    ```sql
    SELECT pathway_id, entity_kind, entity_id
      FROM store_pathway_item
     WHERE entity_kind <> 'product';

    -- Move them to a rail, or remove them:
    DELETE FROM store_pathway_item WHERE entity_kind <> 'product';
    ```

3. **No two product items share a `(pathway_id, position)`.** A slot's
   `sibling_order` is unique per pathway, so a collision would fail the backfill with
   a bare unique violation; the preflight names it instead:

    ```sql
    SELECT pathway_id, position, count(*)
      FROM store_pathway_item
     WHERE entity_kind = 'product'
     GROUP BY pathway_id, position
    HAVING count(*) > 1;
    ```

Both are expected to find zero: nothing in the application has ever been able to
write a pathway item.

---

## Deploy order

1. Apply migrations `0057`–`0058`:

    ```bash
    pnpm run db:migrate
    ```

    `0057` is enum values only and must land first — a value added by
    `ALTER TYPE ... ADD VALUE` cannot be used by the transaction that adds it, and
    `0058` references `pending_review` and `rejected` in a CHECK.

2. Verify constraints before exposing Phase 9 routes:

    ```bash
    pnpm run db:verify-store-phase-8-constraints
    pnpm run db:verify-store-phase-9-constraints
    ```

3. Deploy the API, then restart the worker so the new queues are bound:

    ```bash
    pnpm run jobs:install
    ```

4. Seed the actors and data these flows assume, then drive them:

    ```bash
    pnpm run db:seed-store-demo                  # once; idempotent
    pnpm run dev                                 # separate shell
    pnpm run db:smoke-store-phases-9-11
    ```

    The script signs in over HTTP, activates each organization, and asserts every step
    below including the refusals. The manual list is kept as the specification of what it
    checks — run it by hand when changing one flow, and by script otherwise.

5. Smoke (a seller org, a buyer org, and a `moderate_commerce` staff user):

    - Seller `POST /commerce/pathways` with an `anchorProductId` it owns → `draft`;
      anchoring on someone else's product → `422 ANCHOR_NOT_OWNED`
    - `PUT .../slots` with three slots, one required and one carrying
      `derivedRelationKind: "accessory_of"` → a derived slot on an unanchored
      pathway is refused
    - `PUT .../slots/:slotId/candidates` → a candidate whose product has active
      variants and names none returns `422 VARIANT_REQUIRED`; a body carrying
      `sourceKind` returns `422`; a slot quantity below a candidate's minimum order
      quantity returns `422 QUANTITY_BELOW_MINIMUM`
    - `POST .../submit` → `pending_review`; a required slot with no candidate and no
      derivation is refused. `GET /store/pathways/:slug` still `404` — a set under
      review is not public
    - Staff `GET /commerce/admin/pathways` shows the proposal with
      `ownCandidateShare`; `POST /commerce/admin/pathways/:id/moderate` with
      `publish` → `active` with reviewer attribution; a non-staff caller → `403`; a
      moderator who belongs to the proposing organization → `403`
    - `GET /store/pathways` paginates deterministically; a tampered cursor → `422`,
      not `404`
    - `GET /store/pathways/:slug` → slots in order with `state`,
      `chosenCandidateKey` and `sourceKind` per candidate; `currencyTotals` is an
      array; the derived slot shows relation-graph candidates
    - Zero the rank-0 candidate's stock → that slot becomes `substituted` and the
      total changes. Retire every candidate on the required slot → **the slot is
      still present**, `unavailable`, and `isComplete` is `false`
    - `POST /commerce/cart/from-pathway/:slug` → one line per required slot at slot
      quantity, `unfilledSlots` lists the dead one, and a replay with the same
      `Idempotency-Key` returns the same result with no duplicate lines
    - `checkout/prepare` then `confirm` on that cart → one order per counterparty,
      variant snapshots intact
    - `pnpm run jobs:trigger derive-product-relations` against completed orders →
      `derived_cooccurrence` rows appear, and a pair that already carries a
      `seller_declared` or `moderator_curated` `complements` edge is untouched

---

## Observability

- Audit events: `pathway_created`, `pathway_updated`, `pathway_slots_replaced`,
  `pathway_candidates_replaced`, `pathway_submitted`, `pathway_moderated`,
  `cart_seeded_from_pathway`. A platform-curated pathway writes none — it has no
  owning organization to append to, and the row's own reviewer attribution is the
  record.
- The derivation job's dead-letter queue is `derive-product-relations.dlq`.

---

## Rollback

1. Stop accepting Phase 9 writes (revert the API deploy or gate the new routes).
   Every column added here is nullable, and `store_pathway_item` still holds the
   data it held before, so a pre-Phase-9 application runs unchanged against this
   schema.
2. Do **not** drop `store_pathway_slot_candidate` if production rows exist — its
   `product_id` and `variant_id` are `restrict`, and dropping it would take the
   record of what a published set contained with it.
3. `0057` uses `ALTER TYPE ... ADD VALUE`, which Postgres cannot reverse. Migration
   reverse is only safe on empty Phase 9 tables in pre-production.

---

## Compatibility notes

- **`GET /store/pathways/:pathwaySlug` changes shape.** The flat `items` array is
  replaced by `slots`, as §15.7 specifies. The frontend needs the same release;
  `mockPathwayBannerForSlug` can be deleted now that `cardImageUrl` and
  `heroImageUrl` are real.
- **`GET /store/pathways` is now cursor-paginated** and returns
  `{ items, page }` rather than `{ items }` alone.
- **Migrations `0057`–`0058` are hand-written**, like every store-phase migration
  since `0046`.
- Idempotency on the authoring routes is user-scoped rather than
  organization-scoped. See the decision note above; it is strictly narrower, never
  wider.

---

## Invariants to re-check after deploy

- Every candidate's variant belongs to its own product and is active.
- No candidate omits a variant for a variant-bearing product.
- Every slot with a `derived_relation_kind` belongs to an anchored pathway.
- No `derived` candidate was ever stored.
- Review attribution and pathway state agree in both directions.
- Every product `store_pathway_item` row was backfilled into a slot.

All six are asserted by `pnpm run db:verify-store-phase-9-constraints`.

---

## Explicit non-claims

A set total is **computed at read time and is not a quote**. It reflects current
pricing tiers for the candidates the set currently proposes, per currency; a kit
sourced from three countries has three totals and no single number, because
combining them would mean converting currencies without an FX quote.

A `derived` candidate is a **relation-graph suggestion, not a curatorial decision**,
and a `derived_cooccurrence` edge is a correlation, not a compatibility claim. The
nightly job writes only `complements` for exactly this reason — co-occurrence
cannot support `compatible_with` or `spare_part_of`, and only `moderator_curated`
earns confirmatory language (§15.3).

The `trending_placeholder` rail strategy still returns an empty list. §15.9 notes
the derivation job is also its honest replacement, but trending is ranking, which
§12 defers past this phase. It is unbuilt, not broken.
