-- ---------------------------------------------------------------------------
-- Video content reporting — THE ENUMS ONLY. Tables follow in 0129.
--
-- HAND-WRITTEN, like every migration since 0046.
--
-- WHY THIS IS SPLIT IN TWO, which is the same reason 0123 and 0124 were split: Postgres
-- refuses `ALTER TYPE ... ADD VALUE` inside a transaction block that later uses the new
-- value, and drizzle-kit runs each migration file as one transaction. Three values are
-- being appended to `platform_audit_event_kind` below and 0129's service writes rows
-- carrying them, so they must be committed first. Creating the four brand-new types here
-- as well keeps "types" and "tables" as the file boundary rather than splitting on which
-- statement happens to need it.
--
-- FOUR NEW TYPES, THREE APPENDED VALUES.
--
-- `video_moderation_visibility_state` IS A FOURTH ORTHOGONAL STATUS ON `video`, and 0129
-- adds the column. It is not a value on one of the three that already exist:
--
--   `review_status = 'rejected'` is the ANIME QUEUE's pre-publication verdict. Reusing it
--   would put reported videos into that queue's counts and would tell a creator their
--   video "failed review" when it was taken down weeks after going live.
--
--   `publish_status = 'draft'` says the CREATOR chose not to publish. Handing a moderator
--   the creator's own switch destroys the distinction the moment anyone reads the row —
--   and the creator could then simply publish again.
--
-- TWO VALUES, NOT COMMERCE'S FOUR. `commerce_ugc_visibility_state` carries
-- `hidden_pending_review` for its automatic threshold hide and `removed_by_author` for a
-- review's author retracting it. Neither exists here: every hide names a moderator (see
-- 0129), and a creator withdrawing their own video is `publish_status`.
--
-- THE REASON ENUM IS VIDEO-SPECIFIC AND SHARED WITH NOTHING. That is this codebase's
-- stated policy, recorded on `commerce_content_report_reason`: sharing one type would mean
-- adding `counterfeit` puts it on the R&D report form. `child_safety` and `sexual_content`
-- are video words; `counterfeit` and `prohibited_item` are not.
--
-- THE THREE AUDIT KINDS HAVE NO AUTOMATIC COUNTERPART TO EXCLUDE, unlike the commerce
-- block beside them. Commerce had to explain that an automatic hide names nobody and so
-- cannot enter the hash chain. Video reporting has no threshold at all, so every hide is
-- in the chain and `video_moderation_action` needs no `action_source` column.
--
-- RUN ORDER: new types, then the appended values. No tables, no indexes.
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."video_moderation_visibility_state" AS ENUM('visible', 'hidden_by_moderator');--> statement-breakpoint

CREATE TYPE "public"."video_content_report_reason" AS ENUM('sexual_content', 'violence', 'hateful_or_abusive', 'harassment', 'child_safety', 'spam_or_misleading', 'copyright', 'other');--> statement-breakpoint

CREATE TYPE "public"."video_content_report_status" AS ENUM('open', 'actioned', 'dismissed');--> statement-breakpoint

CREATE TYPE "public"."video_moderation_action_kind" AS ENUM('content_hidden', 'content_restored', 'report_dismissed');--> statement-breakpoint

-- Appended, never reordered: `platform_audit_event_kind` is written into a hash-chained
-- table and the label is part of what each entry hashes.
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'video_content_hidden';--> statement-breakpoint

ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'video_content_restored';--> statement-breakpoint

ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'video_content_report_dismissed';
