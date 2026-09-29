CREATE TABLE "country_economic_indicator" (
	"id" text PRIMARY KEY NOT NULL,
	"region_id" text NOT NULL,
	"indicator_code" text NOT NULL,
	"data_year" integer NOT NULL,
	"value_in_whole_international_dollars" bigint NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text NOT NULL,
	"source_last_updated_date" date,
	"source_retrieved_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "country_economic_indicator_shape_ck" CHECK (indicator_code = 'NY.GDP.PCAP.PP.CD'
          AND data_year BETWEEN 1960 AND 2200
          AND value_in_whole_international_dollars > 0
          AND source_url LIKE 'https://%')
);
--> statement-breakpoint
CREATE TABLE "feasibility_readout_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"as_of" timestamp NOT NULL,
	"region_id" text NOT NULL,
	"domain" "research_category_domain" NOT NULL,
	"model_version" integer NOT NULL,
	"need_density_points" integer,
	"need_distinct_reporter_count" integer,
	"need_active_cluster_count" integer,
	"purchasing_power_points" integer,
	"purchasing_power_value_in_whole_international_dollars" bigint,
	"purchasing_power_data_year" integer,
	"purchasing_power_source_retrieved_at" timestamp,
	"manufacturing_points" integer,
	"manufacturing_export_value_in_cents" bigint,
	"manufacturing_trade_data_year" integer,
	"manufacturing_domestic_producer_count" integer,
	"manufacturing_source_retrieved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feasibility_readout_snapshot_version_ck" CHECK (model_version >= 1),
	CONSTRAINT "feasibility_readout_snapshot_need_density_ck" CHECK ((need_density_points IS NULL
           AND need_distinct_reporter_count IS NULL
           AND need_active_cluster_count IS NULL)
          OR (need_density_points BETWEEN 0 AND 30
              AND need_distinct_reporter_count >= 0
              AND need_active_cluster_count >= 1)),
	CONSTRAINT "feasibility_readout_snapshot_purchasing_power_ck" CHECK ((purchasing_power_points IS NULL
           AND purchasing_power_value_in_whole_international_dollars IS NULL
           AND purchasing_power_data_year IS NULL
           AND purchasing_power_source_retrieved_at IS NULL)
          OR (purchasing_power_points BETWEEN 0 AND 25
              AND purchasing_power_value_in_whole_international_dollars > 0
              AND purchasing_power_data_year BETWEEN 1960 AND 2200
              AND purchasing_power_source_retrieved_at IS NOT NULL)),
	CONSTRAINT "feasibility_readout_snapshot_manufacturing_ck" CHECK ((manufacturing_points IS NULL
           AND manufacturing_export_value_in_cents IS NULL
           AND manufacturing_trade_data_year IS NULL
           AND manufacturing_domestic_producer_count IS NULL
           AND manufacturing_source_retrieved_at IS NULL)
          OR (manufacturing_points BETWEEN 0 AND 25
              AND manufacturing_export_value_in_cents >= 0
              AND manufacturing_trade_data_year BETWEEN 1960 AND 2200
              AND manufacturing_domestic_producer_count >= 0
              AND manufacturing_source_retrieved_at IS NOT NULL)),
	CONSTRAINT "feasibility_readout_snapshot_not_empty_ck" CHECK (need_density_points IS NOT NULL
          OR purchasing_power_points IS NOT NULL
          OR manufacturing_points IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "country_economic_indicator" ADD CONSTRAINT "country_economic_indicator_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feasibility_readout_snapshot" ADD CONSTRAINT "feasibility_readout_snapshot_region_id_discovery_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."discovery_region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "country_economic_indicator_cell_unq" ON "country_economic_indicator" USING btree ("region_id","indicator_code","data_year");--> statement-breakpoint
CREATE UNIQUE INDEX "feasibility_readout_snapshot_cell_unq" ON "feasibility_readout_snapshot" USING btree ("as_of","region_id","domain");--> statement-breakpoint
CREATE INDEX "feasibility_readout_snapshot_region_asOf_idx" ON "feasibility_readout_snapshot" USING btree ("region_id","as_of");