ALTER TABLE "commerce_checkout_prepare" ADD COLUMN "requested_freight_mode" "commerce_shipment_leg_mode";--> statement-breakpoint
ALTER TABLE "commerce_order" ADD COLUMN "requested_freight_mode_snapshot" "commerce_shipment_leg_mode";--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "sourcing_quote_product_line_id" text;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_sourcing_quote_product_line_id_commerce_quote_product_line_id_fk" FOREIGN KEY ("sourcing_quote_product_line_id") REFERENCES "public"."commerce_quote_product_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_sourcing_quote_line_idx" ON "product" USING btree ("sourcing_quote_product_line_id") WHERE sourcing_quote_product_line_id IS NOT NULL;