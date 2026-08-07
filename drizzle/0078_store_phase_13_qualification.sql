-- Store Phase 13 — the two lookup tables behind the trusted-buyer filter.
--
-- Both ship nearly empty, and both are honest about which direction they can argue in.

-- ---------------------------------------------------------------------------
-- What we know about an email domain.
--
-- ABSENCE MEANS `unknown`, NEVER `verified_business`. This is the asymmetry that matters
-- and it is worth being blunt about: a denylist of free-mail and disposable providers is
-- obtainable and finite, while an ALLOWLIST of every legitimate company domain on earth is
-- not. So in practice this table can DENY a buyer one of its three qualification
-- credentials and can almost never GRANT one.
--
-- The consequence reaches further than qualification. The spec's subnet guard wants an
-- exemption for "verified corporate domains" so that one procurement team behind one
-- office NAT is not mistaken for a click farm. That exemption cannot be built on a corpus
-- that does not exist — which is precisely why the subnet penalty ships with a floor
-- rather than the specified `max(0, 1 - concentration)` that can zero a product outright.
--
-- `citext` for the key, because domains are case-insensitive and the `user.email` column
-- this is matched against is already citext. Comparing a lowercased Node string to a text
-- column would work until the day someone registered with a capital letter.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_business_email_domain" (
  "domain" "citext" PRIMARY KEY NOT NULL,
  "classification" "public"."commerce_email_domain_classification" NOT NULL,

  -- Where the judgement came from: an imported denylist, a moderator, or a verification
  -- decision. Free text and not an enum because the sources are operational and will
  -- change faster than a migration cadence.
  "source_note" text NOT NULL,

  -- NULL for a bulk import. A domain classified by a person names that person.
  "decided_by_user_id" text,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "commerce_business_email_domain" ADD CONSTRAINT "commerce_business_email_domain_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- A bare domain: no scheme, no path, no `@`, at least one dot. Rejects `@acme.com` and
-- `https://acme.com`, both of which would silently never match anything.
ALTER TABLE "commerce_business_email_domain" ADD CONSTRAINT "commerce_business_email_domain_shape_ck" CHECK (
  domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
);--> statement-breakpoint

-- "Which domains are disposable" is asked once per confirm; "list the verified business
-- ones" is asked by an operator. Both want the classification leading.
CREATE INDEX "commerce_business_email_domain_classification_idx" ON "commerce_business_email_domain" USING btree ("classification","domain");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Organizations whose activity never counts toward ranking.
--
-- THIS TABLE SHIPS EMPTY, and that is a statement about scope rather than an oversight.
-- The spec asks for internal, test and blocked orders to be excluded from velocity. This
-- database has no `is_test`, no `is_internal` and no blocked flag on either `user` or
-- `commerce_organization` — the closest thing is `trade_state`, which already gates
-- trading and is checked separately. Nor is there an operational process that would keep
-- such a flag current.
--
-- So the mechanism exists and the list is empty, and the rollout doc says so. The one
-- population that WILL be in it immediately is the development seed: every organization
-- `seed-store-ranking-dev.ts` writes is registered here, so that if the seed is ever
-- pointed at a real database by accident its orders are structurally excluded from
-- ranking rather than merely embarrassing.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_organization_ranking_exclusion" (
  "organization_id" text PRIMARY KEY NOT NULL,

  -- Why. Required, because an unexplained exclusion is indistinguishable from a mistake
  -- six months later, and this list silently removes a seller from every discovery
  -- surface.
  "reason" text NOT NULL,

  -- NULL for a seed or an automated import; a person for a moderator decision.
  "added_by_user_id" text,

  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "commerce_organization_ranking_exclusion" ADD CONSTRAINT "commerce_organization_ranking_exclusion_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "commerce_organization_ranking_exclusion" ADD CONSTRAINT "commerce_organization_ranking_exclusion_added_by_user_id_user_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "commerce_organization_ranking_exclusion" ADD CONSTRAINT "commerce_organization_ranking_exclusion_reason_ck" CHECK (length(btrim(reason)) BETWEEN 3 AND 500);
