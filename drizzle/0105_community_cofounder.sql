-- ---------------------------------------------------------------------------
-- Phase 19 — the cofounder directory (STORE_BACKEND_STRUCTURE.md §18, Appendix A34).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- THE COLUMNS THIS TABLE DOES NOT HAVE ARE THE POINT.
--
--   There is no `capital_range_min_in_cents`, no `capital_range_max_in_cents`, no
--   `currency` and no `equity_expectation_basis_points`.
--
-- §14 defers whether Qatoto may publish a self-declared capital range beside an equity
-- expectation, and the deferral's own wording is the instruction: "Until decided, the
-- backend STORES NO CAPITAL FIGURE IT WOULD THEN HAVE TO PUBLISH." A column that exists and
-- is withheld by a projection is one careless edit from being published; a column that does
-- not exist cannot be. The wire keeps both fields — the frontend contract already types
-- them nullable — and they serve `null` until the decision lands, at which point adding
-- them is one additive migration and a projection change.
--
-- WHY NOT EXTEND `talent_profile`, which is genuinely close — user-scoped, with
-- availability, visibility, skills and a compensation ask. Because the R&D talent directory
-- READS that table, and a cofounder row landing in "people open to work on your project" is
-- a different claim about a different person's intent. Reuse its SHAPE, and
-- `talent_profile_skill`'s tag-table pattern for the link tables, not its rows.
--
-- THE VIEWER POSTS ABOUT THEMSELVES, NEVER ABOUT SOMEBODY ELSE, which is what `user_id`
-- UNIQUE enforces at the storage layer: a directory of people who did not consent to being
-- in it is a different product with a different legal shape.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "community_cofounder_profile" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "user_id" text NOT NULL,
  "display_name" text NOT NULL,
  "headline" text NOT NULL,
  "bio" text NOT NULL,
  "looking_for" text NOT NULL,
  "country_code" text NOT NULL,
  "avatar_url" text,
  "commitment_level" "community_cofounder_commitment_level" NOT NULL,
  "engagement_state" "community_cofounder_engagement_state" DEFAULT 'open_to_intros' NOT NULL,
  "state" "community_cofounder_profile_state" DEFAULT 'draft' NOT NULL,
  "published_at" timestamp,
  "moderated_by_user_id" text,
  "moderated_at" timestamp,
  "decision_reason" text,
  "created_at" timestamp (3) DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- `cascade`, unlike the forum's `set null`: a cofounder profile IS a person, and a deleted
-- account must take its own directory listing with it. A forum answer somebody relied on is
-- a different thing from a personal advertisement nobody is standing behind any more.
ALTER TABLE "community_cofounder_profile"
  ADD CONSTRAINT "community_cofounder_profile_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_cofounder_profile"
  ADD CONSTRAINT "community_cofounder_profile_moderated_by_user_id_user_id_fk"
  FOREIGN KEY ("moderated_by_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "community_cofounder_profile_slug_uidx"
  ON "community_cofounder_profile" ("slug");
--> statement-breakpoint

-- ONE PROFILE PER PERSON. The `/mine` read depends on it, and so does the rule that nobody
-- lists anybody else.
CREATE UNIQUE INDEX IF NOT EXISTS "community_cofounder_profile_user_uidx"
  ON "community_cofounder_profile" ("user_id");
--> statement-breakpoint

-- The directory's keyset. DETERMINISTIC AND BORING ON PURPOSE (§18.1 rule 2): there is no
-- `sort` parameter and no ranking, because a ranking on this surface could read as a
-- platform recommendation about a person.
CREATE INDEX IF NOT EXISTS "community_cofounder_profile_directory_idx"
  ON "community_cofounder_profile" ("state", "published_at", "id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "community_cofounder_profile_queue_idx"
  ON "community_cofounder_profile" ("state", "created_at", "id");
--> statement-breakpoint

ALTER TABLE "community_cofounder_profile"
  ADD CONSTRAINT "community_cofounder_profile_slug_ck" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 120
  );
--> statement-breakpoint

ALTER TABLE "community_cofounder_profile"
  ADD CONSTRAINT "community_cofounder_profile_text_ck" CHECK (
    char_length("display_name") BETWEEN 1 AND 120
    AND char_length("headline") BETWEEN 8 AND 200
    AND char_length("bio") BETWEEN 20 AND 5000
    AND char_length("looking_for") BETWEEN 8 AND 2000
    AND "country_code" ~ '^[A-Z]{2}$'
    AND ("avatar_url" IS NULL OR ("avatar_url" LIKE 'https://%' AND char_length("avatar_url") <= 2048))
    AND ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 1 AND 2000)
  );
--> statement-breakpoint

-- `published_at` MEANS "HAS BEEN APPROVED AT LEAST ONCE", set on the first publish and
-- never cleared. It is NOT re-derived on the way back in: a withdrawn profile that is
-- edited and resubmitted sits in `pending_review` still carrying the timestamp, because it
-- was published once and that stays true. The public detail read projects it, which is why
-- both terminal-visible states require it.
ALTER TABLE "community_cofounder_profile"
  ADD CONSTRAINT "community_cofounder_profile_lifecycle_ck" CHECK (
    ("state" <> 'published' OR "published_at" IS NOT NULL)
    AND ("state" <> 'withdrawn' OR "published_at" IS NOT NULL)
    AND ("moderated_at" IS NULL) = ("moderated_by_user_id" IS NULL)
  );
--> statement-breakpoint

-- Tag tables in `talent_profile_skill`'s shape: composite primary key, no surrogate id.
CREATE TABLE IF NOT EXISTS "community_cofounder_profile_contribution" (
  "profile_id" text NOT NULL,
  "contribution_kind" "community_cofounder_contribution_kind" NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "community_cofounder_profile_contribution_pk" PRIMARY KEY ("profile_id", "contribution_kind")
);
--> statement-breakpoint

ALTER TABLE "community_cofounder_profile_contribution"
  ADD CONSTRAINT "community_cofounder_profile_contribution_profile_id_community_cofounder_profile_id_fk"
  FOREIGN KEY ("profile_id") REFERENCES "community_cofounder_profile"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- The reverse lookup the `contributionKind` filter scans.
CREATE INDEX IF NOT EXISTS "community_cofounder_profile_contribution_kind_idx"
  ON "community_cofounder_profile_contribution" ("contribution_kind", "profile_id");
--> statement-breakpoint

-- FREE TEXT, NOT AN ENUM: the long tail here is the whole point, and a closed sector list
-- would refuse exactly the niches a cofounder search is for.
CREATE TABLE IF NOT EXISTS "community_cofounder_profile_sector" (
  "profile_id" text NOT NULL,
  "sector_label" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "community_cofounder_profile_sector_pk" PRIMARY KEY ("profile_id", "sector_label")
);
--> statement-breakpoint

ALTER TABLE "community_cofounder_profile_sector"
  ADD CONSTRAINT "community_cofounder_profile_sector_profile_id_community_cofounder_profile_id_fk"
  FOREIGN KEY ("profile_id") REFERENCES "community_cofounder_profile"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_cofounder_profile_sector"
  ADD CONSTRAINT "community_cofounder_profile_sector_text_ck" CHECK (
    char_length("sector_label") BETWEEN 1 AND 60
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "community_cofounder_profile_language" (
  "profile_id" text NOT NULL,
  "language_code" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "community_cofounder_profile_language_pk" PRIMARY KEY ("profile_id", "language_code")
);
--> statement-breakpoint

ALTER TABLE "community_cofounder_profile_language"
  ADD CONSTRAINT "community_cofounder_profile_language_profile_id_community_cofounder_profile_id_fk"
  FOREIGN KEY ("profile_id") REFERENCES "community_cofounder_profile"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- ISO 639-1, lowercase. Two letters, because the detail read renders them as chips and a
-- free-text language field produces "english", "English" and "EN" side by side.
ALTER TABLE "community_cofounder_profile_language"
  ADD CONSTRAINT "community_cofounder_profile_language_code_ck" CHECK (
    "language_code" ~ '^[a-z]{2}$'
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "community_cofounder_prior_venture" (
  "id" text PRIMARY KEY NOT NULL,
  "profile_id" text NOT NULL,
  "name" text NOT NULL,
  "role_label" text NOT NULL,
  "years_active_label" text NOT NULL,
  "outcome_summary" text,
  "position" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "community_cofounder_prior_venture"
  ADD CONSTRAINT "community_cofounder_prior_venture_profile_id_community_cofounder_profile_id_fk"
  FOREIGN KEY ("profile_id") REFERENCES "community_cofounder_profile"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "community_cofounder_prior_venture_position_uidx"
  ON "community_cofounder_prior_venture" ("profile_id", "position");
--> statement-breakpoint

-- `outcome_summary` STAYS NULLABLE. Plenty of ventures have no tidy outcome, and a renderer
-- that requires one invites people to invent one.
ALTER TABLE "community_cofounder_prior_venture"
  ADD CONSTRAINT "community_cofounder_prior_venture_text_ck" CHECK (
    char_length("name") BETWEEN 1 AND 160
    AND char_length("role_label") BETWEEN 1 AND 120
    AND char_length("years_active_label") BETWEEN 1 AND 40
    AND ("outcome_summary" IS NULL OR char_length("outcome_summary") BETWEEN 1 AND 1000)
    AND "position" >= 0
  );
--> statement-breakpoint

-- The community moderation log can now point at a profile as well as a thread or a reply.
ALTER TABLE "community_moderation_action"
  ADD COLUMN IF NOT EXISTS "cofounder_profile_id" text;
--> statement-breakpoint

ALTER TABLE "community_moderation_action"
  ADD CONSTRAINT "community_moderation_action_cofounder_profile_id_community_cofounder_profile_id_fk"
  FOREIGN KEY ("cofounder_profile_id") REFERENCES "community_cofounder_profile"("id") ON DELETE set null ON UPDATE no action;
