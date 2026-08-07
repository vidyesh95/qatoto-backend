-- Store Phase 12 — organization certifications (Appendix A13 item 6).
--
-- A13'S PLAN FOR THIS WAS WRONG, AND THIS TABLE IS THE CORRECTION.
--
-- The appendix said to "add a `certification` kind" to `commerce_verification_kind` and
-- reuse `commerce_organization_verification`. That table carries
-- `commerce_organization_verification_pending_uidx`, unique on
-- (organization_id, verification_kind) WHERE state = 'pending' — so an organization could
-- hold exactly ONE pending certificate, and a real supplier has ISO 9001 and CE and RoHS
-- and BSCI. It also has no name, issuer, standard or expiry column, so an approved row
-- could not say WHAT it certifies or WHEN it lapses, and the platform would publish lapsed
-- certificates indefinitely.
--
-- Phase 10 made the same call for `commerce_content_report` rather than generalizing the
-- R&D report table. This is the third time in this backend that "reuse the adjacent
-- table" turned out to mean "weaken the constraint that made the adjacent table correct".
--
-- What it DOES borrow is the decision-integrity shape: the same three-way state/reviewer
-- CHECK, and the same rule that a reviewer cannot be the submitter (§11).
--
-- Additive: one new table. Rollback is DROP TABLE plus reverting the projection.

CREATE TABLE "commerce_organization_certification" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  -- "ISO 9001:2015", "CE", "RoHS 3". Free text: the vocabulary is the world's, not this
  -- platform's, and a closed enum would reject a standard the day it is published.
  "standard_name" text NOT NULL,
  "issuer_name" text NOT NULL,
  "certificate_number" text NOT NULL,
  "scope_summary" text,
  "valid_from" date NOT NULL,
  "valid_until" date NOT NULL,
  -- The private scan. NEVER reaches the wire in any form — no id, no URL, no short-lived
  -- token. A certificate carries registration numbers, site addresses and signatures, and
  -- §11 keeps private objects private. The public projection is metadata only.
  "evidence_document_id" text NOT NULL,
  "state" "commerce_certification_state" DEFAULT 'pending' NOT NULL,
  "submitted_by_user_id" text NOT NULL,
  "reviewed_by_user_id" text,
  "decision_reason" text,
  "submitted_at" timestamp DEFAULT now() NOT NULL,
  "decided_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_organization_certification_validity_ck" CHECK (valid_until > valid_from),
  -- Shaped after `commerce_organization_verification_decision_ck`. A withdrawal is dated
  -- but names no reviewer: the seller retracted it, nobody judged it.
  CONSTRAINT "commerce_organization_certification_decision_ck" CHECK (
    (state = 'pending' AND reviewed_by_user_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
    OR (state = 'approved' AND reviewed_by_user_id IS NOT NULL AND decision_reason IS NULL AND decided_at IS NOT NULL)
    OR (state = 'rejected' AND reviewed_by_user_id IS NOT NULL
        AND decision_reason IS NOT NULL AND char_length(decision_reason) BETWEEN 1 AND 2000
        AND decided_at IS NOT NULL)
    OR (state = 'withdrawn' AND reviewed_by_user_id IS NULL AND decision_reason IS NULL
        AND decided_at IS NOT NULL)
  ),
  -- A seller cannot approve its own certificate. Same rule, same shape, as verification
  -- evidence — and the reason the whole table is worth having rather than trusting the
  -- declared-capability rows next to it.
  CONSTRAINT "commerce_organization_certification_reviewer_ck" CHECK (
    reviewed_by_user_id IS NULL OR reviewed_by_user_id <> submitted_by_user_id
  ),
  CONSTRAINT "commerce_organization_certification_text_ck" CHECK (
    char_length(standard_name) BETWEEN 1 AND 200
    AND char_length(issuer_name) BETWEEN 1 AND 200
    AND char_length(certificate_number) BETWEEN 1 AND 120
    AND (scope_summary IS NULL OR char_length(scope_summary) <= 2000)
  )
);--> statement-breakpoint
ALTER TABLE "commerce_organization_certification" ADD CONSTRAINT "commerce_organization_certification_organization_id_commerce_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_certification" ADD CONSTRAINT "commerce_organization_certification_evidence_document_id_commerce_encrypted_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."commerce_encrypted_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_certification" ADD CONSTRAINT "commerce_organization_certification_submitted_by_user_id_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_organization_certification" ADD CONSTRAINT "commerce_organization_certification_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- The public read's exact predicate: approved, for this organization, not yet lapsed.
-- `valid_until` trails the state so this index also orders the "expiring soon" view an
-- owner sees.
CREATE INDEX "commerce_organization_certification_public_idx" ON "commerce_organization_certification" USING btree ("organization_id","state","valid_until");--> statement-breakpoint

-- One live claim per (organization, standard, certificate number).
--
-- Rejected rows are excluded so a seller can resubmit a corrected application after a
-- rejection — without this predicate a typo in the number would be permanently
-- unusable. This names a literal of a type created in 0069, which is legal precisely
-- because the type is NEW in this transaction; the restriction Postgres enforces is on
-- values added to a pre-existing type. It could not be written `state::text <> 'rejected'`
-- either way: an enum->text cast is not IMMUTABLE and is refused in an index predicate.
CREATE UNIQUE INDEX "commerce_organization_certification_identity_uidx" ON "commerce_organization_certification" USING btree ("organization_id","standard_name","certificate_number") WHERE state <> 'rejected';
