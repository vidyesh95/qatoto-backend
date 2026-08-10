-- ---------------------------------------------------------------------------
-- Phase 17 — the manufacturer directory (STORE_BACKEND_STRUCTURE.md §16, Appendix A32).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHAT THIS IS NOT: a `commerce_factory_*` table set. A manufacturer is a
-- `commerce_organization` that sells physical goods and has declared how it makes them,
-- and Phase 12 already built most of what the directory renders — the seller profile, the
-- capability list, the certifications with their validity window, the factory photography.
-- A parallel table set would give one organization two capability lists that can disagree,
-- and the disagreement is the bug, not the duplication. So four small additions here, and
-- everything else in §16 is a read.
--
-- THE THIRD CONFLICT IN §16.2 IS RESOLVED BY BUILDING THE RECORD, NOT BY DROPPING THE
-- STATE. `FACTORY_VERIFICATION_STATES` carries `site_audited`, and until now nothing in
-- this schema could support it: `commerce_organization_verification` covers registration,
-- tax, identity, address and bank account — paperwork, all of it. `site_audited` asserts
-- that somebody stood in the building. `commerce_organization_site_audit` is that
-- assertion. It is NEVER derived from a document review, which is the precise collapse the
-- three-state enum exists to prevent.
--
-- THE SAMPLE FEE IS NULLABLE ON PURPOSE. `NULL` means unstated and `0` means free. Two
-- different facts, and the one thing this surface must not do is render an unstated fee as
-- free — a buyer who orders a sample on that basis finds out at invoice time.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The matchable half of the certification vocabulary.
-- ---------------------------------------------------------------------------

-- NULLABLE, and it stays nullable forever. `standard_name` is the display string and the
-- vocabulary is the world's; `standard_code` is the eight a filter chip can be built for.
-- A factory holding a standard outside the set carries NULL here and still renders on the
-- detail page. The read-time expiry rule is untouched: there is no `expired` state,
-- because lapsing is `valid_until < current_date` evaluated when somebody looks.
ALTER TABLE "commerce_organization_certification"
  ADD COLUMN IF NOT EXISTS "standard_code" "commerce_certification_standard_code";
--> statement-breakpoint

-- What the directory filter actually scans: approved rows of one code, still valid.
CREATE INDEX IF NOT EXISTS "commerce_organization_certification_standardCode_idx"
  ON "commerce_organization_certification" ("standard_code", "state", "valid_until")
  WHERE "standard_code" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Named production lines.
-- ---------------------------------------------------------------------------

-- Today `commerce_seller_profile.production_line_count` is a bare integer. A count is not
-- a capability: "four lines" tells a buyer nothing about whether any of them can hold the
-- order. THE UNIT IS REQUIRED BESIDE THE CAPACITY for the same reason the MOQ pair is
-- both-or-neither — a capacity with no unit cannot be compared against an order.
CREATE TABLE IF NOT EXISTS "commerce_organization_production_line" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "process_summary" text NOT NULL,
  "monthly_capacity_units" integer,
  "unit_label" text NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "commerce_organization_production_line"
  ADD CONSTRAINT "commerce_organization_production_line_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "commerce_organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Same ordering contract as `commerce_organization_site_access` and
-- `commerce_organization_media`: position is unique per organization, and the whole
-- collection is rewritten in one transaction rather than patched row by row.
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_organization_production_line_position_uidx"
  ON "commerce_organization_production_line" ("organization_id", "position");
--> statement-breakpoint

ALTER TABLE "commerce_organization_production_line"
  ADD CONSTRAINT "commerce_organization_production_line_text_ck" CHECK (
    char_length("name") BETWEEN 1 AND 200
    AND char_length("process_summary") BETWEEN 1 AND 2000
    AND char_length("unit_label") BETWEEN 1 AND 40
  );
--> statement-breakpoint

ALTER TABLE "commerce_organization_production_line"
  ADD CONSTRAINT "commerce_organization_production_line_numbers_ck" CHECK (
    "position" >= 0
    AND ("monthly_capacity_units" IS NULL OR "monthly_capacity_units" >= 0)
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Physical sites.
-- ---------------------------------------------------------------------------

-- DISTINCT FROM `commerce_organization_site_access`, which carries only transport modes
-- and is about REACHING a site rather than describing one. A factory may run several
-- sites, in more than one country.
--
-- The org-wide `commerce_seller_profile.factory_area_square_metres` is seller-declared and
-- the per-site figures are seller-declared, and if they disagree THE READ PUBLISHES BOTH
-- rather than summing or reconciling them. A platform that silently prefers one is
-- asserting something neither party said.
CREATE TABLE IF NOT EXISTS "commerce_organization_site" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "label" text NOT NULL,
  "country_code" text NOT NULL,
  "locality" text,
  "floor_area_square_metres" integer,
  "production_staff_count" integer,
  "position" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "commerce_organization_site"
  ADD CONSTRAINT "commerce_organization_site_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "commerce_organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_organization_site_position_uidx"
  ON "commerce_organization_site" ("organization_id", "position");
--> statement-breakpoint

ALTER TABLE "commerce_organization_site"
  ADD CONSTRAINT "commerce_organization_site_text_ck" CHECK (
    char_length("label") BETWEEN 1 AND 200
    AND "country_code" ~ '^[A-Z]{2}$'
    AND ("locality" IS NULL OR char_length("locality") BETWEEN 1 AND 200)
  );
--> statement-breakpoint

ALTER TABLE "commerce_organization_site"
  ADD CONSTRAINT "commerce_organization_site_numbers_ck" CHECK (
    "position" >= 0
    AND ("floor_area_square_metres" IS NULL OR "floor_area_square_metres" >= 0)
    AND ("production_staff_count" IS NULL OR "production_staff_count" >= 0)
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The record behind `site_audited`.
-- ---------------------------------------------------------------------------

-- STAFF-WRITTEN, NEVER SELLER-WRITTEN, and every row names an accountable human through
-- `audit_entry_id` — the shape `commerce_moderation_action` already uses. A verification
-- state is about the ORGANIZATION, never about a capability: this row does not mean the
-- factory is approved to do injection moulding, and there is no per-capability approval on
-- the wire at all.
--
-- `restrict` on the organization, not `cascade`: an audit is a statement the platform made
-- and stands behind, and deleting the subject must not quietly delete the statement.
CREATE TABLE IF NOT EXISTS "commerce_organization_site_audit" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "audited_at" date NOT NULL,
  "auditor_name" text NOT NULL,
  "auditor_organization_name" text,
  "scope_summary" text NOT NULL,
  "state" "commerce_site_audit_state" DEFAULT 'recorded' NOT NULL,
  "recorded_by_user_id" text NOT NULL,
  "audit_entry_id" text NOT NULL,
  "withdrawn_by_user_id" text,
  "withdrawn_at" timestamp,
  "withdrawal_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "commerce_organization_site_audit"
  ADD CONSTRAINT "commerce_organization_site_audit_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "commerce_organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_organization_site_audit"
  ADD CONSTRAINT "commerce_organization_site_audit_recorded_by_user_id_user_id_fk"
  FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_organization_site_audit"
  ADD CONSTRAINT "commerce_organization_site_audit_withdrawn_by_user_id_user_id_fk"
  FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_organization_site_audit"
  ADD CONSTRAINT "commerce_organization_site_audit_audit_entry_id_platform_audit_entry_id_fk"
  FOREIGN KEY ("audit_entry_id") REFERENCES "platform_audit_entry"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- One audit entry, one audit row.
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_organization_site_audit_auditEntryId_uidx"
  ON "commerce_organization_site_audit" ("audit_entry_id");
--> statement-breakpoint

-- What the detail read scans for `lastAuditedAt`, and what the card scans to decide
-- whether the state is `site_audited` at all.
CREATE INDEX IF NOT EXISTS "commerce_organization_site_audit_recent_idx"
  ON "commerce_organization_site_audit" ("organization_id", "state", "audited_at" DESC);
--> statement-breakpoint

-- The three withdrawal columns move as a set, the same discipline
-- `research_program_post`'s hidden columns keep. A withdrawal must carry its reason: this
-- is the platform retracting a claim it published, and "why" is the whole content of that.
ALTER TABLE "commerce_organization_site_audit"
  ADD CONSTRAINT "commerce_organization_site_audit_withdrawal_ck" CHECK (
    ("state" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
    AND ("withdrawn_at" IS NULL) = ("withdrawn_by_user_id" IS NULL)
    AND ("withdrawn_at" IS NULL) = ("withdrawal_reason" IS NULL)
  );
--> statement-breakpoint

ALTER TABLE "commerce_organization_site_audit"
  ADD CONSTRAINT "commerce_organization_site_audit_text_ck" CHECK (
    char_length("auditor_name") BETWEEN 1 AND 200
    AND ("auditor_organization_name" IS NULL OR char_length("auditor_organization_name") BETWEEN 1 AND 200)
    AND char_length("scope_summary") BETWEEN 1 AND 2000
    AND ("withdrawal_reason" IS NULL OR char_length("withdrawal_reason") BETWEEN 1 AND 2000)
  );
--> statement-breakpoint

-- Which sites the auditor actually walked. An audit covering no listed site is still a
-- real audit — a factory may not have declared its sites — so this is a link table rather
-- than a required column.
CREATE TABLE IF NOT EXISTS "commerce_organization_site_audit_site" (
  "audit_id" text NOT NULL,
  "site_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_organization_site_audit_site_pk" PRIMARY KEY ("audit_id", "site_id")
);
--> statement-breakpoint

ALTER TABLE "commerce_organization_site_audit_site"
  ADD CONSTRAINT "commerce_organization_site_audit_site_audit_id_commerce_organization_site_audit_id_fk"
  FOREIGN KEY ("audit_id") REFERENCES "commerce_organization_site_audit"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_organization_site_audit_site"
  ADD CONSTRAINT "commerce_organization_site_audit_site_site_id_commerce_organization_site_id_fk"
  FOREIGN KEY ("site_id") REFERENCES "commerce_organization_site"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Org-level sample policy and order bounds.
-- ---------------------------------------------------------------------------

ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "offers_samples" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "sample_lead_time_days" integer;
--> statement-breakpoint
ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "sample_fee_in_cents" bigint;
--> statement-breakpoint
-- Server-owned and never null, the `talent_profile.currency` precedent. A fee needs a
-- currency to be a fee at all, and the wire carries this even when the fee is unstated.
ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "sample_currency" text DEFAULT 'USD' NOT NULL;
--> statement-breakpoint
ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "minimum_order_quantity" integer;
--> statement-breakpoint
ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "minimum_order_quantity_unit_label" text;
--> statement-breakpoint
ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "minimum_lead_time_days" integer;
--> statement-breakpoint
ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "maximum_lead_time_days" integer;
--> statement-breakpoint
-- A factory's own inbox switch. Without it the only way to stop inquiries is to leave the
-- platform, and a card that says "accepting inquiries" would be asserting something the
-- seller never chose.
ALTER TABLE "commerce_seller_profile" ADD COLUMN IF NOT EXISTS "accepting_inquiries" boolean DEFAULT true NOT NULL;
--> statement-breakpoint

-- THE MOQ PAIR IS BOTH-OR-NEITHER. A bare `500` is unreadable: 500 pieces and 500 cartons
-- are different businesses, so a renderer must have the unit before it prints the number.
-- The lead-time pair is ordered but not paired — a floor with no ceiling is a readable
-- claim where half a MOQ is not.
ALTER TABLE "commerce_seller_profile"
  ADD CONSTRAINT "commerce_seller_profile_order_bounds_ck" CHECK (
    ("minimum_order_quantity" IS NULL) = ("minimum_order_quantity_unit_label" IS NULL)
    AND ("minimum_order_quantity" IS NULL OR "minimum_order_quantity" > 0)
    AND ("minimum_order_quantity_unit_label" IS NULL OR char_length("minimum_order_quantity_unit_label") BETWEEN 1 AND 40)
    AND ("minimum_lead_time_days" IS NULL OR "minimum_lead_time_days" >= 0)
    AND ("maximum_lead_time_days" IS NULL OR "maximum_lead_time_days" >= 0)
    AND (
      "minimum_lead_time_days" IS NULL
      OR "maximum_lead_time_days" IS NULL
      OR "minimum_lead_time_days" <= "maximum_lead_time_days"
    )
  );
--> statement-breakpoint

ALTER TABLE "commerce_seller_profile"
  ADD CONSTRAINT "commerce_seller_profile_sample_policy_ck" CHECK (
    "sample_currency" ~ '^[A-Z]{3}$'
    AND ("sample_lead_time_days" IS NULL OR "sample_lead_time_days" >= 0)
    AND ("sample_fee_in_cents" IS NULL OR "sample_fee_in_cents" >= 0)
    AND ("offers_samples" OR ("sample_lead_time_days" IS NULL AND "sample_fee_in_cents" IS NULL))
  );
