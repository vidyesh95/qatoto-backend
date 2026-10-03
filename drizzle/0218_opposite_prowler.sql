-- todo §23.4: filterable cargo cover types beside the free-text classes on insurance offerings.
-- A closed set for the provider directory filter (`coverageClass`); the free text stays the display.
-- No backfill: no insurance offering existed when this shipped. Generated; no hand edits.
CREATE TYPE "public"."commerce_cargo_coverage_class_code" AS ENUM('institute_cargo_clauses_a', 'institute_cargo_clauses_b', 'institute_cargo_clauses_c', 'institute_cargo_clauses_air', 'institute_war_clauses', 'institute_strikes_clauses', 'stock_throughput', 'goods_in_storage');--> statement-breakpoint
ALTER TABLE "insurance_offering_detail" ADD COLUMN "coverage_class_codes" "commerce_cargo_coverage_class_code"[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "insurance_offering_detail" ADD CONSTRAINT "insurance_offering_detail_coverage_class_codes_ck" CHECK (cardinality(coverage_class_codes) <= 8);