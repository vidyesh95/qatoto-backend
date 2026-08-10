-- ---------------------------------------------------------------------------
-- Phase 19 enums — the cofounder directory's vocabulary (§18).
--
-- HAND-WRITTEN, like every store-phase migration since 0046. Enum-only for the usual
-- reason: 0105 writes CHECKs naming these, and a value added by `ALTER TYPE ... ADD VALUE`
-- cannot be used as a literal in the same transaction.
--
-- WHAT IS NOT HERE, AND WHY IT IS THE MOST IMPORTANT THING IN THIS FILE: there is no
-- currency, no capital range and no equity type, because §14 has not decided whether Qatoto
-- may publish a self-declared capital range beside an equity expectation. That is a legal
-- question per market, not a schema one. Until it lands, THE BACKEND STORES NO CAPITAL
-- FIGURE IT WOULD THEN HAVE TO PUBLISH — so the columns do not exist, rather than existing
-- and being withheld by a projection somebody can later "fix".
-- ---------------------------------------------------------------------------

-- THE FOUR ARE DELIBERATELY NOT INTERCHANGEABLE, and the filter exists because they are the
-- thing a founder is actually short of. `capital` is money. `expertise` is a domain
-- somebody has already done. `influence` is reach — distribution, an audience, a room you
-- cannot get into. `operations` is the person who runs the thing day to day. Claiming all
-- four is itself a signal, which is why the projection must not collapse them.
CREATE TYPE "community_cofounder_contribution_kind" AS ENUM (
  'capital',
  'expertise',
  'influence',
  'operations'
);
--> statement-breakpoint

-- `advisory` is hours a month, not a job.
CREATE TYPE "community_cofounder_commitment_level" AS ENUM ('full_time', 'part_time', 'advisory');
--> statement-breakpoint

-- `not_looking` STAYS VISIBLE in the directory rather than being filtered out: a profile is
-- also a record, and hiding it makes a person who is mid-conversation look as though they
-- had left. The row says so and offers no contact affordance.
CREATE TYPE "community_cofounder_engagement_state" AS ENUM (
  'open_to_intros',
  'in_conversation',
  'not_looking'
);
--> statement-breakpoint

-- TWO VALUES AND NOT A LADDER. `identity_verified` means ONLY that this person is who they
-- say they are. It says nothing about their capital, their track record or their reach,
-- none of which anybody checked — and a third rung would be read as verifying the claims.
CREATE TYPE "community_cofounder_identity_state" AS ENUM ('unverified', 'identity_verified');
--> statement-breakpoint

-- `POST` answers `draft`. Publishing is a separate act behind moderation, the same shape a
-- service offering and a forum thread take.
CREATE TYPE "community_cofounder_profile_state" AS ENUM (
  'draft',
  'pending_review',
  'published',
  'withdrawn'
);
--> statement-breakpoint

ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_cofounder_profile_published';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_cofounder_profile_rejected';
--> statement-breakpoint

ALTER TYPE "community_moderation_action_kind" ADD VALUE IF NOT EXISTS 'cofounder_profile_published';
--> statement-breakpoint
ALTER TYPE "community_moderation_action_kind" ADD VALUE IF NOT EXISTS 'cofounder_profile_rejected';
