import { randomUUID } from "node:crypto";

import { desc, relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  date,
  index,
  uniqueIndex,
  check,
  primaryKey,
  pgEnum,
  doublePrecision,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { user } from "#src/db/schema/_core.js";
import {
  animeAudioModeEnum,
  animeSeriesStatusEnum,
  contentReviewActionKindEnum,
  playlistVideoOrderEnum,
  playlistVisibilityEnum,
} from "#src/db/schema/_primitives.js";
// A TABLE reference, so the import cycle is harmless: every cross-file foreign key here is
// a thunk that resolves long after both modules finish evaluating. `_primitives.ts`'s header
// is about eagerly-CALLED symbols, which this is not.
import { platformAuditEntry } from "#src/db/schema/platform.js";
import { product } from "#src/db/schema/store.js";
import {
  contentCategory,
  video,
  videoAttachedProduct,
  videoCategory,
  videoChapter,
  videoCollaborator,
  videoDocument,
  videoMilestone,
  videoOpenRole,
  videoTeamMember,
  videoSourceEnum,
} from "#src/db/schema/studio.js";

// ---------------------------------------------------------------------------
// HOME FEED — ENGAGEMENT (HOME_BACKEND_STRUCTURE.md §3)
//
// Everything below is written by VIEWERS, not creators. The creator-owned half of
// the `video` table above is the studio; this half is the public surface reading it.
//
// THE FIVE RULES THIS BLOCK ENCODES, because they are invisible in the DDL otherwise:
//
//   R1. Every byte from a viewer is a CLAIM, not a measurement. The beacon is the only
//       unauthenticated write on the platform, and it is clamped in TS
//       (src/modules/home/view-beacon-clamp.ts) before any of these columns move.
//   R2. Integers only. `completion_bp_sum` + `completion_sample_count` are stored
//       instead of an average, because an average is a float and a float makes a
//       ranking bug irreproducible.
//   R3. A VIEW IS NOT A WATCH. `view_count` counts arrivals; `completion_bp_sum`
//       measures watching. Only the second one ranks, and only from a signed-in
//       session — see the note on `video_view_session.viewer_id`.
//   R4. Counters move in the SAME TRANSACTION as the row that caused them, exactly
//       like `project_stats`. A like that commits without its counter is a like that
//       vanishes from the UI until a job runs, and that job is the one we are trying
//       not to need.
//   R5. Absence is not zero. `unique_viewer_count` is NULL until a job computes it,
//       for the same reason `project_stats.allocated_equity_basis_points` is.
// ---------------------------------------------------------------------------

// Where the viewer was standing when the session started. Recorded for ranking
// diagnostics — "does the Spotlight actually convert?" is otherwise unanswerable.
// Pinned on the FIRST beacon of a session and never rewritten: a client that changes
// its mind mid-session is describing a second session, not amending the first.
export const videoFeedSourceEnum = pgEnum("video_feed_source", [
  "feed_recommended",
  "feed_explore",
  "feed_spotlight",
  "feed_filtered",
  "search",
  "channel",
  "direct",
]);

export const videoShareChannelEnum = pgEnum("video_share_channel", [
  "copy_link",
  "x",
  "whatsapp",
  "linkedin",
  "email",
]);

// NOTE what is NOT here: `feed_mode`. §3.1 lists it, but it backs a QUERY PARAMETER on
// `GET /feed/videos` (phase 3) and no column stores it. A pgEnum with no column is a
// Postgres type nobody can use and a migration nobody can reverse cheaply.

/**
 * One row per viewer, per video, per UTC day.
 *
 * THE UNIQUE INDEX IS THE ANTI-REPLAY BOUNDARY. Without it a headless loop opens a
 * fresh session per request and every clamp below becomes decorative, because the
 * clamp bounds what ONE session can claim, not how many sessions exist.
 *
 * Rows are aggregated into `video_stats` and DELETED at 90 days by
 * `prune-engagement-data` (§6, phase 3). The counters survive; the per-viewer rows
 * do not. That is the whole privacy story: a fingerprint is a per-day bucket key with
 * a 90-day life, not an identity.
 */
export const videoViewSession = pgTable(
  "video_view_session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    /**
     * NULL means anonymous, and THIS COLUMN IS THE §8.1 GATE.
     *
     * Anonymous watch time counts toward `view_count` — it is real traffic — but it
     * never touches `completion_bp_sum`, the component carrying 40 of ranking's 100
     * points. Farming the ranker therefore requires real accounts, which is a far
     * more expensive attack than a browser loop.
     *
     * `set null` rather than cascade: deleting an account must not retroactively
     * rewrite a video's view history.
     */
    viewerId: text("viewer_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * sha256 hex. Derived per UTC day from BETTER_AUTH_SECRET plus either the user id
     * (signed in) or ip+user-agent (anonymous) — see src/lib/viewer-fingerprint.ts.
     * THE RAW IP IS NEVER WRITTEN TO THIS DATABASE.
     */
    viewerFingerprint: text("viewer_fingerprint").notNull(),
    /**
     * The UTC day, as the same string that went INTO the fingerprint hash.
     *
     * Deliberately a stored column and NOT generated from `first_beacon_at`: a
     * generated column is a second derivation of the same fact, and the two disagree
     * for any beacon that crosses midnight between the hash and the insert.
     */
    viewDayBucket: date("view_day_bucket", { mode: "string" }).notNull(),
    feedSource: videoFeedSourceEnum("feed_source").notNull(),
    /**
     * The denominator, pinned on the first beacon and never rewritten.
     *
     * `video.duration_seconds` is NULL for every YouTube row — oEmbed returns no
     * duration — so the client's claim is the only source, and it comes from the
     * hostile side. Pinning is what stops a client shrinking its own denominator
     * mid-session to manufacture a completion.
     */
    pinnedDurationSeconds: integer("pinned_duration_seconds").notNull(),
    watchedSeconds: integer("watched_seconds").default(0).notNull(),
    maxPositionSeconds: integer("max_position_seconds").default(0).notNull(),
    completionBasisPoints: integer("completion_basis_points").default(0).notNull(),
    /** Flips ONCE. The transition is what increments `video_stats.view_count`. */
    isCountedView: boolean("is_counted_view").default(false).notNull(),
    // `precision: 3` on both: the clamp divides the gap between them by 1000 to get
    // elapsed seconds, and phase 3's 48-hour view-velocity window scans first_beacon_at.
    firstBeaconAt: timestamp("first_beacon_at", { precision: 3 }).defaultNow().notNull(),
    lastBeaconAt: timestamp("last_beacon_at", { precision: 3 }).defaultNow().notNull(),
    /**
     * When the viewer removed this session from their own watch history. NULL means
     * visible, which is every row until someone asks otherwise.
     *
     * A HIDE, AND DELIBERATELY NOT A DELETE — the distinction is a view-count exploit.
     * `video_view_session_unq` (video, fingerprint, day) IS the anti-replay mechanism,
     * and `video_stats.view_count` is an incremental counter bumped once when
     * `is_counted_view` flips. `prune-engagement-data.ts` says outright that the
     * increment "cannot be walked back from here". So deleting a row on user request
     * reopens the window: remove from history, re-watch the same video the same day,
     * `is_counted_view` flips a second time, `view_count` increments again, repeat. The
     * beacon limiters cap the rate of that; they do not close it.
     *
     * Stamping instead leaves the unique key, the counters and the 90-day prune exactly
     * as they were, and re-watching a hidden video makes it visible again on its own —
     * which is the behaviour a viewer expects anyway.
     *
     * Read by every PER-ROW "has this viewer watched this" question — the `mode=watched`
     * listing, §4.5's already-watched exclusion, §4.8's new-to-you creator exclusion —
     * all of which filter `IS NULL`. That means hiding a video makes it recommendable
     * again, which is deliberate and is what clearing history does elsewhere.
     *
     * It must NEVER reach counting or fraud: `is_counted_view`, `video_stats`, the
     * unique key and the §8.1 outlier prune all ignore it, because a viewer's display
     * preference is not evidence about whether a view happened.
     *
     * The nightly affinity snapshots (`affinity-score.ts`) also ignore it — they are
     * aggregates recomputed on a schedule, not per-row reads, so a hide shows up there
     * on the next run at the earliest. Worth knowing before someone reports it as a bug.
     */
    hiddenFromHistoryAt: timestamp("hidden_from_history_at", { precision: 3 }),
  },
  (table) => [
    uniqueIndex("video_view_session_unq").on(
      table.videoId,
      table.viewerFingerprint,
      table.viewDayBucket,
    ),
    // §4.4 anonymous session-scoped affinity: "what has this fingerprint watched in
    // the last 7 days?", so a logged-out feed responds after two or three watches
    // instead of staying a flat popularity list forever.
    index("video_view_session_fingerprint_idx").on(table.viewerFingerprint, table.viewDayBucket),
    // §4.5's "exclude anything this viewer already watched in the last 30 days", and
    // the `mode=watched` history listing. Partial, because both only ever ask about
    // counted views by a signed-in viewer, and that is a small fraction of the table.
    //
    // `hidden_from_history_at IS NULL` is in the predicate because it is in BOTH those
    // queries — a hidden row is not history and is not an exclusion. Any new query that
    // wants this index has to carry the same three clauses or Postgres will not use it.
    index("video_view_session_viewer_idx")
      .on(table.viewerId, table.videoId, table.firstBeaconAt)
      .where(sql`viewer_id IS NOT NULL AND is_counted_view AND hidden_from_history_at IS NULL`),
    // §4.1 view velocity: counted views in the first 48 hours.
    index("video_view_session_video_idx").on(table.videoId, table.firstBeaconAt),
    check(
      "video_view_session_bounds_ck",
      sql`watched_seconds >= 0
          AND max_position_seconds >= 0
          AND completion_basis_points BETWEEN 0 AND 10000
          AND pinned_duration_seconds BETWEEN 1 AND 43200
          AND last_beacon_at >= first_beacon_at`,
    ),
    // The fingerprint is server-computed, so a row that is not 64 lowercase hex chars
    // means something upstream stopped hashing — fail at the storage layer, loudly.
    check("video_view_session_fingerprint_ck", sql`viewer_fingerprint ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * The unique key is what makes `PUT`/`DELETE /videos/:videoId/like` idempotent by
 * verb — which is why they are PUT and DELETE rather than POST: a double-tap on a
 * slow connection must be harmless, not a second like. Same call, same mechanism, as
 * `research_program_post_reaction`.
 */
export const videoLike = pgTable(
  "video_like",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.videoId, table.userId] }),
    // THE REVERSE INDEX IS THE POINT. "Which of these 24 cards have I liked?" is one
    // join over this index; without it, it is twenty-four round trips.
    index("video_like_userId_idx").on(table.userId, table.videoId),
  ],
);

/** Watch-later. Same shape as `videoLike`, one index apart — see below. */
export const videoSave = pgTable(
  "video_save",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.videoId, table.userId] }),
    // Leads with `created_at`, unlike videoLike's reverse index, because a saved list
    // is RENDERED — newest first — where a like set is only ever probed for membership.
    index("video_save_userId_idx").on(table.userId, table.createdAt, table.videoId),
  ],
);

/**
 * One level of threading only, discriminated by `depth` — the same single-table shape
 * as `research_program_post`, for the same reason: a self-join to depth 1 is one
 * index scan, and an unbounded tree is a recursive CTE nobody paginates correctly.
 *
 * DELETE IS A TOMBSTONE, NOT A ROW DELETE. Deleting a parent outright would cascade
 * its replies away, so a moderator removing one comment would silently remove the
 * conversation under it.
 *
 * §8.4 is explicit that v1 ships with NO reporting flow and NO automated moderation,
 * so the `is_hidden`/`hidden_by`/`hidden_reason` columns `research_program_post`
 * carries are deliberately ABSENT here rather than present and unwritten.
 */
export const videoComment = pgTable(
  "video_comment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    // Cascade is safe ONLY because deletes are tombstones: no row is ever hard-deleted
    // by the application, and the depth cap bounds the cascade to one level anyway.
    parentCommentId: text("parent_comment_id").references((): AnyPgColumn => videoComment.id, {
      onDelete: "cascade",
    }),
    depth: integer("depth").default(0).notNull(),
    // `set null`: closing an account must not erase the thread it participated in.
    // A NULL author renders as "deleted user", which is a true statement.
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    bodyText: text("body_text").notNull(),
    likeCount: integer("like_count").default(0).notNull(),
    replyCount: integer("reply_count").default(0).notNull(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
    // `precision: 3` — LOAD-BEARING. Both listings are keyset-paginated on
    // `(created_at, id)` with a millisecond cursor (src/lib/instant-cursor.ts), and a
    // microsecond column under a millisecond cursor makes rows unreachable at every
    // page boundary. Identical note on research_program_post.created_at.
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The thread: top-level rows, newest first, ending in a unique column. Partial,
    // because replies are never in this listing and they are the bulk of the rows.
    index("video_comment_thread_idx")
      .on(table.videoId, table.createdAt, table.id)
      .where(sql`parent_comment_id IS NULL`),
    // A comment's replies, oldest first.
    index("video_comment_parent_idx").on(table.parentCommentId, table.createdAt, table.id),
    /**
     * THE CREATOR INBOX INDEX — `GET /users/me/video-comments`.
     *
     * Same leading column as `video_comment_thread_idx` above and deliberately NOT partial. That
     * one is `WHERE parent_comment_id IS NULL` because the public thread reads roots and replies
     * separately; an inbox built on it would omit every reply, which is most of them. A creator
     * shown a third of their comments and told it was all of them is worse served than one with
     * no inbox at all.
     *
     * DESC on both sort columns to match the query's ORDER BY, and `id` as the tiebreak so the
     * keyset cursor is total.
     */
    index("video_comment_video_recent_idx").on(
      table.videoId,
      desc(table.createdAt),
      desc(table.id),
    ),
    index("video_comment_authorUserId_idx").on(table.authorUserId, table.id),
    // Depth and parenthood are one fact stated twice, and they must agree.
    check(
      "video_comment_depth_ck",
      sql`depth BETWEEN 0 AND 1 AND (depth = 0) = (parent_comment_id IS NULL)`,
    ),
    // A reply has no replies of its own — the cap, restated where it is cheap to check.
    check("video_comment_leaf_ck", sql`depth = 0 OR reply_count = 0`),
    check("video_comment_counts_ck", sql`like_count >= 0 AND reply_count >= 0`),
    check("video_comment_deleted_ck", sql`is_deleted = (deleted_at IS NOT NULL)`),
    // THE TOMBSTONE ERASES THE TEXT, and the constraint is what makes that true.
    // Without the second arm, "deleted" is a rendering convention the next reader can
    // forget to honour — and the body sits in the table forever.
    check(
      "video_comment_body_ck",
      sql`(is_deleted = false AND char_length(body_text) BETWEEN 1 AND 2000)
          OR (is_deleted = true AND body_text = '')`,
    ),
  ],
);

export const videoCommentLike = pgTable(
  "video_comment_like",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => videoComment.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.commentId, table.userId] }),
    index("video_comment_like_userId_idx").on(table.userId, table.commentId),
  ],
);

/**
 * A share is an append, not a toggle — but the unique index below still makes
 * `POST /videos/:videoId/share` idempotent for a day, which is why that route carries
 * no `idempotency()` middleware. It could not: that middleware no-ops without a
 * session (src/middleware/idempotency.ts), and this is one of three routes an
 * anonymous caller can reach.
 */
export const videoShare = pgTable(
  "video_share",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    /**
     * NULL for an anonymous sharer, and — exactly like `video_view_session.viewer_id`
     * — this column is a GATE: only a share with a user id moves
     * `video_stats.share_count`, because share count feeds §4.1's engagement rate and
     * an anonymous caller must not be able to push a ranking input.
     */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /**
     * The dedupe identity, from the SAME helper as `viewer_fingerprint`. That helper
     * already branches on identity, so one column dedupes signed-in and anonymous
     * sharers without a second code path.
     */
    sharerFingerprint: text("sharer_fingerprint").notNull(),
    channel: videoShareChannelEnum("channel").notNull(),
    shareDayBucket: date("share_day_bucket", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("video_share_unq").on(
      table.videoId,
      table.sharerFingerprint,
      table.channel,
      table.shareDayBucket,
    ),
    index("video_share_videoId_idx").on(table.videoId, table.createdAt),
    check("video_share_fingerprint_ck", sql`sharer_fingerprint ~ '^[0-9a-f]{64}$'`),
  ],
);

export const creatorSubscription = pgTable(
  "creator_subscription",
  {
    subscriberId: text("subscriber_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subscriberId, table.creatorId] }),
    // "Who subscribes to this creator?" — the direction the PK cannot serve.
    index("creator_subscription_creatorId_idx").on(table.creatorId, table.subscriberId),
    // Subscribing to yourself would inflate your own public subscriber count by one
    // and put your own videos in your own feed. Refused at the storage layer.
    check("creator_subscription_self_ck", sql`subscriber_id <> creator_id`),
  ],
);

/*
 * THE TWO NEGATIVE VIEWER SIGNALS. Everything above this point records what a viewer
 * WANTS more of; these two record what they want less of, and they are the only such
 * tables in the schema.
 *
 * NEITHER HAS A COUNTER, and that is not an omission. `creatorSubscription` moves
 * `creatorStats.subscriberCount` because a subscriber count is public social proof; a
 * public "muted by N people" number is the opposite — it is a stick handed to anyone who
 * wants to demoralise a creator, and no route reads it.
 *
 * NEITHER IS EVER RELAXED. The feed's relaxation ladder (feed.service.ts) drops the
 * already-watched exclusion and the recency window when the candidate pool runs thin.
 * These two sit OUTSIDE it: they are stated preferences, not heuristics, and a dismiss
 * button that quietly stops working on a thin catalog is worse than a short feed.
 */

/**
 * "Not interested" — one viewer, one video, permanently out of that viewer's feed.
 *
 * NOT A `video_view_session` STAMP, which is the reuse the shape invites and which would
 * be wrong three times over. That table's grain is (video, fingerprint, UTC day) and its
 * unique key is the anti-replay mechanism for view counting, so a row here for a video
 * the viewer never watched would have to invent a `pinned_duration_seconds` and a
 * fingerprint — evidence of a view that did not happen. Worse, `hidden_from_history_at`
 * means the OPPOSITE of this table: hiding from history makes a video recommendable
 * again (see the note on that column), so one button would carry two contradictory
 * meanings. And that table is pruned at 90 days, where a preference must be durable.
 */
export const videoNotInterested = pgTable(
  "video_not_interested",
  {
    viewerId: text("viewer_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    // VIEWER LEADS, unlike `videoLike`'s `(videoId, userId)`. The only read is the feed's
    // per-viewer `NOT EXISTS` probe, keyed (viewer, video) — this PK serves it alone, and
    // it is also what makes PUT and DELETE idempotent.
    primaryKey({ columns: [table.viewerId, table.videoId] }),
    // FOR THE FOREIGN-KEY CASCADE, not for a query. Deleting a video has to find its rows
    // here, and without this that is a sequential scan of the whole table.
    index("video_not_interested_videoId_idx").on(table.videoId),
    // FOR `GET /users/me/not-interested-videos`, and it is not served by either of the two
    // above. The PK leads on `viewer_id` but its second column is `video_id`, so it answers
    // the feed's point probe and nothing else; a viewer-scoped page ordered by
    // `created_at DESC` would sort every one of that viewer's rows on each request.
    //
    // THE TIEBREAK COLUMN IS PART OF THE INDEX, not decoration. That listing is keyset —
    // `(created_at, video_id)`, because two dismissals share a millisecond often enough
    // (tap a card, tap the next) — and a cursor whose second column the index does not
    // carry re-sorts on every page.
    index("video_not_interested_viewer_recent_idx").on(
      table.viewerId,
      table.createdAt.desc(),
      table.videoId.desc(),
    ),
  ],
);

/** "Don't recommend channel" — every video by one creator, out of one viewer's feed. */
export const creatorMute = pgTable(
  "creator_mute",
  {
    muterId: text("muter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.muterId, table.creatorId] }),
    // FOR THE CASCADE ONLY, and deliberately NOT the mirror of
    // `creator_subscription_creatorId_idx`. That index exists partly to answer "who
    // subscribes to me"; this one must never back "who muted me" — see the header.
    index("creator_mute_creatorId_idx").on(table.creatorId),
    // Muting yourself is already what the feed's creator self-exclusion does, and a row
    // for it would outlive that predicate's last relaxation stage. Refused at rest.
    check("creator_mute_self_ck", sql`muter_id <> creator_id`),
  ],
);

/**
 * The §8.2 fast dead-player path.
 *
 * A creator can disable embedding on youtube.com at any moment and Qatoto finds out
 * only by asking. A nightly re-check means up to 24 hours of serving a dead player.
 * The IFrame API's `onError` gives us a same-second signal instead — but ONE client's
 * error report is one client's claim (R1), so the flip requires three DISTINCT
 * fingerprints, and the unique index below is what makes "distinct" mean something.
 */
export const videoPlaybackError = pgTable(
  "video_playback_error",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    viewerFingerprint: text("viewer_fingerprint").notNull(),
    reportDayBucket: date("report_day_bucket", { mode: "string" }).notNull(),
    errorCode: integer("error_code").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("video_playback_error_unq").on(
      table.videoId,
      table.viewerFingerprint,
      table.reportDayBucket,
    ),
    index("video_playback_error_videoId_idx").on(table.videoId, table.reportDayBucket),
    // The IFrame API's documented codes, as a CLOSED SET. An open integer column is a
    // column of client-chosen junk that the three-fingerprint rule would then count.
    check("video_playback_error_code_ck", sql`error_code IN (2, 5, 100, 101, 150)`),
    check("video_playback_error_fingerprint_ck", sql`viewer_fingerprint ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Counter cache. Same shape and same reasoning as `project_stats`: a sidecar table
 * rather than columns on `video`, because `video.updated_at` uses `$onUpdate` and a
 * view counter must not make a creator's video look edited.
 *
 * Every counter here moves IN THE SAME TRANSACTION as the row that caused it. The
 * source-of-truth tables above stay authoritative; this is a cache, which is the only
 * reason `onDelete: "cascade"` is acceptable on the primary key.
 */
export const videoStats = pgTable(
  "video_stats",
  {
    videoId: text("video_id")
      .primaryKey()
      .references(() => video.id, { onDelete: "cascade" }),
    /**
     * COUNTED views, not beacons and not page loads. Moves exactly once per session,
     * on the `is_counted_view` transition. Rule 4 of the domain: a view is not a watch.
     */
    viewCount: integer("view_count").default(0).notNull(),
    likeCount: integer("like_count").default(0).notNull(),
    commentCount: integer("comment_count").default(0).notNull(),
    shareCount: integer("share_count").default(0).notNull(),
    saveCount: integer("save_count").default(0).notNull(),
    totalWatchedSeconds: bigint("total_watched_seconds", { mode: "number" }).default(0).notNull(),
    /**
     * SUM AND COUNT, NEVER A STORED AVERAGE. An average is a float, floats make a
     * ranking bug irreproducible, and §4.1 divides these two at read time with integer
     * division instead.
     *
     * ONLY ACCUMULATES FROM SESSIONS WHERE `viewer_id IS NOT NULL` (§8.1). That single
     * rule is what makes farming the 40-point completion component require real
     * accounts rather than a headless browser.
     */
    completionBasisPointsSum: bigint("completion_bp_sum", { mode: "number" }).default(0).notNull(),
    completionSampleCount: integer("completion_sample_count").default(0).notNull(),
    /**
     * NULLABLE WITH NO DEFAULT, deliberately — the `project_stats` split between
     * transactional counters and job-computed ones.
     *
     * This is a count of DISTINCT fingerprints across all days, which no single
     * transaction can maintain. §4.1's engagement rate divides by it, so defaulting it
     * to 0 would state as fact a denominator that is false and make a brand-new
     * video's engagement rate undefined-but-rendered. The phase-3 job writes it; until
     * then NULL is the honest value and the ranker treats it as absent, not as zero.
     */
    uniqueViewerCount: integer("unique_viewer_count"),
    /**
     * Counted views inside the first 48 hours — §4.1's velocity input, PERSISTED.
     *
     * Job-computed, nullable with no default, for the same Rule 5 reason as
     * `unique_viewer_count` above: a video nobody has scored yet has no velocity, which
     * is not the same fact as a velocity of zero.
     *
     * IT IS STORED RATHER THAN ALWAYS RECOMPUTED because `prune-engagement-data` deletes
     * the `video_view_session` rows it is derived from at 90 days. Without a stored
     * floor, every video older than the retention window would silently drop to zero
     * velocity on the next nightly run — and its engagement rate would inflate at the
     * same time, because the unique-viewer denominator collapses too. See
     * `engagement-retention.ts` for how the two jobs agree on the horizon.
     */
    countedViewsFirst48Hours: integer("counted_views_first_48_hours"),
    lastEngagementAt: timestamp("last_engagement_at"),
    /**
     * The §4.1 quality score, denormalized off `video_quality_score_snapshot`.
     *
     * DENORMALIZED FOR THE SAME REASON `problem_cluster.current_opportunity_score_points`
     * is: the feed already joins this table for its counters, and making it also resolve
     * "which snapshot is the current one" per request would be a second query on the
     * hottest read on the platform.
     *
     * NULLABLE WITH NO DEFAULT (Rule 5). A brand-new video is UNSCORED, which is not the
     * same fact as scored zero, and the feed's COALESCE is where that distinction is
     * made. `scoreComputedAt` carries the monotonic guard that stops an operator
     * replaying an old `asOf` for an audit from clobbering today's published scores.
     */
    qualityScorePoints: integer("quality_score_points"),
    qualityScoreComputedAt: timestamp("quality_score_computed_at"),
    /**
     * Position in the hourly top 200, or NULL for everything else.
     *
     * `?mode=trending` orders by this; Spotlight is `rank <= 3`. Denormalized rather than
     * joined for the same reason as above — and it is rewritten wholesale each hour, so
     * it needs no monotonic guard: there is exactly one live trending list at a time.
     */
    trendingRank: integer("trending_rank"),
  },
  () => [
    check(
      "video_stats_score_range_ck",
      sql`(quality_score_points IS NULL OR quality_score_points BETWEEN 0 AND 100)
          AND (quality_score_points IS NULL) = (quality_score_computed_at IS NULL)
          AND (trending_rank IS NULL OR trending_rank >= 1)`,
    ),
    check(
      "video_stats_counters_non_negative_ck",
      sql`view_count >= 0 AND like_count >= 0 AND comment_count >= 0
          AND share_count >= 0 AND save_count >= 0
          AND total_watched_seconds >= 0 AND completion_bp_sum >= 0
          AND completion_sample_count >= 0
          AND (unique_viewer_count IS NULL OR unique_viewer_count >= 0)
          AND (counted_views_first_48_hours IS NULL OR counted_views_first_48_hours >= 0)`,
    ),
  ],
);

/**
 * The creator-level counter cache. Separate from `video_stats` because a subscription
 * is not about any one video, and `subscriber_count` must survive every video being
 * unpublished.
 *
 * Rows are minted lazily — `INSERT … ON CONFLICT DO NOTHING` at the first video create
 * and at the first subscribe — because `user` rows are created by Better Auth inside a
 * transaction this schema cannot hook.
 */
export const creatorStats = pgTable(
  "creator_stats",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    subscriberCount: integer("subscriber_count").default(0).notNull(),
    publishedVideoCount: integer("published_video_count").default(0).notNull(),
    totalViewCount: bigint("total_view_count", { mode: "number" }).default(0).notNull(),
  },
  () => [
    check(
      "creator_stats_counters_non_negative_ck",
      sql`subscriber_count >= 0 AND published_video_count >= 0 AND total_view_count >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// HOME FEED — RANKING SNAPSHOTS (HOME_BACKEND_STRUCTURE.md §4, §6)
//
// All five copy `problem_cluster_score_snapshot` (schema.ts:1968), and the shape is the
// point: THE COMPONENT COLUMNS ARE STORED NEXT TO THE TOTAL. Six months from now,
// "why was this video ranked third?" has an answer that does not require replaying data
// that has since moved. A snapshot holding only a total is a number nobody can defend.
//
// Every one of them is APPEND-ONLY and keyed `unique(scope…, as_of)`, so re-running a job
// for the same `asOf` is an `ON CONFLICT DO NOTHING` rather than a duplicate row or a
// destructive overwrite — the property that makes "run it again and diff" a valid way to
// check the ranking is deterministic.
//
// `scoreAlgorithmVersion` on each: the formula may evolve without invalidating history.
// ---------------------------------------------------------------------------

/**
 * §4.1 — one video's quality, nightly, 0..100.
 *
 * The five components do NOT have fixed budgets, because §4.2's sample ramp moves the
 * completion budget and redistributes the remainder. So the CHECK below asserts only that
 * the components sum to the total and the total is in band — which is the invariant that
 * actually holds, rather than one that looks tidier and is false.
 */
export const videoQualityScoreSnapshot = pgTable(
  "video_quality_score_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // `restrict`, not cascade — the snapshot precedent. Deleting a video that has ranking
    // history should fail loudly rather than silently erase the record of how it ranked.
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "restrict" }),
    /** From the job payload, quantized to a UTC day start. Never a clock read. */
    asOf: timestamp("as_of").notNull(),
    qualityScorePoints: integer("quality_score_points").notNull(),
    // --- Inputs, so the score is reproducible without replaying history.
    meanCompletionBasisPoints: integer("mean_completion_basis_points").notNull(),
    completionSampleCount: integer("completion_sample_count").notNull(),
    engagementPerThousandViewers: integer("engagement_per_thousand_viewers").notNull(),
    /** NULL when the job could not establish one — Rule 5, not a fabricated zero. */
    uniqueViewerCount: integer("unique_viewer_count"),
    countedViewsFirst48Hours: integer("counted_views_first_48_hours").notNull(),
    creatorMedianQualityPoints: integer("creator_median_quality_points"),
    hoursSincePublished: integer("hours_since_published").notNull(),
    // --- Components. Their sum IS the score.
    completionComponentPoints: integer("completion_component_points").notNull(),
    engagementComponentPoints: integer("engagement_component_points").notNull(),
    velocityComponentPoints: integer("velocity_component_points").notNull(),
    creatorTrackComponentPoints: integer("creator_track_component_points").notNull(),
    freshnessComponentPoints: integer("freshness_component_points").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // No updatedAt. An append-only table has nothing to update.
  },
  (table) => [
    uniqueIndex("video_quality_score_snapshot_unq").on(table.videoId, table.asOf),
    index("video_quality_score_snapshot_asOf_idx").on(table.asOf, table.id),
    check(
      "video_quality_score_snapshot_score_ck",
      sql`quality_score_points BETWEEN 0 AND 100
          AND completion_component_points >= 0 AND engagement_component_points >= 0
          AND velocity_component_points >= 0 AND creator_track_component_points >= 0
          AND freshness_component_points >= 0
          AND completion_component_points + engagement_component_points
              + velocity_component_points + creator_track_component_points
              + freshness_component_points = quality_score_points`,
    ),
    check(
      "video_quality_score_snapshot_inputs_ck",
      sql`mean_completion_basis_points BETWEEN 0 AND 10000
          AND completion_sample_count >= 0
          AND engagement_per_thousand_viewers >= 0
          AND (unique_viewer_count IS NULL OR unique_viewer_count >= 0)
          AND counted_views_first_48_hours >= 0
          AND (creator_median_quality_points IS NULL
               OR creator_median_quality_points BETWEEN 0 AND 100)
          AND hours_since_published >= 0`,
    ),
  ],
);

/**
 * §4.3 — how much one viewer likes one category, nightly, 0..100.
 *
 * A ROW ONLY EXISTS WHERE THERE IS EVIDENCE. The absence of a (user, category) row is what
 * triggers §4.4's cold-start fallback to damped platform popularity; writing a zero row
 * instead would fabricate the very value the fallback exists to avoid, and the feed would
 * have no way to tell "watched it and hated it" from "never saw it".
 */
export const userTopicAffinitySnapshot = pgTable(
  "user_topic_affinity_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Cascade here, unlike the video snapshot: this is derived personal data, and a
    // deleted account's taste profile should go with it.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => contentCategory.id, { onDelete: "restrict" }),
    asOf: timestamp("as_of").notNull(),
    affinityPoints: integer("affinity_points").notNull(),
    countedViewCount: integer("counted_view_count").notNull(),
    meanCompletionBasisPoints: integer("mean_completion_basis_points").notNull(),
    explicitSignalCount: integer("explicit_signal_count").notNull(),
    // "Not interested" rows in this category, plus `MUTE_SIGNAL_WEIGHT` per mute — which is
    // always zero here, because a category cannot be muted. See `affinity-score.ts`.
    negativeSignalCount: integer("negative_signal_count").default(0).notNull(),
    watchCountComponentPoints: integer("watch_count_component_points").notNull(),
    meanCompletionComponentPoints: integer("mean_completion_component_points").notNull(),
    explicitSignalComponentPoints: integer("explicit_signal_component_points").notNull(),
    // SUBTRACTED, not added, and stored ALREADY CLAMPED to the positive total so the CHECK's
    // sum identity below stays exact. The raw ladder output is never stored.
    negativeSignalComponentPoints: integer("negative_signal_component_points").default(0).notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_topic_affinity_snapshot_unq").on(table.userId, table.categoryId, table.asOf),
    // The feed's join: every category this viewer has an opinion about, at one asOf.
    index("user_topic_affinity_snapshot_viewer_idx").on(table.userId, table.asOf, table.categoryId),
    index("user_topic_affinity_snapshot_asOf_idx").on(table.asOf, table.id),
    check(
      "user_topic_affinity_snapshot_score_ck",
      sql`affinity_points BETWEEN 0 AND 100
          AND watch_count_component_points >= 0 AND mean_completion_component_points >= 0
          AND explicit_signal_component_points >= 0 AND negative_signal_component_points >= 0
          AND watch_count_component_points + mean_completion_component_points
              + explicit_signal_component_points - negative_signal_component_points
              = affinity_points
          AND counted_view_count >= 0
          AND mean_completion_basis_points BETWEEN 0 AND 10000
          AND explicit_signal_count >= 0
          AND negative_signal_count >= 0`,
    ),
  ],
);

/** §4.3 — the same question about a creator rather than a category. Same shape. */
export const userCreatorAffinitySnapshot = pgTable(
  "user_creator_affinity_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    asOf: timestamp("as_of").notNull(),
    affinityPoints: integer("affinity_points").notNull(),
    countedViewCount: integer("counted_view_count").notNull(),
    meanCompletionBasisPoints: integer("mean_completion_basis_points").notNull(),
    explicitSignalCount: integer("explicit_signal_count").notNull(),
    // Dismissals of this creator's videos, plus `MUTE_SIGNAL_WEIGHT` if this viewer muted
    // them. Unlike the topic table, the mute term is genuinely reachable here.
    negativeSignalCount: integer("negative_signal_count").default(0).notNull(),
    watchCountComponentPoints: integer("watch_count_component_points").notNull(),
    meanCompletionComponentPoints: integer("mean_completion_component_points").notNull(),
    explicitSignalComponentPoints: integer("explicit_signal_component_points").notNull(),
    negativeSignalComponentPoints: integer("negative_signal_component_points").default(0).notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_creator_affinity_snapshot_unq").on(table.userId, table.creatorId, table.asOf),
    index("user_creator_affinity_snapshot_viewer_idx").on(
      table.userId,
      table.asOf,
      table.creatorId,
    ),
    index("user_creator_affinity_snapshot_asOf_idx").on(table.asOf, table.id),
    // A viewer cannot have an affinity for themselves — their own videos are excluded
    // from the candidate pool anyway, so such a row could only ever be dead weight.
    check("user_creator_affinity_snapshot_self_ck", sql`user_id <> creator_id`),
    check(
      "user_creator_affinity_snapshot_score_ck",
      sql`affinity_points BETWEEN 0 AND 100
          AND watch_count_component_points >= 0 AND mean_completion_component_points >= 0
          AND explicit_signal_component_points >= 0 AND negative_signal_component_points >= 0
          AND watch_count_component_points + mean_completion_component_points
              + explicit_signal_component_points - negative_signal_component_points
              = affinity_points
          AND counted_view_count >= 0
          AND mean_completion_basis_points BETWEEN 0 AND 10000
          AND explicit_signal_count >= 0
          AND negative_signal_count >= 0`,
    ),
  ],
);

/**
 * §6 — the hourly top 200. Spotlight is `rank <= 3`.
 *
 * HOURLY, not nightly, and that is the one scheduling decision in this domain that is not
 * negotiable: a "trending" chip recomputed once a day is a lie about what the word means.
 *
 * `unique(asOf, rank)` alongside `unique(asOf, videoId)` is what makes `rank` mean
 * something. Without it a bug that emits two rank-1 rows would store happily and Spotlight
 * would render whichever the planner happened to return.
 */
export const trendingVideoSnapshot = pgTable(
  "trending_video_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "restrict" }),
    /** Quantized to a UTC HOUR start, unlike its nightly siblings. */
    asOf: timestamp("as_of").notNull(),
    rank: integer("rank").notNull(),
    trendingScorePoints: integer("trending_score_points").notNull(),
    countedViewsInWindow: integer("counted_views_in_window").notNull(),
    watchedMinutesInWindow: integer("watched_minutes_in_window").notNull(),
    engagementActionsInWindow: integer("engagement_actions_in_window").notNull(),
    qualityScorePoints: integer("quality_score_points"),
    recentViewComponentPoints: integer("recent_view_component_points").notNull(),
    recentWatchTimeComponentPoints: integer("recent_watch_time_component_points").notNull(),
    recentEngagementComponentPoints: integer("recent_engagement_component_points").notNull(),
    qualityComponentPoints: integer("quality_component_points").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("trending_video_snapshot_video_unq").on(table.asOf, table.videoId),
    uniqueIndex("trending_video_snapshot_rank_unq").on(table.asOf, table.rank),
    check(
      "trending_video_snapshot_score_ck",
      sql`rank >= 1
          AND trending_score_points BETWEEN 0 AND 100
          AND recent_view_component_points >= 0 AND recent_watch_time_component_points >= 0
          AND recent_engagement_component_points >= 0 AND quality_component_points >= 0
          AND recent_view_component_points + recent_watch_time_component_points
              + recent_engagement_component_points + quality_component_points
              = trending_score_points
          AND counted_views_in_window >= 0 AND watched_minutes_in_window >= 0
          AND engagement_actions_in_window >= 0
          AND (quality_score_points IS NULL OR quality_score_points BETWEEN 0 AND 100)`,
    ),
  ],
);

/**
 * §4.4 — what the platform as a whole watches, per category, nightly.
 *
 * The ONLY consumer is cold start: a signed-in viewer with no history sees this
 * distribution, damped to 60%, instead of a flat feed. It is deliberately not exposed on
 * any route — "which categories are popular" is a product decision surface, not a public
 * fact, and publishing it would hand a creator a targeting list.
 */
export const platformCategoryPopularitySnapshot = pgTable(
  "platform_category_popularity_snapshot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    categoryId: text("category_id")
      .notNull()
      .references(() => contentCategory.id, { onDelete: "restrict" }),
    asOf: timestamp("as_of").notNull(),
    /** 0..100, a share of the most-watched category rather than of the whole. */
    popularityPoints: integer("popularity_points").notNull(),
    countedViewCount: integer("counted_view_count").notNull(),
    publishedVideoCount: integer("published_video_count").notNull(),
    scoreAlgorithmVersion: integer("score_algorithm_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("platform_category_popularity_snapshot_unq").on(table.categoryId, table.asOf),
    index("platform_category_popularity_snapshot_asOf_idx").on(table.asOf, table.categoryId),
    check(
      "platform_category_popularity_snapshot_ck",
      sql`popularity_points BETWEEN 0 AND 100
          AND counted_view_count >= 0 AND published_video_count >= 0`,
    ),
  ],
);

export const playlist = pgTable(
  "playlist",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    visibility: playlistVisibilityEnum("visibility").default("private").notNull(),
    defaultVideoOrder: playlistVideoOrderEnum("default_video_order")
      .default("date_published_newest")
      .notNull(),
    language: text("language"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("playlist_creatorId_idx").on(table.creatorId)],
);

export const playlistItem = pgTable(
  "playlist_item",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlist.id, { onDelete: "cascade" }),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("playlist_item_playlistId_idx").on(table.playlistId),
    // Serves PUT /videos/:id/playlists, which reads membership by video, not playlist.
    index("playlist_item_videoId_idx").on(table.videoId),
    uniqueIndex("playlist_item_unq").on(table.playlistId, table.videoId),
  ],
);

export const animeSeries = pgTable(
  "anime_series",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /**
     * The public URL identity — `/anime/series/<slug>`.
     *
     * SERVER-MINTED FROM THE TITLE ON CREATE, AND NEVER REWRITTEN. A slug is linked
     * the moment it exists, so letting an edit change it silently breaks every link
     * anyone has already shared. The title is free to change; this is not.
     *
     * kebab-case, per the wire-casing rule for URL identities.
     */
    slug: text("slug").notNull(),
    description: text("description"),
    posterUrl: text("poster_url"),
    genreTags: text("genre_tags").array().notNull().default([]),
    status: animeSeriesStatusEnum("status").default("ongoing").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("anime_series_ownerId_idx").on(table.ownerId),
    // The public detail read is keyed by slug, and uniqueness is what makes the slug
    // an identity rather than a label.
    uniqueIndex("anime_series_slug_uidx").on(table.slug),
    check("anime_series_genre_tags_ck", sql`cardinality(genre_tags) <= 20`),
    check(
      "anime_series_slug_ck",
      sql`char_length(slug) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
  ],
);

export const animeSeason = pgTable(
  "anime_season",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    seriesId: text("series_id")
      .notNull()
      .references(() => animeSeries.id, { onDelete: "cascade" }),
    seasonLabel: text("season_label").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("anime_season_seriesId_idx").on(table.seriesId),
    // ADDITION TO SPEC §4. Two "Season 1" rows under one series make the upload
    // modal's season picker ambiguous and render the episode-number unique index
    // below useless. It is also what lets "pick or create Season 1" be an idempotent
    // insert-on-conflict rather than a read-then-write race.
    uniqueIndex("anime_season_label_unq").on(table.seriesId, table.seasonLabel),
  ],
);

export const animeEpisode = pgTable(
  "anime_episode",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    seasonId: text("season_id")
      .notNull()
      .references(() => animeSeason.id, { onDelete: "cascade" }),
    // `set null` so deleting the video leaves the catalog entry standing.
    videoId: text("video_id").references(() => video.id, { onDelete: "set null" }),
    episodeNumber: integer("episode_number").notNull(),
    episodeTitle: text("episode_title").notNull(),
    isPremium: boolean("is_premium").default(false).notNull(),
    releaseScheduleDay: text("release_schedule_day"),
    releaseScheduleTime: text("release_schedule_time"),
    premiereDate: timestamp("premiere_date"),
    audioMode: animeAudioModeEnum("audio_mode"),
    audioLanguage: text("audio_language"),
    ageRating: text("age_rating"),
    // Set when the episode goes live in /anime, which is on APPROVAL, not on publish.
    releasedAt: timestamp("released_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("anime_episode_seasonId_idx").on(table.seasonId),
    uniqueIndex("anime_episode_unq").on(table.seasonId, table.episodeNumber),
    // ADDITION TO SPEC §4, which asserts "one video is at most one episode" in a
    // comment and then does not enforce it. Partial because videoId is nullable.
    uniqueIndex("anime_episode_videoId_unq")
      .on(table.videoId)
      .where(sql`video_id is not null`),
    check("anime_episode_number_ck", sql`episode_number >= 0`),
  ],
);

// Every approve/reject, logged. This is the record of record for moderation.
export const contentReviewAction = pgTable(
  "content_review_action",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Cascade, deliberately, and the asymmetry with reviewerId below is the point:
    // once the video is gone there is no longer a subject to have been reviewed, so
    // the row describes nothing. The REVIEWER, by contrast, must stay accountable.
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    // `restrict`, per the R&D cascade rule R2: this row bears AUDIT weight, so a
    // moderator cannot be hard-deleted out from under the decisions they made.
    // Account deletion is an anonymization flow, not a DELETE.
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    action: contentReviewActionKindEnum("action").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("content_review_action_videoId_idx").on(table.videoId),
    // The admin audit-log view is chronological across every video.
    index("content_review_action_createdAt_idx").on(table.createdAt),
    // A rejection with no reason is unactionable for the creator and unauditable for
    // the next moderator.
    check("content_review_action_reason_ck", sql`(action <> 'reject') OR (reason IS NOT NULL)`),
  ],
);

/*
 * VIDEO CONTENT REPORTING — the fourth report fork, and the fourth is not an accident.
 *
 * `research_program_content_report`, `commerce_content_report` and
 * `community_content_report` each exist because the surface before them refused to
 * generalize, and each recorded why. The reason is always the same and it is worth stating
 * once more: two report queues gated by DIFFERENT capabilities in one table is "the coupling
 * capabilities exist to prevent". A commerce moderator working counterfeit listings and a
 * content moderator judging a video are not the same shift.
 *
 * THIS ONE ALSO CANNOT REUSE `content_review_action` DIRECTLY ABOVE, which is the reuse that
 * looks obvious — it is already the video moderation log. Two columns forbid it, and
 * `commerce_content_report`'s own docblock predicted both:
 *
 *   `reviewerId` is NOT NULL. Fine for the anime queue, where a human always decides.
 *   `videoId` is NOT NULL with a CASCADE, so a decision vanishes when its subject does —
 *     the opposite of what an audit needs, and the reason the action table below uses
 *     `set null` instead.
 *
 * WHAT THIS FORK DELIBERATELY DOES NOT COPY FROM COMMERCE: the automatic path. There is no
 * `action_source`, no nullable moderator, no threshold. Commerce auto-hides a review at
 * three reporters but NEVER a product, because "delisting a seller's listing is a commercial
 * action against their livelihood and requires a human to take it". A video is a creator's
 * livelihood by exactly that argument, so every hide here names a human — which is what lets
 * `moderatorUserId` and `auditEntryId` both be NOT NULL, the community and R&D shape.
 */

/** Why someone reported a video. Video-specific, and NOT shared with the other three forks. */
export const videoContentReportReasonEnum = pgEnum("video_content_report_reason", [
  "sexual_content",
  "violence",
  "hateful_or_abusive",
  "harassment",
  "child_safety",
  "spam_or_misleading",
  "copyright",
  "other",
]);

export const videoContentReportStatusEnum = pgEnum("video_content_report_status", [
  "open",
  "actioned",
  "dismissed",
]);

export const videoModerationActionKindEnum = pgEnum("video_moderation_action_kind", [
  "content_hidden",
  "content_restored",
  "report_dismissed",
  /**
   * The claim may well be good, and **Qatoto is not who can act on it**.
   *
   * ⚠️ DISTINCT FROM `report_dismissed` ON PURPOSE. A dismissal says "we looked, the claim does not
   * hold". For a YouTube-hosted video a copyright holder's real remedy is a YouTube claim: hiding
   * the row here withdraws Qatoto's copy while the video keeps playing on youtube.com, so filing
   * that answer as a dismissal tells a rights-holder they were wrong when the truth is that they
   * asked the wrong platform.
   *
   * IT TOUCHES NO CONTENT. The report closes, `moderation_visibility_state` is untouched, and the
   * video still serves. The report's own `status` stays `dismissed` — no content action was taken,
   * and a fourth status would ripple through `video_content_report_resolution_ck` and every queue
   * filter for nothing. This kind carries the meaning, and it is this that the reporter's page
   * renders rather than the raw status.
   *
   * It becomes rare, not wrong, if Qatoto ever hosts its own bytes.
   */
  "redirected_to_source",
]);

/**
 * A viewer flagging a video.
 *
 * ONE TARGET, so none of commerce's XOR machinery: no five nullable foreign keys, no
 * `num_nonnulls(...) = 1`, no per-kind biconditional. `videoId` is simply NOT NULL. That
 * apparatus exists there because one queue covers five different things; this one covers a
 * video, and inventing a `targetKind` column with a single member would be ceremony.
 *
 * ONE REPORT PER PERSON PER VIDEO, through the partial unique index below — so a brigading
 * loop cannot inflate the queue and `409 ALREADY_REPORTED` is an honest answer rather than a
 * silent second row.
 */
export const videoContentReport = pgTable(
  "video_content_report",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    reason: videoContentReportReasonEnum("reason").notNull(),
    detailText: text("detail_text"),
    // `set null`, NOT cascade: a deleted account must not erase the report it filed. The
    // report is evidence about the VIDEO, and it stays evidence once the reporter is gone.
    reporterUserId: text("reporter_user_id").references(() => user.id, { onDelete: "set null" }),
    status: videoContentReportStatusEnum("status").default("open").notNull(),
    // `restrict`, unlike the reporter above, and the asymmetry is the point: a moderator
    // cannot be deleted out from under a decision they made. Account deletion is an
    // anonymization flow, not a DELETE — the same rule `content_review_action` follows.
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolved_at", { precision: 3 }),
    /**
     * What the REPORTER is told, in the moderator's own words. Nullable — a bare outcome is the
     * honest default, and a template pretending to be a considered reply is worse than silence.
     *
     * ⚠️ THIS IS NOT `video_moderation_action.reasonNote`, AND THE TWO MUST NEVER BE MERGED. That
     * one is STAFF-ONLY: an accountability record hash-chained into `platform_audit_entry`, where a
     * moderator may legitimately write "reported by three people, one is the seller in #4821". This
     * one is published to whoever filed the report. One field cannot be both an internal record and
     * a message somebody reads, and collapsing them would turn every internal note into a leak.
     *
     * It exists so an answer like "we cannot remove a video hosted on YouTube — file a claim with
     * them" can actually reach the person who asked. Before it, a reporter saw `dismissed` and a
     * timestamp.
     */
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    // `reporter_user_id IS NOT NULL` in the predicate because the column is nullable by the
    // `set null` above: two reports whose reporters have both been deleted are two NULLs,
    // and NULLs do not collide in a unique index anyway. Stating it keeps the index partial
    // and small rather than indexing rows nothing will ever probe.
    uniqueIndex("video_content_report_reporter_uidx")
      .on(table.videoId, table.reporterUserId)
      .where(sql`reporter_user_id IS NOT NULL`),
    // The queue read: open reports, oldest first. `id` is the tiebreak that makes the
    // keyset cursor total — `created_at` alone is not unique.
    index("video_content_report_queue_idx").on(table.status, table.createdAt, table.id),
    index("video_content_report_videoId_idx").on(table.videoId, table.status),
    check(
      "video_content_report_detail_ck",
      sql`detail_text IS NULL OR char_length(detail_text) BETWEEN 1 AND 2000`,
    ),
    // Byte-identical to the same check in all three other forks. Both halves matter: a
    // resolver with no timestamp is a half-written decision, and an `open` row carrying a
    // resolution is a queue entry that will be handed to a moderator twice.
    check(
      "video_content_report_resolution_ck",
      sql`(resolved_by_user_id IS NULL) = (resolved_at IS NULL)
          AND (status = 'open') = (resolved_at IS NULL)`,
    ),
  ],
);

/**
 * What staff DID, kept apart from what was reported.
 *
 * TARGETS ARE `set null`, the opposite of the report table's cascade, and deliberately so: a
 * report about a deleted video is noise, but a record that staff hid something is exactly
 * what an audit needs to still find afterwards.
 *
 * `moderatorUserId`, `moderatorRoleSnapshot` and `auditEntryId` are ALL NOT NULL, unlike
 * commerce's nullable trio — see the block above `videoContentReport`. No automatic path
 * exists here, so there is no authorless row to accommodate and no `action_source` column
 * needed to tell the two apart.
 *
 * THE ROLE IS A SNAPSHOT, NEVER A JOIN. Roles are revocable; "who was this person when they
 * decided" is not a question `user.platformRole` can answer later.
 */
export const videoModerationAction = pgTable(
  "video_moderation_action",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    actionKind: videoModerationActionKindEnum("action_kind").notNull(),
    videoId: text("video_id").references(() => video.id, { onDelete: "set null" }),
    reportId: text("report_id").references(() => videoContentReport.id, { onDelete: "set null" }),
    moderatorUserId: text("moderator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    moderatorRoleSnapshot: text("moderator_role_snapshot").notNull(),
    reasonNote: text("reason_note").notNull(),
    // The hash-chain entry. NOT NULL because every action here has a human behind it, so
    // every one of them belongs in the chain — an unlogged staff action is the thing the
    // chain exists to make impossible.
    auditEntryId: text("audit_entry_id")
      .notNull()
      .references(() => platformAuditEntry.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    // One action per chain entry, both directions.
    uniqueIndex("video_moderation_action_audit_uidx").on(table.auditEntryId),
    index("video_moderation_action_timeline_idx").on(table.createdAt, table.id),
    index("video_moderation_action_video_idx").on(table.videoId, table.createdAt),
    check("video_moderation_action_reason_ck", sql`char_length(reason_note) BETWEEN 1 AND 2000`),
    check(
      "video_moderation_action_role_ck",
      sql`char_length(moderator_role_snapshot) BETWEEN 1 AND 40`,
    ),
  ],
);

// --- Studio relations. Child-side only: each table declares its own `one(user, ...)`
// --- and `userRelations` is left untouched, matching the store and R&D precedent.

export const videoRelations = relations(video, ({ one, many }) => ({
  creator: one(user, { fields: [video.creatorId], references: [user.id] }),
  chapters: many(videoChapter),
  attachedProducts: many(videoAttachedProduct),
  documents: many(videoDocument),
  milestones: many(videoMilestone),
  openRoles: many(videoOpenRole),
  teamMembers: many(videoTeamMember),
  collaborators: many(videoCollaborator),
  playlistItems: many(playlistItem),
  reviewActions: many(contentReviewAction),
  categories: many(videoCategory),
  stats: one(videoStats, { fields: [video.id], references: [videoStats.videoId] }),
  viewSessions: many(videoViewSession),
  likes: many(videoLike),
  saves: many(videoSave),
  comments: many(videoComment),
  shares: many(videoShare),
}));

// Child-side only, as everywhere in this section: userRelations is deliberately untouched.
export const contentCategoryRelations = relations(contentCategory, ({ many }) => ({
  videoLinks: many(videoCategory),
}));

export const videoCategoryRelations = relations(videoCategory, ({ one }) => ({
  video: one(video, { fields: [videoCategory.videoId], references: [video.id] }),
  category: one(contentCategory, {
    fields: [videoCategory.categoryId],
    references: [contentCategory.id],
  }),
}));

// --- Engagement (§3). Child-side only: userRelations stays untouched, as everywhere
// --- in this section.

export const videoStatsRelations = relations(videoStats, ({ one }) => ({
  video: one(video, { fields: [videoStats.videoId], references: [video.id] }),
}));

export const creatorStatsRelations = relations(creatorStats, ({ one }) => ({
  user: one(user, { fields: [creatorStats.userId], references: [user.id] }),
}));

export const videoViewSessionRelations = relations(videoViewSession, ({ one }) => ({
  video: one(video, { fields: [videoViewSession.videoId], references: [video.id] }),
  viewer: one(user, { fields: [videoViewSession.viewerId], references: [user.id] }),
}));

export const videoLikeRelations = relations(videoLike, ({ one }) => ({
  video: one(video, { fields: [videoLike.videoId], references: [video.id] }),
  user: one(user, { fields: [videoLike.userId], references: [user.id] }),
}));

export const videoSaveRelations = relations(videoSave, ({ one }) => ({
  video: one(video, { fields: [videoSave.videoId], references: [video.id] }),
  user: one(user, { fields: [videoSave.userId], references: [user.id] }),
}));

export const videoNotInterestedRelations = relations(videoNotInterested, ({ one }) => ({
  video: one(video, { fields: [videoNotInterested.videoId], references: [video.id] }),
  viewer: one(user, { fields: [videoNotInterested.viewerId], references: [user.id] }),
}));

export const creatorMuteRelations = relations(creatorMute, ({ one }) => ({
  muter: one(user, { fields: [creatorMute.muterId], references: [user.id] }),
  creator: one(user, { fields: [creatorMute.creatorId], references: [user.id] }),
}));

export const videoCommentRelations = relations(videoComment, ({ one, many }) => ({
  video: one(video, { fields: [videoComment.videoId], references: [video.id] }),
  author: one(user, { fields: [videoComment.authorUserId], references: [user.id] }),
  // The self-relation carries an explicit `relationName` on BOTH sides, or drizzle
  // cannot tell which of the two references to `videoComment` pairs with which.
  parent: one(videoComment, {
    fields: [videoComment.parentCommentId],
    references: [videoComment.id],
    relationName: "videoCommentThread",
  }),
  replies: many(videoComment, { relationName: "videoCommentThread" }),
  likes: many(videoCommentLike),
}));

export const videoCommentLikeRelations = relations(videoCommentLike, ({ one }) => ({
  comment: one(videoComment, {
    fields: [videoCommentLike.commentId],
    references: [videoComment.id],
  }),
  user: one(user, { fields: [videoCommentLike.userId], references: [user.id] }),
}));

export const videoShareRelations = relations(videoShare, ({ one }) => ({
  video: one(video, { fields: [videoShare.videoId], references: [video.id] }),
  user: one(user, { fields: [videoShare.userId], references: [user.id] }),
}));

export const videoPlaybackErrorRelations = relations(videoPlaybackError, ({ one }) => ({
  video: one(video, { fields: [videoPlaybackError.videoId], references: [video.id] }),
}));

// --- Ranking snapshots (§4, §6). Child-side only, as everywhere in this section.

export const videoQualityScoreSnapshotRelations = relations(
  videoQualityScoreSnapshot,
  ({ one }) => ({
    video: one(video, { fields: [videoQualityScoreSnapshot.videoId], references: [video.id] }),
  }),
);

export const userTopicAffinitySnapshotRelations = relations(
  userTopicAffinitySnapshot,
  ({ one }) => ({
    user: one(user, { fields: [userTopicAffinitySnapshot.userId], references: [user.id] }),
    category: one(contentCategory, {
      fields: [userTopicAffinitySnapshot.categoryId],
      references: [contentCategory.id],
    }),
  }),
);

// Both FKs point at `user`, so both need a relationName — same rule as the comment thread.
export const userCreatorAffinitySnapshotRelations = relations(
  userCreatorAffinitySnapshot,
  ({ one }) => ({
    viewer: one(user, {
      fields: [userCreatorAffinitySnapshot.userId],
      references: [user.id],
      relationName: "creatorAffinityViewer",
    }),
    creator: one(user, {
      fields: [userCreatorAffinitySnapshot.creatorId],
      references: [user.id],
      relationName: "creatorAffinityCreator",
    }),
  }),
);

export const trendingVideoSnapshotRelations = relations(trendingVideoSnapshot, ({ one }) => ({
  video: one(video, { fields: [trendingVideoSnapshot.videoId], references: [video.id] }),
}));

export const platformCategoryPopularitySnapshotRelations = relations(
  platformCategoryPopularitySnapshot,
  ({ one }) => ({
    category: one(contentCategory, {
      fields: [platformCategoryPopularitySnapshot.categoryId],
      references: [contentCategory.id],
    }),
  }),
);

// Both sides point at `user`, so both need a relationName — same rule as the comment
// thread above.
export const creatorSubscriptionRelations = relations(creatorSubscription, ({ one }) => ({
  subscriber: one(user, {
    fields: [creatorSubscription.subscriberId],
    references: [user.id],
    relationName: "creatorSubscriptionSubscriber",
  }),
  creator: one(user, {
    fields: [creatorSubscription.creatorId],
    references: [user.id],
    relationName: "creatorSubscriptionCreator",
  }),
}));

export const videoChapterRelations = relations(videoChapter, ({ one }) => ({
  video: one(video, { fields: [videoChapter.videoId], references: [video.id] }),
}));

export const videoAttachedProductRelations = relations(videoAttachedProduct, ({ one }) => ({
  video: one(video, { fields: [videoAttachedProduct.videoId], references: [video.id] }),
  product: one(product, { fields: [videoAttachedProduct.productId], references: [product.id] }),
}));

export const videoDocumentRelations = relations(videoDocument, ({ one }) => ({
  video: one(video, { fields: [videoDocument.videoId], references: [video.id] }),
}));

export const videoMilestoneRelations = relations(videoMilestone, ({ one }) => ({
  video: one(video, { fields: [videoMilestone.videoId], references: [video.id] }),
}));

export const videoOpenRoleRelations = relations(videoOpenRole, ({ one }) => ({
  video: one(video, { fields: [videoOpenRole.videoId], references: [video.id] }),
}));

export const videoTeamMemberRelations = relations(videoTeamMember, ({ one }) => ({
  video: one(video, { fields: [videoTeamMember.videoId], references: [video.id] }),
  linkedUser: one(user, { fields: [videoTeamMember.linkedUserId], references: [user.id] }),
}));

export const videoCollaboratorRelations = relations(videoCollaborator, ({ one }) => ({
  video: one(video, { fields: [videoCollaborator.videoId], references: [video.id] }),
  invitedUser: one(user, { fields: [videoCollaborator.userId], references: [user.id] }),
}));

export const playlistRelations = relations(playlist, ({ one, many }) => ({
  creator: one(user, { fields: [playlist.creatorId], references: [user.id] }),
  items: many(playlistItem),
}));

export const playlistItemRelations = relations(playlistItem, ({ one }) => ({
  playlist: one(playlist, { fields: [playlistItem.playlistId], references: [playlist.id] }),
  video: one(video, { fields: [playlistItem.videoId], references: [video.id] }),
}));

export const animeSeriesRelations = relations(animeSeries, ({ one, many }) => ({
  owner: one(user, { fields: [animeSeries.ownerId], references: [user.id] }),
  seasons: many(animeSeason),
}));

export const animeSeasonRelations = relations(animeSeason, ({ one, many }) => ({
  series: one(animeSeries, { fields: [animeSeason.seriesId], references: [animeSeries.id] }),
  episodes: many(animeEpisode),
}));

export const animeEpisodeRelations = relations(animeEpisode, ({ one }) => ({
  season: one(animeSeason, { fields: [animeEpisode.seasonId], references: [animeSeason.id] }),
  video: one(video, { fields: [animeEpisode.videoId], references: [video.id] }),
}));

export const contentReviewActionRelations = relations(contentReviewAction, ({ one }) => ({
  video: one(video, { fields: [contentReviewAction.videoId], references: [video.id] }),
  reviewer: one(user, { fields: [contentReviewAction.reviewerId], references: [user.id] }),
}));

// ---------------------------------------------------------------------------
// Promotions — the home-page promotional carousel.
//
// ONE TABLE, NO OWNER. Unlike `product` or `animeSeries`, a slide has no member
// owner: it is platform-authored merchandising, written only by a holder of the
// `manage_promotions` capability. So there is no `ownerId`, and the 404-as-ownership
// rule does not apply — the capability check, decided BEFORE any id is read, is the
// whole gate (see requirePlatformCapability's ordering requirement).
//
// WHY `manage_promotions` AND NOT `moderate_content`. A slide is a front-page
// placement that may point at an arbitrary external https URL. That is a phishing
// lure wearing Qatoto's own branding, so its blast radius sits next to role
// management, not next to deciding whether a user's video is allowed. `admin` only.
// ---------------------------------------------------------------------------

/**
 * Where a slide sends the visitor. A discriminator, not two nullable columns: a slide
 * always has EXACTLY ONE destination, so one enum + one value column makes that
 * cardinality structural rather than something an XOR check has to un-represent
 * afterwards. It also maps 1:1 onto `z.discriminatedUnion` in the controller and onto
 * the frontend's `<Link>` vs `<a target="_blank">` switch.
 *
 * snake_case labels, sent VERBATIM in both directions (CLAUDE.md wire-casing). Never
 * "internal-path".
 */
export const promotionalDestinationKindEnum = pgEnum("promotional_destination_kind", [
  "internal_path",
  "external_url",
]);

export const promotionalSlide = pgTable(
  "promotional_slide",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * Cloudinary secure_url of the normalized asset, mirroring `productImage.url`.
     *
     * STORE WHAT CLOUDINARY RETURNED — never reconstruct this from the public id. The
     * `/v<timestamp>/` segment changes on every overwrite, and that segment is exactly
     * what busts the browser cache when an admin replaces a slide's image in place.
     */
    imageUrl: text("image_url").notNull(),
    /**
     * Intrinsic dimensions of the stored asset. A DELIBERATE DEVIATION from
     * `product_image`, which stores neither: `validateAndNormalizeImage` returns them
     * for free, and a full-bleed hero rendered without an aspect ratio is a guaranteed
     * layout shift on the single most-visited page on the site. A product thumbnail
     * sits in a fixed-size grid tile and does not have that problem, which is why the
     * store table can get away without them.
     */
    imageWidthPx: integer("image_width_px").notNull(),
    imageHeightPx: integer("image_height_px").notNull(),
    /**
     * NOT NULL, on purpose. The image sits INSIDE a link, so without alt text the link
     * has no accessible name at all — a WCAG 2.4.4/1.1.1 failure rather than a missing
     * nicety. Nullable would make an unlabelled slide representable.
     */
    altText: text("alt_text").notNull(),
    destinationKind: promotionalDestinationKindEnum("destination_kind").notNull(),
    /** The path or URL itself, already normalized by `parsePromotionalDestination`. */
    destinationValue: text("destination_value").notNull(),
    /**
     * 0-based display order; slide 0 shows first. Contiguous, re-packed on delete —
     * the same contract as `productImage.position`. No unique index on it: a reorder
     * rewrites every row inside one transaction and a non-deferrable UNIQUE would fire
     * mid-loop.
     */
    position: integer("position").notNull(),
    /** The retirement switch. The row survives; the public read stops offering it. */
    isActive: boolean("is_active").default(true).notNull(),
    /** NULL on either side = unbounded in that direction. Absolute instants, UTC. */
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    /**
     * Who touched this, for the admin list. `set null`, NOT `restrict`: the
     * authoritative accountability record is the platform audit chain, and `restrict`
     * would make one promo slide block a staff account deletion forever. `cascade` is
     * worse still — it would silently delete live merchandising when someone leaves.
     */
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The public read — live slides in order. Partial, because the overwhelming
    // majority of reads want only the live set.
    index("promotional_slide_live_idx")
      .on(table.position, table.id)
      .where(sql`is_active`),
    // The admin read, which includes retired and out-of-window rows.
    index("promotional_slide_position_idx").on(table.position, table.id),

    check("promotional_slide_position_ck", sql`position >= 0`),
    check("promotional_slide_alt_text_ck", sql`char_length(alt_text) BETWEEN 1 AND 200`),
    check(
      "promotional_slide_image_url_ck",
      sql`char_length(image_url) <= 2048 AND image_url LIKE 'https://%'`,
    ),
    check(
      "promotional_slide_image_dimensions_ck",
      sql`image_width_px BETWEEN 1 AND 8192 AND image_height_px BETWEEN 1 AND 8192`,
    ),
    check(
      "promotional_slide_window_ck",
      sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`,
    ),
    /**
     * THE OPEN-REDIRECT BACKSTOP.
     *
     * `//evil.tld/x` starts with "/" and IS an open redirect, so the internal arm has to
     * refuse a doubled leading slash explicitly. The fine-grained parse lives in
     * `src/modules/home/promotions/promotional-destination.ts` where it can return a useful message; this
     * check exists so the bad row stays UNREPRESENTABLE even if a future code path
     * skips the service.
     *
     * Written with no apostrophe inside the character class on purpose — quote-doubling
     * inside a `sql` template is how you get a migration that generates but won't apply.
     */
    check(
      "promotional_slide_destination_ck",
      sql`(destination_kind = 'internal_path'
             AND char_length(destination_value) BETWEEN 1 AND 512
             AND destination_value LIKE '/%'
             AND destination_value NOT LIKE '//%'
             AND destination_value !~ '[[:space:][:cntrl:]]')
          OR (destination_kind = 'external_url'
             AND char_length(destination_value) BETWEEN 1 AND 2048
             AND destination_value LIKE 'https://%'
             AND destination_value !~ '[[:space:][:cntrl:]]')`,
    ),
  ],
);

export const promotionalSlideRelations = relations(promotionalSlide, ({ one }) => ({
  createdBy: one(user, { fields: [promotionalSlide.createdByUserId], references: [user.id] }),
  updatedBy: one(user, { fields: [promotionalSlide.updatedByUserId], references: [user.id] }),
}));

// ---------------------------------------------------------------------------
// Spotlight — the three-video rail on the home feed below the category tiles.
//
// PLATFORM-AUTHORED, like `promotional_slide`. No member owner; the gate is
// `manage_promotions` (same front-page placement blast radius as the carousel). The
// only write is a whole-set replace of 0..3 video ids — there is no per-slot CRUD,
// because a partial list would silently drop a slot the admin had not seen.
//
// Thumbnails and titles are NOT stored here. They are joined from `video` at read
// time, so an admin never uploads a second creative for a video that already has one.
// ---------------------------------------------------------------------------

export const feedSpotlightSlot = pgTable(
  "feed_spotlight_slot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * 0-based display order: 0 = left, 1 = center, 2 = right. Contiguous after every
     * replace. UNIQUE — two rows sharing a position would make the rail order undefined.
     */
    position: integer("position").notNull(),
    /**
     * The catalogue video shown in this slot. Cascade: deleting the video must not leave
     * a dangling homepage placement pointing at a 404.
     */
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("feed_spotlight_slot_position_uidx").on(table.position),
    uniqueIndex("feed_spotlight_slot_video_uidx").on(table.videoId),
    check("feed_spotlight_slot_position_ck", sql`position >= 0 AND position <= 2`),
  ],
);

export const feedSpotlightSlotRelations = relations(feedSpotlightSlot, ({ one }) => ({
  video: one(video, { fields: [feedSpotlightSlot.videoId], references: [video.id] }),
  updatedBy: one(user, {
    fields: [feedSpotlightSlot.updatedByUserId],
    references: [user.id],
  }),
}));

// ---------------------------------------------------------------------------
// The /anime hero carousel — `anime_hero_slide`.
//
// PLATFORM-AUTHORED, like `promotional_slide` and `feed_spotlight_slot`. No member
// owner; the gate is `manage_promotions`, the same grant the other two front-page
// placements use. Reusing it is deliberate: this is the same staff act with the same
// blast radius, and a fourth admin-only capability for it would be role ceremony.
//
// WHY ITS OWN TABLE AND NOT A `placement` COLUMN ON `promotional_slide`. Two
// differences, and both are structural rather than cosmetic:
//
//   1. THIS SURFACE IS INTERNAL-ONLY. A promotional slide carries
//      `destination_kind ∈ {internal_path, external_url}` because an advertiser link
//      is supposed to leave the site. A Blueprints hero slide points at a page in this
//      app or at nothing at all. Folding the two together would put an
//      external-URL arm one boolean away from a content surface.
//   2. NO INTRINSIC DIMENSIONS. The promo carousel is `object-contain` inside a
//      fixed-height band, so it needs the asset's width and height to avoid a layout
//      shift. This one renders `fill`/`object-cover` inside a fixed `aspect-video`
//      box, so the aspect ratio is the container's and the columns would be dead
//      weight that every write has to populate.
//
// One shared table would therefore mean two validation regimes, two renderers and
// two meanings for the same columns behind a single discriminator.
// ---------------------------------------------------------------------------

export const animeHeroSlide = pgTable(
  "anime_hero_slide",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * Either a Cloudinary `secure_url` from an admin upload, or a SITE-RELATIVE path
     * for the rows seeded with this table.
     *
     * THE RELATIVE ARM IS NOT A LOOPHOLE, it is the only honest way to seed. A
     * migration cannot upload to Cloudinary, and the alternative — a hardcoded
     * fallback slide inside the component when the list comes back empty — is a mock
     * fallback on a wired surface, which this repo forbids. Seeded rows are real rows
     * an admin can edit, reorder or delete like any other.
     *
     * Store what Cloudinary returned; never reconstruct it from the public id. The
     * `/v<timestamp>/` segment changes on every overwrite, and that segment is exactly
     * what busts the browser cache when an image is replaced in place.
     */
    imageUrl: text("image_url").notNull(),
    /**
     * The overlay caption, AND the image's alt text — one field, two uses.
     *
     * The mock this replaces already did exactly that (`alt={hero.title}`), and the
     * title names the show, which is what a screen reader needs from a link whose only
     * content is an image. A separate `alt_text` column would be a second thing to
     * fill in on every slide for a distinction nobody making these slides would draw.
     */
    title: text("title").notNull(),
    /**
     * Where the slide sends the visitor, or NULL for a decorative slide.
     *
     * NULLABLE ON PURPOSE. `store_hero_slide` already models a slide with no link, and
     * `HeroCarousel.slideHref()` already returns null for one. It is also what lets the
     * seeded rows exist before any anime series does — the alternative would be seeding
     * them with a link to a page that 404s.
     */
    destinationPath: text("destination_path"),
    /**
     * 0-based display order; slide 0 shows first. Contiguous, re-packed on delete —
     * the same contract as `promotional_slide.position`. NO UNIQUE INDEX, for the same
     * reason: a reorder rewrites every row inside one transaction and a
     * non-deferrable UNIQUE would fire mid-loop.
     */
    position: integer("position").notNull(),
    /** The retirement switch. The row survives; the public read stops offering it. */
    isActive: boolean("is_active").default(true).notNull(),
    /** NULL on either side = unbounded in that direction. Absolute instants, UTC. */
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    /**
     * `set null`, not `restrict`: the authoritative accountability record is the
     * platform audit chain, and `restrict` would let one hero slide block a staff
     * account deletion forever.
     */
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The public read — live slides in order. Partial, because that is what almost
    // every read wants.
    index("anime_hero_slide_live_idx")
      .on(table.position, table.id)
      .where(sql`is_active`),
    // The admin read, which includes retired and out-of-window rows.
    index("anime_hero_slide_position_idx").on(table.position, table.id),

    check("anime_hero_slide_position_ck", sql`position >= 0`),
    check("anime_hero_slide_title_ck", sql`char_length(title) BETWEEN 1 AND 160`),
    /**
     * `https://` for an uploaded asset, or a site-relative path for a seeded one.
     *
     * The doubled-slash refusal is the same open-redirect backstop
     * `promotional_slide_destination_ck` applies to its internal arm: `//evil.tld/x`
     * starts with "/" and is a protocol-relative URL that leaves the site. It matters
     * here too, because this value becomes a `next/image` src on a public page.
     */
    check(
      "anime_hero_slide_image_url_ck",
      sql`char_length(image_url) BETWEEN 1 AND 2048
          AND image_url !~ '[[:space:][:cntrl:]]'
          AND (image_url LIKE 'https://%'
               OR (image_url LIKE '/%' AND image_url NOT LIKE '//%'))`,
    ),
    /** Same rule, minus the https arm — this surface never links off-site. */
    check(
      "anime_hero_slide_destination_ck",
      sql`destination_path IS NULL
          OR (char_length(destination_path) BETWEEN 1 AND 512
              AND destination_path LIKE '/%'
              AND destination_path NOT LIKE '//%'
              AND destination_path !~ '[[:space:][:cntrl:]]')`,
    ),
    check(
      "anime_hero_slide_window_ck",
      sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`,
    ),
  ],
);

export const animeHeroSlideRelations = relations(animeHeroSlide, ({ one }) => ({
  createdBy: one(user, { fields: [animeHeroSlide.createdByUserId], references: [user.id] }),
  updatedBy: one(user, { fields: [animeHeroSlide.updatedByUserId], references: [user.id] }),
}));

// ---------------------------------------------------------------------------
// BLUEPRINTS — showcase launches (`/blueprints/showcase`), frontend todo.md "Posting a launch" 2b.
//
// THE FIRST BLUEPRINTS CONTENT TABLE. Until this, `anime_hero_slide` was the whole server-side
// surface; teardowns, launches and case studies were all frontend fixtures.
//
// ⚠️ TWO ENUMS SHARED BY EVERY BLUEPRINT KIND, NOT ONE PER TABLE. `blueprint_moderation_state`
// carries all seven labels the frontend's `BLUEPRINT_MODERATION_STATES` byte-matches, although a
// launch can reach only three of them today (see `showcase_launch_moderation_state_ck`). Case
// studies and teardowns will reuse both enums, and there is a hard reason not to grow a
// per-table enum later: Postgres refuses a label added by `ALTER TYPE … ADD VALUE` inside the
// same transaction that uses it, and `db:migrate` applies a batch in one transaction. Widening a
// CHECK is a drop-and-add of one constraint. `draft` is never stored — a draft lives in the
// browser — and is in the enum only so the label set matches the contract.
//
// ⚠️ ONE UNIQUE SLUG PER TABLE, NO CROSS-KIND REGISTRY. A launch's address is
// `/blueprints/showcase/<slug>`; a teardown's is `/blueprints/teardowns/<slug>`. Nothing needs a
// slug to be unique across kinds — `/blueprints/[slug]` on the frontend only redirects the old
// flat URLs of fixtures.
//
// ⚠️ EVERY TIMESTAMP HERE IS precision 3. The review queue pages on `(created_at, id)`, and a
// cursor carries a JavaScript millisecond; a microsecond column would never compare equal to it.
// ---------------------------------------------------------------------------

export const BLUEPRINT_MODERATION_STATES = [
  "draft",
  "pending_review",
  "published",
  "rejected",
  "flagged",
  "quarantined",
  "removed",
] as const;

export const blueprintModerationStateEnum = pgEnum(
  "blueprint_moderation_state",
  BLUEPRINT_MODERATION_STATES,
);

/** Byte-matches the frontend's `BLUEPRINT_DIFFICULTIES`. */
export const blueprintDifficultyEnum = pgEnum("blueprint_difficulty", [
  "beginner",
  "intermediate",
  "advanced",
]);

/** Slugs a launch may never take, because a literal route already sits at that address. */
export const SHOWCASE_LAUNCH_RESERVED_SLUGS = ["new", "mine", "write-up-images"] as const;

export const showcaseLaunch = pgTable(
  "showcase_launch",
  {
    /** Minted by the service BEFORE the heading image uploads, because the asset path uses it. */
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** `cascade`: deleting an account deletes its launches (owner decision, todo.md 2b). */
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /**
     * The name as the uniqueness rule sees it: trimmed, internal whitespace collapsed, lowercased.
     *
     * `[[:space:]]` rather than `\s`, which would have to survive two layers of escaping (a TS
     * template and a SQL string) to reach the regex engine intact. The service's duplicate
     * pre-check runs this SAME expression in SQL, never a JavaScript copy of it.
     */
    titleNormalized: text("title_normalized").generatedAlwaysAs(
      sql`lower(regexp_replace(btrim(title), '[[:space:]]+', ' ', 'g'))`,
    ),
    tagline: text("tagline").notNull(),
    summary: text("summary").notNull(),
    /** GitHub-style Markdown. NULL when the maker wrote none; never an empty string. */
    writeUp: text("write_up"),
    /** Chosen by the maker, at most a few minutes ahead of the server clock. */
    launchedAt: timestamp("launched_at", { precision: 3 }).notNull(),
    difficulty: blueprintDifficultyEnum("difficulty").notNull(),
    /** Integer cents. All three cost columns are NULL together — half a range is no answer. */
    billOfMaterialsMinimumCents: integer("bill_of_materials_minimum_cents"),
    billOfMaterialsMaximumCents: integer("bill_of_materials_maximum_cents"),
    billOfMaterialsCurrency: text("bill_of_materials_currency"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * FREE TEXT WITH A SLUG SHAPE, NO FOREIGN KEY. It names a teardown, and there is no teardown
     * table yet — the "Built from a teardown" select still lists frontend fixtures. A foreign key
     * would refuse every pick; an existence check would too.
     */
    builtFromBlueprintSlug: text("built_from_blueprint_slug"),
    /** The launch's one outbound link. NULL together. */
    callToActionLabel: text("call_to_action_label"),
    callToActionUrl: text("call_to_action_url"),
    /** The two statements the maker ticked. Kept because the moderator reads them. */
    acceptedLaunchStatementIds: text("accepted_launch_statement_ids").array().notNull(),
    /** Cloudinary `secure_url` as returned — never rebuilt from the public id. */
    headingImageUrl: text("heading_image_url").notNull(),
    headingImagePublicId: text("heading_image_public_id").notNull().unique(),
    moderationState: blueprintModerationStateEnum("moderation_state")
      .default("pending_review")
      .notNull(),
    /** `restrict`: a moderation decision is attributable for as long as the launch exists. */
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at", { precision: 3 }),
    /** What the moderator told the maker. Required for a rejection. */
    moderatorNote: text("moderator_note"),
    /** Minted when a moderator publishes, and not before. */
    publicSlug: text("public_slug").unique(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    /**
     * A NAME IS TAKEN WHILE IT IS IN REVIEW OR LIVE, NOT AFTER A REJECTION — so a maker who was
     * sent back can post again under the same name.
     */
    uniqueIndex("showcase_launch_title_live_uidx")
      .on(table.titleNormalized)
      .where(sql`moderation_state IN ('pending_review', 'published')`),
    // My Launches, newest first.
    index("showcase_launch_author_idx").on(table.authorUserId, table.createdAt, table.id),
    // The review queue, oldest first. Partial, because a decided launch never re-enters it.
    index("showcase_launch_review_queue_idx")
      .on(table.createdAt, table.id)
      .where(sql`moderation_state = 'pending_review'`),
    /*
     * THE PUBLIC FEED'S `newest` PAGE, and the column DIRECTIONS are the whole point.
     *
     * That keyset is `launched_at DESC, id ASC` — MIXED, unlike every other cursor in this
     * codebase, because the frontend's comparator breaks ties on `id` ascending. Postgres will only
     * walk an index for an ORDER BY whose directions match it pair for pair, so a plain
     * `(launched_at, id)` index would be ignored and the feed would sort in memory.
     *
     * Partial on `published`: nothing else is ever public, and keeping drafts and rejected rows out
     * keeps the index the size of the readable set rather than the size of the table.
     *
     * The `top` page has no index here on purpose — its leading key is `upvote_count`, which lives
     * in `showcase_launch_stats`, and no single index spans two tables.
     */
    index("showcase_launch_public_newest_idx")
      .on(desc(table.launchedAt), table.id)
      .where(sql`moderation_state = 'published'`),

    check(
      "showcase_launch_moderation_state_ck",
      sql`moderation_state IN ('pending_review', 'published', 'rejected')`,
    ),
    check(
      "showcase_launch_text_lengths_ck",
      sql`char_length(title) BETWEEN 8 AND 120
          AND char_length(tagline) BETWEEN 10 AND 80
          AND char_length(summary) BETWEEN 40 AND 1000
          AND (write_up IS NULL OR char_length(write_up) BETWEEN 1 AND 10000)`,
    ),
    check("showcase_launch_tags_ck", sql`cardinality(tags) <= 10`),
    check(
      "showcase_launch_cost_range_ck",
      sql`(bill_of_materials_minimum_cents IS NULL
           AND bill_of_materials_maximum_cents IS NULL
           AND bill_of_materials_currency IS NULL)
          OR (bill_of_materials_minimum_cents IS NOT NULL
              AND bill_of_materials_maximum_cents IS NOT NULL
              AND bill_of_materials_currency IS NOT NULL
              AND bill_of_materials_currency = 'USD'
              AND bill_of_materials_minimum_cents >= 0
              AND bill_of_materials_maximum_cents >= bill_of_materials_minimum_cents
              AND bill_of_materials_maximum_cents <= 100000000)`,
    ),
    check(
      "showcase_launch_call_to_action_ck",
      sql`(call_to_action_label IS NULL AND call_to_action_url IS NULL)
          OR (char_length(call_to_action_label) BETWEEN 1 AND 40
              AND char_length(call_to_action_url) BETWEEN 1 AND 2048
              AND call_to_action_url LIKE 'https://%'
              AND call_to_action_url !~ '[[:space:][:cntrl:]]')`,
    ),
    check(
      "showcase_launch_built_from_slug_ck",
      sql`built_from_blueprint_slug IS NULL
          OR (char_length(built_from_blueprint_slug) BETWEEN 3 AND 120
              AND built_from_blueprint_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')`,
    ),
    check(
      "showcase_launch_heading_image_url_ck",
      sql`char_length(heading_image_url) BETWEEN 1 AND 2048
          AND heading_image_url LIKE 'https://%'
          AND heading_image_url !~ '[[:space:][:cntrl:]]'`,
    ),
    check(
      "showcase_launch_statements_ck",
      sql`accepted_launch_statement_ids @> ARRAY['built_it_ourselves', 'results_are_our_own']::text[]
          AND cardinality(accepted_launch_statement_ids) = 2`,
    ),
    /**
     * THE DECISION COLUMNS MOVE TOGETHER. A launch in review has no reviewer, no decision time and
     * no note; a decided one has a reviewer and a time; a rejection carries its reason; and a
     * launch has a public address exactly when it is published.
     */
    check(
      "showcase_launch_decision_ck",
      sql`(moderation_state = 'pending_review') = (reviewed_at IS NULL)
          AND (reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
          AND (moderation_state <> 'pending_review' OR moderator_note IS NULL)
          AND (moderation_state <> 'rejected' OR moderator_note IS NOT NULL)
          AND (moderation_state = 'published') = (public_slug IS NOT NULL)`,
    ),
    check(
      "showcase_launch_moderator_note_ck",
      sql`moderator_note IS NULL OR char_length(moderator_note) BETWEEN 1 AND 2000`,
    ),
    check(
      "showcase_launch_public_slug_ck",
      sql`public_slug IS NULL
          OR (char_length(public_slug) BETWEEN 3 AND 120
              AND public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND public_slug NOT IN ('new', 'mine', 'write-up-images'))`,
    ),
  ],
);

/**
 * One person on a launch, as the maker typed them.
 *
 * FREE TEXT, NOT AN ACCOUNT LINK. Handles are not verified, and the moderator card says so. A
 * nullable `user_id` and a verified badge are deferred (todo.md 2b, "Still open").
 */
export const showcaseLaunchTeamMember = pgTable(
  "showcase_launch_team_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    launchId: text("launch_id")
      .notNull()
      .references(() => showcaseLaunch.id, { onDelete: "cascade" }),
    /** 0-based, in the order the maker listed them. */
    position: integer("position").notNull(),
    displayName: text("display_name").notNull(),
    handle: text("handle").notNull(),
    /**
     * `lower()` equals JavaScript's `toLowerCase()` here only because the handle CHECK admits
     * ASCII alone — the same reason the request schema's duplicate rule and this index agree.
     */
    handleNormalized: text("handle_normalized").generatedAlwaysAs(sql`lower(handle)`),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("showcase_launch_team_member_position_uidx").on(table.launchId, table.position),
    uniqueIndex("showcase_launch_team_member_handle_uidx").on(
      table.launchId,
      table.handleNormalized,
    ),
    check("showcase_launch_team_member_position_ck", sql`position BETWEEN 0 AND 11`),
    check(
      "showcase_launch_team_member_text_ck",
      sql`char_length(display_name) BETWEEN 1 AND 80
          AND char_length(role) BETWEEN 1 AND 60
          AND char_length(handle) BETWEEN 1 AND 64
          AND handle ~ '^[A-Za-z0-9_.-]+$'`,
    ),
  ],
);

/**
 * One image a maker uploaded for a write-up.
 *
 * ⚠️ `launch_id` IS NULL UNTIL A LAUNCH CLAIMS IT, and that is the design, not a gap. The form
 * uploads an image the moment it is added to the write-up, which is before any launch exists, so
 * the row is created unclaimed and the submit transaction sets `launch_id` for every image the
 * write-up references. An image nobody claims within 24 hours is deleted by
 * `sweep-orphan-showcase-images`, row and asset.
 *
 * THE SIZE IS THE SERVER'S. `width_px` and `height_px` are read from sharp's re-encoded output,
 * never from the client, and the frontend reserves each image's box from them so nothing below it
 * moves as it loads.
 */
export const showcaseLaunchWriteUpImage = pgTable(
  "showcase_launch_write_up_image",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    launchId: text("launch_id").references(() => showcaseLaunch.id, { onDelete: "cascade" }),
    uploadedByUserId: text("uploaded_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Stored so a delete never has to rebuild it. */
    publicId: text("public_id").notNull().unique(),
    url: text("url").notNull().unique(),
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    /** A 16px WebP as a base64 data URL, painted in the reserved box until the file loads. */
    blurDataUrl: text("blur_data_url").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    index("showcase_launch_write_up_image_launch_idx").on(table.launchId),
    // The staging cap and the sweeper both ask "which of this maker's uploads are unclaimed".
    index("showcase_launch_write_up_image_unclaimed_idx")
      .on(table.uploadedByUserId, table.createdAt)
      .where(sql`launch_id IS NULL`),
    check(
      "showcase_launch_write_up_image_dimensions_ck",
      sql`width_px BETWEEN 1 AND 8192 AND height_px BETWEEN 1 AND 8192`,
    ),
    check(
      "showcase_launch_write_up_image_url_ck",
      sql`char_length(url) BETWEEN 1 AND 2048
          AND url LIKE 'https://%'
          AND url !~ '[[:space:][:cntrl:]]'`,
    ),
    /**
     * THE SAME PATTERN THE FRONTEND ENFORCES ON READ, because `next/image` writes this value into
     * an inline CSS `url()`. Anything but a base64 image data URL there is an injection.
     *
     * ⚠️ NO LITERAL SEMICOLON IN THIS EXPRESSION, and `chr(59)` is why it reads oddly. drizzle-kit
     * cuts a CHECK body at its first `;` when it writes the migration, so the natural
     * `~ '^data:image/webp;base64,…'` generated a truncated, unterminated statement. The prefix is
     * compared as text (23 characters) and only the base64 tail goes through the regex.
     */
    check(
      "showcase_launch_write_up_image_blur_ck",
      sql`char_length(blur_data_url) <= 2048
          AND left(blur_data_url, 23) = ('data:image/webp' || chr(59) || 'base64,')
          AND substr(blur_data_url, 24) ~ '^[A-Za-z0-9+/]+={0,2}$'`,
    ),
  ],
);

/**
 * Denormalised counters for one published launch — a read cache, never a source of truth.
 *
 * WHY A SIDECAR RATHER THAN COLUMNS ON `showcase_launch`. Same reason as `video_stats`: a counter
 * moves on a different cadence from the row it counts, and a launch row is append-mostly after
 * moderation. Keeping them apart means a view never contends with an edit.
 *
 * ⚠️ THESE COUNTERS HAVE NO SOURCE OF TRUTH YET, and that is the one way this differs from
 * `video_stats`. There is no vote table, no like table and no comment table, because the frontend
 * offers none of those controls — its vote box is deliberately a `<span>` rather than a `<button>`.
 * So every counter here reads 0 through `coalesce`, and 0 is TRUE rather than a placeholder. When
 * the write routes land they bring their own source tables and reconcile into this one.
 *
 * NO ROWS ARE WRITTEN ON PUBLISH. Every read left-joins and coalesces, exactly as the video reads
 * do, so a launch with no row and a launch with a row of zeroes are the same answer. That also
 * keeps `publishUnderFreeSlug` — a savepoint-retry transaction that is correct today — out of this.
 *
 * NO `save_count`. Saving is on the TEARDOWN arm of the frontend's contract, not the showcase one,
 * and a column nothing renders is the unverified code the field sweep exists to catch.
 *
 * `integer`, NOT `bigint`, on all four. node-postgres hands `int8` back as a STRING, so a bigint
 * behind a `sql<number>` projection would be a type that lies about its own value.
 */
export const showcaseLaunchStats = pgTable(
  "showcase_launch_stats",
  {
    launchId: text("launch_id")
      .primaryKey()
      .references(() => showcaseLaunch.id, { onDelete: "cascade" }),
    viewCount: integer("view_count").default(0).notNull(),
    likeCount: integer("like_count").default(0).notNull(),
    upvoteCount: integer("upvote_count").default(0).notNull(),
    commentCount: integer("comment_count").default(0).notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    // The `top` page's leading key. `launch_id` rides along so the tie-break is covered too.
    index("showcase_launch_stats_top_idx").on(desc(table.upvoteCount), table.launchId),
    check(
      "showcase_launch_stats_nonnegative_ck",
      sql`view_count >= 0 AND like_count >= 0 AND upvote_count >= 0 AND comment_count >= 0`,
    ),
  ],
);

export const showcaseLaunchStatsRelations = relations(showcaseLaunchStats, ({ one }) => ({
  launch: one(showcaseLaunch, {
    fields: [showcaseLaunchStats.launchId],
    references: [showcaseLaunch.id],
  }),
}));

export const showcaseLaunchRelations = relations(showcaseLaunch, ({ one, many }) => ({
  author: one(user, { fields: [showcaseLaunch.authorUserId], references: [user.id] }),
  reviewedBy: one(user, { fields: [showcaseLaunch.reviewedByUserId], references: [user.id] }),
  teamMembers: many(showcaseLaunchTeamMember),
  writeUpImages: many(showcaseLaunchWriteUpImage),
  stats: one(showcaseLaunchStats, {
    fields: [showcaseLaunch.id],
    references: [showcaseLaunchStats.launchId],
  }),
}));

export const showcaseLaunchTeamMemberRelations = relations(showcaseLaunchTeamMember, ({ one }) => ({
  launch: one(showcaseLaunch, {
    fields: [showcaseLaunchTeamMember.launchId],
    references: [showcaseLaunch.id],
  }),
}));

export const showcaseLaunchWriteUpImageRelations = relations(
  showcaseLaunchWriteUpImage,
  ({ one }) => ({
    launch: one(showcaseLaunch, {
      fields: [showcaseLaunchWriteUpImage.launchId],
      references: [showcaseLaunch.id],
    }),
    uploadedBy: one(user, {
      fields: [showcaseLaunchWriteUpImage.uploadedByUserId],
      references: [user.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// WATCH TIME AND ACTIVITY ROLLUPS (§3.3a)
// ---------------------------------------------------------------------------
//
// THREE TABLES, TWO GRAINS, AND ONE REASON THEY EXIST AT ALL.
//
// `video_view_session` already carries real, server-clamped watch seconds — but one row per
// (video, fingerprint, UTC DAY), and every row is DELETED at 90 days by `prune-engagement-data`.
// So the data that would answer "how long have I watched this year" is destroyed a quarter of the
// way into the year, and the data that would answer "what hour of the day is this platform busy"
// never existed: a session row spans a whole day, so attributing its seconds to the hour of its
// last beacon would put a three-hour evening sitting into one bucket. That histogram would not be
// missing. It would be WRONG, and plausibly so, which is worse.
//
// `commerce_product_daily_signal` is the precedent and its header makes this exact argument for
// products: a series whose history is pruned on the schedule its sibling uses leaves a detector
// "shipped, wired, and silently returning nothing".

/**
 * The write-side counter, incremented as beacons arrive. Per user, per UTC date, per UTC hour.
 *
 * PER-USER ROWS RATHER THAN A PLATFORM COUNTER, ON PURPOSE. Twenty-four platform-wide rows
 * incremented by every beacon on the site is a lock hotspot on the hottest write path there is;
 * per-user rows spread that contention across the active population, and they are also the grain
 * the "who has gone quiet" segment needs. The 24-row aggregate is DERIVED from these nightly
 * (`platform_activity_hour_daily` below), which is the cheap direction to compute in.
 *
 * SIGNED-IN ONLY. `recordViewBeacon` writes here only when the session carries a `viewer_id` — the
 * same §8.1 Rule 2 gate that keeps anonymous watch time out of `completion_bp_sum`. A fingerprint
 * is a per-day bucket key over an IP and a user agent, so an hour-by-hour profile keyed on one
 * would be a profile of a coffee shop rather than a person. The user-visible consequence has to be
 * stated wherever this is displayed: watching signed out does not count toward your time watched.
 *
 * RETENTION: 90 DAYS, deliberately equal to `VIEW_SESSION_RETENTION_DAYS`. This is the most
 * granular behavioural record on the platform and it must not outlive the sessions it was derived
 * from. The thing that survives 25 months is the aggregate, not this.
 */
export const userActivityHour = pgTable(
  "user_activity_hour",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * The UTC date, derived from the SERVER clock in the same breath as the hour below — never
     * from the request body. Same rule and same reason as `video_view_session.view_day_bucket`:
     * this is the hostile side of the wire.
     */
    activityDate: date("activity_date", { mode: "string" }).notNull(),
    /** 0..23 UTC. Bounded by CHECK because an out-of-range hour is a bug upstream, not a datum. */
    activityHour: integer("activity_hour").notNull(),
    /**
     * The CLAMPED credit from `applyViewBeacon`, never `positionSeconds`. The clamp caps each
     * beacon at `min(elapsed + 5, 20)` seconds, and it is the only thing between this column and a
     * client claiming eight hours a minute.
     */
    watchedSeconds: integer("watched_seconds").default(0).notNull(),
    /**
     * How many beacons landed in the hour. Kept because it separates "watched 900 seconds" from
     * "sent 60 beacons that each credited nothing" — the second is a stalled tab, not attention.
     */
    beaconCount: integer("beacon_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "user_activity_hour_pk",
      columns: [table.userId, table.activityDate, table.activityHour],
    }),
    // The nightly rollup scans a whole DAY across all users, and the per-user histogram reads one
    // user's recent days. Date-first serves the first; the PK already serves the second.
    index("user_activity_hour_date_idx").on(table.activityDate, table.activityHour),
    check(
      "user_activity_hour_bounds_ck",
      sql`activity_hour BETWEEN 0 AND 23
          AND watched_seconds >= 0
          AND beacon_count >= 0`,
    ),
  ],
);

/**
 * The retained per-user daily series. One row per user per UTC day they watched anything.
 *
 * THIS IS THE ONLY TABLE THAT CAN ANSWER "THIS YEAR", and the only long-lived per-person
 * behavioural record on the platform. Both facts are why its retention is bounded at 25 months
 * rather than kept forever: two years plus a month is enough for a year-over-year comparison and a
 * 24-month cohort grid, and "we keep a daily record of your viewing indefinitely" is a sentence
 * that has to be defended rather than assumed.
 *
 * NOTHING WRITES A ZERO ROW. A user with no row for a day did not watch that day, and the absence
 * is the answer; a stored zero would be indistinguishable from a day the rollup failed to run.
 * The read side must return `null` rather than `0` for a user with no rows at all.
 */
export const userWatchDaily = pgTable(
  "user_watch_daily",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    watchDate: date("watch_date", { mode: "string" }).notNull(),
    watchedSeconds: integer("watched_seconds").default(0).notNull(),
    countedViewCount: integer("counted_view_count").default(0).notNull(),
    /**
     * How many DISTINCT videos, which `user_activity_hour` cannot answer — it counts seconds, not
     * subjects. Sourced from `video_view_session` for the same (viewer, day), and therefore the
     * one column in this table that goes stale rather than wrong once those rows are pruned at 90
     * days: it was computed while they existed and is never recomputed after.
     */
    distinctVideoCount: integer("distinct_video_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "user_watch_daily_pk", columns: [table.userId, table.watchDate] }),
    // "This user's last N days", the shape every user-facing read has.
    index("user_watch_daily_recent_idx").on(table.userId, table.watchDate.desc()),
    // "Everyone active between two dates" — DAU/WAU/MAU, churn and the cohort grid all scan this
    // way, date first, and none of them names a user.
    index("user_watch_daily_date_idx").on(table.watchDate, table.userId),
    check(
      "user_watch_daily_bounds_ck",
      sql`watched_seconds >= 0 AND counted_view_count >= 0 AND distinct_video_count >= 0`,
    ),
  ],
);

/**
 * The platform hour-of-day series. Twenty-four rows a day, ~18k rows over 25 months.
 *
 * CARRIES NO USER ID, which makes it the one thing in this block that survives 25 months without
 * being personal data. It is folded from `user_activity_hour` by the same nightly job that writes
 * `user_watch_daily` — one scan, two outputs, the argument `recompute-user-affinities` already
 * makes for not splitting topic and creator affinity into two jobs over the same rows.
 */
export const platformActivityHourDaily = pgTable(
  "platform_activity_hour_daily",
  {
    activityDate: date("activity_date", { mode: "string" }).notNull(),
    activityHour: integer("activity_hour").notNull(),
    /** DISTINCT users with any credited second in the hour — not a sum of anything. */
    activeUserCount: integer("active_user_count").default(0).notNull(),
    watchedSeconds: bigint("watched_seconds", { mode: "number" }).default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "platform_activity_hour_daily_pk",
      columns: [table.activityDate, table.activityHour],
    }),
    check(
      "platform_activity_hour_daily_bounds_ck",
      sql`activity_hour BETWEEN 0 AND 23
          AND active_user_count >= 0
          AND watched_seconds >= 0`,
    ),
  ],
);

export const userActivityHourRelations = relations(userActivityHour, ({ one }) => ({
  user: one(user, { fields: [userActivityHour.userId], references: [user.id] }),
}));

export const userWatchDailyRelations = relations(userWatchDaily, ({ one }) => ({
  user: one(user, { fields: [userWatchDaily.userId], references: [user.id] }),
}));

// ---------------------------------------------------------------------------
// BLUEPRINTS — TEARDOWNS (§home). The second blueprint kind, and the largest.
//
// ⚠️ A CLEAN-ROOM SURFACE. A teardown documents somebody else's shipped product, surveyed by the
// publisher. There is deliberately NO column here that could hold a vendor's own drawing, an
// internal document or NDA material: the absence is the guarantee. Do not add one.
//
// TWO SHARED ENUMS ARE REUSED, not redeclared — `blueprint_moderation_state` and
// `blueprint_difficulty` above, exactly as their header promised ("Case studies and teardowns will
// reuse both enums"). `video_source` comes from `studio.ts` for the same reason.
//
// THE SLUG IS ALWAYS PRESENT, which is the one place this departs from `showcase_launch`. A launch
// mints its address on publication, so its CHECK ties state and slug together. A teardown carries a
// slug from the moment it exists — a `pending_review` row has one — so the reading gates are
// computed from `moderation_state` alone and there is no decision CHECK here.
//
// THE ASSET URLS ARE SITE-RELATIVE-OR-HTTPS, not https-only. That is the frontend's own contract
// (`createHttpsOrSiteRelativeUrlSchema`), because a teardown's documents and models are served from
// this site. Only the two OUTBOUND links — a fastener's supplier and a licence — are https-only
// (`createExternalHttpsUrlSchema`). Protocol-relative values are refused in both cases.
// ---------------------------------------------------------------------------

/** Byte-matches the frontend's `BLUEPRINT_PROVENANCE_KINDS`. */
export const blueprintProvenanceKindEnum = pgEnum("blueprint_provenance_kind", [
  "licensed_open_source",
  "authorized_by_manufacturer",
  "community_reverse_engineered",
]);

/** Byte-matches `TEARDOWN_SUBJECT_KINDS`. Only the first is publishable — see the CHECK below. */
export const teardownSubjectKindEnum = pgEnum("teardown_subject_kind", [
  "existing_physical_product",
  "proposed_design",
]);

export const teardownUnitAcquisitionEnum = pgEnum("teardown_unit_acquisition", [
  "retail_purchase",
  "secondary_market",
  "manufacturer_supplied",
  "donated_unit",
]);

export const teardownSurveyMethodEnum = pgEnum("teardown_survey_method", [
  "dimensional_survey",
  "empirical_teardown",
  "material_spectroscopy",
]);

export const teardownMaterialClassEnum = pgEnum("teardown_material_class", [
  "metal_alloy",
  "polymer",
  "elastomer",
  "composite",
  "ceramic",
  "glass",
  "laminate",
  "semiconductor_package",
  "coating",
  "other",
]);

export const teardownDesignationSourceEnum = pgEnum("teardown_designation_source", [
  "measured_spectroscopy",
  "manufacturer_marking",
  "public_datasheet",
  "supplier_declared",
  "contributor_freetext",
]);

/**
 * How a composition figure was established.
 *
 * ⚠️ THE FIRST FOUR ARE MEASUREMENTS, the last two are not, and an `instrument_label` may only
 * accompany a measurement — see `teardown_material_element_instrument_ck`. A label beside
 * `declared_not_measured` would claim an instrument read a number nobody measured.
 */
export const teardownCompositionAnalysisMethodEnum = pgEnum(
  "teardown_composition_analysis_method",
  ["xrf", "oes", "eds", "icp_oes", "declared_not_measured", "synthetic_example"],
);

/** One enum, two columns: a part's `manufacturing_method` and a material's `process`. */
export const teardownManufacturingMethodEnum = pgEnum("teardown_manufacturing_method", [
  "cnc_milled",
  "injection_molded",
  "sheet_metal",
  "fdm_printed",
  "pcb_assembly",
  "cast",
  "off_the_shelf",
]);

export const teardownFastenerDriveEnum = pgEnum("teardown_fastener_drive", [
  "torx",
  "hex_socket",
  "phillips",
  "slotted",
  "adhesive",
  "snap_fit",
  "press_fit",
]);

export const blueprintDocumentKindEnum = pgEnum("blueprint_document_kind", [
  "schematic",
  "bill_of_materials",
  "assembly_guide",
  "datasheet",
]);

/**
 * Fabrication files.
 *
 * ⚠️ NEVER MERGED WITH `blueprint_document_kind`, which the contract argues at length: a schematic
 * is something a reader opens, a Gerber is something a fab consumes. Two arrays, two renderers.
 */
export const teardownManufacturingFileKindEnum = pgEnum("teardown_manufacturing_file_kind", [
  "step",
  "stl",
  "dxf",
  "gerber",
  "drill",
  "pick_and_place",
  "bill_of_materials_csv",
]);

/**
 * How a teardown's 3D view is assembled.
 *
 * `composite` is ONE model file whose named nodes are the parts; `individual_parts` is one file per
 * part. The two are structurally different and a row may not be half of each — see the composite
 * foreign key on `teardown_part`, which carries this discriminator down so a per-row CHECK can
 * close it without a trigger.
 */
export const teardownAssemblyKindEnum = pgEnum("teardown_assembly_kind", [
  "composite",
  "individual_parts",
]);

/**
 * The SQL fragment behind every in-site asset URL on this surface.
 *
 * ⚠️ `chr(92)` IS A BACKSLASH, and it is written that way for the same reason
 * `showcase_launch_write_up_image_blur_ck` writes `chr(59)`: drizzle-kit truncates a CHECK body at
 * the first literal it mishandles, and a `\` inside a generated migration is not worth the risk.
 *
 * Refuses protocol-relative values in both spellings. `//evil.tld` and `/\evil.tld` are read as
 * "same scheme, different host" by a browser, so a leading-slash test alone is not a same-site test.
 */
function assetUrlCheck(columnName: string) {
  return sql.raw(
    `char_length(${columnName}) BETWEEN 1 AND 2048
          AND ${columnName} !~ '[[:space:][:cntrl:]]'
          AND (${columnName} LIKE 'https://%'
               OR (left(${columnName}, 1) = '/'
                   AND left(${columnName}, 2) <> '//'
                   AND left(${columnName}, 2) <> ('/' || chr(92))))`,
  );
}

/** Outbound links — a supplier, a licence. https only; there is no same-site case for these. */
function externalUrlCheck(columnName: string) {
  return sql.raw(
    `char_length(${columnName}) BETWEEN 1 AND 2048
          AND ${columnName} !~ '[[:space:][:cntrl:]]'
          AND ${columnName} LIKE 'https://%'`,
  );
}

/**
 * One teardown: a survey of somebody else's shipped product.
 *
 * WIDE ON PURPOSE. Six blocks are inlined rather than given side tables — provenance, the
 * repairability index, the telemetry readings, the store class, the walkthrough video and the
 * bill-of-materials cost range. Each is 1:1 with the row and each, moved out, would make an illegal
 * state representable: a teardown with NO provenance (which the contract forbids outright), three
 * repairability criteria instead of four, five of six telemetry figures, a category slug with no
 * label. A side table would need a trigger to say what a CHECK says here for free. That is
 * CLAUDE.md §2's "make illegal states unrepresentable", not a preference about joins.
 *
 * THE COUNTERS ARE NOT HERE. They live in `teardown_stats`, on the `video_stats` precedent, because
 * a counter moves on a different cadence from the row it counts.
 *
 * THE AUTHOR IS DENORMALISED, and the reason is the privacy machinery rather than convenience.
 * Every foreign key into `user` must be named in `anonymization-manifest.ts`, and
 * `db:verify-anonymization-coverage` asks Postgres and exits non-zero if one is missing. A teardown
 * has no authoring path yet, so an `author_user_id` would mean minting credential-less accounts and
 * then carrying them through account closure, handle uniqueness and data export — to render a
 * byline. When authoring lands it adds `author_user_id` AND the manifest entry in the same commit,
 * or that script fails the build.
 */
export const teardown = pgTable(
  "teardown",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * The public address, `/blueprints/teardowns/<slug>`.
     *
     * PRESENT FROM THE START, unlike a launch's `public_slug`. A `pending_review` teardown has an
     * address; whether a reader may follow it is decided by `moderation_state` alone.
     */
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    thumbnailUrl: text("thumbnail_url").notNull(),

    authorDisplayName: text("author_display_name").notNull(),
    /** Nullable exactly as `user.handle` is — nothing guarantees a contributor has one. */
    authorHandle: text("author_handle"),
    authorAvatarUrl: text("author_avatar_url"),

    difficulty: blueprintDifficultyEnum("difficulty").notNull(),
    /** Free text, e.g. "STEP / Fusion 360". NULL when no CAD source was published. */
    cadFormat: text("cad_format"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * THE AUTHOR'S OWN TALLY, and deliberately unrelated to how many parts the model carries. The
     * solar controller says 148 while its assembly lists 9, because a model shows the parts worth
     * exploding rather than every screw. There is NO CHECK tying the two: 148 is not nine and must
     * not become nine.
     */
    partCount: integer("part_count"),
    subjectKind: teardownSubjectKindEnum("subject_kind").notNull(),
    moderationState: blueprintModerationStateEnum("moderation_state").notNull(),

    billOfMaterialsMinimumCents: integer("bill_of_materials_minimum_cents"),
    billOfMaterialsMaximumCents: integer("bill_of_materials_maximum_cents"),
    billOfMaterialsCurrency: text("bill_of_materials_currency"),

    // --- Provenance. NOT NULL as a block: a teardown with no stated origin may not exist. ---
    provenanceKind: blueprintProvenanceKindEnum("provenance_kind").notNull(),
    /** Somebody else's product name, as the publisher wrote it. */
    provenanceSubjectProductName: text("provenance_subject_product_name").notNull(),
    provenanceUnitAcquisition: teardownUnitAcquisitionEnum("provenance_unit_acquisition").notNull(),
    provenanceSurveyMethods: teardownSurveyMethodEnum("provenance_survey_methods")
      .array()
      .notNull(),
    /** When the unit was measured — which is not when the write-up was posted. */
    provenanceSurveyedAt: timestamp("provenance_surveyed_at", { precision: 3 }).notNull(),
    provenanceLicenceName: text("provenance_licence_name"),
    provenanceLicenceUrl: text("provenance_licence_url"),
    /**
     * The publisher's own words about a private permission. IT IS NOT A LICENCE and no renderer may
     * dress it as one — which is why it is a separate column from the licence pair rather than a
     * third variant of it.
     */
    provenanceAuthorizationNote: text("provenance_authorization_note"),
    /** That the attestation clauses were accepted. An attestation nobody can see is none. */
    provenanceAttestationAcceptedAt: timestamp("provenance_attestation_accepted_at", {
      precision: 3,
    }).notNull(),
    provenanceNotes: text("provenance_notes"),

    // --- Repairability index. All nine or none — half an index is not an index. ---
    repairabilityFastenerUniformityScore: integer("repairability_fastener_uniformity_score"),
    repairabilityFastenerUniformityNote: text("repairability_fastener_uniformity_note"),
    repairabilityToolAccessibilityScore: integer("repairability_tool_accessibility_score"),
    repairabilityToolAccessibilityNote: text("repairability_tool_accessibility_note"),
    repairabilityDisassemblyStepCountScore: integer("repairability_disassembly_step_count_score"),
    repairabilityDisassemblyStepCountNote: text("repairability_disassembly_step_count_note"),
    repairabilityModularIndependenceScore: integer("repairability_modular_independence_score"),
    repairabilityModularIndependenceNote: text("repairability_modular_independence_note"),
    /**
     * STORED, NEVER AVERAGED from the four criteria. They are not equally weighted, and the
     * weighting is an editorial decision the publisher owns.
     */
    repairabilityOverallScore: integer("repairability_overall_score"),

    // --- Simulation telemetry. Author-reported measurements; no solver exists on either side. ---
    telemetryFactorOfSafety: doublePrecision("telemetry_factor_of_safety"),
    telemetryPeakVonMisesStressMegapascals: doublePrecision(
      "telemetry_peak_von_mises_stress_megapascals",
    ),
    telemetryMaxDisplacementMicrometres: integer("telemetry_max_displacement_micrometres"),
    /** SIGNED — a thermal delta can be a drop. */
    telemetryThermalDeltaKelvin: doublePrecision("telemetry_thermal_delta_kelvin"),
    telemetryRatedLoadNewtons: doublePrecision("telemetry_rated_load_newtons"),
    /**
     * Text with a CHECK rather than a one-label enum, because the contract calls this the first arm
     * of a future union: a `platform_simulated` arm would carry a run id and a mesh count this row
     * cannot. Widening a CHECK is a drop-and-add; widening an enum inside a migration batch is the
     * `ALTER TYPE … ADD VALUE` trap the blueprint header above records.
     */
    telemetrySource: text("telemetry_source"),

    // --- Where the surveyed product sits in the store. ---
    storeProductClassCategorySlug: text("store_product_class_category_slug"),
    /** STORED, not un-kebabbed from the slug — a heading is not a slug with dashes removed. */
    storeProductClassLabel: text("store_product_class_label"),

    // --- The walkthrough video, when somebody filmed it. ---
    walkthroughVideoSource: videoSourceEnum("walkthrough_video_source"),
    walkthroughYoutubeVideoId: text("walkthrough_youtube_video_id"),
    walkthroughPosterUrl: text("walkthrough_poster_url"),
    /**
     * NULLABLE INSIDE A PRESENT BLOCK. YouTube's oEmbed returns no duration and nothing on either
     * side of the wire can measure one, so a typed runtime would be a guess. NULL is the honest
     * value and the all-or-none CHECK below spans the other three fields only.
     */
    walkthroughDurationSeconds: integer("walkthrough_duration_seconds"),

    createdAt: timestamp("created_at", { precision: 3 }).notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    /*
     * THE PUBLIC INDEX'S PAGE, and the directions matter. The keyset is `created_at DESC, id ASC`,
     * mixed, because the frontend's comparator breaks ties on the id ascending and Postgres only
     * walks an index whose directions match pair for pair.
     *
     * Partial on the LIST gate, so the index and the predicate cannot drift apart.
     */
    index("teardown_public_newest_idx")
      .on(desc(table.createdAt), table.id)
      .where(sql`moderation_state IN ('published', 'flagged')`),

    /**
     * The four states a teardown can actually be in today. Narrower than the seven-label enum, in
     * the same way `showcase_launch_moderation_state_ck` narrows it to three — written from what
     * exists rather than from what the enum permits.
     */
    check(
      "teardown_moderation_state_ck",
      sql`moderation_state IN ('published', 'flagged', 'quarantined', 'pending_review')`,
    ),
    /**
     * Only an existing physical product is publishable. The enum keeps both labels because the
     * authoring wizard needs to name the one it refuses; the CHECK is the gate.
     */
    check("teardown_subject_kind_ck", sql`subject_kind = 'existing_physical_product'`),
    check(
      "teardown_slug_ck",
      sql`char_length(slug) BETWEEN 3 AND 120
          AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND slug NOT IN ('teardowns', 'showcase', 'case-studies', 'new', 'slugs', 'options')`,
    ),
    check(
      "teardown_text_lengths_ck",
      sql`char_length(title) BETWEEN 8 AND 160
          AND char_length(summary) BETWEEN 40 AND 2000
          AND (cad_format IS NULL OR char_length(cad_format) BETWEEN 1 AND 120)`,
    ),
    check("teardown_thumbnail_url_ck", assetUrlCheck("thumbnail_url")),
    check(
      "teardown_author_ck",
      sql`char_length(author_display_name) BETWEEN 1 AND 80
          AND (author_handle IS NULL
               OR (char_length(author_handle) BETWEEN 1 AND 64
                   AND author_handle ~ '^[A-Za-z0-9_.-]+$'))`,
    ),
    check(
      "teardown_author_avatar_url_ck",
      sql`author_avatar_url IS NULL OR (${assetUrlCheck("author_avatar_url")})`,
    ),
    check("teardown_tags_ck", sql`cardinality(tags) <= 12`),
    /** Never zero — a zero-part teardown is not a teardown. NULL means nobody counted. */
    check("teardown_part_count_ck", sql`part_count IS NULL OR part_count > 0`),
    check(
      "teardown_cost_range_ck",
      sql`(bill_of_materials_minimum_cents IS NULL
           AND bill_of_materials_maximum_cents IS NULL
           AND bill_of_materials_currency IS NULL)
          OR (bill_of_materials_minimum_cents IS NOT NULL
              AND bill_of_materials_maximum_cents IS NOT NULL
              AND bill_of_materials_currency IS NOT NULL
              AND bill_of_materials_currency = 'USD'
              AND bill_of_materials_minimum_cents >= 0
              AND bill_of_materials_maximum_cents >= bill_of_materials_minimum_cents
              AND bill_of_materials_maximum_cents <= 100000000)`,
    ),
    /**
     * THE PERMISSION TRUTH TABLE, all three arms enumerated rather than two tested and the
     * remainder let through.
     *
     * An open-source teardown carries a licence and no private note; an authorized one carries the
     * note and no licence; a reverse-engineered one carries neither, because there was no
     * permission to record. Each arm refuses BOTH the missing required field and the present
     * forbidden one.
     */
    check(
      "teardown_provenance_permission_ck",
      sql`(provenance_kind = 'licensed_open_source'
           AND provenance_licence_name IS NOT NULL
           AND provenance_licence_url IS NOT NULL
           AND provenance_authorization_note IS NULL)
          OR (provenance_kind = 'authorized_by_manufacturer'
              AND provenance_licence_name IS NULL
              AND provenance_licence_url IS NULL
              AND provenance_authorization_note IS NOT NULL)
          OR (provenance_kind = 'community_reverse_engineered'
              AND provenance_licence_name IS NULL
              AND provenance_licence_url IS NULL
              AND provenance_authorization_note IS NULL)`,
    ),
    check(
      "teardown_provenance_licence_url_ck",
      sql`provenance_licence_url IS NULL OR (${externalUrlCheck("provenance_licence_url")})`,
    ),
    /**
     * At least one survey method, at most one of each kind's worth.
     *
     * Distinctness is NOT here: a CHECK may not hold the subquery `SELECT DISTINCT unnest(...)`
     * needs, and the contract itself permits duplicates. The import schema normalises instead.
     */
    check(
      "teardown_provenance_survey_methods_ck",
      sql`cardinality(provenance_survey_methods) BETWEEN 1 AND 3`,
    ),
    /** Nine columns or none, and every score inside 0..10. */
    check(
      "teardown_repairability_ck",
      sql`(repairability_fastener_uniformity_score IS NULL
           AND repairability_fastener_uniformity_note IS NULL
           AND repairability_tool_accessibility_score IS NULL
           AND repairability_tool_accessibility_note IS NULL
           AND repairability_disassembly_step_count_score IS NULL
           AND repairability_disassembly_step_count_note IS NULL
           AND repairability_modular_independence_score IS NULL
           AND repairability_modular_independence_note IS NULL
           AND repairability_overall_score IS NULL)
          OR (repairability_fastener_uniformity_score IS NOT NULL
              AND repairability_fastener_uniformity_score BETWEEN 0 AND 10
              AND repairability_fastener_uniformity_note IS NOT NULL
              AND repairability_tool_accessibility_score IS NOT NULL
              AND repairability_tool_accessibility_score BETWEEN 0 AND 10
              AND repairability_tool_accessibility_note IS NOT NULL
              AND repairability_disassembly_step_count_score IS NOT NULL
              AND repairability_disassembly_step_count_score BETWEEN 0 AND 10
              AND repairability_disassembly_step_count_note IS NOT NULL
              AND repairability_modular_independence_score IS NOT NULL
              AND repairability_modular_independence_score BETWEEN 0 AND 10
              AND repairability_modular_independence_note IS NOT NULL
              AND repairability_overall_score IS NOT NULL
              AND repairability_overall_score BETWEEN 0 AND 10)`,
    ),
    /** Six figures or none. `thermal_delta_kelvin` is the only one allowed to be negative. */
    /**
     * ⚠️ EVERY ALL-OR-NONE ARM BELOW OPENS WITH `IS NOT NULL`, AND THAT IS NOT BELT-AND-BRACES.
     *
     * A CHECK passes on NULL, not just on true. `telemetry_source = 'author_reported'` is NULL when
     * the column is NULL, so an arm reading `five comparisons AND source = 'author_reported'`
     * evaluates to NULL for a row carrying five of the six figures — and `false OR NULL` is NULL,
     * which Postgres ACCEPTS. `pnpm db:verify-teardown-constraints` caught exactly that: five of six
     * telemetry figures was written and the constraint did not fire.
     *
     * The same hole was in eight sibling CHECKs across this file, including `showcase_launch`'s cost
     * range. Anywhere a nullable column is compared rather than tested for presence, the comparison
     * needs an `IS NOT NULL` beside it.
     */
    check(
      "teardown_telemetry_ck",
      sql`(telemetry_factor_of_safety IS NULL
           AND telemetry_peak_von_mises_stress_megapascals IS NULL
           AND telemetry_max_displacement_micrometres IS NULL
           AND telemetry_thermal_delta_kelvin IS NULL
           AND telemetry_rated_load_newtons IS NULL
           AND telemetry_source IS NULL)
          OR (telemetry_factor_of_safety IS NOT NULL
              AND telemetry_factor_of_safety > 0
              AND telemetry_peak_von_mises_stress_megapascals IS NOT NULL
              AND telemetry_peak_von_mises_stress_megapascals >= 0
              AND telemetry_max_displacement_micrometres IS NOT NULL
              AND telemetry_max_displacement_micrometres >= 0
              AND telemetry_thermal_delta_kelvin IS NOT NULL
              AND telemetry_rated_load_newtons IS NOT NULL
              AND telemetry_rated_load_newtons > 0
              AND telemetry_source IS NOT NULL
              AND telemetry_source = 'author_reported')`,
    ),
    /**
     * A slug and its label, or neither.
     *
     * ⚠️ DELIBERATELY NOT A FOREIGN KEY into `commerce_category`. The publisher places the surveyed
     * product in a class that may not be a category this store carries yet, and a foreign key would
     * refuse the placement rather than record it — the same argument
     * `showcase_launch_built_from_slug_ck` already makes for naming a teardown.
     */
    check(
      "teardown_store_product_class_ck",
      sql`(store_product_class_category_slug IS NULL AND store_product_class_label IS NULL)
          OR (store_product_class_category_slug IS NOT NULL
              AND store_product_class_category_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND store_product_class_label IS NOT NULL
              AND char_length(store_product_class_label) BETWEEN 1 AND 80)`,
    ),
    /**
     * ⚠️ PINS THE SOURCE TO `youtube`, and that is not redundancy.
     *
     * This column reuses the `video_source` enum, which also carries `hosted` — but the frontend's
     * video shape is a ONE-ARM union. A `hosted` row is not a field the page ignores; it is a parse
     * failure that blanks the detail page. The enum is shared, so the CHECK is what narrows it.
     */
    check(
      "teardown_walkthrough_video_ck",
      sql`(walkthrough_video_source IS NULL
           AND walkthrough_youtube_video_id IS NULL
           AND walkthrough_poster_url IS NULL
           AND walkthrough_duration_seconds IS NULL)
          OR (walkthrough_video_source IS NOT NULL
              AND walkthrough_video_source = 'youtube'
              AND walkthrough_youtube_video_id IS NOT NULL
              AND walkthrough_youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
              AND walkthrough_poster_url IS NOT NULL
              AND (walkthrough_duration_seconds IS NULL OR walkthrough_duration_seconds > 0))`,
    ),
    check(
      "teardown_walkthrough_poster_url_ck",
      sql`walkthrough_poster_url IS NULL OR (${assetUrlCheck("walkthrough_poster_url")})`,
    ),
  ],
);

/**
 * Denormalised counters for one teardown — a read cache, never a source of truth.
 *
 * ⚠️ ONE DIFFERENCE FROM `showcase_launch_stats`, and it inverts that table's argument. There, no
 * route writes a counter, so no rows exist and every read coalesces to zero. Here the seeded
 * teardowns carry real figures a publisher reported, so the seed DOES write a row per teardown and
 * the `coalesce` on the read is defence rather than the mechanism.
 *
 * Still no source-of-truth tables behind these: there is no view beacon, no like route and no
 * comment table for a teardown, because the frontend renders all four as inert spans. When those
 * routes land they bring their own tables and reconcile into this one.
 */
export const teardownStats = pgTable(
  "teardown_stats",
  {
    teardownId: text("teardown_id")
      .primaryKey()
      .references(() => teardown.id, { onDelete: "cascade" }),
    viewCount: integer("view_count").default(0).notNull(),
    likeCount: integer("like_count").default(0).notNull(),
    commentCount: integer("comment_count").default(0).notNull(),
    saveCount: integer("save_count").default(0).notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull(),
  },
  () => [
    check(
      "teardown_stats_nonnegative_ck",
      sql`view_count >= 0 AND like_count >= 0 AND comment_count >= 0 AND save_count >= 0`,
    ),
  ],
);

/**
 * The 3D view of one teardown, when a model was published.
 *
 * ONE PER TEARDOWN — `unique(teardown_id)` — so `?media=assembly` is an index-only semi-join and
 * the 1:1 shape is declared rather than assumed.
 *
 * `unique(teardown_id, id)` exists for a different reason: it is the first hop of the composite
 * foreign keys on `teardown_assembly_step` and `teardown_material`, which is how "this step's
 * focused part belongs to THIS teardown's assembly" becomes a declarative rule instead of a trigger.
 */
export const teardownAssembly = pgTable(
  "teardown_assembly",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    teardownId: text("teardown_id")
      .notNull()
      .references(() => teardown.id, { onDelete: "cascade" }),
    kind: teardownAssemblyKindEnum("kind").notNull(),
    /**
     * The direction parts fly apart in. NULL means the author did not state one, and then no part
     * may carry a `layer_index` either — see the import schema, which is where that cross-row rule
     * lives because a CHECK cannot see sibling rows.
     */
    explosionAxisX: doublePrecision("explosion_axis_x"),
    explosionAxisY: doublePrecision("explosion_axis_y"),
    explosionAxisZ: doublePrecision("explosion_axis_z"),
    /** The one composite model file. NULL on the `individual_parts` arm, where parts carry their own. */
    modelUrl: text("model_url"),
    modelByteSize: integer("model_byte_size"),
  },
  (table) => [
    unique("teardown_assembly_teardown_uidx").on(table.teardownId),
    unique("teardown_assembly_teardown_id_uidx").on(table.teardownId, table.id),
    unique("teardown_assembly_kind_uidx").on(table.id, table.kind),
    /** A composite assembly has the model; an individual-parts one has none. */
    check(
      "teardown_assembly_kind_shape_ck",
      sql`(kind = 'composite'
           AND model_url IS NOT NULL
           AND model_byte_size IS NOT NULL
           AND model_byte_size > 0)
          OR (kind = 'individual_parts' AND model_url IS NULL AND model_byte_size IS NULL)`,
    ),
    check(
      "teardown_assembly_model_url_ck",
      sql`model_url IS NULL OR (${assetUrlCheck("model_url")})`,
    ),
    /** Three components or none, and never the zero vector — a zero axis explodes nothing. */
    check(
      "teardown_assembly_explosion_axis_ck",
      sql`(explosion_axis_x IS NULL AND explosion_axis_y IS NULL AND explosion_axis_z IS NULL)
          OR (explosion_axis_x IS NOT NULL
              AND explosion_axis_y IS NOT NULL
              AND explosion_axis_z IS NOT NULL
              AND (explosion_axis_x <> 0 OR explosion_axis_y <> 0 OR explosion_axis_z <> 0))`,
    ),
  ],
);

/**
 * One part of one assembly, in a tree.
 *
 * ⚠️ `assembly_kind` IS DENORMALISED ON PURPOSE, and it is what makes the union's shape a
 * declarative rule. The composite foreign key `(assembly_id, assembly_kind)` forces it to agree
 * with the parent assembly, and then a per-row CHECK can say "a composite part names a node and
 * carries no model; an individual part carries a model and names no node" — with no trigger and no
 * application rule. Without the denormalised column that CHECK would need to read another table.
 *
 * `parent_part_id` is a composite self-reference, so a parent must be a part of the SAME assembly —
 * a bare `references()` would have let a part adopt a parent from another teardown.
 *
 * ⚠️ ACYCLICITY BEYOND SELF-PARENTING IS NOT HERE. A cycle needs a recursive walk, which a CHECK
 * cannot do; `teardown-import.schemas.ts` walks it instead, because the seed is the only writer on
 * this surface and a trigger for a rule no route can break is machinery with no caller.
 */
export const teardownPart = pgTable(
  "teardown_part",
  {
    id: text("id").notNull(),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => teardownAssembly.id, { onDelete: "cascade" }),
    assemblyKind: teardownAssemblyKindEnum("assembly_kind").notNull(),
    parentPartId: text("parent_part_id"),
    /** Publication order, so the tree comes back the way the author wrote it. */
    position: integer("position").notNull(),
    label: text("label").notNull(),
    /** Free text, and unrelated to the `teardown_material` rows — a part says "6063-T5 aluminium". */
    material: text("material").notNull(),
    manufacturingMethod: teardownManufacturingMethodEnum("manufacturing_method").notNull(),
    explosionDirectionX: doublePrecision("explosion_direction_x"),
    explosionDirectionY: doublePrecision("explosion_direction_y"),
    explosionDirectionZ: doublePrecision("explosion_direction_z"),
    explosionDistanceMm: doublePrecision("explosion_distance_mm"),
    /** Duplicates and zero are BOTH legal — three buttons can share one plane. */
    layerIndex: integer("layer_index"),
    /**
     * AN AUTHOR-ASSIGNED HEAT-MAP WEIGHT IN [0,1], NOT A SOLVER RESULT. It tints a part; it claims
     * nothing about a load case, and must never be conflated with the telemetry figures.
     */
    stressRating: doublePrecision("stress_rating"),
    calloutText: text("callout_text"),
    /** Composite arm only: the node name inside the shared `.glb`, byte-matched by the viewer. */
    nodeName: text("node_name"),
    /** Individual arm only. */
    modelUrl: text("model_url"),
    modelByteSize: integer("model_byte_size"),
    placementPositionX: doublePrecision("placement_position_x"),
    placementPositionY: doublePrecision("placement_position_y"),
    placementPositionZ: doublePrecision("placement_position_z"),
    placementRotationX: doublePrecision("placement_rotation_x"),
    placementRotationY: doublePrecision("placement_rotation_y"),
    placementRotationZ: doublePrecision("placement_rotation_z"),
  },
  (table) => [
    primaryKey({ columns: [table.assemblyId, table.id] }),
    // The target of the self-reference and of the two child tables' second hop.
    unique("teardown_part_assembly_id_uidx").on(table.assemblyId, table.id),
    // Composite arm only, so partial: an individual part names no node.
    uniqueIndex("teardown_part_node_name_uidx")
      .on(table.assemblyId, table.nodeName)
      .where(sql`node_name IS NOT NULL`),
    foreignKey({
      name: "teardown_part_assembly_kind_fk",
      columns: [table.assemblyId, table.assemblyKind],
      foreignColumns: [teardownAssembly.id, teardownAssembly.kind],
    }).onDelete("cascade"),
    /** Deleting a part takes its subtree with it — an orphaned child is not a tree. */
    foreignKey({
      name: "teardown_part_parent_fk",
      columns: [table.assemblyId, table.parentPartId],
      foreignColumns: [table.assemblyId, table.id],
    }).onDelete("cascade"),
    /** The 1-cycle. Longer ones are the import schema's job. */
    check("teardown_part_not_own_parent_ck", sql`parent_part_id IS NULL OR parent_part_id <> id`),
    /** The union's shape, readable on the row because `assembly_kind` travels with it. */
    check(
      "teardown_part_arm_shape_ck",
      sql`(assembly_kind = 'composite'
           AND node_name IS NOT NULL
           AND model_url IS NULL
           AND model_byte_size IS NULL
           AND placement_position_x IS NULL
           AND placement_rotation_x IS NULL)
          OR (assembly_kind = 'individual_parts'
              AND node_name IS NULL
              AND model_url IS NOT NULL
              AND model_byte_size IS NOT NULL
              AND model_byte_size > 0)`,
    ),
    check("teardown_part_model_url_ck", sql`model_url IS NULL OR (${assetUrlCheck("model_url")})`),
    /**
     * Three components or none, never the zero vector.
     *
     * ⚠️ `explosion_distance_mm` IS INDEPENDENTLY NULLABLE, which departs from this file's usual
     * co-required-pair rule and does so because the contract says to: a direction with no distance
     * means "move it this way by the viewer's default", which is a different statement from "do not
     * move it".
     */
    check(
      "teardown_part_explosion_direction_ck",
      sql`(explosion_direction_x IS NULL
           AND explosion_direction_y IS NULL
           AND explosion_direction_z IS NULL)
          OR (explosion_direction_x IS NOT NULL
              AND explosion_direction_y IS NOT NULL
              AND explosion_direction_z IS NOT NULL
              AND (explosion_direction_x <> 0
                   OR explosion_direction_y <> 0
                   OR explosion_direction_z <> 0))`,
    ),
    check(
      "teardown_part_placement_ck",
      sql`(placement_position_x IS NULL
           AND placement_position_y IS NULL
           AND placement_position_z IS NULL
           AND placement_rotation_x IS NULL
           AND placement_rotation_y IS NULL
           AND placement_rotation_z IS NULL)
          OR (placement_position_x IS NOT NULL
              AND placement_position_y IS NOT NULL
              AND placement_position_z IS NOT NULL
              AND placement_rotation_x IS NOT NULL
              AND placement_rotation_y IS NOT NULL
              AND placement_rotation_z IS NOT NULL)`,
    ),
    check(
      "teardown_part_scalars_ck",
      sql`(explosion_distance_mm IS NULL OR explosion_distance_mm > 0)
          AND (layer_index IS NULL OR layer_index >= 0)
          AND (stress_rating IS NULL OR (stress_rating >= 0 AND stress_rating <= 1))
          AND position >= 0
          AND char_length(label) BETWEEN 1 AND 120
          AND char_length(material) BETWEEN 1 AND 120
          AND (node_name IS NULL OR char_length(node_name) BETWEEN 1 AND 120)
          AND (callout_text IS NULL OR char_length(callout_text) BETWEEN 1 AND 400)`,
    ),
  ],
);

/** Something a reader opens: a schematic, a bill of materials, an assembly guide, a datasheet. */
export const teardownDocument = pgTable(
  "teardown_document",
  {
    id: text("id").primaryKey(),
    teardownId: text("teardown_id")
      .notNull()
      .references(() => teardown.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: blueprintDocumentKindEnum("kind").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** NULL means nobody counted the pages — which is not zero pages. */
    pageCount: integer("page_count"),
  },
  (table) => [
    // `?media=documents` is an EXISTS over this index, and the page's child load is an IN over it.
    index("teardown_document_teardown_idx").on(table.teardownId, table.position),
    check("teardown_document_url_ck", assetUrlCheck("url")),
    check(
      "teardown_document_scalars_ck",
      sql`byte_size >= 0
          AND position >= 0
          AND (page_count IS NULL OR page_count > 0)
          AND char_length(title) BETWEEN 1 AND 200`,
    ),
  ],
);

/**
 * Something a fab consumes: STEP, STL, DXF, Gerber, drill, pick-and-place, a BOM csv.
 *
 * A SEPARATE TABLE FROM `teardown_document`, which the contract argues at length — two kinds, two
 * renderers, and a `page_count` that means nothing for a Gerber. Note `byte_size > 0` here against
 * `>= 0` on a document: the contract draws that distinction and this mirrors it.
 */
export const teardownManufacturingFile = pgTable(
  "teardown_manufacturing_file",
  {
    id: text("id").primaryKey(),
    teardownId: text("teardown_id")
      .notNull()
      .references(() => teardown.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: teardownManufacturingFileKindEnum("kind").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    byteSize: integer("byte_size").notNull(),
  },
  (table) => [
    index("teardown_manufacturing_file_teardown_idx").on(table.teardownId, table.position),
    check("teardown_manufacturing_file_url_ck", assetUrlCheck("url")),
    check(
      "teardown_manufacturing_file_scalars_ck",
      sql`byte_size > 0 AND position >= 0 AND char_length(title) BETWEEN 1 AND 200`,
    ),
  ],
);

/** One line of the fastener bill of materials. */
export const teardownFastener = pgTable(
  "teardown_fastener",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    teardownId: text("teardown_id")
      .notNull()
      .references(() => teardown.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** NULL for a proprietary part — never the string "N/A". */
    standardCode: text("standard_code"),
    /**
     * A DESIGNATION, NOT A MEASUREMENT. "M3 × 8", "#6-32 × ½″" and "12 mm × 40 mm" come from three
     * different standards and do not reduce to a number pair.
     */
    sizeLabel: text("size_label").notNull(),
    drive: teardownFastenerDriveEnum("drive").notNull(),
    quantity: integer("quantity").notNull(),
    supplierLabel: text("supplier_label"),
    supplierUrl: text("supplier_url"),
  },
  (table) => [
    index("teardown_fastener_teardown_idx").on(table.teardownId, table.position),
    /** A supplier is a label and a link together, or neither. */
    check(
      "teardown_fastener_supplier_ck",
      sql`(supplier_label IS NULL AND supplier_url IS NULL)
          OR (supplier_label IS NOT NULL
              AND char_length(supplier_label) BETWEEN 1 AND 80
              AND supplier_url IS NOT NULL)`,
    ),
    /** Outbound, so https only — there is no same-site supplier. */
    check(
      "teardown_fastener_supplier_url_ck",
      sql`supplier_url IS NULL OR (${externalUrlCheck("supplier_url")})`,
    ),
    check(
      "teardown_fastener_scalars_ck",
      sql`quantity > 0
          AND position >= 0
          AND char_length(size_label) BETWEEN 1 AND 80
          AND (standard_code IS NULL OR char_length(standard_code) BETWEEN 1 AND 80)`,
    ),
  ],
);

/**
 * One numbered disassembly step.
 *
 * `focused_part_id` NAMES A PART OF THIS TEARDOWN'S OWN ASSEMBLY, and that is enforced in two hops:
 * `(teardown_id, assembly_id)` proves the assembly belongs to this teardown, then
 * `(assembly_id, focused_part_id)` proves the part belongs to that assembly. The denormalised
 * `assembly_id` is the price of not needing a trigger.
 *
 * ⚠️ THE DENSE 1..N SEQUENCE IS NOT ENFORCED HERE. `unique(teardown_id, step_number)` stops a
 * duplicate, but "no gaps, starting at 1" needs a count over sibling rows, which a CHECK cannot do.
 * `teardown-import.schemas.ts` checks it, and the read orders by `step_number` so the API cannot
 * emit them out of order even if a gap ever appeared.
 */
export const teardownAssemblyStep = pgTable(
  "teardown_assembly_step",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    teardownId: text("teardown_id")
      .notNull()
      .references(() => teardown.id, { onDelete: "cascade" }),
    stepNumber: integer("step_number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    assemblyId: text("assembly_id"),
    focusedPartId: text("focused_part_id"),
  },
  (table) => [
    unique("teardown_assembly_step_number_uidx").on(table.teardownId, table.stepNumber),
    foreignKey({
      name: "teardown_assembly_step_assembly_fk",
      columns: [table.teardownId, table.assemblyId],
      foreignColumns: [teardownAssembly.teardownId, teardownAssembly.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "teardown_assembly_step_part_fk",
      columns: [table.assemblyId, table.focusedPartId],
      foreignColumns: [teardownPart.assemblyId, teardownPart.id],
    }).onDelete("cascade"),
    /** A focused part needs the assembly it lives in; neither travels alone. */
    check(
      "teardown_assembly_step_focus_ck",
      sql`(assembly_id IS NULL) = (focused_part_id IS NULL)`,
    ),
    check(
      "teardown_assembly_step_scalars_ck",
      sql`step_number BETWEEN 1 AND 64
          AND char_length(title) BETWEEN 1 AND 200
          AND char_length(description) BETWEEN 1 AND 2000`,
    ),
  ],
);

/**
 * One composition record: what a named piece of the product is made of.
 *
 * `part_id` resolves through the same two hops as a step's focused part. Most materials name no
 * part at all — a housing nobody modelled is still worth recording.
 */
export const teardownMaterial = pgTable(
  "teardown_material",
  {
    id: text("id").primaryKey(),
    teardownId: text("teardown_id")
      .notNull()
      .references(() => teardown.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    appliesToLabel: text("applies_to_label").notNull(),
    /**
     * FREE TEXT BY DECREE. A closed enum would refuse the first unusual polymer somebody actually
     * measured; the form offers a combobox of suggestions instead.
     */
    designation: text("designation").notNull(),
    /** Travels with the designation everywhere it renders — no renderer may drop it to save a line. */
    designationSource: teardownDesignationSourceEnum("designation_source").notNull(),
    materialClass: teardownMaterialClassEnum("material_class").notNull(),
    process: teardownManufacturingMethodEnum("process"),
    finish: text("finish"),
    assemblyId: text("assembly_id"),
    partId: text("part_id"),
  },
  (table) => [
    index("teardown_material_teardown_idx").on(table.teardownId, table.position),
    foreignKey({
      name: "teardown_material_assembly_fk",
      columns: [table.teardownId, table.assemblyId],
      foreignColumns: [teardownAssembly.teardownId, teardownAssembly.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "teardown_material_part_fk",
      columns: [table.assemblyId, table.partId],
      foreignColumns: [teardownPart.assemblyId, teardownPart.id],
    }).onDelete("cascade"),
    check("teardown_material_part_ck", sql`(assembly_id IS NULL) = (part_id IS NULL)`),
    check(
      "teardown_material_scalars_ck",
      sql`position >= 0
          AND char_length(applies_to_label) BETWEEN 1 AND 120
          AND char_length(designation) BETWEEN 1 AND 120
          AND (finish IS NULL OR char_length(finish) BETWEEN 1 AND 120)`,
    ),
  ],
);

/**
 * One element inside one material's composition.
 *
 * ⚠️ A WEIGHT RANGE OF NULL IS NOT ZERO PERCENT. "Iron is present but we did not quantify it" is a
 * different statement from "there is no iron", and the fixtures contain exactly that case.
 */
export const teardownMaterialElement = pgTable(
  "teardown_material_element",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    materialId: text("material_id")
      .notNull()
      .references(() => teardownMaterial.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** A chemical symbol: one to three characters. */
    symbol: text("symbol").notNull(),
    minimumPercent: doublePrecision("minimum_percent"),
    maximumPercent: doublePrecision("maximum_percent"),
    analysisMethod: teardownCompositionAnalysisMethodEnum("analysis_method").notNull(),
    instrumentLabel: text("instrument_label"),
    operatorNote: text("operator_note"),
  },
  (table) => [
    index("teardown_material_element_material_idx").on(table.materialId, table.position),
    /** Both bounds or neither, and ordered. */
    check(
      "teardown_material_element_range_ck",
      sql`(minimum_percent IS NULL AND maximum_percent IS NULL)
          OR (minimum_percent IS NOT NULL
              AND maximum_percent IS NOT NULL
              AND minimum_percent >= 0
              AND maximum_percent <= 100
              AND maximum_percent >= minimum_percent)`,
    ),
    /**
     * AN INSTRUMENT MAY ONLY ACCOMPANY A MEASUREMENT. `declared_not_measured` and
     * `synthetic_example` are honest values, and naming a spectrometer beside either would claim it
     * read a number nobody measured. One-directional, exactly as the contract is: a measured row
     * may still leave the instrument unnamed.
     */
    check(
      "teardown_material_element_instrument_ck",
      sql`instrument_label IS NULL
          OR analysis_method IN ('xrf', 'oes', 'eds', 'icp_oes')`,
    ),
    check(
      "teardown_material_element_scalars_ck",
      sql`position >= 0
          AND char_length(symbol) BETWEEN 1 AND 3
          AND (instrument_label IS NULL OR char_length(instrument_label) BETWEEN 1 AND 120)
          AND (operator_note IS NULL OR char_length(operator_note) BETWEEN 1 AND 400)`,
    ),
  ],
);

export const teardownRelations = relations(teardown, ({ one, many }) => ({
  stats: one(teardownStats, {
    fields: [teardown.id],
    references: [teardownStats.teardownId],
  }),
  assembly: one(teardownAssembly, {
    fields: [teardown.id],
    references: [teardownAssembly.teardownId],
  }),
  documents: many(teardownDocument),
  manufacturingFiles: many(teardownManufacturingFile),
  fasteners: many(teardownFastener),
  assemblySteps: many(teardownAssemblyStep),
  materials: many(teardownMaterial),
}));

export const teardownAssemblyRelations = relations(teardownAssembly, ({ one, many }) => ({
  teardown: one(teardown, {
    fields: [teardownAssembly.teardownId],
    references: [teardown.id],
  }),
  parts: many(teardownPart),
}));

export const teardownPartRelations = relations(teardownPart, ({ one }) => ({
  assembly: one(teardownAssembly, {
    fields: [teardownPart.assemblyId],
    references: [teardownAssembly.id],
  }),
}));

export const teardownMaterialRelations = relations(teardownMaterial, ({ one, many }) => ({
  teardown: one(teardown, {
    fields: [teardownMaterial.teardownId],
    references: [teardown.id],
  }),
  elements: many(teardownMaterialElement),
}));

export const teardownMaterialElementRelations = relations(teardownMaterialElement, ({ one }) => ({
  material: one(teardownMaterial, {
    fields: [teardownMaterialElement.materialId],
    references: [teardownMaterial.id],
  }),
}));

// ---------------------------------------------------------------------------
// CASE STUDIES — the third blueprint arm, and the first with a write path.
//
// ⚠️ A CASE STUDY IS A CLAIM ABOUT A BUSINESS, OFTEN SOMEBODY ELSE'S. The writer states how they
// know it (`author_relationship`), the two statements they ticked follow from that answer, and a
// case study written from public sources must link what it drew on. None of that makes a claim
// true. It makes the writer say which claim they are making, and a moderator stays the gate.
//
// ⚠️ THE ONE RULE THESE TABLES EXIST TO ENFORCE: a FIRST-HAND writer may withhold a company's name
// from READERS — an NDA is the ordinary reason — and a moderator still sees it. So `name` is NOT
// NULL and `is_name_withheld` is the flag; `null` is written by the PUBLIC SERIALIZER, never stored.
// A nullable `name` beside the flag would be two spellings of one fact, and the moderator read's
// contract requires a non-null name.
//
// ⚠️ THE GUARANTEE IS NARROW, AND SAYING SO IS PART OF IT. This withholds ONE COLUMN. A writer can
// still name the company in `summary`, in a step, in a tag, or in a source's publisher label — the
// fixtures contain exactly that shape ("Verdant Sensing build log" is a company name in a
// `publisher_label`). The submit service sweeps a withheld name against every published free-text
// field for that reason, but the column is what these tables promise and the moderator is the gate.
//
// ⚠️ ONE VISIBILITY GATE, NOT TWO — do NOT copy the teardown shape here. A teardown needs LIST and
// READABLE because a quarantine withholds its FILES while leaving its address alive. A case study
// has no files: a report moves a published row to `flagged`, and nothing is withheld by state. So
// `published, flagged` is the whole gate, and `moderation_state` is checked down to the FOUR states
// this arm can reach. A second predicate identical to the first would teach the next reader that
// the difference is meaningful.
//
// DECLARED AT THE END OF THIS FILE ON PURPOSE: `assetUrlCheck` and `externalUrlCheck` are declared
// above the teardown tables, and a table above them cannot call them.

export const blueprintDisciplineEnum = pgEnum("blueprint_discipline", [
  "tooling",
  "supply_chain",
  "quality",
  "distribution",
  "unit_economics",
]);

/**
 * How the writer knows the story.
 *
 * ⚠️ APPEND-ONLY ONCE A COMPANY ROW EXISTS, and that is enforced rather than hoped for: the
 * composite foreign key on `case_study_evidence_company` carries this value down with
 * `ON UPDATE RESTRICT`, so changing it on a row that has companies raises 23503. That is correct —
 * flipping it would edit somebody else's sworn statement, and it would silently invalidate the two
 * statement ids they ticked. The two decision verbs a moderator has (`published`, `rejected`) cannot
 * reach it; changing this answer means resubmitting.
 */
export const caseStudyAuthorRelationshipEnum = pgEnum("case_study_author_relationship", [
  "first_hand",
  "public_sources",
]);

/**
 * The three shapes a figure can take.
 *
 * A PERCENTAGE IS BASIS POINTS so a fraction survives the integer — 43.8% is 4380 — which is the
 * frontend's rule and the reason there is no float here.
 */
export const caseStudyMetricKindEnum = pgEnum("case_study_metric_kind", [
  "count",
  "money",
  "percentage",
]);

/** The route literals under `/blueprints/case-studies/`, which no slug may shadow. */
export const CASE_STUDY_RESERVED_SLUGS = ["new", "mine", "slugs", "options"] as const;

/** The two statement ids each answer to "how do you know this" requires. */
export const CASE_STUDY_FIRST_HAND_STATEMENT_IDS = [
  "was_part_of_it",
  "figures_from_records",
] as const;
export const CASE_STUDY_PUBLIC_SOURCES_STATEMENT_IDS = [
  "figures_in_linked_sources",
  "says_only_what_sources_say",
] as const;

/**
 * One written-up lesson.
 *
 * ⚠️ NO `thumbnail_url`, `difficulty`, `cad_format` OR COST RANGE, and their absence is a decision
 * `todo.md` asked to take before this migration. The composer collects none of the four and no
 * case-study component renders any; they were on the frontend's shared blueprint shape only because
 * a since-deleted shared card once read them. Columns nothing writes and nothing shows are the
 * unverified code the field sweeps exist to catch.
 *
 * ⚠️ THE AUTHOR IS ONE OF TWO ARMS, AND EXACTLY ONE. An authored row names an account
 * (`author_user_id`); a SEEDED row carries the byline as text, because the ten fixture writers are
 * invented people and minting them as accounts would spend ten entries in a UNIQUE handle namespace,
 * ten account-closure obligations and ten rows in every job that walks `user` — to render ten
 * bylines. The teardown arm denormalised its byline entirely for this reason; that was available
 * there because nothing wrote a teardown, and it is not available here.
 *
 * ⚠️ AND SO A `null_out` ON `author_user_id` IS NOT MERELY WRONG, IT IS ILLEGAL: the arm CHECK
 * refuses a row with neither an account nor a byline, so clearing the column mid-scrub raises 23514
 * and dead-letters the anonymization job. `db:verify-anonymization-coverage` CANNOT SEE THIS — it
 * flags `null_out` on a NOT NULL column and this column is nullable — so the manifest entry says it
 * in words and `db:verify-case-study-constraints` proves it against a real database.
 *
 * MONEY IS `bigint` AND THE CURRENCY IS NOT PINNED TO USD, which departs from the other two
 * blueprint arms. The write contract offers USD and INR, and one fixture carries ₹1 crore —
 * 1,000,000,000 paise. That clears int4 by a factor of two, which is not a margin: `rnd.ts`'s §4b
 * rule ("int4 caps at $21.5M — a single round overflows it") is about exactly this figure.
 */
export const caseStudy = pgTable(
  "case_study",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * The public address, `/blueprints/case-studies/<slug>`.
     *
     * MINT-ONCE AND NEVER CLEARED, and that is a PRECONDITION rather than an observation:
     * `case_study_related_lesson.related_public_slug` is a foreign key onto this column, so the day
     * something clears a slug every inbound edge raises 23503 and that moderation action fails.
     * NULL until a moderator publishes.
     */
    publicSlug: text("public_slug").unique(),
    /** THE LESSON, AS ONE INSTRUCTION — "Budget for a second mould." There is no second title. */
    title: text("title").notNull(),
    /**
     * ⚠️ THE EXPRESSION IS COPIED BYTE-FOR-BYTE FROM `showcase_launch.title_normalized`, and it must
     * stay that way. POSIX `[[:space:]]` is not JavaScript's `\s` and `lower()` is not
     * `toLowerCase()` — they disagree on a Turkish dotted İ and on ß — so the uniqueness question is
     * answered by THIS expression and never by a JavaScript copy of it.
     */
    titleNormalized: text("title_normalized").generatedAlwaysAs(
      sql`lower(regexp_replace(btrim(title), '[[:space:]]+', ' ', 'g'))`,
    ),
    /** The one thing a reader should do, one line, under the title. */
    oneLineAction: text("one_line_action").notNull(),
    summary: text("summary").notNull(),
    problem: text("problem").notNull(),
    context: text("context").notNull(),
    discipline: blueprintDisciplineEnum("discipline").notNull(),
    /**
     * FREE TEXT, AND NOT A DUPLICATE OF `discipline`. One is a typed axis that filters the index,
     * the other describes the business — "Hardware", "Packaged food". A closed list would refuse the
     * first sector somebody actually worked in.
     */
    sector: text("sector").notNull(),
    /**
     * What happened after. NULL means nobody can say tidily; it is NOT "Unknown" and NOT a failure.
     *
     * There is deliberately no `scaled | failed | pivoted` enum beside it — that badge was specified
     * and rejected, because a renderer that requires an outcome invites people to invent one.
     */
    outcomeSummary: text("outcome_summary"),
    /** Free text, e.g. "14 months, two production runs". NULL when nobody recorded it. */
    timelineLabel: text("timeline_label"),
    authorRelationship: caseStudyAuthorRelationshipEnum("author_relationship").notNull(),
    /** The two statements the writer ticked. Kept because the moderator holds them to it. */
    acceptedStatementIds: text("accepted_statement_ids").array().notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Integer minor units — paise for INR, cents for USD. Both move with the currency or neither. */
    capitalRaisedAmountCents: bigint("capital_raised_amount_cents", { mode: "number" }),
    capitalRaisedCurrency: text("capital_raised_currency"),

    // --- The author, one arm of two. See the table docblock. ---
    /** `cascade`: deleting an account deletes its case studies (the `showcase_launch` decision). */
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "cascade" }),
    authorDisplayName: text("author_display_name"),
    /** Nullable WITHIN the byline arm, exactly as `user.handle` and `user.image` are. */
    authorHandle: text("author_handle"),
    authorAvatarUrl: text("author_avatar_url"),

    // --- The decision. ---
    moderationState: blueprintModerationStateEnum("moderation_state")
      .default("pending_review")
      .notNull(),
    /** What the moderator told the writer. Required for a rejection; it is all the writer sees. */
    moderatorNote: text("moderator_note"),
    /** `restrict`: a moderation decision stays attributable for as long as the row exists. */
    reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at", { precision: 3 }),
    createdAt: timestamp("created_at", { precision: 3 }).notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * ⚠️ THE TITLE IS TAKEN WHILE IT IS IN REVIEW OR READABLE, AND FREED BY A REJECTION.
     *
     * `pending_review` is in the predicate, which is what makes the interesting race impossible: two
     * writers sending the same title a millisecond apart both pass any SELECT, and the second INSERT
     * raises 23505 — so two pending rows can never share a title and the clash-at-publish a
     * submit-time check would permit never arises. Uniqueness is the database's answer, never a
     * check-then-insert.
     *
     * ⚠️ `flagged` IS IN THE PREDICATE, which `showcase_launch_title_uidx` has no need for. A
     * flagged case study was published and its address still answers, so its title is still live;
     * freeing it would let a second row claim a title a reader can reach. `rejected` is OUT, so a
     * writer who was sent back can resubmit under the same title.
     */
    uniqueIndex("case_study_title_live_uidx")
      .on(table.titleNormalized)
      .where(sql`moderation_state IN ('pending_review', 'published', 'flagged')`),
    /**
     * The first hop of `case_study_evidence_company`'s composite foreign key, which is how "only a
     * first-hand writer may withhold a name" becomes a per-row CHECK instead of a trigger.
     */
    unique("case_study_author_relationship_uidx").on(table.id, table.authorRelationship),
    /** My Case Studies, newest first. */
    index("case_study_author_idx").on(table.authorUserId, table.createdAt, table.id),
    /** The review queue, oldest first. Partial, because a decided row never re-enters it. */
    index("case_study_review_queue_idx")
      .on(table.createdAt, table.id)
      .where(sql`moderation_state = 'pending_review'`),
    /**
     * The public index's page. Directions matter: the keyset is `created_at DESC, id ASC` and
     * Postgres only walks an index whose directions match pair for pair. Partial on the one gate,
     * so the index and the predicate cannot drift apart.
     */
    index("case_study_public_newest_idx")
      .on(desc(table.createdAt), table.id)
      .where(sql`moderation_state IN ('published', 'flagged')`),
    /** The four states this arm can reach. Narrower than the seven-label shared enum, deliberately. */
    check(
      "case_study_moderation_state_ck",
      sql`moderation_state IN ('pending_review', 'published', 'rejected', 'flagged')`,
    ),
    /**
     * ⚠️ THE STATEMENT PAIR, AND THE TWO GUARDS THAT LOOK REDUNDANT AND ARE NOT.
     *
     * `array_position(..., NULL) IS NULL` is there because `text[] NOT NULL` says NOTHING ABOUT ITS
     * ELEMENTS: `ARRAY['was_part_of_it', NULL] @> ARRAY['was_part_of_it','figures_from_records']`
     * evaluates to NULL, `false OR NULL` is NULL, and a NULL CHECK PASSES. That is migration 0172's
     * bug in a new disguise — every constraint that one fixed was a scalar arm, so recognising the
     * scalar shape does not catch this one.
     *
     * `cardinality = 2` is there because containment is not set equality: `@>` is satisfied by
     * `{was_part_of_it, was_part_of_it}`. With the cardinality pinned, `@>` becomes exact, which is
     * what refuses a tick carried over from the other answer — a statement about a different claim.
     */
    check(
      "case_study_statements_ck",
      sql`cardinality(accepted_statement_ids) = 2
          AND array_position(accepted_statement_ids, NULL) IS NULL
          AND ((author_relationship = 'first_hand'
                AND accepted_statement_ids @> ARRAY['was_part_of_it', 'figures_from_records']::text[])
            OR (author_relationship = 'public_sources'
                AND accepted_statement_ids @> ARRAY['figures_in_linked_sources', 'says_only_what_sources_say']::text[]))`,
    ),
    /** Ten tags, and not one of them NULL — see the statement CHECK for why that is spelled out. */
    check(
      "case_study_tags_ck",
      sql`cardinality(tags) <= 10 AND array_position(tags, NULL) IS NULL`,
    ),
    /**
     * EXACTLY ONE AUTHOR ARM. An account-authored row names one and carries no byline text; a seeded
     * row carries the byline and names no account. See the table docblock on why a `null_out` on
     * `author_user_id` is illegal rather than merely wrong.
     */
    check(
      "case_study_author_arm_ck",
      sql`(author_user_id IS NOT NULL
           AND author_display_name IS NULL
           AND author_handle IS NULL
           AND author_avatar_url IS NULL)
          OR (author_user_id IS NULL AND author_display_name IS NOT NULL)`,
    ),
    /**
     * THE DECISION COLUMNS MOVE TOGETHER — with one clause deliberately absent.
     *
     * ⚠️ THERE IS NO "published IMPLIES A REVIEWER" CLAUSE, which `showcase_launch_decision_ck` does
     * carry. The seed publishes ten rows nobody reviewed, and satisfying that clause would mean
     * inventing a reviewer for each — a fact about a person that never happened. A reviewer and a
     * review time still travel together, a rejection still carries its reason, and a row in review
     * still carries no note.
     */
    check(
      "case_study_decision_ck",
      sql`(reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
          AND (moderation_state <> 'pending_review' OR moderator_note IS NULL)
          AND (moderation_state <> 'rejected' OR moderator_note IS NOT NULL)
          AND (public_slug IS NOT NULL) = (moderation_state IN ('published', 'flagged'))`,
    ),
    check(
      "case_study_slug_ck",
      sql`public_slug IS NULL
          OR (char_length(public_slug) BETWEEN 3 AND 120
              AND public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND public_slug NOT IN ('new', 'mine', 'slugs', 'options'))`,
    ),
    /** Mirrors the draft contract's caps, so a payload the form accepts is one this table takes. */
    check(
      "case_study_text_lengths_ck",
      sql`char_length(title) BETWEEN 12 AND 140
          AND char_length(one_line_action) BETWEEN 10 AND 140
          AND char_length(summary) BETWEEN 40 AND 600
          AND char_length(problem) BETWEEN 20 AND 2000
          AND char_length(context) BETWEEN 20 AND 2000
          AND char_length(sector) BETWEEN 1 AND 60
          AND (outcome_summary IS NULL OR char_length(outcome_summary) BETWEEN 1 AND 120)
          AND (timeline_label IS NULL OR char_length(timeline_label) BETWEEN 1 AND 60)
          AND (moderator_note IS NULL OR char_length(moderator_note) BETWEEN 1 AND 2000)
          AND (author_display_name IS NULL OR char_length(author_display_name) BETWEEN 1 AND 80)
          AND (author_handle IS NULL
               OR (char_length(author_handle) BETWEEN 1 AND 64
                   AND author_handle ~ '^[A-Za-z0-9_.-]+$'))`,
    ),
    check(
      "case_study_author_avatar_url_ck",
      sql`author_avatar_url IS NULL OR (${assetUrlCheck("author_avatar_url")})`,
    ),
    /**
     * NULL MEANS NOT DISCLOSED, NEVER ZERO — the row says nothing about money rather than say a
     * number. Both columns or neither, and every arm opens with `IS NOT NULL` for 0172's reason.
     */
    check(
      "case_study_capital_raised_ck",
      sql`(capital_raised_amount_cents IS NULL AND capital_raised_currency IS NULL)
          OR (capital_raised_amount_cents IS NOT NULL
              AND capital_raised_amount_cents >= 0
              AND capital_raised_currency IS NOT NULL
              AND capital_raised_currency IN ('USD', 'INR'))`,
    ),
  ],
);

/**
 * Denormalised counters for one case study — a read cache, never a source of truth.
 *
 * ⚠️ TWO COUNTERS, NOT FOUR. A case study has no `comment_count` and no `upvote_count`, and that is
 * the contract's decision rather than an omission: it "is a numbered lesson with no discussion
 * surface". The showcase arm carries both and the teardown arm carries comments; this one renders
 * views and likes as inert spans and nothing else.
 *
 * A ROW PER CASE STUDY, like the teardown sidecar and unlike the showcase one — the ten seeded rows
 * carry real figures the fixture states, so the read's `coalesce` is defence rather than mechanism.
 */
export const caseStudyStats = pgTable(
  "case_study_stats",
  {
    caseStudyId: text("case_study_id")
      .primaryKey()
      .references(() => caseStudy.id, { onDelete: "cascade" }),
    viewCount: integer("view_count").default(0).notNull(),
    likeCount: integer("like_count").default(0).notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull(),
  },
  () => [check("case_study_stats_nonnegative_ck", sql`view_count >= 0 AND like_count >= 0`)],
);

/**
 * One thing they did, in order.
 *
 * ⚠️ THE ORDER IS A CLAIM HERE AND NOT ON `case_study_pitfall`, which is why both carry `position`
 * and only one is rendered as a numbered list: "the actions happened in that sequence, the pitfalls
 * did not. Numbering a list of mistakes would assert an order nobody recorded." The column exists on
 * both so the author's arrangement survives a round trip either way; the renderer draws the line.
 *
 * ⚠️ THE DUPLICATE INDEX IS `lower(btrim(body))` AND MUST NOT COLLAPSE INTERNAL WHITESPACE. The form
 * compares `value.trim().toLowerCase()`, so an index that also collapsed runs of spaces would be
 * STRICTER than the form — and a draft the form accepts would arrive as a 23505 the service has no
 * error type for. The title's expression is the whitespace-collapsing one; these are not.
 */
export const caseStudyActionStep = pgTable(
  "case_study_action_step",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    caseStudyId: text("case_study_id")
      .notNull()
      .references(() => caseStudy.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    body: text("body").notNull(),
  },
  (table) => [
    uniqueIndex("case_study_action_step_position_uidx").on(table.caseStudyId, table.position),
    uniqueIndex("case_study_action_step_body_uidx").on(table.caseStudyId, sql`lower(btrim(body))`),
    check("case_study_action_step_ck", sql`position >= 0 AND char_length(body) BETWEEN 1 AND 300`),
  ],
);

/** What to avoid. NOT the inverse of the steps — these are the things that went wrong. */
export const caseStudyPitfall = pgTable(
  "case_study_pitfall",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    caseStudyId: text("case_study_id")
      .notNull()
      .references(() => caseStudy.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    body: text("body").notNull(),
  },
  (table) => [
    uniqueIndex("case_study_pitfall_position_uidx").on(table.caseStudyId, table.position),
    uniqueIndex("case_study_pitfall_body_uidx").on(table.caseStudyId, sql`lower(btrim(body))`),
    check("case_study_pitfall_ck", sql`position >= 0 AND char_length(body) BETWEEN 1 AND 300`),
  ],
);

/**
 * A company the case study is about.
 *
 * ⚠️ `name` IS NOT NULL EVEN WHEN IT IS WITHHELD, and the public serializer writes `null` in its
 * place. A withheld name is withheld from READERS, not from Qatoto: a moderator has to be able to
 * check the case study against the company, and a company nobody at Qatoto can see is a claim nobody
 * can check. That is also why a PUBLIC-SOURCES case study may not withhold one — there the company
 * is a source a reader could otherwise verify.
 *
 * ⚠️ "ONLY A FIRST-HAND WRITER MAY WITHHOLD" IS DECLARATIVE, via the trick `teardown_part` uses for
 * its arm discriminator: `author_relationship` is carried down here, forced to agree with the parent
 * by a composite foreign key, and then a per-row CHECK can read it. Without the denormalised column
 * that CHECK would have to reach into another table.
 *
 * ⚠️ AND THE FOREIGN KEY IS `ON UPDATE RESTRICT` ON PURPOSE, WHICH MAKES THE PARENT'S
 * `author_relationship` APPEND-ONLY once any company row exists. That is the outcome to want, so it
 * is stated rather than inherited from a default: changing the answer would edit somebody else's
 * sworn statement and silently invalidate the two statement ids they ticked. `ON UPDATE CASCADE`
 * would be worse — it would propagate the new value down and this CHECK would fire 23514 in the
 * middle of a moderator's transaction. The rule, once: never put a moderation-owned mutable column
 * in a composite foreign key that a child CHECK reads.
 */
export const caseStudyEvidenceCompany = pgTable(
  "case_study_evidence_company",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    caseStudyId: text("case_study_id")
      .notNull()
      .references(() => caseStudy.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** ALWAYS THE REAL NAME. The public read returns `null` for it when withheld. */
    name: text("name").notNull(),
    isNameWithheld: boolean("is_name_withheld").default(false).notNull(),
    /** Denormalised from the parent and forced to agree with it. See the docblock. */
    authorRelationship: caseStudyAuthorRelationshipEnum("author_relationship").notNull(),
    /** FREE TEXT, not a place id — "Porto", "Western Norway". */
    locationLabel: text("location_label").notNull(),
    /** FREE TEXT, not a date — "2024". */
    yearLabel: text("year_label").notNull(),
  },
  (table) => [
    uniqueIndex("case_study_evidence_company_position_uidx").on(table.caseStudyId, table.position),
    /** The detail page keys its fact rows by label, so a repeat would collide there. */
    uniqueIndex("case_study_evidence_company_name_uidx").on(
      table.caseStudyId,
      sql`lower(btrim(name))`,
    ),
    foreignKey({
      name: "case_study_evidence_company_relationship_fk",
      columns: [table.caseStudyId, table.authorRelationship],
      foreignColumns: [caseStudy.id, caseStudy.authorRelationship],
    })
      .onDelete("cascade")
      .onUpdate("restrict"),
    /** Both columns are NOT NULL, so there is no NULL arm for this one to fall through. */
    check(
      "case_study_evidence_company_withheld_ck",
      sql`NOT (is_name_withheld AND author_relationship <> 'first_hand')`,
    ),
    check(
      "case_study_evidence_company_text_ck",
      sql`position >= 0
          AND char_length(name) BETWEEN 1 AND 80
          AND char_length(location_label) BETWEEN 1 AND 60
          AND char_length(year_label) BETWEEN 1 AND 20`,
    ),
  ],
);

/**
 * One figure the lesson rests on.
 *
 * THE THREE ARMS ARE COLUMNS, NOT A JSON BLOB, so each one's bounds are a CHECK rather than a hope.
 * A percentage is BASIS POINTS and money is integer minor units; there is no float on this row.
 *
 * ⚠️ A LABEL MAY NOT IMPERSONATE A WITHHELD COMPANY. The form's version of this rule is conditional
 * — "if any company is withheld, no figure may be labelled `Name withheld`" — which would need to
 * read a sibling row. Dropping the condition makes it a per-row CHECK: it is stricter than the form
 * and harmless, because no honest figure is called that. Converting a conditional cross-row rule
 * into an unconditional per-row one is the move worth reusing.
 *
 * NOT declarative, and so left to the submit service: a label that equals a company's NAME. The
 * detail page puts companies and figures in one keyspace, but they are two tables and a CHECK may
 * not cross one.
 */
export const caseStudyOutcomeMetric = pgTable(
  "case_study_outcome_metric",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    caseStudyId: text("case_study_id")
      .notNull()
      .references(() => caseStudy.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    kind: caseStudyMetricKindEnum("kind").notNull(),
    countAmount: integer("count_amount"),
    moneyAmountCents: bigint("money_amount_cents", { mode: "number" }),
    moneyCurrency: text("money_currency"),
    basisPoints: integer("basis_points"),
  },
  (table) => [
    uniqueIndex("case_study_outcome_metric_position_uidx").on(table.caseStudyId, table.position),
    uniqueIndex("case_study_outcome_metric_label_uidx").on(
      table.caseStudyId,
      sql`lower(btrim(label))`,
    ),
    /** Exactly one arm's columns are present, and every arm opens with `IS NOT NULL` (0172). */
    check(
      "case_study_outcome_metric_kind_ck",
      sql`(kind = 'count'
           AND count_amount IS NOT NULL
           AND count_amount >= 0
           AND money_amount_cents IS NULL
           AND money_currency IS NULL
           AND basis_points IS NULL)
          OR (kind = 'money'
              AND money_amount_cents IS NOT NULL
              AND money_amount_cents >= 0
              AND money_currency IS NOT NULL
              AND money_currency IN ('USD', 'INR')
              AND count_amount IS NULL
              AND basis_points IS NULL)
          OR (kind = 'percentage'
              AND basis_points IS NOT NULL
              AND count_amount IS NULL
              AND money_amount_cents IS NULL
              AND money_currency IS NULL)`,
    ),
    check(
      "case_study_outcome_metric_label_ck",
      sql`position >= 0
          AND char_length(label) BETWEEN 1 AND 60
          AND lower(btrim(label)) NOT LIKE 'name withheld%'`,
    ),
  ],
);

/**
 * Where a figure came from.
 *
 * OUTBOUND, SO https ONLY — there is no same-site case for a citation. A source is a label AND a
 * publisher, which is the whole reason this is not a bare link: "Name the source of a number. An
 * unattributed figure reads as invented on this product, because on comparable products it usually
 * is."
 *
 * ⚠️ THE URL INDEX IS `btrim(url)` AND CASE-SENSITIVE, deliberately laxer than the form. The form
 * compares URLs lowercased, which is wrong — a URL path is case-sensitive — so two addresses the
 * form calls the same are two addresses. Being laxer than the form is the safe direction; being
 * stricter would turn an accepted draft into an untranslatable 23505.
 */
export const caseStudySource = pgTable(
  "case_study_source",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    caseStudyId: text("case_study_id")
      .notNull()
      .references(() => caseStudy.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    publisherLabel: text("publisher_label").notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    uniqueIndex("case_study_source_position_uidx").on(table.caseStudyId, table.position),
    /** The detail page keys its source list by address. */
    uniqueIndex("case_study_source_url_uidx").on(table.caseStudyId, sql`btrim(url)`),
    check("case_study_source_url_ck", externalUrlCheck("url")),
    check(
      "case_study_source_text_ck",
      sql`position >= 0
          AND char_length(label) BETWEEN 1 AND 120
          AND char_length(publisher_label) BETWEEN 1 AND 80`,
    ),
  ],
);

/**
 * One lesson this one links to — a case-study-to-case-study edge, the only intra-arm reference on
 * this surface.
 *
 * ⚠️ IT IS A REAL FOREIGN KEY, AND `showcase_launch.built_from_blueprint_slug` IS NOT A PRECEDENT
 * FOR DOING OTHERWISE. That column is free text because it names a teardown and there was no
 * teardown table — "a foreign key would refuse every pick". The reason does not transfer: the target
 * here is this same table. Copying the shape without the reason would be cargo-culting a workaround.
 *
 * ⚠️ THE FOREIGN KEY'S PRECONDITION IS THAT `public_slug` IS NEVER CLEARED, which is why the parent
 * says so. `ON UPDATE RESTRICT` makes an attempt to change one fail loudly rather than silently
 * rewrite everybody's links.
 *
 * ⚠️ `moderation_state` IS DELIBERATELY NOT PART OF THIS KEY. The tempting version — a composite FK
 * on `(public_slug, moderation_state)` with `ON UPDATE CASCADE` and a child CHECK pinning
 * `'published'` — would make visibility declarative and would turn "flag a popular lesson" into a
 * 23514, because the cascade propagates the new state into the child and the child CHECK fires. So:
 * THE KEY IS FOR REFERENTIAL INTEGRITY, THE SERIALIZER IS FOR VISIBILITY. A rejected or flagged
 * target keeps its slug and its edge and is dropped by the resolver, which is what the frontend
 * already promises — "an unresolvable slug is DROPPED, not rendered as a dead row".
 *
 * CYCLES ARE INTENDED — the ten fixtures carry sixteen edges including five mutual pairs — and this
 * key does not care, because the resolver is one hop deep by construction. The order is the
 * author's, which is what `position` is for: the resolver "resolves slugs; it does not rank".
 *
 * A side effect worth keeping: a PENDING case study cannot name itself, because its own
 * `public_slug` does not exist yet. Self-edges are impossible by construction for an author.
 */
export const caseStudyRelatedLesson = pgTable(
  "case_study_related_lesson",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    caseStudyId: text("case_study_id")
      .notNull()
      .references(() => caseStudy.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    relatedPublicSlug: text("related_public_slug")
      .notNull()
      .references((): AnyPgColumn => caseStudy.publicSlug, {
        onDelete: "cascade",
        onUpdate: "restrict",
      }),
  },
  (table) => [
    uniqueIndex("case_study_related_lesson_position_uidx").on(table.caseStudyId, table.position),
    /** The same lesson linked twice is a repeat the detail page would render twice. */
    uniqueIndex("case_study_related_lesson_slug_uidx").on(
      table.caseStudyId,
      table.relatedPublicSlug,
    ),
    check(
      "case_study_related_lesson_ck",
      sql`position >= 0 AND related_public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
  ],
);

export const caseStudyRelations = relations(caseStudy, ({ one, many }) => ({
  author: one(user, { fields: [caseStudy.authorUserId], references: [user.id] }),
  stats: one(caseStudyStats, {
    fields: [caseStudy.id],
    references: [caseStudyStats.caseStudyId],
  }),
  actionSteps: many(caseStudyActionStep),
  pitfalls: many(caseStudyPitfall),
  evidenceCompanies: many(caseStudyEvidenceCompany),
  outcomeMetrics: many(caseStudyOutcomeMetric),
  sources: many(caseStudySource),
  relatedLessons: many(caseStudyRelatedLesson),
}));
