CREATE TYPE "public"."product_category" AS ENUM('electronics', 'fashion', 'home_kitchen', 'anime_collectibles', 'digital_goods', 'books_media', 'sports_outdoors', 'beauty_personal_care');--> statement-breakpoint
CREATE TYPE "public"."product_condition" AS ENUM('new', 'refurbished', 'used');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active');--> statement-breakpoint
CREATE TABLE "product" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"title" text NOT NULL,
	"brand" text,
	"category" "product_category" NOT NULL,
	"condition" "product_condition" DEFAULT 'new' NOT NULL,
	"description" text,
	"price_in_cents" integer NOT NULL,
	"compare_at_price_in_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"sku" text,
	"key_features" text[] DEFAULT '{}' NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_image" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"url" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_pricing_tier" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"unit_price_in_cents" integer NOT NULL,
	"minimum_order_quantity" integer NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_seller_id_user_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_image" ADD CONSTRAINT "product_image_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_pricing_tier" ADD CONSTRAINT "product_pricing_tier_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_sellerId_idx" ON "product" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "product_status_idx" ON "product" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "product_seller_sku_unq" ON "product" USING btree ("seller_id","sku");--> statement-breakpoint
CREATE INDEX "product_image_productId_idx" ON "product_image" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_pricing_tier_productId_idx" ON "product_pricing_tier" USING btree ("product_id");