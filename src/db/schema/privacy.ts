import { randomUUID } from "node:crypto";

import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from "drizzle-orm/pg-core";

import { user } from "#src/db/schema/_core.js";

// ---------------------------------------------------------------------------
// Privacy Part 3 — the account lifecycle, and the two data-subject rights that have
// endpoints (GDPR Art. 15/20 access and portability, Art. 17 erasure).
//
// ## WHY THESE ROWS OUTLIVE THEIR OWN SUBJECT
//
// Every FK here is `restrict`, which reads backwards until you notice what the domain
// is. `account_deletion_request` is the record THAT AN ERASURE HAPPENED. It is the only
// artifact left proving a person exercised a right, when it was granted, and when it
// completed — and a `cascade` would make it a candidate for the very erasure pass it
// documents. The scrub reads `anonymization-manifest.ts` and does what each entry says;
// an entry saying "this dies with the account" pointed at the audit trail of the
// deletion is how you end up unable to answer a regulator's "show me".
//
// ## THE CONSTRAINT DOING THE REAL WORK IS A PARTIAL UNIQUE INDEX, TWICE
//
// `account_deletion_request_active_uidx` and `data_export_request_active_uidx` each
// permit exactly one live row per user. That is not tidiness — it is the whole
// concurrency story for both endpoints, and it is why neither service ever does
// read-then-write. Two tabs pressing "delete my account" at the same instant is a
// unique violation the controller maps to `409`, not a lost update and two grace windows
// racing the same scrub.
//
// ## WHAT IS DELIBERATELY ABSENT
//
// There is no "why are you leaving?" column, and there must never be one. Collecting a
// free-text reason at the exact moment somebody exercises a right to erasure creates
// personal data whose only home is a table you then have to scrub — and it would be the
// one field in this file with no lawful basis behind it.
//
// There is also no `cancelledByUserId`. A deletion is only ever cancelled by its own
// subject signing in (see `session.create.before` in src/lib/auth.ts), so a column
// naming the actor could hold exactly one value.
// ---------------------------------------------------------------------------

/**
 * The lifecycle of one erasure request.
 *
 * `failed` is a real terminal state and not an error channel: the scrub can be refused by
 * an immutability trigger, and when it is, the account must stay DEACTIVATED with the row
 * carrying the reason, rather than silently retrying into a half-scrubbed identity. An
 * operator reading `failed` is the intended outcome — it means the manifest is wrong.
 */
export const accountDeletionRequestStateEnum = pgEnum("account_deletion_request_state", [
  "pending", // deactivated, inside the grace window, cancellable by signing in
  "cancelled", // the subject came back
  "completed", // anonymized; `user.anonymized_at` is stamped
  "failed", // the scrub was refused — see failure_reason, and fix the manifest
]);

export const accountDeletionRequest = pgTable(
  "account_deletion_request",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict`, and see the file header. This row must survive its own subject.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    state: accountDeletionRequestStateEnum("state").default("pending").notNull(),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    /**
     * STORED, NOT `requested_at + INTERVAL '30 days'` COMPUTED AT READ TIME.
     *
     * The window is a promise made to a named person on a particular day. Deriving it
     * from a constant means changing that constant silently re-dates every live request
     * — including shortening one, which erases somebody earlier than they were told. It
     * is also what the sweep's index is built on, and an expression index over an
     * interval is a needless dependency on the constant never moving.
     */
    scheduledAnonymizationAt: timestamp("scheduled_anonymization_at").notNull(),
    cancelledAt: timestamp("cancelled_at"),
    completedAt: timestamp("completed_at"),
    failureReason: text("failure_reason"),
    /** Retries are hours apart (see jobs.ts) — a lock or a trigger is not a flake. */
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at"),
  },
  (table) => [
    /**
     * ONE LIVE REQUEST PER ACCOUNT, BY CONSTRAINT. This is the endpoint's entire
     * concurrency and idempotency story; the service inserts and lets Postgres arbitrate.
     */
    uniqueIndex("account_deletion_request_active_uidx")
      .on(table.userId)
      .where(sql`state = 'pending'`),
    /** The nightly sweep's candidate scan: due, and not yet dealt with. */
    index("account_deletion_request_due_idx")
      .on(table.scheduledAnonymizationAt)
      .where(sql`state = 'pending'`),
    index("account_deletion_request_userId_idx").on(table.userId, table.requestedAt),
    // A grace window that ends before it starts is not a window.
    check("account_deletion_request_window_ck", sql`scheduled_anonymization_at > requested_at`),
    /**
     * EACH STATE MOVES WITH ITS OWN TIMESTAMP, as a set. Without this, `cancelled` with a
     * NULL `cancelled_at` is representable, and the one question anybody asks of this
     * table afterwards — WHEN did this happen — has no answer for the row that needed it.
     */
    check(
      "account_deletion_request_state_ck",
      sql`(state = 'cancelled') = (cancelled_at IS NOT NULL)
          AND (state = 'completed') = (completed_at IS NOT NULL)
          AND (state <> 'failed' OR failure_reason IS NOT NULL)`,
    ),
    check(
      "account_deletion_request_reason_ck",
      sql`failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 2000`,
    ),
    check("account_deletion_request_attempts_ck", sql`attempt_count >= 0`),
  ],
);

/**
 * What did the scrub actually touch, and how much of it.
 *
 * THE RESUMABILITY MECHANISM. The scrub runs one transaction per step rather than one
 * across ~40 tables, because a single transaction holds locks on `video_view_session` and
 * `commerce_order` for the whole run and turns one trigger rejection into a total
 * rollback. The cost of that choice is that a crash lands mid-way — and this table is
 * what makes the retry skip what already committed instead of redoing it.
 *
 * IT IS ALSO THE ONLY EVIDENCE. After the scrub the account is unrecognizable by
 * construction, so "did it delete the notifications?" is a question with no other place
 * to look. `rows_affected` of 0 is a real answer and is recorded as one.
 */
export const anonymizationStepLog = pgTable(
  "anonymization_step_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    requestId: text("request_id")
      .notNull()
      .references(() => accountDeletionRequest.id, { onDelete: "restrict" }),
    /** The manifest key (`table.column`) or a named phase like `scrub_user`. */
    stepName: text("step_name").notNull(),
    tableName: text("table_name").notNull(),
    rowsAffected: integer("rows_affected").notNull(),
    ranAt: timestamp("ran_at").defaultNow().notNull(),
  },
  (table) => [
    // The skip-what-is-done check, and the reason a retry is not a re-run.
    uniqueIndex("anonymization_step_log_request_step_uidx").on(table.requestId, table.stepName),
    check("anonymization_step_log_rows_ck", sql`rows_affected >= 0`),
  ],
);

/**
 * The lifecycle of one export.
 *
 * `expired` is separate from `failed` on purpose: an archive that was built, delivered and
 * then aged out is a SUCCESS whose artifact is gone, and collapsing it into `failed` would
 * make a working feature look broken in every count anyone ever runs over this table.
 */
export const dataExportRequestStateEnum = pgEnum("data_export_request_state", [
  "pending", // queued
  "running", // a worker holds it
  "ready", // the archive exists and is downloadable
  "failed",
  "expired", // retention elapsed; the object is deleted
]);

export const dataExportRequest = pgTable(
  "data_export_request",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    state: dataExportRequestStateEnum("state").default("pending").notNull(),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    /**
     * The private-bucket key. NOT a URL, and never one: downloads are presigned per
     * request with a 300-second life (`object-storage.ts`), so a URL stored here would be
     * a long-lived bearer credential to a full PII dump sitting in a database column.
     */
    objectKey: text("object_key"),
    byteSize: bigint("byte_size", { mode: "number" }),
    /** Hex sha256 of the archive, mirroring `research_program_paper`'s integrity story. */
    contentSha256: text("content_sha256"),
    /**
     * When the ARCHIVE dies, not when the download link does. Two different clocks: the
     * presigned URL lasts 300 seconds, this lasts a week. Conflating them either leaves a
     * PII dump in a bucket for a week's worth of link, or expires the export every five
     * minutes.
     */
    expiresAt: timestamp("expires_at"),
    failureReason: text("failure_reason"),
    attemptCount: integer("attempt_count").default(0).notNull(),
  },
  (table) => [
    /**
     * ONE IN-FLIGHT EXPORT PER ACCOUNT. This is what makes the 202 idempotent: a second
     * POST while one is building returns the existing row rather than queueing a second
     * full-table walk, and it does so because the insert cannot succeed.
     */
    uniqueIndex("data_export_request_active_uidx")
      .on(table.userId)
      .where(sql`state IN ('pending', 'running')`),
    index("data_export_request_userId_idx").on(table.userId, table.requestedAt),
    /** The retention reaper's scan. */
    index("data_export_request_expiry_idx")
      .on(table.expiresAt)
      .where(sql`state = 'ready'`),
    /**
     * `ready` MEANS ALL FOUR ARE PRESENT. The controller presigns from `object_key` and
     * renders `expires_at`; a row that claims `ready` while missing either hands the
     * caller a 500 at the exact moment they were told their data was waiting.
     */
    check(
      "data_export_request_ready_ck",
      sql`(state = 'ready') = (
            object_key IS NOT NULL
            AND content_sha256 IS NOT NULL
            AND byte_size IS NOT NULL
            AND expires_at IS NOT NULL
          )`,
    ),
    check(
      "data_export_request_sha_ck",
      sql`content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'`,
    ),
    // A zero-byte archive is a failed build that reported success.
    check("data_export_request_size_ck", sql`byte_size IS NULL OR byte_size > 0`),
    check("data_export_request_expiry_ck", sql`expires_at IS NULL OR expires_at > requested_at`),
    check(
      "data_export_request_reason_ck",
      sql`failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 2000`,
    ),
    check("data_export_request_attempts_ck", sql`attempt_count >= 0`),
  ],
);

export const accountDeletionRequestRelations = relations(
  accountDeletionRequest,
  ({ one, many }) => ({
    user: one(user, {
      fields: [accountDeletionRequest.userId],
      references: [user.id],
    }),
    steps: many(anonymizationStepLog),
  }),
);

export const anonymizationStepLogRelations = relations(anonymizationStepLog, ({ one }) => ({
  request: one(accountDeletionRequest, {
    fields: [anonymizationStepLog.requestId],
    references: [accountDeletionRequest.id],
  }),
}));

export const dataExportRequestRelations = relations(dataExportRequest, ({ one }) => ({
  user: one(user, {
    fields: [dataExportRequest.userId],
    references: [user.id],
  }),
}));
