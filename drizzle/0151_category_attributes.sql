-- STORE §20 / Phase 24 — the parametric half of the catalogue.
--
-- WHAT THIS CLOSES. `commerce_product_specification` is free text: two sellers listing the same
-- chair write "Material"/"Wood" and "material type"/"Solid oak", and nothing can filter or compare
-- them. These tables give a category a VOCABULARY — typed questions, inherited down the tree — so
-- the spec sheet becomes a comparison and the facets become filters.
--
-- ADDITIVE ONLY. Four tables, two enums, ten indexes. No existing column is touched, nothing is
-- backfilled, and every listing on the site keeps working with zero attribute values.
--
-- ⚠️ THREE DELETE RULES, AND EACH IS LOad-BEARING.
--   * `commerce_product_attribute_value.attribute_id` is RESTRICT — a definition in use cannot be
--     deleted, which is why the admin exit is `is_filterable = false` (reversible) and not DELETE.
--   * `..._choice.attribute_id` is CASCADE — a choice has no meaning without its question — but
--     `..._value.choice_id` is RESTRICT, so a choice a listing actually answered still cannot go.
--   * `commerce_category_attribute.category_id` is RESTRICT, matching `product.category_id`: the
--     taxonomy's only exit is `retire`, and it stays that way.
--
-- ⚠️ NO UNIQUE INDEX ON (category_id, position), AND THAT IS A DEPARTURE FROM `commerce_category`.
-- That table can enforce a unique sibling order because its reorder route rewrites a whole sibling
-- set in two passes (park above the maximum, then assign). An attribute set cannot be rewritten
-- that way at all — the RESTRICT above means a replace-set fails the moment one listing uses one —
-- so a unique position would forbid inserting at 3 with no operation able to make room. Position is
-- an ordering hint; ties break on `attribute_key`, which is stable, so the order is still
-- deterministic. If a reorder control is ever added, the two-pass pattern comes with it.
--
-- ⚠️ `numeric_scale` LIVES ON THE DEFINITION, NEVER ON THE VALUE. Fixed point, like the FX rate on
-- a quote revision. On the value row it would let two answers to one question disagree about what
-- `4700` means.
--
-- ⚠️ ONLY `enum` AND `number` MAY BE FILTERABLE (`..._filterable_ck`). A filterable free-text
-- attribute yields "Oak", "oak" and "Solid oak" as three chips over one intended answer — worse
-- than no filter, because it looks authoritative. Same split as the shipped certification model:
-- `standard_code` closed and filterable, `standard_name` open and not.
CREATE TYPE "public"."commerce_category_attribute_request_state" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."commerce_category_attribute_value_kind" AS ENUM('enum', 'number', 'text');--> statement-breakpoint
CREATE TABLE "commerce_category_attribute" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"attribute_key" text NOT NULL,
	"label" text NOT NULL,
	"group_label" text,
	"value_kind" "commerce_category_attribute_value_kind" NOT NULL,
	"unit_label" text,
	"numeric_scale" smallint,
	"is_filterable" boolean DEFAULT false NOT NULL,
	"is_required_for_publish" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_category_attribute_key_ck" CHECK (attribute_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "commerce_category_attribute_text_ck" CHECK (char_length(attribute_key) BETWEEN 1 AND 64
          AND char_length(label) BETWEEN 1 AND 120
          AND (group_label IS NULL OR char_length(group_label) BETWEEN 1 AND 80)
          AND (unit_label IS NULL OR char_length(unit_label) BETWEEN 1 AND 24)),
	CONSTRAINT "commerce_category_attribute_numeric_ck" CHECK ((value_kind = 'number') = (numeric_scale IS NOT NULL)
          AND (unit_label IS NULL OR value_kind = 'number')
          AND (numeric_scale IS NULL OR numeric_scale BETWEEN 0 AND 6)),
	CONSTRAINT "commerce_category_attribute_filterable_ck" CHECK (NOT (is_filterable AND value_kind = 'text')),
	CONSTRAINT "commerce_category_attribute_position_ck" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_category_attribute_choice" (
	"id" text PRIMARY KEY NOT NULL,
	"attribute_id" text NOT NULL,
	"choice_value" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_category_attribute_choice_value_ck" CHECK (choice_value ~ '^[a-z0-9]+(_[a-z0-9]+)*$' AND char_length(choice_value) BETWEEN 1 AND 64),
	CONSTRAINT "commerce_category_attribute_choice_label_ck" CHECK (char_length(label) BETWEEN 1 AND 120),
	CONSTRAINT "commerce_category_attribute_choice_position_ck" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "commerce_category_attribute_request" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_by_user_id" text,
	"requested_organization_id" text,
	"category_id" text NOT NULL,
	"proposed_label" text NOT NULL,
	"proposed_value_kind" "commerce_category_attribute_value_kind" NOT NULL,
	"proposed_unit_label" text,
	"justification" text,
	"state" "commerce_category_attribute_request_state" DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp,
	"review_note" text,
	"resulting_attribute_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_category_attribute_request_review_ck" CHECK ((reviewed_at IS NULL) = (state = 'pending')
          AND (state = 'approved' OR resulting_attribute_id IS NULL)
          AND (state <> 'rejected' OR review_note IS NOT NULL)),
	CONSTRAINT "commerce_category_attribute_request_text_ck" CHECK (char_length(proposed_label) BETWEEN 1 AND 120
          AND (proposed_unit_label IS NULL OR char_length(proposed_unit_label) BETWEEN 1 AND 24)
          AND (justification IS NULL OR char_length(justification) BETWEEN 1 AND 2000)
          AND (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 2000)),
	CONSTRAINT "commerce_category_attribute_request_unit_ck" CHECK (proposed_unit_label IS NULL OR proposed_value_kind = 'number')
);
--> statement-breakpoint
CREATE TABLE "commerce_product_attribute_value" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"attribute_id" text NOT NULL,
	"choice_id" text,
	"numeric_value_scaled" bigint,
	"text_value" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_product_attribute_value_one_value_ck" CHECK (num_nonnulls(choice_id, numeric_value_scaled, text_value) = 1),
	CONSTRAINT "commerce_product_attribute_value_text_ck" CHECK (text_value IS NULL OR char_length(text_value) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "commerce_category_attribute" ADD CONSTRAINT "commerce_category_attribute_category_id_commerce_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."commerce_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_category_attribute_choice" ADD CONSTRAINT "commerce_category_attribute_choice_attribute_id_commerce_category_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."commerce_category_attribute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_category_attribute_request" ADD CONSTRAINT "commerce_category_attribute_request_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_category_attribute_request" ADD CONSTRAINT "commerce_category_attribute_request_requested_organization_id_commerce_organization_id_fk" FOREIGN KEY ("requested_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_category_attribute_request" ADD CONSTRAINT "commerce_category_attribute_request_category_id_commerce_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."commerce_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_category_attribute_request" ADD CONSTRAINT "commerce_category_attribute_request_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_category_attribute_request" ADD CONSTRAINT "commerce_category_attribute_request_resulting_attribute_id_commerce_category_attribute_id_fk" FOREIGN KEY ("resulting_attribute_id") REFERENCES "public"."commerce_category_attribute"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_attribute_value" ADD CONSTRAINT "commerce_product_attribute_value_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_attribute_value" ADD CONSTRAINT "commerce_product_attribute_value_attribute_id_commerce_category_attribute_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."commerce_category_attribute"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_attribute_value" ADD CONSTRAINT "commerce_product_attribute_value_choice_id_commerce_category_attribute_choice_id_fk" FOREIGN KEY ("choice_id") REFERENCES "public"."commerce_category_attribute_choice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_category_attribute_key_uidx" ON "commerce_category_attribute" USING btree ("category_id","attribute_key");--> statement-breakpoint
CREATE INDEX "commerce_category_attribute_category_idx" ON "commerce_category_attribute" USING btree ("category_id","position","attribute_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_category_attribute_choice_uidx" ON "commerce_category_attribute_choice" USING btree ("attribute_id","choice_value");--> statement-breakpoint
CREATE INDEX "commerce_category_attribute_choice_attribute_idx" ON "commerce_category_attribute_choice" USING btree ("attribute_id","position","choice_value");--> statement-breakpoint
CREATE INDEX "commerce_category_attribute_request_queue_idx" ON "commerce_category_attribute_request" USING btree ("state","created_at","id");--> statement-breakpoint
CREATE INDEX "commerce_category_attribute_request_requestedByUserId_idx" ON "commerce_category_attribute_request" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE INDEX "commerce_category_attribute_request_category_idx" ON "commerce_category_attribute_request" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_attribute_value_uidx" ON "commerce_product_attribute_value" USING btree ("product_id","attribute_id");--> statement-breakpoint
CREATE INDEX "commerce_product_attribute_value_choice_idx" ON "commerce_product_attribute_value" USING btree ("attribute_id","choice_id");--> statement-breakpoint
CREATE INDEX "commerce_product_attribute_value_numeric_idx" ON "commerce_product_attribute_value" USING btree ("attribute_id","numeric_value_scaled");