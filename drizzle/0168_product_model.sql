-- STORE Appendix A47 — a listing can carry a 3D MODEL.
--
-- WHAT WAS MISSING. `product_media_kind` has had a `spin_360` label since Phase 8, but a spin is
-- an ordered run of STILLS, and no seller has ever uploaded one. The product page's "View in 360°"
-- control needs a mesh a viewer can orbit, and nothing in the schema could hold one.
--
-- ONE ROW PER PRODUCT, REPLACED IN PLACE. `commerce_product_model_product_uidx` is what makes a
-- re-upload an upsert: the Cloudinary public id is derived from `product_id`, the bytes are
-- overwritten at that id, and the row converges — which is why the route needs no idempotency key.
--
-- ⚠️ A `url` COLUMN, AND THAT IS DELIBERATE — the `product_image` posture, NOT `0155`'s. A document
-- is a download a buyer takes away, so it sits in a private bucket behind a gate. A model is
-- rendered in place on the same public page as the nine public gallery URLs, and the viewer fetches
-- it with a browser `fetch()` that needs CORS on the final response — which Cloudinary delivery
-- answers and a presigned private-bucket link does not. Same exposure class as the gallery.
--
-- NO BYTE CAP IN A CHECK. The 10 MB limit is Cloudinary's per-file cap for `resource_type: "raw"`
-- on the current plan, held in `glb.ts` so raising it with the plan is a constant, not a migration.
--
-- `product_media_kind` is untouched: a pgEnum label cannot be dropped, and a spin and a model may
-- coexist on one listing.
--
CREATE TABLE "commerce_product_model" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"url" text NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"file_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_product_model_byte_size_ck" CHECK (byte_size > 0),
	CONSTRAINT "commerce_product_model_sha_ck" CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "commerce_product_model_file_name_ck" CHECK (char_length(file_name) BETWEEN 1 AND 120),
	CONSTRAINT "commerce_product_model_url_ck" CHECK (char_length(url) <= 2048 AND url LIKE 'https://%')
);
--> statement-breakpoint
ALTER TABLE "commerce_product_model" ADD CONSTRAINT "commerce_product_model_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_model_product_uidx" ON "commerce_product_model" USING btree ("product_id");