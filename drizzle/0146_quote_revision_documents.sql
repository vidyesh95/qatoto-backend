-- ---------------------------------------------------------------------------
-- Documents on a quote — the provider half of A30. The buyer half (`commerce_rfq_document`)
-- has existed since RFQs did.
--
-- WHY NOW. `todo.md` carried this as "there is no route to attach one", and that stopped being
-- true when `POST /commerce/documents` shipped with encryption, virus scanning, audit entries
-- and its own test file. The gap was never the upload; it was that a quote had nowhere to point.
-- Attachments on both sides of a quote are table stakes for a B2B procurement marketplace.
--
-- ## ⚠️ KEYED ON THE REVISION, NOT THE QUOTE
--
-- A revision is the immutable submitted offer — `commerce_prevent_submitted_quote_revision_mutation`
-- freezes its commercial terms on submit — and the documents supporting it are part of that offer.
-- Keying on `commerce_quote` would give one document set to every revision, letting a provider
-- swap the drawing or spec sheet behind an offer a buyer had already read and priced against. A
-- revised offer gets revised documents; the superseded revision keeps what it was judged on.
--
-- This is the same argument `commerce_order_product_line` makes for snapshotting its own title
-- and price rather than joining live rows.
--
-- ## BOTH FOREIGN KEYS ARE `restrict`, MIRRORING `commerce_rfq_document`
--
-- A document cited by a commercial offer must stay resolvable, and so must the member who
-- attached it — "who sent this drawing" is exactly the question a dispute asks. The cascade is on
-- the revision alone: deleting a quote deletes its offers and their attachment rows, while the
-- encrypted documents themselves survive in the uploader's own document list.
--
-- ## NO BACKFILL, AND NONE IS POSSIBLE
--
-- Nothing has ever attached a document to a quote, so there is no prior state to migrate. The
-- unique index is safe to create empty for the same reason.
-- ---------------------------------------------------------------------------

CREATE TABLE "commerce_quote_revision_document" (
  "id" text PRIMARY KEY NOT NULL,
  "revision_id" text NOT NULL,
  "encrypted_document_id" text NOT NULL,
  "attached_by_member_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "commerce_quote_revision_document"
  ADD CONSTRAINT "commerce_quote_revision_document_revision_id_fk"
  FOREIGN KEY ("revision_id") REFERENCES "commerce_quote_revision"("id") ON DELETE cascade;
--> statement-breakpoint

ALTER TABLE "commerce_quote_revision_document"
  ADD CONSTRAINT "commerce_quote_revision_document_encrypted_document_id_fk"
  FOREIGN KEY ("encrypted_document_id") REFERENCES "commerce_encrypted_document"("id") ON DELETE restrict;
--> statement-breakpoint

ALTER TABLE "commerce_quote_revision_document"
  ADD CONSTRAINT "commerce_quote_revision_document_attached_by_member_id_fk"
  FOREIGN KEY ("attached_by_member_id") REFERENCES "commerce_organization_member"("id") ON DELETE restrict;
--> statement-breakpoint

CREATE UNIQUE INDEX "commerce_quote_revision_document_uidx"
  ON "commerce_quote_revision_document" ("revision_id", "encrypted_document_id");
--> statement-breakpoint

CREATE INDEX "commerce_quote_revision_document_revision_idx"
  ON "commerce_quote_revision_document" ("revision_id");
