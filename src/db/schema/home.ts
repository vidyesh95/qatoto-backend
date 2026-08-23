import { randomUUID } from "node:crypto";

import { relations, sql } from "drizzle-orm";
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
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { user } from "#src/db/schema/_core.js";
// A TABLE reference, so the import cycle is harmless: every cross-file foreign key here is
// a thunk that resolves long after both modules finish evaluating. `_primitives.ts`'s header
// is about eagerly-CALLED symbols, which this is not.
import { platformAuditEntry } from "#src/db/schema/platform.js";
import {
  animeAudioModeEnum,
  animeSeriesStatusEnum,
  contentReviewActionKindEnum,
  playlistVideoOrderEnum,
  playlistVisibilityEnum,
} from "#src/db/schema/_primitives.js";
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
    check("anime_series_genre_tags_ck", sql`cardinality(genre_tags) <= 20`),
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
    check(
      "video_moderation_action_reason_ck",
      sql`char_length(reason_note) BETWEEN 1 AND 2000`,
    ),
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
