-- ---------------------------------------------------------------------------
-- Phase 21 — the buyer workspace (STORE_BACKEND_STRUCTURE.md §14, Appendix A37).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHAT THIS CLOSES. §14 marked buyer-organization auto-provisioning DECIDED and nothing was
-- built. The only application-code INSERT into `commerce_organization` is the explicit
-- `POST /commerce/organizations`, it writes `trade_state = 'pending'`, and only a
-- `moderate_commerce` decision makes a row `active` — while cart, checkout, RFQ, quotes and
-- inquiry all require `active`. So a signed-in buyer's FIRST CART TAP answered 403 and
-- stayed 403 until staff acted by hand. Phase 15's rollout already recorded the symptom
-- from the other side: "the smoke script's first run 403'd everywhere because it never
-- activated an organization."
--
-- WHAT THIS MIGRATION IS NOT. It does not move the trust gate. §14 named where the gate
-- earns something — `checkout/confirm`, RFQ broadcast, seller listing, provider offerings —
-- and those stay exactly where they are. This makes a PENDING shell usable for the taps in
-- front of them; it does not make a pending organization tradeable.
-- ---------------------------------------------------------------------------

-- Defaults to 'self_declared' so every pre-existing row keeps the meaning it was created
-- with: each one came through the explicit POST, which is a person asserting a company.
ALTER TABLE "commerce_organization"
  ADD COLUMN "provisioning_origin" "commerce_organization_provisioning_origin" DEFAULT 'self_declared' NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A COUNTRY IS A FACT, AND THE SERVER DOES NOT HAVE ONE AT PROVISIONING TIME.
--
-- There is no geo middleware, and `user.location_label` is a free-text self-set place whose
-- own comment forbids exactly this use ("CLAUDE.md §1.1 forbids trusting a client-claimed
-- country for tax, pricing, fraud or geo-restriction"). Alibaba collects a self-declared
-- country in its registration form; this backend does not, because §0's rule is that a
-- missing component is NAMED rather than defaulted — the same rule §19.4 applies to an
-- uncovered freight lane.
--
-- So a pending shell may carry NULL, and activation is where the country gets established.
-- The blast radius is small on purpose: every public read already filters
-- `trade_state = 'active'`, so no catalog, search, storefront or directory projection can
-- observe a NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_organization" ALTER COLUMN "country_code" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "commerce_organization" DROP CONSTRAINT "commerce_organization_country_ck";
--> statement-breakpoint

ALTER TABLE "commerce_organization"
  ADD CONSTRAINT "commerce_organization_country_ck"
  CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');
--> statement-breakpoint

-- The NOT NULL that was dropped above, restated where it is actually true. An organization
-- that trades has a country; one that has never traded need not have declared one yet.
-- Written as a CHECK rather than left to the activation service because §0's posture is that
-- a rule which must survive request replay belongs in the backend, and the cheapest backend
-- is the one that cannot be bypassed by a second writer.
ALTER TABLE "commerce_organization"
  ADD CONSTRAINT "commerce_organization_country_pending_ck"
  CHECK (trade_state = 'pending' OR country_code IS NOT NULL);
--> statement-breakpoint

-- ONE AUTO-PROVISIONED SHELL PER USER.
--
-- This is the concurrency guard, not a business rule about how many organizations a person
-- may own: two simultaneous first taps both find no membership and both try to mint. The
-- partial predicate is what keeps it from being that broader rule — a user may still own any
-- number of organizations they explicitly created, because those are 'self_declared' and
-- fall outside the index.
--
-- A unique violation here is therefore EXPECTED traffic, not an error: the loser re-reads
-- and returns the winner's row.
CREATE UNIQUE INDEX "commerce_organization_auto_provisioned_owner_uidx"
  ON "commerce_organization" USING btree ("created_by_user_id")
  WHERE provisioning_origin = 'auto_provisioned';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- THE SEARCH DOCUMENT MIRRORS THE ORGANISATION, SO IT INHERITS THE NULLABILITY.
--
-- `refreshOrganizationSearchDocument` writes a row for EVERY organization, not only
-- eligible ones — that is what `is_eligible` is for, and it is why a suspended catalog
-- stops steering supplier search without its documents being deleted. An auto-provisioned
-- shell therefore gets a document too, and it has no country to copy.
--
-- An ineligible document with a NULL country simply fails to match the country filter,
-- which is the correct answer: a shell that has never traded should not appear under any
-- country's facet. Every eligible document still has one, because eligibility requires
-- `trade_state = 'active'` and `commerce_organization_country_pending_ck` requires a
-- country to reach that state.
-- ---------------------------------------------------------------------------
ALTER TABLE "store_search_document" ALTER COLUMN "organization_country_code" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "store_search_document" DROP CONSTRAINT "store_search_document_country_ck";
--> statement-breakpoint

ALTER TABLE "store_search_document"
  ADD CONSTRAINT "store_search_document_country_ck"
  CHECK (organization_country_code IS NULL OR organization_country_code ~ '^[A-Z]{2}$');
--> statement-breakpoint

-- An eligible document is a public one, and a public row with no country would be a hole in
-- the facet counts rather than a missing filter match. The organization-side CHECK already
-- makes this unreachable; this one makes the search table say so itself, so a future writer
-- that bypasses the refresh path cannot open the hole quietly.
ALTER TABLE "store_search_document"
  ADD CONSTRAINT "store_search_document_eligible_country_ck"
  CHECK (is_eligible = false OR organization_country_code IS NOT NULL);
