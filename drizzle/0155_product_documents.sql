-- STORE §21.3 — a listing can finally carry a FILE.
--
-- WHAT WAS MISSING. A listing carried nine images, twelve highlight blocks, a spec sheet and a
-- typed attribute vocabulary, and not one downloadable document. A buyer could not get the
-- assembly guide, the care card, the dimensional drawing or the datasheet.
--
-- MODELLED ON `video_document`, NOT on `commerce_encrypted_document`. The latter is private,
-- envelope-encrypted and moderator-read; this is published material a buyer reads BEFORE deciding
-- to talk to anybody. Different thing, different threat model.
--
-- ⚠️ NO `url` COLUMN, AND ADDING ONE WOULD BE A REGRESSION. A URL outlives the gate: a link handed
-- out while the listing was public keeps working after it is unpublished, suspended by a moderator,
-- or its organization's trade state changes, because bytes do not know a row's visibility changed.
-- Downloads go through `GET /store/products/:productSlug/documents/:documentId/file`, which
-- re-checks the whole §4.4 eligibility chain per request and 302s to a five-minute presigned URL.
--
-- ⚠️ NO `state` COLUMN, AND THAT IS A DECISION §21.3 LEFT OPEN. `video_document` — the precedent
-- this copies — is not scanned at all, and the only working scanner is an EICAR-only fake whose
-- `clamav` sibling returns SCANNER_UNAVAILABLE. Unlike the payment factory, that fake IS permitted
-- in production, so a `pending_scan` gate would stamp every upload `clean` and promote it while
-- implying a review nobody performed. The route answers 201, not 202, and no copy anywhere says
-- the file is checked. A gate that passes everything is worse than an honest absence.
--
-- ⚠️ THE ENUM HAS NO `certificate` VALUE, AND THE SPEC ASKED FOR ONE. §21.3 lists it two paragraphs
-- after saying `commerce_encrypted_document` "is the right home for a business registration
-- certificate and the wrong home for a datasheet" — the spec contradicts itself, the same way its
-- §21.1 "no migration" claim did. `commerce_organization_certification` already carries reviewed
-- compliance claims with a three-way state, a reviewer who may not be the submitter, validity dates
-- and evidence that never rides the wire. A seller-uploaded file labelled "certificate" would look
-- identical to a buyer with none of that behind it. The asymmetry settles it rather than taste:
-- Postgres cannot DROP an enum value, but adding one is a one-line migration.
--
-- ⚠️ A SEPARATE ENUM FROM `commerce_document_kind`, which belongs to the encrypted store. Sharing
-- one vocabulary would put a datasheet and a passport scan in the same list of words.
--
-- CONTENT-ADDRESSED. `object_storage_key` derives from `content_sha256`, so a retried upload
-- converges on the same object; `commerce_product_document_content_uidx` makes the row converge
-- too. That is why the route carries no `idempotency()` middleware — the storage layer already
-- gives a stronger guarantee than a replayed response would.
--
-- `position` is assigned at insert and NOT re-packed on delete: a gap orders identically, and
-- re-packing rewrites rows the seller did not touch. This diverges from `product_image`, which does
-- re-pack and has a reorder route — a nine-image gallery is curated presentation, five attached
-- files are not.
--
-- ADDITIVE ONLY: one enum, one table, two indexes. Nothing existing is altered.
CREATE TYPE "public"."commerce_product_document_kind" AS ENUM('datasheet', 'manual', 'care_guide', 'other');--> statement-breakpoint
CREATE TABLE "commerce_product_document" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"document_kind" "commerce_product_document_kind" NOT NULL,
	"object_storage_key" text NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"file_name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_product_document_byte_size_ck" CHECK (byte_size > 0),
	CONSTRAINT "commerce_product_document_sha_ck" CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "commerce_product_document_position_ck" CHECK (position >= 0),
	CONSTRAINT "commerce_product_document_file_name_ck" CHECK (char_length(file_name) BETWEEN 1 AND 120)
);
--> statement-breakpoint
ALTER TABLE "commerce_product_document" ADD CONSTRAINT "commerce_product_document_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_product_document_product_idx" ON "commerce_product_document" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_document_content_uidx" ON "commerce_product_document" USING btree ("product_id","content_sha256");