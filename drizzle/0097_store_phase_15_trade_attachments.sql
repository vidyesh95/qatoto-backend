-- ---------------------------------------------------------------------------
-- Store Phase 15 — Appendices A30 and A27. Buyer-authored trade attachments.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- `CreateDraftRfqSchema` accepts `documentIds` and `assertOwnedDocuments` requires every
-- id to name a `commerce_encrypted_document` the buyer's organization already owns. NO
-- ROUTE CREATED ONE. The three upload routes in this backend are organization
-- verification evidence, customization assets, and A21's image multiparts — none of
-- which a buyer composing an RFQ can use. So `documentIds` was a field that existed and
-- could not be filled: any id a client invented came back `DOCUMENT_NOT_OWNED`.
--
-- `/store/rfqs/new` therefore shipped with no attachment step at all, which on a sourcing
-- request is a real loss — the drawing IS the requirement.
--
-- Two enum values, and nothing else. Both are used only at RUNTIME, never as a literal
-- in a later statement of this batch: `drizzle-kit migrate` runs the whole pending set in
-- ONE transaction, and a value added by `ALTER TYPE ... ADD VALUE` cannot be referenced
-- as a literal inside it.
--
--   * `trade_attachment` — the document kind. One kind rather than two, because
--     "attached to an RFQ" and "attached to a message" are facts recorded by the LINK
--     tables (`commerce_rfq_document`, `commerce_message_attachment`), not by the
--     document. The same file legitimately rides both.
--
--   * `document_downloaded` — the audit event. The download route decrypts and streams
--     bytes belonging to another organization, and A15 settled that every such read is
--     an auditable event. `document_uploaded` already exists and is its mirror.
-- ---------------------------------------------------------------------------

ALTER TYPE "commerce_document_kind" ADD VALUE IF NOT EXISTS 'trade_attachment';
--> statement-breakpoint

ALTER TYPE "commerce_organization_audit_event_kind"
  ADD VALUE IF NOT EXISTS 'document_downloaded';
