-- ---------------------------------------------------------------------------
-- Privacy Part 3 — account lifecycle, erasure requests, and data exports.
--
-- HAND-WRITTEN, like every migration since 0046. The DDL below was composed by
-- `drizzle-kit export --sql`, which reads src/db/schema.ts with no database connection and
-- without consulting drizzle/meta/ — the only way to get canonical DDL in this repo, since the
-- snapshots stop at 0054 and `db:generate` therefore tries to recreate four phases of tables.
--
-- ## WHY `user` GROWS TWO COLUMNS AND NOT A `deleted_at`
--
-- Cascade rule R2 (src/db/schema/rnd.ts) makes 40+ tables hold `restrict` foreign keys into
-- `user`, and 45 earlier migrations install BEFORE UPDATE OR DELETE triggers over ledgers,
-- equity, pay records and hash-chained audit trails. `DELETE FROM "user"` physically cannot
-- succeed for anybody who has founded, joined or applied to a project, transacted, moderated or
-- voted — which is the POINT: it is what stops one person's erasure destroying another person's
-- financial record. So deletion here is an ANONYMIZATION, and it needs two states rather than
-- the absence of a row: deactivated (reversible, 30 days) and anonymized (terminal).
--
-- THE INVARIANT THE REST OF THE FEATURE RESTS ON is that `deactivated_at` is NULL for any
-- account holding a live session. Signing in reactivates — see the `session.create.before` hook
-- in src/lib/auth.ts — so there is no authenticated caller who is mid-deletion, and therefore no
-- cancel endpoint, no pending-deletion banner, and no UI for a state that cannot be reached.
--
-- `user_lifecycle_ck` checks the ORDERING, not merely the nulls. An anonymized row that was
-- never deactivated means the scrub ran without a grace window ever opening — somebody called
-- the service directly, past the request route. Postgres refusing that is cheaper than finding
-- out afterwards, when the data is already gone.
--
-- ## THE TWO PARTIAL UNIQUE INDEXES ARE THE CONCURRENCY DESIGN
--
-- `account_deletion_request_active_uidx` and `data_export_request_active_uidx` each admit one
-- live row per user. Neither service does read-then-write; both insert and let Postgres
-- arbitrate, and the controller maps the unique violation to 409. Two tabs pressing "delete my
-- account" in the same instant is therefore one grace window, not two racing the same scrub.
--
-- NOTE THE PREDICATES DIFFER, and deliberately: deletion has one live state (`pending`), export
-- has two (`pending`, `running`), because a worker picking up an export must not free the slot
-- for a second full-table walk while the first is still building.
--
-- ## EVERY FOREIGN KEY HERE IS `restrict`, WHICH READS BACKWARDS UNTIL YOU SEE THE DOMAIN
--
-- `account_deletion_request` is the record THAT AN ERASURE HAPPENED — the only artifact proving
-- a person exercised a right, when it was granted, and when it completed. A `cascade` would make
-- it a candidate for the very erasure pass it documents, and the answer to a regulator's "show
-- me" would be the one row the scrub took with it.
--
-- ## `anonymization_step_log` EXISTS BECAUSE THE SCRUB IS NOT ONE TRANSACTION
--
-- One transaction across ~40 tables holds locks on `video_view_session` and `commerce_order` for
-- the run's duration and turns a single trigger rejection into a total rollback that retries
-- forever. The scrub therefore commits per step — and this table is what makes the retry skip
-- what already landed. It is also the ONLY evidence: afterwards the account is unrecognizable by
-- construction, so "did it actually delete the notifications?" has nowhere else to look.
-- `rows_affected = 0` is a real answer and is recorded as one.
--
-- ## RUN ORDER
--
-- Enums first (the tables reference them), then tables, then foreign keys, then indexes —
-- the same four-phase order `drizzle-kit export` emits and every migration since 0046 follows.
-- Nothing here backfills: all four new columns are nullable or defaulted, so existing `user`
-- rows are correct as they stand (NULL = active, which is what they are).
--
-- Verify with `pnpm db:verify-privacy-constraints`, which checks these constraint names in
-- pg_constraint and then proves the two partial unique indexes actually refuse a second live row.
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."account_deletion_request_state" AS ENUM('pending', 'cancelled', 'completed', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."data_export_request_state" AS ENUM('pending', 'running', 'ready', 'failed', 'expired');
--> statement-breakpoint

ALTER TABLE "user" ADD COLUMN "deactivated_at" timestamp;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "anonymized_at" timestamp;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_lifecycle_ck" CHECK (anonymized_at IS NULL
          OR (deactivated_at IS NOT NULL AND anonymized_at >= deactivated_at));
--> statement-breakpoint

CREATE TABLE "account_deletion_request" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"state" "account_deletion_request_state" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"scheduled_anonymization_at" timestamp NOT NULL,
	"cancelled_at" timestamp,
	"completed_at" timestamp,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	CONSTRAINT "account_deletion_request_window_ck" CHECK (scheduled_anonymization_at > requested_at),
	CONSTRAINT "account_deletion_request_state_ck" CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)
          AND (state = 'completed') = (completed_at IS NOT NULL)
          AND (state <> 'failed' OR failure_reason IS NOT NULL)),
	CONSTRAINT "account_deletion_request_reason_ck" CHECK (failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 2000),
	CONSTRAINT "account_deletion_request_attempts_ck" CHECK (attempt_count >= 0)
);
--> statement-breakpoint

CREATE TABLE "anonymization_step_log" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"step_name" text NOT NULL,
	"table_name" text NOT NULL,
	"rows_affected" integer NOT NULL,
	"ran_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "anonymization_step_log_rows_ck" CHECK (rows_affected >= 0)
);
--> statement-breakpoint

CREATE TABLE "data_export_request" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"state" "data_export_request_state" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"object_key" text,
	"byte_size" bigint,
	"content_sha256" text,
	"expires_at" timestamp,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "data_export_request_ready_ck" CHECK ((state = 'ready') = (
            object_key IS NOT NULL
            AND content_sha256 IS NOT NULL
            AND byte_size IS NOT NULL
            AND expires_at IS NOT NULL
          )),
	CONSTRAINT "data_export_request_sha_ck" CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "data_export_request_size_ck" CHECK (byte_size IS NULL OR byte_size > 0),
	CONSTRAINT "data_export_request_expiry_ck" CHECK (expires_at IS NULL OR expires_at > requested_at),
	CONSTRAINT "data_export_request_reason_ck" CHECK (failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 2000),
	CONSTRAINT "data_export_request_attempts_ck" CHECK (attempt_count >= 0)
);
--> statement-breakpoint

ALTER TABLE "account_deletion_request" ADD CONSTRAINT "account_deletion_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "anonymization_step_log" ADD CONSTRAINT "anonymization_step_log_request_id_account_deletion_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."account_deletion_request"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_export_request" ADD CONSTRAINT "data_export_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "user_deactivatedAt_idx" ON "user" USING btree ("deactivated_at") WHERE deactivated_at IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_request_active_uidx" ON "account_deletion_request" USING btree ("user_id") WHERE state = 'pending';
--> statement-breakpoint
CREATE INDEX "account_deletion_request_due_idx" ON "account_deletion_request" USING btree ("scheduled_anonymization_at") WHERE state = 'pending';
--> statement-breakpoint
CREATE INDEX "account_deletion_request_userId_idx" ON "account_deletion_request" USING btree ("user_id","requested_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "anonymization_step_log_request_step_uidx" ON "anonymization_step_log" USING btree ("request_id","step_name");
--> statement-breakpoint
CREATE UNIQUE INDEX "data_export_request_active_uidx" ON "data_export_request" USING btree ("user_id") WHERE state IN ('pending', 'running');
--> statement-breakpoint
CREATE INDEX "data_export_request_userId_idx" ON "data_export_request" USING btree ("user_id","requested_at");
--> statement-breakpoint
CREATE INDEX "data_export_request_expiry_idx" ON "data_export_request" USING btree ("expires_at") WHERE state = 'ready';
