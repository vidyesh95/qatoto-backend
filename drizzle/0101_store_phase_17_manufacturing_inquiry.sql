-- ---------------------------------------------------------------------------
-- Phase 17 — the manufacturing inquiry (STORE_BACKEND_STRUCTURE.md §16.5).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- WHY NOT `commerce_product_inquiry`. That table REQUIRES a `product_id` and is uniquely
-- indexed on `(product_id, buyer_organization_id)`. A manufacturing inquiry has no
-- product — that is the whole point of sending it. "Can you make this thing that does not
-- exist yet" cannot be hung off a listing.
--
-- WHY NOT `commerce_rfq` WITH ONE INVITATION. It would come with the quote revision flow,
-- the thread, trade attachments and expiry for free, and it was the wrong trade anyway: an
-- RFQ thread has every invited provider in it, so folding a one-to-one conversation into
-- that shape exposes one seller's chat to its competitors. A manufacturing inquiry is
-- one-to-one by definition. It gets its own thread through the
-- `manufacturing_inquiry` resource kind that 0099 added.
--
-- `capability_kind` IS NOT NULL, and it is the only enum on the row. It is the one field
-- that decides whether the inquiry is answerable at all: a buyer who needs tooling and
-- writes to an assembly-only shop should find that out from the form, not from silence
-- three weeks later.
--
-- `converted_to_rfq_id` mirrors `commerce_product_inquiry`'s: an inquiry that grows into
-- real sourcing points at the RFQ it became, and the two conversations stay separate.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "commerce_manufacturing_inquiry" (
  "id" text PRIMARY KEY NOT NULL,
  -- The handle a buyer reads out on a call. Server-minted, never client-supplied.
  "reference" text NOT NULL,
  "factory_organization_id" text NOT NULL,
  "buyer_organization_id" text NOT NULL,
  "buyer_member_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "state" "commerce_manufacturing_inquiry_state" DEFAULT 'draft' NOT NULL,
  "capability_kind" "commerce_organization_capability_kind" NOT NULL,
  "product_description" text NOT NULL,
  "estimated_annual_quantity" integer,
  "unit_label" text,
  "target_unit_price_in_cents" bigint,
  "currency" text,
  "desired_first_delivery_at" date,
  "notes" text,
  "converted_to_rfq_id" text,
  "thread_id" text,
  "sent_at" timestamp,
  "answered_at" timestamp,
  "closed_at" timestamp,
  "created_at" timestamp (3) DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- `restrict` on both parties: an inquiry is a commercial record and must not vanish
-- because one side closed its account.
ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_factory_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("factory_organization_id") REFERENCES "commerce_organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_buyer_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("buyer_organization_id") REFERENCES "commerce_organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_buyer_member_id_commerce_organization_member_id_fk"
  FOREIGN KEY ("buyer_member_id") REFERENCES "commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_created_by_user_id_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_converted_to_rfq_id_commerce_rfq_id_fk"
  FOREIGN KEY ("converted_to_rfq_id") REFERENCES "commerce_rfq"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_thread_id_commerce_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "commerce_thread"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_manufacturing_inquiry_reference_uidx"
  ON "commerce_manufacturing_inquiry" ("reference");
--> statement-breakpoint

-- The buyer's `/mine` keyset.
CREATE INDEX IF NOT EXISTS "commerce_manufacturing_inquiry_buyer_idx"
  ON "commerce_manufacturing_inquiry" ("buyer_organization_id", "created_at", "id");
--> statement-breakpoint

-- The factory's queue. `state` is in the key because a factory works `sent` first and
-- never wants a buyer's abandoned drafts in the list — which it could not see anyway.
CREATE INDEX IF NOT EXISTS "commerce_manufacturing_inquiry_factory_idx"
  ON "commerce_manufacturing_inquiry" ("factory_organization_id", "state", "created_at", "id");
--> statement-breakpoint

-- OPTIONAL FIELDS ARE BOTH-OR-NEITHER IN PAIRS, never half-filled. A quantity with no unit
-- cannot be compared against a line, and a price with no currency is not a price. A blank
-- input is OMITTED from the body rather than sent as `0`: `0` for a target unit price asks
-- the factory to work free.
ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_pairs_ck" CHECK (
    ("estimated_annual_quantity" IS NULL) = ("unit_label" IS NULL)
    AND ("target_unit_price_in_cents" IS NULL) = ("currency" IS NULL)
    AND ("estimated_annual_quantity" IS NULL OR "estimated_annual_quantity" > 0)
    AND ("target_unit_price_in_cents" IS NULL OR "target_unit_price_in_cents" > 0)
    AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
  );
--> statement-breakpoint

ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_parties_ck" CHECK (
    "buyer_organization_id" <> "factory_organization_id"
  );
--> statement-breakpoint

ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_text_ck" CHECK (
    char_length("reference") BETWEEN 6 AND 40
    AND char_length("product_description") BETWEEN 1 AND 5000
    AND ("unit_label" IS NULL OR char_length("unit_label") BETWEEN 1 AND 40)
    AND ("notes" IS NULL OR char_length("notes") BETWEEN 1 AND 4000)
  );
--> statement-breakpoint

-- EVERY STATE AGREES WITH ITS TIMESTAMP, so no code path can leave a row claiming it was
-- sent with nothing recording when. A `draft` has none of the three; `answered` implies
-- `sent`; `closed` can be reached from anywhere, including straight from a draft the buyer
-- abandoned.
ALTER TABLE "commerce_manufacturing_inquiry"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_state_ck" CHECK (
    ("state" = 'draft') = ("sent_at" IS NULL AND "answered_at" IS NULL AND "closed_at" IS NULL)
    AND ("state" = 'closed') = ("closed_at" IS NOT NULL)
    AND ("answered_at" IS NULL OR "sent_at" IS NOT NULL)
    AND ("state" <> 'sent' OR ("sent_at" IS NOT NULL AND "answered_at" IS NULL))
    AND ("state" <> 'answered' OR "answered_at" IS NOT NULL)
  );
--> statement-breakpoint

-- The certifications the buyer needs the factory to hold. A link table over the closed
-- code set, because this is a REQUIREMENT the factory is matched against — free text here
-- would be unmatchable, which is the opposite of what a requirement is for.
CREATE TABLE IF NOT EXISTS "commerce_manufacturing_inquiry_certification" (
  "inquiry_id" text NOT NULL,
  "standard_code" "commerce_certification_standard_code" NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_manufacturing_inquiry_certification_pk" PRIMARY KEY ("inquiry_id", "standard_code")
);
--> statement-breakpoint

ALTER TABLE "commerce_manufacturing_inquiry_certification"
  ADD CONSTRAINT "commerce_manufacturing_inquiry_certification_inquiry_id_commerce_manufacturing_inquiry_id_fk"
  FOREIGN KEY ("inquiry_id") REFERENCES "commerce_manufacturing_inquiry"("id") ON DELETE cascade ON UPDATE no action;
