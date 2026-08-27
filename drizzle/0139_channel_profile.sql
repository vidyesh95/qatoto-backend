-- ---------------------------------------------------------------------------
-- THE CHANNEL PROFILE: a public description and a set of external links.
--
-- WHAT THIS UNBLOCKS. `/channel/:handle`'s About panel shipped with four counters and nothing a
-- creator had written, because `user` carried no bio and there was no link table. Everything below
-- is additive: two nullable-or-defaulted columns and one new table. Nothing is dropped or rewritten
-- and the running application keeps serving through it.
--
-- ## `bio` IS PUBLIC THE MOMENT IT IS WRITTEN, WHICH DIVERGES FROM EVERY PRECEDENT HERE
--
-- `talent_profile.visibility` defaults to `private`. `community_cofounder_profile.state` defaults
-- to `draft` behind a moderation queue. This column has neither gate, which is a deliberate product
-- decision and is only defensible because the REACTIVE half ships with it: `user_report` plus
-- `profile_moderation_state` below. If those are ever removed, this column becomes public free text
-- with no queue behind it — the exact thing the two precedents above were built to avoid.
--
-- ## `profile_moderation_state` IS NOT `deactivated_at`, AND MUST NOT BECOME IT
--
-- `deactivated_at` is the self-service GDPR lifecycle column and its invariant is that a live
-- session implies NULL — signing in cancels a pending deletion. A moderator writing it would
-- therefore be undone by the user simply logging in. This is the same argument `studio.ts` makes
-- for `moderation_visibility_state` being its own column rather than a value on `publish_status`:
-- a moderator's verdict and a user's own switch must not be the same field.
--
-- IT GATES THE BIO AND THE LINKS, AND NOTHING ELSE. There is no platform-wide "hidden user" state
-- here and this is not one — the name, the avatar and every video stay visible. A real account-level
-- suspension would need a public-user gate plus an audit of every public read of a user, and nothing
-- would fail if one were missed. That is separate work, not a column.
--
-- ## `user_profile_link` CASCADES, AND ITS CHILDREN MUST TOO
--
-- Rule R2: `cascade` for a possession that dies with the account. The same verdict
-- `community_cofounder_profile` reaches, for the reason it states — "a cofounder profile IS a
-- person, so a deleted account must take its own listing with it".
--
-- ⚠️ Anything that later references THIS table must also cascade. The anonymization sweep issues
-- `DELETE FROM user_profile_link WHERE user_id = $1` by iterating the manifest, and a `restrict`
-- child would raise `23503` — which the job does not treat as a permanent refusal, so pg-boss would
-- retry the whole erasure ladder forever against something that can never succeed.
--
-- ## THE URL CHECK IS A SECURITY CONTROL, NOT A FORMAT PREFERENCE
--
-- This value is rendered as an `href` on a public page that anyone can reach. `LIKE 'https://%'` is
-- what keeps a `javascript:` or `data:` scheme out of it. Byte-identical in shape to
-- `commerce_organization_url_ck`, which guards the same class of field for the same reason.
--
-- NO ENUM SPLIT NEEDED. `CREATE TYPE` followed by a column using it is legal inside one
-- transaction; only `ALTER TYPE ... ADD VALUE` is not, which is why `0128` was split and this is
-- not.
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."user_profile_moderation_state" AS ENUM('visible', 'hidden_by_moderator');--> statement-breakpoint

ALTER TABLE "user" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "profile_moderation_state" "user_profile_moderation_state" DEFAULT 'visible' NOT NULL;--> statement-breakpoint

CREATE TABLE "user_profile_link" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_profile_link_text_ck" CHECK (char_length(label) BETWEEN 1 AND 60
          AND char_length(url) <= 2048
          AND url LIKE 'https://%'
          AND sort_order >= 0)
);--> statement-breakpoint

ALTER TABLE "user_profile_link" ADD CONSTRAINT "user_profile_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "user_profile_link_userId_idx" ON "user_profile_link" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profile_link_position_uidx" ON "user_profile_link" USING btree ("user_id","sort_order");
