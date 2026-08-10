-- ---------------------------------------------------------------------------
-- Phase 20 enums — the delivery surface's vocabulary (STORE_BACKEND_STRUCTURE.md §19).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- ENUM-ONLY, for the usual reason: 0107 writes a partial index predicate naming 'active'
-- as a literal, and `drizzle-kit migrate` runs every pending migration in ONE transaction,
-- where a value added by `ALTER TYPE ... ADD VALUE` cannot yet be used as a literal.
--
-- WHAT IS NOT HERE IS THE MOST IMPORTANT LINE IN THIS FILE: there is no
-- `commerce_freight_mode`. `commerce_shipment_leg_mode` already carries air|sea|land|rail
-- and a shipment leg already records one (§19.2). A parallel enum is how a card becomes
-- unmatchable to the shipment it priced.
-- ---------------------------------------------------------------------------

-- THREE MEMBERS AND NO `proposed`, which is why this is not a reuse of
-- `compensation_agreement_status`. Nobody ACCEPTS a rate card — an admin keys in a list a
-- forwarder already sold — so there is no proposal to accept, and a fourth member would be
-- a state the rating read must remember to exclude.
CREATE TYPE "commerce_freight_rate_card_state" AS ENUM ('active', 'superseded', 'withdrawn');
--> statement-breakpoint

-- Every mutation is named, the `commerce_category_*` posture, because a rate card is a
-- number a BUYER is shown and §19.6 puts its provenance on the wire. A supersession emits
-- no kind of its own: it is a consequence of a create, and its predecessor id rides in that
-- entry's payload.
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_freight_rate_card_created';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_freight_rate_card_window_shortened';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_freight_rate_card_withdrawn';
--> statement-breakpoint

-- TWO KINDS, NOT ONE. A replace destroys prices; an append does not. The audit list filters
-- by kind, and collapsing them would hide the destructive half.
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_freight_rate_break_added';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_freight_rate_breaks_replaced';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_customs_dwell_estimate_created';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'commerce_customs_dwell_estimate_retired';
