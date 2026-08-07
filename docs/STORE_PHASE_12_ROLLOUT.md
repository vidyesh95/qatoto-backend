# Store Phase 12 Rollout — Seller Profile Depth

Seller-declared company depth, moderated certifications, and the three measured metrics
that replace a hardcoded `null`. Appendix A13.

**Status:** Shipped through additive migrations `0069`–`0072`.

This phase does **not** add product comments (A10 — still awaiting the product decision),
trade-protection copy or revenue disclosure (A20 — §14 blocked), ranking, recommendations,
or a `trending` rail.

---

## The gap this phase closes

`onTimeShipmentRate` was projected on the storefront card, the provider card and the
pathway read, and it was **hardcoded `null`**. The comment at
`commerce-trust-metrics.service.ts:168` said it "stays null until promised-delivery
timestamps exist", and across 244 tables no such column existed.

That is the worst shape a gap can take. A missing field is a known absence; a field that
reaches the wire and can never carry a value looks wired, and the frontend built a stat
tile for it. Appendix A exists to keep that distinction visible, and A13 was the last entry
still holding one.

Alongside it, `commerce_provider_profile` was keyed to **service providers**, so a
manufacturer selling products had no profile row anywhere. Three frontend surfaces —
`company-details-section.tsx`, `company-details-sheet.tsx`,
`verified-capabilities-sheet.tsx` — were mock for that reason.

---

## What ships

### The declared side (A13 items 2–5)

- `commerce_seller_profile` — one row per organization, mirroring
  `commerce_provider_profile`: `yearFounded`, `factoryCount`, `totalStaffCount`,
  `productionLineCount`, `factoryAreaSquareMetres`, `businessType`, `visitPolicy`,
  `acceptingCustomOrders`, `publicSummary`, `declaredResponseTimeHours`
- `commerce_organization_media` — factory/office/warehouse photography, **uploaded through
  Cloudinary**, dimensions measured from the decoded bytes
- `commerce_organization_site_access` — declared freight access, `distanceKm` as an integer
- `commerce_organization_stakeholder` — named officers, **with no column that could hold a
  way to contact them**
- `commerce_organization_capability` — OEM / ODM / customization / inspection / R&D / samples

### The moderated side (A13 item 6)

- `commerce_organization_certification` — standard, issuer, certificate number, validity
  window, private evidence document, and a `pending → approved | rejected | withdrawn`
  review lifecycle with the no-self-approval rule
- `POST /commerce/admin/certifications/:certificationId/decision`, gated on
  `moderate_commerce` **inside the transaction that writes the decision**

### The measured side (A13 items 1 and 7)

- `commerce_order.promised_delivery_at`, `commerce_order_product_line.promised_delivery_at`
  and `commerce_checkout_prepare_product_line.lead_time_max_days_snapshot`
- `onTimeShipmentRate` — real for the first time
- `reorderRate` and `measuredResponseTimeHours` — new, derived from order and message data
- every rate carries its `sampleSize` and is `null` below its threshold

### The wire

`GET /store/organizations/:slug` and `GET /store/providers/:slug` gain **two objects**:
`declaredProfile` (null when a company has never described itself) and `measuredMetrics`.

Ten authoring routes on a new `commerce-seller-profile.routes.ts`.

---

## Decisions worth knowing before reading the code

**A13's plan for certifications was wrong, and the correction ships with it.** The appendix
said to add a `certification` kind to `commerceVerificationKindEnum` and reuse
`commerce_organization_verification`. That table's
`commerce_organization_verification_pending_uidx` is unique on
`(organization_id, verification_kind)` where `state = 'pending'` — so an organization could
hold exactly **one** pending certificate, and a real supplier has ISO 9001 and CE and RoHS
and BSCI. It also has no name, issuer, standard or expiry column, so an approved row could
not say what it certifies or when it lapses. This is the third time in this backend that
"reuse the adjacent table" turned out to mean "weaken the constraint that made the adjacent
table correct" — Phase 10 made the same call for `commerce_content_report`.

**Expiry is deliberately not a state.** `commerce_certification_state` has no `expired`
value. Lapsing is `valid_until < current_date`, evaluated by Postgres at read time, so it
cannot be stale. A stored state would need a nightly job to flip it and would therefore be
**wrong between ticks** — publishing a lapsed certificate, which is the exact failure this
entry exists to prevent. The verify script asserts the value is still absent.

**The promise is derived where the order is created, and never afterwards.** A13 said "a
promised-delivery timestamp on the shipment or order line". It needs three tables, because
`confirmCheckout` builds each order line **verbatim from the prepare row** and never touches
the cart or the product again — the constraint A18's customization selections already had to
route around. So the seller's advertised lead time is snapshotted at preparation and the
promise computed from it at confirm.

The alternative, a seller typing a target date at ship time, was rejected: the seller would
be setting the bar after it already knew the outcome, and the metric would grade itself.
Re-reading `product.leadTimeMaxDays` at confirm was also rejected — that derives a
commitment from mutable listing data the buyer never saw, which is what §0 forbids for
prices and forbids here for the same reason.

**Null is never zero.** A seller who declared no lead time makes no promise, and its orders
are **absent from the on-time denominator** rather than scored as met. Nothing is
backfilled: inventing a commitment for orders placed before `0072` would fabricate the very
measurement this phase makes honest.

**Every rate is null below its sample threshold, and the threshold stays off the wire.**
"100% on-time across three orders" is not a performance claim, and a bare `1.0` is
indistinguishable from an earned one — so the wire carries `onTimeSampleSize`,
`reorderSampleSize` and `responseSampleSize`, and the client decides whether to render "not
enough data yet". The thresholds themselves are not projected: a client that knew them would
render a countdown to a good score rather than an absence of evidence.

**Response time is a median, not a mean.** One thread left over a weekend moves a mean by
hours and a median not at all, and "typically replies within N hours" is the claim a buyer
reads into the number. It joins through `commerce_organization_member`, so a member who has
since left keeps their replies in the denominator instead of silently improving it.

**The metric loader is split in two, and the split is about cost.** Reorder rate and median
response time need a per-buyer aggregate over a year of orders and a window function over
ninety days of messages. A category page asks for 48 organizations at once and renders
neither, so `loadOrganizationFulfillmentMetrics` serves the card path and
`loadOrganizationMeasuredMetrics` serves the two company pages.

**Company photos are uploaded, not hotlinked.** This departs from the two closest
precedents — `commerce_product_highlight.imageUrl` and `commerce_organization.logoUrl` both
take an https string. A factory photograph is taken on site, on a phone, and its EXIF names
the seller's coordinates; a hotlink cannot have it stripped. The re-encode is also what
proves the bytes are an image from their magic bytes rather than from the multipart header.

**Stakeholder rows can hold a name and a role and nothing else.** That absence is not an
oversight to be filled in later — it is the entire reason the rows are publishable. A name
and a title are what a company already prints on its own website; a direct line to a named
individual is personal data. The verify script fails if the table ever grows an `email`,
`phone` or `contact` column.

**A certification decision lands on the certified organization's audit chain**, with a null
role snapshot, exactly as `trade_state_changed` already records a moderator's trade-state
decision. Migration `0064` sent _content_ moderation to the platform chain because a review
or a question may have no organization behind it; a certification always does.

---

## Preconditions

1. Migrations `0040`–`0068` applied, and the Phase 10 and 11 verify scripts green.
2. **Cloudinary must be configured** (`CLOUDINARY_*`). Company media is the only new upload
   path, and without configuration `addOrganizationMedia` returns
   `IMAGE_STORAGE_FAILED` → HTTP 502. Nothing else in the phase depends on it.
3. **`COMMERCE_PII_ENCRYPTION_SECRET` and object storage must be set** — certification
   evidence is an envelope-encrypted private document on the same path verification evidence
   uses. Without them, certification submit returns
   `EVIDENCE_ENCRYPTION_UNAVAILABLE`/`EVIDENCE_STORAGE_NOT_CONFIGURED`. See the Phase 11
   rollout for how to generate the secret and why it is permanent once addresses exist.
4. **A platform account holding `moderate_commerce`** must exist, or no certification can
   ever be approved and the certifications list stays permanently empty on every storefront.

---

## Deploy order

1. Apply migrations:

   ```bash
   pnpm run db:migrate
   ```

   `0069` is enum values and types only and must land first. Two notes on why it is safe:

   - The two `ALTER TYPE ... ADD VALUE` statements (`commerce_document_kind` and the seven
     audit event kinds) are referenced **only by runtime INSERTs**, never by DDL in
     `0070`–`0072`. A value added by one transaction cannot be used by that transaction,
     and this phase avoids the situation rather than negotiating with it, as `0064` did.
   - `0071`'s `commerce_organization_certification_identity_uidx` predicate names a literal
     of `commerce_certification_state`, which is legal because that type is **created** in
     the same transaction — the restriction applies to pre-existing types. It could not have
     been written `state::text <> 'rejected'` either way: an enum→text cast is not
     `IMMUTABLE` and Postgres refuses it in an index predicate.

2. Verify before exposing the routes:

   ```bash
   pnpm run db:verify-store-phase-11-constraints
   pnpm run db:verify-store-phase-12-constraints
   ```

   The Phase 12 script asserts presence **and attempts every violation** inside a
   transaction it rolls back — a CHECK whose expression is wrong still appears in
   `pg_constraint`, so presence alone proves nothing. Checks it cannot run for want of a
   foreign-key anchor report `SKIP`, never `PASS`.

3. Deploy the API.

4. Smoke it over HTTP:

   ```bash
   pnpm run db:seed-store-demo
   pnpm run db:smoke-store-phase-12
   ```

   41 checks, and they assert refusals as hard as successes.

---

## Observability

- **HTTP 502 from `POST /commerce/organizations/:id/media`** means Cloudinary is
  unreachable or unconfigured, not that the image was bad.
- **HTTP 422 on that route** means the decoded bytes were not an image at least 64px on
  each side. The multipart mimetype is a claim; sharp reads the bytes.
- **HTTP 503 from certification submit** means the encryption secret or object storage is
  missing.
- **A 500 from any Phase 12 write** should be read first as an audit-payload rejection —
  see the compatibility note below.
- `onTimeShipmentRate` staying `null` after deploy is **expected** until ten promised,
  delivered orders exist. `onTimeSampleSize` is how you tell "not enough data" from "not
  wired".

---

## Rollback

1. Revert the API deploy. Every column added is nullable or defaulted, so a pre-Phase-12
   application runs unchanged against this schema.
2. `declaredProfile` and `measuredMetrics` disappearing from the storefront is additive in
   reverse — a client that reads them defensively is unaffected.
3. Do **not** drop `commerce_organization_certification` if production rows exist: it holds
   moderator decisions and the evidence pointers behind them.
4. `0069` uses `ALTER TYPE ... ADD VALUE`, which Postgres cannot reverse.
5. `promised_delivery_at` may be dropped safely — nothing reads it but the metric, and no
   money or entitlement depends on it.

---

## Compatibility notes

- **`PublicProviderCard.averageResponseTimeHours` is renamed
  `declaredResponseTimeHours`.** This is the one **breaking** field change in the phase, and
  the rename is the fix: that value is an integer a provider types about itself, and it had
  been shipping since Phase 2 as a flat sibling of the platform-derived
  `fulfillmentMetrics.onTimeShipmentRate` — precisely the flattening A13's closing rule
  forbids. A client reading the old key gets `undefined`.
- **`fulfillmentMetrics` gains `onTimeSampleSize`** on every card. Additive.
- **`GET /store/organizations/:slug` and `GET /store/providers/:slug` gain two objects.**
  Additive.
- **A new multipart middleware exists for certificates.** Reusing
  `uploadCommerceVerificationEvidence` looked right and was wrong: it caps multer at
  `fields: 2` for its own two text parts, and a certification sends six, so every submission
  returned a flat 422 from `LIMIT_FIELD_COUNT`. The size cap and media-type allowlist are
  still shared from that module. **The HTTP smoke caught this; nothing else could have**,
  because a multer field cap is invisible to types and to any test that does not send a real
  multipart body.
- Migrations `0069`–`0072` are hand-written, like every store-phase migration since `0046`.
  `drizzle-kit generate` diffs against the `0054` snapshot and tries to recreate four phases
  of tables — do not use it here.

---

## Invariants to re-check after deploy

- No certification is approved by its own submitter, and every approval names a reviewer and
  a decision time.
- Approved-but-lapsed certifications exist in the table and are **absent from every public
  projection**.
- Every certification's evidence document belongs to the same organization and carries the
  `certification_evidence` kind.
- No order line is promised later than its own order.
- `commerce_certification_state` still has no `expired` value.
- `commerce_organization_stakeholder` still has no contact column.
- The certification identity index is still **partial** on `state <> 'rejected'`, or a
  seller whose number was rejected for a typo can never resubmit the corrected one.

All are asserted by `pnpm run db:verify-store-phase-12-constraints`.

---

## Explicit non-claims

**A declared profile is a claim, not a check.** Founding year, factory count, staff count,
site access, officers and capabilities are all seller-asserted and unverified. They are
reportable through A12's shipped queue and they live under `declaredProfile` for exactly
that reason. Nothing in this phase verifies a factory exists.

**A capability is not a certification.** `verified-capabilities-sheet.tsx` is named for what
it renders, not for what those rows prove. Only the certifications beside them carry a
moderator's decision.

**A measured rate below its threshold is `null`, and `null` does not mean zero.** It means
the platform will not make a claim yet. Rendering it as 0%, or as "no data" alongside a
progress bar toward a good score, both misstate it.

**A certificate scan never reaches any client.** The public projection is metadata —
standard, issuer, certificate number, validity window, approval time. Not the document id,
not a URL, not a short-lived token. A certificate carries registration numbers, site
addresses and signatures.

**Online revenue is still not derivable from anything here, and that is §14's call, not an
aggregation gap.** A20 stands.
