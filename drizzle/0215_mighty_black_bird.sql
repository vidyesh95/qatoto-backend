CREATE TABLE "country_business_ready_score" (
	"id" text PRIMARY KEY NOT NULL,
	"region_id" text NOT NULL,
	"indicator_code" text NOT NULL,
	"edition_year" integer NOT NULL,
	"score_in_tenths" integer NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text NOT NULL,
	"source_last_updated_date" date,
	"source_retrieved_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "country_business_ready_score_shape_ck" CHECK (indicator_code = 'IC.BRE.P1.RF'
          AND edition_year BETWEEN 2024 AND 2200
          AND score_in_tenths BETWEEN 0 AND 1000
          AND source_url LIKE 'https://%')
);
--> statement-breakpoint
ALTER TABLE "feasibility_readout_snapshot" DROP CONSTRAINT "feasibility_readout_snapshot_not_empty_ck";--> statement-breakpoint
ALTER TABLE "feasibility_readout_snapshot" ADD COLUMN "regulatory_framework_points" integer;--> statement-breakpoint
ALTER TABLE "feasibility_readout_snapshot" ADD COLUMN "regulatory_framework_score_in_tenths" integer;--> statement-breakpoint
ALTER TABLE "feasibility_readout_snapshot" ADD COLUMN "regulatory_framework_edition_year" integer;--> statement-breakpoint
ALTER TABLE "feasibility_readout_snapshot" ADD COLUMN "regulatory_framework_source_retrieved_at" timestamp;--> statement-breakpoint
ALTER TABLE "country_business_ready_score" ADD CONSTRAINT "country_business_ready_score_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "country_business_ready_score_cell_unq" ON "country_business_ready_score" USING btree ("region_id","indicator_code","edition_year");--> statement-breakpoint
ALTER TABLE "feasibility_readout_snapshot" ADD CONSTRAINT "feasibility_readout_snapshot_regulatory_framework_ck" CHECK ((regulatory_framework_points IS NULL
           AND regulatory_framework_score_in_tenths IS NULL
           AND regulatory_framework_edition_year IS NULL
           AND regulatory_framework_source_retrieved_at IS NULL)
          OR (regulatory_framework_points BETWEEN 0 AND 20
              AND regulatory_framework_score_in_tenths BETWEEN 0 AND 1000
              AND regulatory_framework_edition_year BETWEEN 2024 AND 2200
              AND regulatory_framework_source_retrieved_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "feasibility_readout_snapshot" ADD CONSTRAINT "feasibility_readout_snapshot_not_empty_ck" CHECK (need_density_points IS NOT NULL
          OR purchasing_power_points IS NOT NULL
          OR manufacturing_points IS NOT NULL
          OR regulatory_framework_points IS NOT NULL);