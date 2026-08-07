-- Store Phase 12 — seller-declared company depth (Appendix A13 items 2–5).
--
-- WHY THESE TABLES EXIST AT ALL: `commerce_provider_profile` is keyed to SERVICE
-- PROVIDERS, so a manufacturer selling products had no profile row anywhere and the whole
-- company-details surface was mock UI. `commerce_seller_profile` mirrors that table's
-- shape deliberately — one row per organization, keyed on the organization, cascade on
-- delete — so two trade roles read recognisably the same way.
--
-- EVERY COLUMN IN THIS FILE IS A CLAIM. Nothing here is verified, measured or derived.
-- The certifications in 0071 are the only rows in this phase carrying a decision.
--
-- Additive: five new tables, no column changes to anything shipped. Rollback is
-- DROP TABLE in reverse dependency order plus reverting the projection.

-- ---------------------------------------------------------------------------
-- A13 item 2. The profile row.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_seller_profile" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "year_founded" integer,
  "factory_count" integer,
  "total_staff_count" integer,
  "production_line_count" integer,
  "factory_area_square_metres" integer,
  "business_type" "commerce_seller_business_type",
  "visit_policy" "commerce_visit_policy",
  "accepting_custom_orders" boolean DEFAULT false NOT NULL,
  "public_summary" text,
  -- SELLER-TYPED, NOT MEASURED, and named to say so. The same shape as
  -- `commerce_provider_profile.average_response_time_hours`, which had been shipping as a
  -- flat sibling of the platform-derived `fulfillmentMetrics.onTimeShipmentRate` since
  -- Phase 2 — precisely the flattening A13's rule forbids. The measured figure is
  -- computed from message timestamps and lives nowhere on this table.
  "declared_response_time_hours" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  -- The upper bound is a FIXED YEAR, not `extract(year from now())`: now() is not
  -- IMMUTABLE and Postgres refuses it in a CHECK. The real rule — a founding year is not
  -- in the future — is enforced in Zod at the boundary, where it can read a clock. This
  -- constraint exists to stop a typo like 20250, not to be the whole rule.
  CONSTRAINT "commerce_seller_profile_year_founded_ck" CHECK (
    year_founded IS NULL OR year_founded BETWEEN 1800 AND 2100
  ),
  CONSTRAINT "commerce_seller_profile_counts_ck" CHECK (
    (factory_count IS NULL OR factory_count >= 0)
    AND (total_staff_count IS NULL OR total_staff_count >= 0)
    AND (production_line_count IS NULL OR production_line_count >= 0)
    AND (factory_area_square_metres IS NULL OR factory_area_square_metres >= 0)
  ),
  CONSTRAINT "commerce_seller_profile_response_ck" CHECK (
    declared_response_time_hours IS NULL OR declared_response_time_hours BETWEEN 0 AND 8760
  ),
  CONSTRAINT "commerce_seller_profile_text_ck" CHECK (
    public_summary IS NULL OR char_length(public_summary) <= 4000
  )
);--> statement-breakpoint
ALTER TABLE "commerce_seller_profile" ADD CONSTRAINT "commerce_seller_profile_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_seller_profile_businessType_idx" ON "commerce_seller_profile" USING btree ("business_type");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A13 item 3a. Factory / office / warehouse photography.
--
-- PLATFORM-HOSTED, not a seller-supplied URL, and that is a deliberate departure from the
-- two closest precedents: `commerce_product_highlight.image_url` and
-- `commerce_organization.logo_url` both take an https string. These images are uploaded
-- through Cloudinary like `product_image` instead, because a factory photo is the one
-- image class here that routinely carries EXIF GPS, and a hotlink cannot have it stripped.
--
-- `width_px`/`height_px` are measured from the DECODED BYTES, never accepted from the
-- client — the rule A2 established for `product_image`.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_organization_media" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "media_kind" "commerce_organization_media_kind" NOT NULL,
  "image_url" text NOT NULL,
  -- Retained so deletion can destroy the remote asset. NEVER projected publicly, and
  -- never named in an audit payload — see 0069 on `object.*key`.
  "cloudinary_public_id" text NOT NULL,
  "alt_text" text,
  "width_px" integer NOT NULL,
  "height_px" integer NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_organization_media_position_ck" CHECK (position >= 0),
  CONSTRAINT "commerce_organization_media_dimensions_ck" CHECK (width_px > 0 AND height_px > 0),
  CONSTRAINT "commerce_organization_media_url_ck" CHECK (
    char_length(image_url) <= 2048 AND image_url LIKE 'https://%'
    AND (alt_text IS NULL OR char_length(alt_text) <= 500)
  )
);--> statement-breakpoint
ALTER TABLE "commerce_organization_media" ADD CONSTRAINT "commerce_organization_media_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A plain (organization_id, position) unique index, NOT the coalesce() expression index
-- A2 needed for `product_image`. There is no per-variant gallery here, so nothing shares
-- position 0 — which also means gallery re-packing needs no park-beyond-the-range dance.
CREATE UNIQUE INDEX "commerce_organization_media_position_uidx" ON "commerce_organization_media" USING btree ("organization_id","position");--> statement-breakpoint
CREATE INDEX "commerce_organization_media_kind_idx" ON "commerce_organization_media" USING btree ("organization_id","media_kind");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A13 item 3b. Declared freight access to the seller's site.
--
-- `distance_km` is an INTEGER IN A NAMED UNIT, never the formatted string the mock
-- rendered. A5 made the same call about package dimensions and for the same reason: prose
-- cannot be filtered, compared, or freight-rated.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_organization_site_access" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "access_mode" "commerce_site_access_mode" NOT NULL,
  "facility_name" text NOT NULL,
  "distance_km" integer,
  "notes" text,
  "position" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_organization_site_access_position_ck" CHECK (position >= 0),
  -- 40000 km is roughly the earth's circumference. A distance larger than that is a data
  -- entry error, not a remote factory.
  CONSTRAINT "commerce_organization_site_access_distance_ck" CHECK (
    distance_km IS NULL OR (distance_km >= 0 AND distance_km <= 40000)
  ),
  CONSTRAINT "commerce_organization_site_access_text_ck" CHECK (
    char_length(facility_name) BETWEEN 1 AND 200
    AND (notes IS NULL OR char_length(notes) <= 1000)
  )
);--> statement-breakpoint
ALTER TABLE "commerce_organization_site_access" ADD CONSTRAINT "commerce_organization_site_access_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_organization_site_access_position_uidx" ON "commerce_organization_site_access" USING btree ("organization_id","position");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A13 item 4. Named company officers.
--
-- NOTE WHAT THIS TABLE CANNOT HOLD: an email address, a phone number, or any other way to
-- reach the person named. That absence is not an oversight and is not to be filled in
-- later — it is the entire reason these rows are safe to publish. A name and a role title
-- are what a company already prints on its own website; a direct line to a named
-- individual is personal data, and adding a column for it would silently convert a public
-- projection into a disclosure.
--
-- Stored plaintext for the same reason: there is nothing here to encrypt.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_organization_stakeholder" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "full_name" text NOT NULL,
  "role_title" text NOT NULL,
  "photo_url" text,
  "position" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_organization_stakeholder_position_ck" CHECK (position >= 0),
  CONSTRAINT "commerce_organization_stakeholder_text_ck" CHECK (
    char_length(full_name) BETWEEN 1 AND 200
    AND char_length(role_title) BETWEEN 1 AND 200
    AND (photo_url IS NULL OR (char_length(photo_url) <= 2048 AND photo_url LIKE 'https://%'))
  )
);--> statement-breakpoint
ALTER TABLE "commerce_organization_stakeholder" ADD CONSTRAINT "commerce_organization_stakeholder_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_organization_stakeholder_position_uidx" ON "commerce_organization_stakeholder" USING btree ("organization_id","position");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A13 item 5. Declared production capabilities.
--
-- Unique on (organization_id, capability_kind) rather than on position: claiming OEM twice
-- is not an ordering question, it is one row. Position still exists so the seller controls
-- display order.
--
-- `sheets/verified-capabilities-sheet.tsx` is named for what it renders, not for what
-- these rows prove. Only the certifications in 0071 carry a moderator's decision.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_organization_capability" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "capability_kind" "commerce_organization_capability_kind" NOT NULL,
  "detail" text,
  "position" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_organization_capability_position_ck" CHECK (position >= 0),
  CONSTRAINT "commerce_organization_capability_detail_ck" CHECK (
    detail IS NULL OR char_length(detail) <= 1000
  )
);--> statement-breakpoint
ALTER TABLE "commerce_organization_capability" ADD CONSTRAINT "commerce_organization_capability_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_organization_capability_kind_uidx" ON "commerce_organization_capability" USING btree ("organization_id","capability_kind");
