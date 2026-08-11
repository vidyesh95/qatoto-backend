-- ---------------------------------------------------------------------------
-- Phase 23 — the Incoterm vocabulary (STORE_BACKEND_STRUCTURE.md §19.9, Appendix A40).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- ENUM-ONLY, and separate from 0116 for the house reason: `drizzle-kit migrate` runs every
-- pending migration in ONE transaction, and a type must exist before another statement in that
-- transaction can cast to it.
--
-- WHY THIS EXISTS. `commerce_quote_revision.incoterm` was `text` with only a 1..20 length check
-- and `commerce_order.incoterm_snapshot` was `text` with NO constraint at all — the snapshot was
-- LESS constrained than the column it is copied from. `BANANA` saved fine, and
-- `commerce_prevent_submitted_quote_revision_mutation` then froze it permanently.
--
-- WHAT THIS IS NOT. §19.9 calls the absence of an Incoterm CONCEPT "the largest practical
-- divergence in the phase" — an uncovered inland leg makes a whole journey unpriceable where
-- Alibaba would sell the international leg port-to-port, because Alibaba models Incoterms and
-- this backend does not. THAT IS NOT THIS. This is the vocabulary only: a term a seller types is
-- now a term that exists. Nothing branches on the value, and §19.9's divergence stays open.
--
-- INCOTERMS 2020, all eleven, in the ICC's own two groups.
-- ---------------------------------------------------------------------------

CREATE TYPE "commerce_incoterm" AS ENUM (
  -- Any mode or modes of transport.
  'EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP',
  -- Sea and inland waterway transport only.
  'FAS', 'FOB', 'CFR', 'CIF'
);
