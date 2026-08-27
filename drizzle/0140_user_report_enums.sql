-- ---------------------------------------------------------------------------
-- Profile-text reporting — THE ENUMS ONLY. Tables follow in 0141.
--
-- HAND-WRITTEN, like every migration since 0046.
--
-- WHY THIS IS SPLIT IN TWO, exactly as 0128/0129 were: Postgres refuses
-- `ALTER TYPE ... ADD VALUE` inside a transaction block that later uses the new value, and
-- drizzle-kit runs each migration file as one transaction. Three values are appended to
-- `platform_audit_event_kind` below and 0141's service writes rows carrying them, so they must be
-- committed first.
--
-- ⚠️ `platform_audit_event_kind` IS APPEND-ONLY AND NEVER REORDERED. The label is part of what each
-- audit entry hashes, so moving one rewrites history that the chain is supposed to make
-- unrewritable.
--
-- ## THE REASONS ARE PROFILE-SCOPED, AND THAT IS A SAFETY DECISION
--
-- They are deliberately NOT a copy of `video_content_report_reason`. Upholding a report here hides
-- a person's bio and links and nothing else, so every reason names something that lever can address.
-- `child_safety` and `copyright` are absent because answering either by hiding a description would
-- be worse than not offering the reason at all — it would look like the platform had acted.
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."user_report_reason" AS ENUM('impersonation', 'abusive_profile_text', 'misleading_links', 'spam', 'other');--> statement-breakpoint
CREATE TYPE "public"."user_report_status" AS ENUM('open', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."user_moderation_action_kind" AS ENUM('profile_text_hidden', 'profile_text_restored', 'report_dismissed');--> statement-breakpoint

ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'user_profile_text_hidden';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'user_profile_text_restored';--> statement-breakpoint
ALTER TYPE "public"."platform_audit_event_kind" ADD VALUE IF NOT EXISTS 'user_report_dismissed';
