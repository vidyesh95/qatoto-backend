-- ---------------------------------------------------------------------------
-- Phase 18 enums — the business forum's vocabulary (§17).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- ENUM-ONLY FOR THE USUAL REASON: `drizzle-kit migrate` runs the whole pending set in ONE
-- transaction, and a value added by `ALTER TYPE ... ADD VALUE` cannot be referenced as a
-- literal inside it. 0103 writes CHECKs naming these, so they land first.
--
-- COMMUNITY IS A SIBLING CONTEXT, NOT COMMERCE (§1.1). Nothing here shares a type with the
-- `commerce_*` family, and that is deliberate rather than duplication: a forum reply
-- confers no standing in a dispute, and a shared enum is the first step towards a join that
-- implies it does. The one thing this surface must never do is let a piece of public text
-- be read as a commercial fact about a party, because no order, payment or verification
-- stands behind any of it.
-- ---------------------------------------------------------------------------

-- SIX BOARDS, MATCHING THE WORK RATHER THAN THE ORG CHART. Each maps to a thing a business
-- actually gets stuck on and to a surface this platform already has — sourcing to the
-- catalogue, logistics and customs to /store/providers, compliance to factory
-- certifications, payments to quotes and orders.
--
-- A "GENERAL" BOARD IS DELIBERATELY ABSENT. It is where every thread ends up when nobody
-- can decide, and a board nobody can characterise is a board nobody subscribes to.
CREATE TYPE "community_forum_board" AS ENUM (
  'sourcing',
  'logistics_and_customs',
  'compliance_and_certification',
  'payments_and_trade_finance',
  'manufacturing',
  'selling_on_qatoto'
);
--> statement-breakpoint

-- `pending_review` ON CREATE IS THE DESIGN, NOT A PLACEHOLDER (§17.1).
--
-- A10 closed public product comments because a comment would be "the only public text
-- surface with no purchase proof and no standing requirement behind it". A standalone forum
-- inherits that problem exactly. Moderation is what lets it exist without reopening the
-- decision, so the public reads filter this state out the way the provider directory never
-- returns a `draft` offering.
--
-- `answered` is DERIVED from an accepted reply and stored, so a list row does not have to
-- fetch replies to know.
CREATE TYPE "community_forum_thread_state" AS ENUM (
  'pending_review',
  'open',
  'answered',
  'locked'
);
--> statement-breakpoint

CREATE TYPE "community_forum_reply_state" AS ENUM ('visible', 'hidden');
--> statement-breakpoint

CREATE TYPE "community_content_target_kind" AS ENUM ('forum_thread', 'forum_reply');
--> statement-breakpoint

-- Narrower than `commerce_content_report_reason`, because the failures differ. There is no
-- `counterfeit` or `prohibited_item` here: nothing on this surface is for sale.
CREATE TYPE "community_content_report_reason" AS ENUM (
  'spam',
  'misinformation',
  'harassment',
  'off_topic',
  'intellectual_property',
  'other'
);
--> statement-breakpoint

CREATE TYPE "community_content_report_status" AS ENUM ('open', 'actioned', 'dismissed');
--> statement-breakpoint

CREATE TYPE "community_moderation_action_kind" AS ENUM (
  'thread_published',
  'thread_rejected',
  'thread_locked',
  'thread_unlocked',
  'reply_hidden',
  'reply_restored',
  'report_dismissed'
);
--> statement-breakpoint

-- Every one of these names an accountable human, which is the bar for the platform chain.
-- An ordinary member posting a thread or endorsing a reply is NOT here — recording those
-- would drown the entries that name a moderator, the same call §10 made for research
-- programs.
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_forum_thread_published';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_forum_thread_rejected';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_forum_thread_locked';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_forum_thread_unlocked';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_forum_reply_hidden';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_forum_reply_restored';
--> statement-breakpoint
ALTER TYPE "platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'community_content_report_dismissed';
