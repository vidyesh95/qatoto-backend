-- ---------------------------------------------------------------------------
-- Phase 18 — the business forum (STORE_BACKEND_STRUCTURE.md §17, Appendix A33).
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- MODELLED ON `research_program_post` AND ITS SIBLINGS, which is a threaded board with a
-- moderation queue in front of it and is already shipped. Copying a shape that works is
-- worth more here than a clean-sheet design.
--
-- THREE DIFFERENCES FROM THAT PRECEDENT, each deliberate:
--
-- 1. THE VOTE IS KEYED ON THE USER, not on an organization. `commerce_product_answer_vote`
--    keys on the organization so one procurement team does not get five votes for five
--    logins — but a forum has no members, only authors, and requiring an organization to
--    endorse an answer would exclude exactly the individuals §17.2 says the nullable
--    `authorOrganizationId` exists to distinguish.
--
-- 2. THERE IS NO DOWNVOTE AND THERE NEVER WILL BE. `helpful_count` is a COUNT, not a
--    score. A negative signal against a named organization on a commerce platform is a
--    reputational act, and this surface has no appeal process to put behind one.
--
-- 3. NO `excerpt` COLUMN. The card's first lines are truncated at read time, so editing a
--    body cannot leave a stale card behind.
--
-- THE REPORT QUEUE IS ITS OWN TABLE rather than two new members on
-- `commerce_content_target_kind`. The precedent is Phase 10, which built
-- `commerce_content_report` instead of generalizing the R&D one, because the two queues are
-- gated by different capabilities and merging them creates the coupling capabilities exist
-- to prevent. A commerce moderator working a counterfeit-listing queue and a community
-- moderator working an off-topic-thread queue are not the same shift.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "community_forum_thread" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "board" "community_forum_board" NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "author_user_id" text,
  "author_organization_id" text,
  "state" "community_forum_thread_state" DEFAULT 'pending_review' NOT NULL,
  "accepted_reply_id" text,
  "reply_count" integer DEFAULT 0 NOT NULL,
  "last_activity_at" timestamp (3) DEFAULT now() NOT NULL,
  "published_at" timestamp,
  "moderated_by_user_id" text,
  "moderated_at" timestamp,
  "decision_reason" text,
  "created_at" timestamp (3) DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- `set null` on the author: a deleted account must not take a published thread with it, and
-- the answer somebody relied on stays readable after its author leaves.
ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_author_user_id_user_id_fk"
  FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- NULLABLE AND THAT IS A REAL DISTINCTION, not a missing join. Somebody posting as an
-- individual has no organization behind them, and a reader weighing an answer about customs
-- clearance wants to know whether it came from a broker or from a stranger.
ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_author_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("author_organization_id") REFERENCES "commerce_organization"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_moderated_by_user_id_user_id_fk"
  FOREIGN KEY ("moderated_by_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "community_forum_thread_slug_uidx"
  ON "community_forum_thread" ("slug");
--> statement-breakpoint

-- The moderation queue's own lookup, the shape `commerce_category_request_queue_idx` uses.
CREATE INDEX IF NOT EXISTS "community_forum_thread_queue_idx"
  ON "community_forum_thread" ("state", "created_at", "id");
--> statement-breakpoint

-- The public browse. `last_activity_at` leads the tail because the list is newest-activity
-- first, which is the one ordering a forum can have that is not a ranking.
CREATE INDEX IF NOT EXISTS "community_forum_thread_browse_idx"
  ON "community_forum_thread" ("board", "state", "last_activity_at", "id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "community_forum_thread_author_idx"
  ON "community_forum_thread" ("author_user_id", "created_at", "id");
--> statement-breakpoint

ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_slug_ck" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 120
  );
--> statement-breakpoint

ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_text_ck" CHECK (
    char_length("title") BETWEEN 8 AND 200
    AND char_length("body") BETWEEN 20 AND 20000
    AND ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 1 AND 2000)
  );
--> statement-breakpoint

ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_counts_ck" CHECK ("reply_count" >= 0);
--> statement-breakpoint

-- `published_at` IS SET WHEN THE THREAD FIRST LEAVES THE QUEUE and never cleared. A locked
-- thread is still published; only `pending_review` has never been seen by anybody.
-- A REJECTION MUST CARRY A REASON. An approval need not: the published thread is the
-- explanation, and requiring prose there would be a stricter rule than a moderator's job
-- actually has — the same call `commerce_category_request_review_ck` makes.
ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_moderation_ck" CHECK (
    ("state" = 'pending_review') = ("published_at" IS NULL)
    AND ("moderated_at" IS NULL) = ("moderated_by_user_id" IS NULL)
  );
--> statement-breakpoint

-- `answered` IS DERIVED FROM `accepted_reply_id` AND STORED, so the two can never disagree.
-- `accepted_reply_id IS NULL` is NOT "nobody helped" — plenty of useful threads never get
-- an accepted answer. It means only that nobody pressed the button.
-- A `locked` thread may hold either: locking stops new text, not bookkeeping, so the author
-- can still mark the answer afterwards. Every other state is pinned.
ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_answered_ck" CHECK (
    ("state" <> 'answered' OR "accepted_reply_id" IS NOT NULL)
    AND ("state" NOT IN ('open', 'pending_review') OR "accepted_reply_id" IS NULL)
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "community_forum_reply" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "author_user_id" text,
  "author_organization_id" text,
  "body" text NOT NULL,
  "helpful_count" integer DEFAULT 0 NOT NULL,
  "state" "community_forum_reply_state" DEFAULT 'visible' NOT NULL,
  "hidden_by_user_id" text,
  "hidden_at" timestamp,
  "hidden_reason" text,
  "created_at" timestamp (3) DEFAULT now() NOT NULL,
  "updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "community_forum_reply"
  ADD CONSTRAINT "community_forum_reply_thread_id_community_forum_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "community_forum_thread"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_forum_reply"
  ADD CONSTRAINT "community_forum_reply_author_user_id_user_id_fk"
  FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_forum_reply"
  ADD CONSTRAINT "community_forum_reply_author_organization_id_commerce_organization_id_fk"
  FOREIGN KEY ("author_organization_id") REFERENCES "commerce_organization"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_forum_reply"
  ADD CONSTRAINT "community_forum_reply_hidden_by_user_id_user_id_fk"
  FOREIGN KEY ("hidden_by_user_id") REFERENCES "user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Deferred: the thread's accepted reply is written in the same transaction that reads it.
ALTER TABLE "community_forum_thread"
  ADD CONSTRAINT "community_forum_thread_accepted_reply_id_community_forum_reply_id_fk"
  FOREIGN KEY ("accepted_reply_id") REFERENCES "community_forum_reply"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "community_forum_reply_thread_idx"
  ON "community_forum_reply" ("thread_id", "created_at", "id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "community_forum_reply_author_idx"
  ON "community_forum_reply" ("author_user_id", "created_at", "id");
--> statement-breakpoint

ALTER TABLE "community_forum_reply"
  ADD CONSTRAINT "community_forum_reply_text_ck" CHECK (
    char_length("body") BETWEEN 2 AND 10000
    AND ("hidden_reason" IS NULL OR char_length("hidden_reason") BETWEEN 1 AND 2000)
  );
--> statement-breakpoint

ALTER TABLE "community_forum_reply"
  ADD CONSTRAINT "community_forum_reply_counts_ck" CHECK ("helpful_count" >= 0);
--> statement-breakpoint

-- The four hidden columns move as a SET, copied from `research_program_post_hidden_ck`.
ALTER TABLE "community_forum_reply"
  ADD CONSTRAINT "community_forum_reply_hidden_ck" CHECK (
    ("state" = 'hidden') = ("hidden_at" IS NOT NULL)
    AND ("hidden_at" IS NULL) = ("hidden_by_user_id" IS NULL)
  );
--> statement-breakpoint

-- ROW PRESENCE IS THE VOTE. No `id`, no `value` column — the same shape
-- `commerce_product_answer_vote` uses, and the reason `PUT` and `DELETE` of it need no
-- `Idempotency-Key`: they are idempotent by verb (A24).
CREATE TABLE IF NOT EXISTS "community_forum_reply_vote" (
  "reply_id" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp (3) DEFAULT now() NOT NULL,
  CONSTRAINT "community_forum_reply_vote_pk" PRIMARY KEY ("reply_id", "user_id")
);
--> statement-breakpoint

ALTER TABLE "community_forum_reply_vote"
  ADD CONSTRAINT "community_forum_reply_vote_reply_id_community_forum_reply_id_fk"
  FOREIGN KEY ("reply_id") REFERENCES "community_forum_reply"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_forum_reply_vote"
  ADD CONSTRAINT "community_forum_reply_vote_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- "Have I endorsed this" for a page of replies, in one prefix scan.
CREATE INDEX IF NOT EXISTS "community_forum_reply_vote_user_idx"
  ON "community_forum_reply_vote" ("user_id", "reply_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "community_content_report" (
  "id" text PRIMARY KEY NOT NULL,
  "target_kind" "community_content_target_kind" NOT NULL,
  "thread_id" text,
  "reply_id" text,
  "reason" "community_content_report_reason" NOT NULL,
  "detail_text" text,
  "reporter_user_id" text,
  "status" "community_content_report_status" DEFAULT 'open' NOT NULL,
  "resolved_by_user_id" text,
  "resolved_at" timestamp (3),
  "resolution_note" text,
  "created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "community_content_report"
  ADD CONSTRAINT "community_content_report_thread_id_community_forum_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "community_forum_thread"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_content_report"
  ADD CONSTRAINT "community_content_report_reply_id_community_forum_reply_id_fk"
  FOREIGN KEY ("reply_id") REFERENCES "community_forum_reply"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_content_report"
  ADD CONSTRAINT "community_content_report_reporter_user_id_user_id_fk"
  FOREIGN KEY ("reporter_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_content_report"
  ADD CONSTRAINT "community_content_report_resolved_by_user_id_user_id_fk"
  FOREIGN KEY ("resolved_by_user_id") REFERENCES "user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- One open report per (target, reporter). Partial so a deleted reporter's row does not
-- block the next person from reporting the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS "community_content_report_thread_reporter_uidx"
  ON "community_content_report" ("thread_id", "reporter_user_id")
  WHERE "thread_id" IS NOT NULL AND "reporter_user_id" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "community_content_report_reply_reporter_uidx"
  ON "community_content_report" ("reply_id", "reporter_user_id")
  WHERE "reply_id" IS NOT NULL AND "reporter_user_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "community_content_report_queue_idx"
  ON "community_content_report" ("status", "created_at", "id");
--> statement-breakpoint

-- Exactly one target, and the kind must AGREE with which column is set. `num_nonnulls` is
-- the same construction `commerce_content_report_target_ck` uses.
ALTER TABLE "community_content_report"
  ADD CONSTRAINT "community_content_report_target_ck" CHECK (
    num_nonnulls("thread_id", "reply_id") = 1
    AND ("target_kind" <> 'forum_thread' OR "thread_id" IS NOT NULL)
    AND ("target_kind" <> 'forum_reply' OR "reply_id" IS NOT NULL)
  );
--> statement-breakpoint

ALTER TABLE "community_content_report"
  ADD CONSTRAINT "community_content_report_text_ck" CHECK (
    ("detail_text" IS NULL OR char_length("detail_text") BETWEEN 1 AND 2000)
    AND ("resolution_note" IS NULL OR char_length("resolution_note") BETWEEN 1 AND 2000)
  );
--> statement-breakpoint

ALTER TABLE "community_content_report"
  ADD CONSTRAINT "community_content_report_resolution_ck" CHECK (
    ("resolved_by_user_id" IS NULL) = ("resolved_at" IS NULL)
    AND ("status" = 'open') = ("resolved_at" IS NULL)
  );
--> statement-breakpoint

-- The decision log. Mirrors `commerce_moderation_action`: targets are `set null` (opposite
-- of the report table's cascade) so the record of a decision survives the thing it was
-- about, and `audit_entry_id` is NOT NULL so every row names an accountable human.
CREATE TABLE IF NOT EXISTS "community_moderation_action" (
  "id" text PRIMARY KEY NOT NULL,
  "action_kind" "community_moderation_action_kind" NOT NULL,
  "thread_id" text,
  "reply_id" text,
  "report_id" text,
  "moderator_user_id" text NOT NULL,
  "moderator_role_snapshot" text NOT NULL,
  "reason_note" text NOT NULL,
  "audit_entry_id" text NOT NULL,
  "created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "community_moderation_action"
  ADD CONSTRAINT "community_moderation_action_thread_id_community_forum_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "community_forum_thread"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_moderation_action"
  ADD CONSTRAINT "community_moderation_action_reply_id_community_forum_reply_id_fk"
  FOREIGN KEY ("reply_id") REFERENCES "community_forum_reply"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_moderation_action"
  ADD CONSTRAINT "community_moderation_action_report_id_community_content_report_id_fk"
  FOREIGN KEY ("report_id") REFERENCES "community_content_report"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_moderation_action"
  ADD CONSTRAINT "community_moderation_action_moderator_user_id_user_id_fk"
  FOREIGN KEY ("moderator_user_id") REFERENCES "user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "community_moderation_action"
  ADD CONSTRAINT "community_moderation_action_audit_entry_id_platform_audit_entry_id_fk"
  FOREIGN KEY ("audit_entry_id") REFERENCES "platform_audit_entry"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "community_moderation_action_auditEntryId_uidx"
  ON "community_moderation_action" ("audit_entry_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "community_moderation_action_recent_idx"
  ON "community_moderation_action" ("created_at", "id");
--> statement-breakpoint

ALTER TABLE "community_moderation_action"
  ADD CONSTRAINT "community_moderation_action_reason_ck" CHECK (
    char_length("reason_note") BETWEEN 1 AND 2000
    AND char_length("moderator_role_snapshot") BETWEEN 1 AND 40
  );
