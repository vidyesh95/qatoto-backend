-- Store Phase 10 — pre-sales product inquiries (Appendix A14).
--
-- THIS TABLE EXISTS TO KEEP `commerce_thread_resource_uidx` CORRECT.
--
-- The obvious design — add 'product' to `commerce_thread_resource_kind` and point the
-- thread at the product id — collides with that unique index on
-- (resource_kind, resource_id) and produces ONE THREAD PER PRODUCT ACROSS ALL BUYERS.
-- `assertThreadParticipant` would then admit every buyer organization that ever
-- inquired and hand each of them every other buyer's negotiation: a cross-tenant leak
-- against §11, not a UX wart.
--
-- With an inquiry row the index is correct unmodified — one thread per inquiry, one
-- inquiry per (product, buyer organization) — and `commerce_message` is untouched, so
-- no shipped wire contract changes.
--
-- It also removes a migration hazard rather than negotiating with one. Keying on the
-- product would need partial-index predicates naming a newly ADD VALUE'd enum literal,
-- and an enum->text cast is not IMMUTABLE so Postgres rejects it in an index
-- predicate — which would have forced two separate `db:migrate` runs across two
-- releases. Here 0064's `product_inquiry` value is used only by runtime INSERTs.
--
-- Depends on 0064 for that enum value. Nothing in THIS file references it.

CREATE TABLE "commerce_product_inquiry" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "buyer_organization_id" text NOT NULL,
  "buyer_member_id" text NOT NULL,
  "seller_organization_id" text NOT NULL,
  "converted_to_rfq_id" text,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  "updated_at" timestamp(3) DEFAULT now() NOT NULL,
  -- A seller cannot open a pre-sales inquiry on its own listing, mirroring
  -- `commerce_review_self_ck`.
  CONSTRAINT "commerce_product_inquiry_parties_ck" CHECK (
    buyer_organization_id <> seller_organization_id
  )
);--> statement-breakpoint
ALTER TABLE "commerce_product_inquiry" ADD CONSTRAINT "commerce_product_inquiry_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_inquiry" ADD CONSTRAINT "commerce_product_inquiry_buyer_organization_id_commerce_organization_id_fk" FOREIGN KEY ("buyer_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_inquiry" ADD CONSTRAINT "commerce_product_inquiry_buyer_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("buyer_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_inquiry" ADD CONSTRAINT "commerce_product_inquiry_seller_organization_id_commerce_organization_id_fk" FOREIGN KEY ("seller_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_product_inquiry" ADD CONSTRAINT "commerce_product_inquiry_converted_to_rfq_id_commerce_rfq_id_fk" FOREIGN KEY ("converted_to_rfq_id") REFERENCES "public"."commerce_rfq"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- One inquiry per (product, buyer organization). This is the constraint that makes the
-- thread's own unique index correct without touching it.
CREATE UNIQUE INDEX "commerce_product_inquiry_product_buyer_uidx" ON "commerce_product_inquiry" USING btree ("product_id","buyer_organization_id");--> statement-breakpoint
-- The seller's inquiry inbox: an index scan the `resourceKind`-filtered thread query
-- this design replaced could never have served.
CREATE INDEX "commerce_product_inquiry_seller_idx" ON "commerce_product_inquiry" USING btree ("seller_organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "commerce_product_inquiry_buyer_idx" ON "commerce_product_inquiry" USING btree ("buyer_organization_id","created_at","id");
