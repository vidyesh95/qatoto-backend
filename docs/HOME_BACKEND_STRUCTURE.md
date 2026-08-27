# Home Feed — Backend Structure

The API contract for Qatoto's homepage (`/`): the filter chip row, the "What's on your mind?"
category tiles, the 3-video Spotlight, and the one personalized video stream that the frontend
splits into **Recommended** and **Explore**.

**Read alongside:**

- [HOME_STRUCTURE.md](HOME_STRUCTURE.md) — the frontend surface that consumes this contract.
  Section references below like "frontend §4" point there.
- [STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) — the **creator** side of the same
  `video` table. That doc owns writes; this doc owns public reads and engagement. Its Appendix A
  (deferred self-hosted video) is why every row here is a YouTube link.
- [CLAUDE.md](CLAUDE.md) — thin-client invariant, naming rules, wire-casing table.

> **Phase note: all three phases are BUILT.** This document is now a description of shipped code,
> not a proposal. Where the implementation departs from what was originally specified, the section
> says so inline under a **SHIPPED AS** note and gives the reason — those are decisions, and the
> reasoning is what stops the next reader "correcting" the code back into a bug. Every such note was
> written after a section-by-section audit of this document against the source.

---

## 0. The five rules this domain does not bend

**Rule 1 — Every byte from a viewer is attacker-controlled.** The watch-progress beacon is the
only unauthenticated write on the platform. It is not a measurement, it is a **claim** about a
measurement, and it is clamped server-side before it touches anything that ranks (§3). A creator
who edits the beacon payload in DevTools must not be able to promote their own video.

**Rule 2 — Scoring is integer-only and deterministic.** No floats, no `Math.exp`, no
`Math.random()`, no `Date.now()` outside the tick layer. Two runs over the same data produce
bit-identical scores, which is what makes a ranking bug reproducible instead of folklore. This
copies `src/modules/rnd/opportunity-score.ts` exactly and for exactly the same reason.

**Rule 3 — There is one feed ranking route.** `GET /feed/videos` returns one ranked page.
Recommended and Explore are a **frontend slice** of that page (frontend §5), not two response
fields. One ranking contract, one cache story, one place a ranking bug can live. Spotlight is the
**exception**: it is admin-curated via `GET /spotlight/videos` (up to three catalogue videos set
at `PUT /spotlight/admin/slots`), not `?mode=trending&limit=3`. The Trending chip still uses
`mode=trending` on the feed route.

**Rule 4 — A view is not a watch.** `viewCount` counts arrivals. `completionBasisPoints` measures
watching. Only the second one ranks, and **only when it came from a signed-in session** (§8).
Conflating the two is how a feed gets farmed.

**Rule 5 — Absence is not zero.** A video with no completion samples does not score 0 on
completion; its completion budget is redistributed (§4.2). A category a user has never watched is
not affinity 0; it falls back to platform popularity (§4.4). Fabricating a zero for missing data
is the same error as fabricating a value the server returned as `null`.

---

## 1. What exists today, and what it can't do

| Piece                                                        | Location                             | State                                                                            |
| ------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------- |
| `video` table, ~50 columns                                   | `src/db/schema.ts:9383`              | ✅ built, YouTube-first                                                          |
| `videoSource` / `youtubeVideoId` + charset CHECK             | `schema.ts:9280`, `:9513-9521`       | ✅ — the CHECK is a **security** constraint, it closes SSRF at the storage layer |
| Owner-scoped `/videos` CRUD, publish, review                 | `src/modules/studio/videos/videos.routes.ts:38-120` | ✅ built, **all `requireAuth`**                                                  |
| `contentReviewAction` audit log, anime review queue          | `schema.ts:9831`                     | ✅ built                                                                         |
| **Any public read route**                                    | —                                    | 🚫 does not exist                                                                |
| **Taxonomy** (categories with slugs + images)                | —                                    | 🚫 `video.category` is nullable free text                                        |
| **Engagement** (view, like, comment, share, save, subscribe) | —                                    | 🚫 no tables at all                                                              |
| **Ranking / recommendation**                                 | —                                    | 🚫 nothing                                                                       |

Three properties of the existing table shape everything below:

1. **`durationSeconds` is NULL on every row.** YouTube's oEmbed returns no duration. Completion
   rate — the single most predictive signal in a short-form ranker — has no denominator. §3.3 is
   how we get one.
2. **`category` is free text and unindexed.** Filtering on it would be a `LIKE` over a column
   nobody validated. §2 replaces it.
3. **`visibility: "investor_only"` and `isNdaRequired` are refused for YouTube rows** by
   `video_gating_ck` (`schema.ts:9525`). A YouTube video cannot be gated — the bytes are on
   youtube.com. The candidate pool therefore only ever sees `public`.

---

## 2. Taxonomy — `content_category` + `video_category`

A **table**, not a `pgEnum`. Same call, same reasoning as `researchCategory`
(`schema.ts:833`): categories carry an image and a display order, they get added and retired by
product decision rather than by schema change, and an enum cannot hold a `imageUrl`.

```ts
export const contentCategory = pgTable(
    "content_category",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => randomUUID()),
        // Kebab-case, server-generated, public, and linked the moment it exists —
        // therefore UNWRITABLE after creation (CLAUDE.md wire-casing table).
        slug: text("slug").notNull(),
        label: text("label").notNull(),
        // The tile image for "What's on your mind?". Not nullable: a tile with no
        // image is a broken tile, and the empty state is "no categories", not
        // "a category with a hole in it".
        imageUrl: text("image_url").notNull(),
        sortOrder: integer("sort_order").notNull(),
        isActive: boolean("is_active").default(true).notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (table) => [
        uniqueIndex("content_category_slug_unq").on(table.slug),
        // The only read pattern: the chip row and the tile grid, both ordered.
        index("content_category_active_order_idx").on(table.isActive, table.sortOrder),
        check("content_category_slug_ck", sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    ],
);
```

```ts
export const videoCategory = pgTable(
    "video_category",
    {
        videoId: text("video_id")
            .notNull()
            .references(() => video.id, { onDelete: "cascade" }),
        // RESTRICT, not cascade: deleting a category that videos still use should
        // fail loudly. Retiring one is `isActive = false`, which is reversible.
        categoryId: text("category_id")
            .notNull()
            .references(() => contentCategory.id, { onDelete: "restrict" }),
    },
    (table) => [
        primaryKey({ columns: [table.videoId, table.categoryId] }),
        // The feed filter reads category -> videos. Without this it is a seq scan.
        index("video_category_categoryId_idx").on(table.categoryId, table.videoId),
    ],
);
```

**Max 3 categories per video**, enforced in the service — a cardinality bound across rows is not
expressible as a table CHECK, and pretending otherwise with a trigger buys nothing here.

### 2.1 The seed set

Taken from the two places the frontend already names categories, minus the ones nothing can be
tagged into:

- **The 12 tiles** (`all-content.tsx:268-341`): Manufacturing, Robotics, Immortality, Magic, Toys,
  Teleportation, Fusion Energy, Quantum Computing, Neural Interfaces, Space Mining, Nanotech,
  Space Jump Gate.
- **The topical chips** (`filter.tsx:7-30`): Gaming, Music, Cosplay, AI, Research, Hardware,
  Electronics, Sports, Animated, Shopping, News.
- **Dropped:** `Minimalist`, `Retro`, `Precision`, `Upcoming`. These describe an aesthetic or a
  time, not a subject. A creator cannot reliably tag into them and a ranker cannot learn from them.
- **Dropped:** `Live` — see §5.3.

Seeded by `scripts/seed-content-categories.ts`, idempotent on `slug`.

### 2.2 What happens to `video.category`

The existing nullable free-text column is **deprecated, not dropped**. Writes stop; a one-shot
backfill maps the distinct existing values onto `videoCategory` rows where a confident match
exists and leaves the rest alone; the column keeps a schema comment saying it is dead and which
release removes it. Dropping a column in the same migration that replaces it is how you find out
in production that something still read it.

The studio create/update schemas gain `categoryIds: string[]`, max 3, each validated to exist and
be `isActive`. See [STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) §4.

---

## 3. Engagement

### 3.1 Tables

| Table                 | Key                                                                                                           | Notes                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `videoViewSession`    | `id`; **unique `(videoId, viewerFingerprint, viewDayBucket)`**                                                | One row per viewer, per video, per UTC day. That constraint is the anti-replay boundary — see §3.2.                                             |
| `videoLike`           | PK `(videoId, userId)`, **reverse index `(userId, videoId)`**, listing index `(userId, createdAt DESC, videoId DESC)` | The reverse index is what turns "which of these 24 cards have I liked?" into one join. Copies `researchProgramPostReaction` (`schema.ts:8621`). The listing index carries `createdAt`, which the reverse one does not — §5.2d. |
| `videoSave`           | PK `(videoId, userId)`, index `(userId, createdAt, videoId)`                                                  | Watch-later. Its viewer index leads with `createdAt` where `videoLike`'s does not, because a saved list is RENDERED and a like set is only probed — which is why §5.2d's listing needed no new index here. |
| `videoComment`        | `id`; index `(videoId, createdAt DESC) WHERE parent_comment_id IS NULL`, index `(parentCommentId, createdAt)` | One level of threading only. `isDeleted` + `deletedAt` tombstone so deleting a parent does not orphan its replies. `body` CHECK length 1..2000. |
| `videoCommentLike`    | PK `(commentId, userId)`                                                                                      |                                                                                                                                                 |
| `videoShare`          | `id`; index `(videoId, createdAt)`                                                                            | `channel` enum, `userId` nullable.                                                                                                              |
| `creatorSubscription` | PK `(subscriberId, creatorId)`, reverse index, listing index `(subscriberId, createdAt DESC, creatorId DESC)`, CHECK `subscriber <> creator` | The listing index is §5.2d's; neither the PK nor the reverse index carries `createdAt`.                                                          |
| `videoPlaybackError`  | `id`; unique `(videoId, viewerFingerprint, reportDayBucket)`                                                  | Feeds the fast dead-player path, §8.2.                                                                                                          |
| `videoStats`          | PK `videoId`                                                                                                  | Counter cache. §3.4.                                                                                                                            |
| `creatorStats`        | PK `userId`                                                                                                   | `subscriberCount`, `publishedVideoCount`, `totalViewCount`.                                                                                     |
| `videoNotInterested`  | PK `(viewerId, videoId)`, index `(videoId)` for the FK cascade                                                | §5.2b. **Viewer leads**, unlike `videoLike` — the only read is the feed's per-viewer probe. No counter, by design.                              |
| `creatorMute`         | PK `(muterId, creatorId)`, index `(creatorId)` for the cascade, CHECK `muter <> creator`                       | §5.2b. The inverse of `creatorSubscription` and NOT its mirror: no `creatorStats` counter moves, because a public mute count is hostile.        |

New enums, snake_case labels per the repo rule:

```ts
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
// SHIPPED AS: not created. `feedMode` backs a QUERY PARAMETER and no column stores it, so a
// pgEnum here would be a Postgres type nothing can be assigned to — and a migration nobody can
// reverse cheaply. It lives as a TypeScript `as const` array, `FEED_MODES` in
// src/modules/home/feed/feed.service.ts, with the same snake_case labels so the wire contract is unchanged.
```

### 3.2 `viewerFingerprint` — identifying an anonymous viewer without storing them

```text
viewerFingerprint = sha256(dailyRotatingSalt || clientIp || userAgent)
```

> **SHIPPED AS: branched on identity.**
>
> ```text
> signed in : sha256(secret || "videoview" || utcDay || "u:" || userId)
> anonymous : sha256(secret || "videoview" || utcDay || "a:" || clientIp || userAgent)
> ```
>
> The formula above is wrong for signed-in viewers and wrong SILENTLY. Two people in one office,
> on the same browser build, hash identically — so the unique index below collapses them into ONE
> `videoViewSession` row. Whoever arrives first owns the row and its `viewerId`, and the second
> person's watch time is credited to the first, straight into `completionBasisPointsSum`: the
> component carrying 40 of ranking's 100 points. That is a correctness bug in the ranker's most
> important input, not a privacy nicety.
>
> The salt is derived (`BETTER_AUTH_SECRET` + the UTC day string) rather than stored. It still
> rotates daily, is still not persisted beside the hash, and the raw IP is still never written —
> and a deployment that forgot a dedicated env var cannot silently fall back to an empty salt.
> `src/lib/viewer-fingerprint.ts`.

The salt rotates daily and is not persisted alongside the hash. **The raw IP is never written to
the database.** The fingerprint is not an identity, it is a per-day bucket key whose only jobs are
(a) making the unique index above meaningful for logged-out viewers and (b) giving an anonymous
visitor a session-scoped affinity (§4.4) so their feed responds to what they watch.

`videoViewSession` rows are aggregated into `videoStats` and **deleted at 90 days** by
`prune-engagement-data` (§6). The counters survive; the per-viewer rows do not.

### 3.3 The beacon, and how it is clamped

`POST /videos/:videoId/view-beacon`, `attachOptionalUser`, `viewBeaconLimiter` (the tightest
limiter on the platform — it is the only unauthenticated write).

Body: `{ positionSeconds: number, reportedDurationSeconds: number, feedSource: videoFeedSource }`.

The client sends a heartbeat roughly every 15s while the YouTube player reports "playing"
(frontend §6). The server treats the payload as a claim:

```text
elapsed   = now - session.lastBeaconAt
rawDelta  = positionSeconds - session.maxPositionSeconds
delta     = clamp(rawDelta, 0, min(elapsed + GRACE_SECONDS, BEACON_INTERVAL_SECONDS + GRACE_SECONDS))

watchedSeconds     += delta
maxPositionSeconds  = max(maxPositionSeconds, positionSeconds)
completionBp        = min(10000, watchedSeconds * 10000 / max(1, reportedDurationSeconds))
isCountedView       = watchedSeconds >= 10 OR completionBp >= 3000
```

Every clause is load-bearing:

- **`delta` is bounded by wall-clock elapsed.** A client claiming it advanced 600 seconds in a
  15-second window gets 20. You cannot watch a video faster than time passes.
- **`delta` is floored at 0.** Seeking backwards adds nothing. Seeking forwards adds nothing
  beyond the wall-clock bound, so scrubbing to the end does not manufacture a completion.
- **`reportedDurationSeconds` is pinned on the first beacon** and bounded to 1..43200. Later
  beacons that disagree are ignored, so a client cannot shrink the denominator mid-session to
  inflate its own completion rate.
- **`isCountedView` flips once**, and the transition is what increments `videoStats.viewCount`.
  Re-flipping is a no-op, so beacon count and view count are not the same number.

**Duration, solved by consensus.** `video.durationSeconds` is NULL for YouTube rows, so
`reportedDurationSeconds` is the only source — and it comes from the hostile side. The nightly
`recompute-video-durations` job takes the **median** across ≥5 distinct sessions and writes that
to `video.durationSeconds`. A median over five independent untrusted clients is not
trustworthy in the cryptographic sense; it is trustworthy enough to divide by, and it is the best
available while the bytes live on someone else's CDN.

### 3.3a Watch time and activity — three rollups

The beacon already produces real, clamped watch seconds. Two things it does **not** produce, and
this section is both of them.

**Nothing survives 90 days.** `video_view_session` rows are deleted at
`VIEW_SESSION_RETENTION_DAYS`, so "how long have I watched this year" is unanswerable a quarter of
the way into the year. **And nothing carries an hour.** A session row spans a whole UTC day, so
attributing its seconds to the hour of its last beacon would file a three-hour evening sitting
into one bucket. That histogram would not be missing; it would be *wrong, plausibly*, which is
worse.

| Table | Grain | Written by | Retention |
| --- | --- | --- | --- |
| `user_activity_hour` | user × UTC date × UTC hour | `recordViewBeacon`, per beacon | `ACTIVITY_HOUR_RETENTION_DAYS` (90) |
| `user_watch_daily` | user × UTC date | `rollup-user-watch-activity`, nightly | `WATCH_ROLLUP_RETENTION_DAYS` (762 — 25 months) |
| `platform_activity_hour_daily` | UTC date × hour, **no user id** | same job, same scan | 762 |

**The hour counter is per-user rather than a 24-row platform counter on purpose.** Twenty-four
rows incremented by every beacon on the site is a lock hotspot on the hottest write path there
is. Per-user rows spread the contention and are also the grain the "who has gone quiet" segment
needs; the aggregate is derived nightly, which is the cheap direction.

**Signed-in only.** The insert is gated on the same `viewerId !== null` expression §8.1 Rule 2
uses, reused rather than re-derived so "does this move the ranker" and "does this become a
behavioural record" cannot drift apart. A fingerprint is a per-day bucket key over an IP and a
user agent; an hour-by-hour profile keyed on one describes a coffee shop. **Every surface built
on this has to say that signed-out watching is not counted.**

**`ACTIVITY_HOUR_RETENTION_DAYS` equals `VIEW_SESSION_RETENTION_DAYS`, and must stay equal.** The
hour table is *finer*-grained than the sessions it derives from — it says which hour of which day
a named account was watching — so a longer horizon there would quietly undo §3.2's promise by
keeping a sharper record after the blunter one was deleted.

**Cron ordering is the correctness argument.** `rollup-user-watch-activity-tick` runs at `40 4`,
fifteen minutes before `prune-engagement-data` at `55 4`. Reversed, on exactly the days that
matter it would aggregate rows that had just been deleted and write zeros over a real history.
Ordering between jobs in this codebase is expressed by cron minute and nothing else.

**Reads draw one fixed boundary.** The hour table answers for the last 90 days, the rollup for
everything older. Not "prefer the rollup" — that would make today's number wrong for the twenty
hours before the job next runs — and not "prefer the live table", which would double count. The
boundary is derived from the retention constant, so it moves if that does.

`GET /users/me/watch-time` is the viewer's own read: four totals, a 30-day series, a 24-bucket
histogram. Optional `?timeZone=` decides where a day starts and is trusted for nothing else — a
display preference in the sense CLAUDE.md means. An account with no rows gets **`null`, never
`0`**: zero means "we watched you watch nothing".

`/admin/metrics/*` is five reads behind `view_platform_metrics`, held by `admin` alone. Four are
aggregates that name nobody. The fifth, `GET /admin/metrics/users`, returns named accounts and is
**the one read in the platform audit chain** — looking at a behavioural dossier the subject
cannot see being assembled is an exercise of authority even though it changes nothing. The
aggregates are deliberately unaudited; stamping the chain on every dashboard refresh would bury
the entries that name a person.

**Churn has one definition**, in `engagement-retention.ts` and nowhere else: active means at least
one `user_watch_daily` row in the period, churned means active in the previous period and absent
from this one, `INACTIVITY_CHURN_DAYS = 30`. Watching is the only per-user per-day activity this
platform records — nothing writes a last-seen — so it is the only honest basis for the word.

> ⚠️ `ENGAGEMENT_PRUNE_ENABLED` still defaults to **false**, so the 762-day horizon, like the
> 90-day one, is a policy expressed in code that nothing currently enforces.

### 3.4 `videoStats` — counter cache, in-transaction

```ts
export const videoStats = pgTable("video_stats", {
    videoId: text("video_id")
        .primaryKey()
        .references(() => video.id, { onDelete: "cascade" }),
    viewCount: integer("view_count").default(0).notNull(),
    uniqueViewerCount: integer("unique_viewer_count").default(0).notNull(),
    likeCount: integer("like_count").default(0).notNull(),
    commentCount: integer("comment_count").default(0).notNull(),
    shareCount: integer("share_count").default(0).notNull(),
    saveCount: integer("save_count").default(0).notNull(),
    totalWatchedSeconds: bigint("total_watched_seconds", { mode: "number" }).default(0).notNull(),
    // Sum + count, never a stored average: an average is a float, and Rule 2 says no floats.
    // The mean is computed at read time by integer division.
    completionBasisPointsSum: bigint("completion_bp_sum", { mode: "number" }).default(0).notNull(),
    completionSampleCount: integer("completion_sample_count").default(0).notNull(),
    lastEngagementAt: timestamp("last_engagement_at"),
});
```

Every counter moves **in the same transaction as the row that caused it**, exactly like
`projectStats` (`schema.ts:1010`). A like that commits without its counter is a like that
disappears from the UI until a job runs, and the job that would fix it is the job we are trying
not to need.

`completionBasisPointsSum` only accumulates from sessions where `viewerId IS NOT NULL` — see §8.1.

---

## 4. Ranking

Three new pure modules beside `src/modules/rnd/opportunity-score.ts`: `feed-score.ts`, `trending-score.ts`,
`affinity-score.ts`. Same shape as the existing scorers — exported component budgets, a
module-load assertion that they sum to 100, step ladders instead of curves, integers throughout.

### 4.1 Video quality — nightly, per video, 0..100

| Component        | Budget | Ladder input                                                      |
| ---------------- | ------ | ----------------------------------------------------------------- |
| `completionRate` | 40     | `completionBasisPointsSum / completionSampleCount`                |
| `engagementRate` | 25     | `(likes + comments + shares + saves)` per 1000 **unique viewers** |
| `viewVelocity`   | 20     | counted views in the first 48h                                    |
| `creatorTrack`   | 10     | the creator's median quality across their published videos        |
| `freshnessFloor` | 5      | published < 72h → the full 5                                      |

Completion first is the Douyin lean, and it is the right lean: it is the only component that
measures whether the video was _good_, as opposed to whether it was _clicked_.

Engagement divides by **unique viewers, not views**. This is the cheapest structural defence
against a creator inflating their own denominator, and it costs one extra column.

### 4.2 The sample ramp — Rule 5 applied

A new video has no completion samples. Scoring it 0 on a 40-point component means it can never
rank, which means it never gets watched, which means it never gets samples. The obvious fix — a
cliff at 5 samples — just moves the discontinuity somewhere visible.

```text
completionWeight = 40 * min(completionSampleCount, 20) / 20      // integer
remainder        = 40 - completionWeight
// redistributed across the other four budgets in proportion to their own weights
```

At 0 samples the video is scored purely on engagement, velocity, creator track and freshness. At
20 samples completion carries its full 40. In between it ramps. No cliff, no video pinned at zero.

### 4.3 Feed rank — query time, per viewer × video, 0..100

| Component         | Budget | Source                                                                                                                                |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `videoQuality`    | 35     | `videoQualityScoreSnapshot`                                                                                                           |
| `topicAffinity`   | 25     | max over the video's ≤3 categories                                                                                                    |
| `creatorAffinity` | 15     | `userCreatorAffinitySnapshot`                                                                                                         |
| `recency`         | 15     | hours since `publishedAt`: `<6→15, <24→13, <72→10, <168→7, <336→4, <720→2, else 0`                                                    |
| `exploration`     | 10     | `hash(rankSeed, videoId) % 8` (0..7) **plus 3** when the viewer has no affinity in any of the video's categories — 7 + 3 = the budget |

> **SHIPPED AS.** `videoQuality` reads the denormalized `videoStats.qualityScorePoints` mirror
> rather than joining `videoQualityScoreSnapshot` — the feed already joins `videoStats` for its
> counters, and resolving "which snapshot generation is current" per request would be a second
> query on the hottest read on the platform. The snapshot remains the auditable record.
>
> The exploration hash is **md5**, not `hashtext`: `hashtextextended` is an undocumented Postgres
> internal whose output is not contracted across versions, and a ranking that reshuffles on a minor
> server upgrade is exactly the irreproducibility Rule 2 forbids. Seven hex characters cast through
> `bit(28)::int` so the value is always non-negative — `abs(-2147483648)` raises in Postgres.
>
> `?mode=new_to_you` does not simply add 30 to exploration. It uses a SECOND budget table —
> quality 35, topicAffinity 10, creatorAffinity 0, recency 15, exploration 40 — which still sums
> to 100. Adding 30 while leaving the rest alone would let the rank reach 130 in a module whose
> whole discipline is that budgets sum to 100. Taking it from the two affinity components is also
> what the mode _means_: stop ranking on how deep in the bubble you already are.

**`rankSeed = hash(userId ?? viewerFingerprint, asOfDay)`**, echoed in every response and accepted
back on the next page request. This is what makes exploration deterministic — Rule 2 forbids
`Math.random()`, and it would be wrong here anyway: a random exploration term reshuffles the feed
between page 1 and page 2 and shows the same video twice.

### 4.3b The negative signal — what "not interested" teaches the ranker

Shipped in `0131_affinity_negative_signal`. Until then the two feed preferences (§5.2b) were a
query-time `NOT EXISTS` and **nothing else**: the dismissed video vanished and the ranker learned
nothing from the dismissal, so the feed kept serving the same kind of video. The hard filter is
unchanged — this is additive.

| Table column | Meaning |
| --- | --- |
| `negative_signal_count` | dismissals in this category / on this creator, **plus `MUTE_SIGNAL_WEIGHT` per mute** |
| `negative_signal_component_points` | the penalty **actually applied**, already clamped |

**It is a SUBTRAHEND, not a fourth component.** `AFFINITY_SCORE_COMPONENT_BUDGETS` still holds
three entries summing to 100 and `assertBudgetsSumTo` still passes; `NEGATIVE_SIGNAL_BUDGET_POINTS`
(40) is separate and claws back from that ceiling. Both snapshot CHECKs were rewritten to
`watch + completion + explicit − negative = affinity_points`, so the identity is enforced at rest:
an insert that gets the arithmetic wrong is a `23514`, not a bad recommendation discovered months
later.

**Stored already clamped** — `min(rawLadderPoints, positiveTotal)`. That is what keeps the identity
exact for a viewer whose penalty exceeds their positives, and it makes the floor a real zero rather
than a negative score. Zero is not nothing here: §4.4's fallback is a `COALESCE`, so a stored 0
suppresses HARDER than an absent row, which reaches damped popularity instead.

> **THE LADDER IS DELIBERATELY SHALLOW AT THE BOTTOM.** One dismissal costs 2 points of 100; it
> takes about a dozen in one category to spend the 40. The shape follows the only public
> measurement of these controls anywhere — Mozilla's RegretsReporter (Sept 2022) found YouTube's
> "don't recommend channel" cut unwanted recommendations ~43% while "not interested" managed
> ~11%. A single idle tap must not visibly reshape a feed: the person who made it cannot tell
> which tap did what, and a control whose effect they cannot predict is one they stop trusting.
>
> **A MUTE NEVER TOUCHES TOPIC AFFINITY, and this is the load-bearing rule.** `MUTE_SIGNAL_WEIGHT`
> is 12 — the ladder's top rung — so one mute spends the whole budget, mirroring
> `SUBSCRIPTION_SIGNAL_WEIGHT` with the sign flipped. But it is only ever set on a CREATOR row.
> Muting one anime channel is not a statement about anime, and demoting someone's whole subject
> matter because they silenced one loud channel is a control that lied about what it does. The
> topic call passes `isCreatorMuted: false` exactly as it already passes
> `isSubscribedToCreator: false`. The commerce side holds the same line: blocking a supplier does
> not hide their product category.
>
> **NO LOWER TIME BOUND**, matching `like_count` / `save_count` rather than the 90-day view window.
> A dismissal is a standing request the viewer never withdrew — and since
> `GET /users/me/not-interested-videos` now exists, they CAN withdraw it. Honouring an old request
> is correct once withdrawing it is possible; before that route it would have been a trap.
>
> **TWO LIMITS, ACCEPTED.** A penalty only lands where a snapshot row already exists, because the
> job's `FROM` is `video_view_session` — a category dismissed but never watched gets no damping,
> and widening that `FROM` would start writing rows whose only evidence is negative, which given
> the `COALESCE` above is a much larger ranking change than it looks. And un-muting takes up to one
> nightly cycle to stop damping; the hard filter lifts instantly, which is the half the viewer sees.
>
> The anonymous in-request path (§4.4) passes `dismissalCount: 0` — **a limitation, not a fact**,
> unlike the `likeCount: 0` beside it. Like and save are gated by `requireIdentifiedUser` so an
> anonymous session truly cannot have them; the preferences are not, so it can. That path is keyed
> on a fingerprint and the preferences are keyed on a user id, and one score must not consult two
> identity models. The `NOT EXISTS` still hides the videos themselves.

`score_algorithm_version` is written as **2** by the job from here on, explicitly rather than via
the column default. The default stays **1** because that is what the existing rows were computed
with, and moving it would retroactively relabel them.

### 4.4 Cold start, all three kinds

**Signed-in viewer with no history.** Affinity components `COALESCE` to
`platformCategoryPopularitySnapshot * 60 / 100` — the platform's own distribution, damped, so a
new account sees a sensible feed that is not _claiming_ to be personalized. No sentinel user rows.

**Anonymous viewer.** A **session-scoped affinity**, computed in-request: join `videoViewSession`
on `viewerFingerprint`, count categories, run the same ladder. One indexed join. An anonymous
visitor's feed starts responding after two or three watches instead of staying a flat popularity
list forever — which matters, because most first visits are logged out.

> **SHIPPED AS: a ONE-day window, not seven.** The seven was never achievable. §3.2 salts the
> fingerprint with the UTC day string, so it rotates at midnight and yesterday's sessions carry a
> different one — a 7-day query matches none of them. Writing 7 would produce a constant that reads
> like a week of history and delivers a day of it, which is the worst kind of wrong because nothing
> fails. Recovering the real week needs a stable per-visitor identifier that survives midnight, and
> that is precisely the long-lived anonymous tracking record §3.2 declined to keep.
>
> Creator affinity has **no** cold-start fallback and is a hard 0 for a viewer without a snapshot
> row: popularity is measured per category, so there is nothing to damp for a creator.

**New video.** `freshnessFloor` + `recency` + a hard **exploration quota**: **4 slots** are
reserved for videos published < 72h with < 50 counted views. This is the Douyin traffic-pool idea
in its simplest honest form. Without it, ranking is a closed loop where the already-popular stay
popular and a first upload is invisible.

> **SHIPPED AS: a promotion inside the ranking, not an injection into the page.** The quota moves
> fresh videos already present in the diversified prefix (§4.6) to its head; it never inserts a row
> the ranking placed elsewhere. Injecting would put a video on page 1 that the raw ranking also
> places on page 3, and the viewer would meet it twice. It therefore acts on the first page rather
> than on every page — which is where the traffic is, and where a closed loop actually costs a new
> upload its start.

### 4.5 Candidate pool

```sql
publishStatus = 'published'
AND visibility = 'public'
AND publishedAt <= now()
AND reviewStatus IN ('not_required', 'approved')
AND uploadStatus = 'ready'
AND isSourceVerified = true
AND creatorId <> :viewerId
AND (publishedAt > now() - interval '180 days' OR id IN (SELECT video_id FROM trending_video_snapshot WHERE as_of = :asOf))
AND NOT EXISTS (counted view by this viewer in the last 30 days)
AND NOT EXISTS (video_not_interested row for this viewer)      -- §5.2b, never relaxed
AND NOT EXISTS (creator_mute row for this viewer × this creator) -- §5.2b, never relaxed
AND moderation_visibility_state = 'visible'                      -- §5.2c, staff takedown
```

The 180-day window is what stops this becoming a full-table scan as the catalog grows; the
trending escape hatch is what stops an evergreen hit falling off a cliff at day 181.

> **SHIPPED AS.** The escape hatch tests `videoStats.trendingRank IS NOT NULL` rather than joining
> `trendingVideoSnapshot` at an `asOf` — the hourly job rewrites that column wholesale, so there is
> exactly one live trending list and no generation to pin.
>
> The already-watched exclusion keys on **`viewer_id` when the viewer is signed in**, and only
> falls back to `viewer_fingerprint` when there is no session. A 30-day lookback on a fingerprint
> that rotates daily would match nothing older than today — the exclusion would appear to work and
> quietly re-serve a signed-in viewer everything they watched last week. For an anonymous viewer
> the fingerprint is the only identity there is, so their exclusion is honestly same-day.
>
> The five status terms are written out as LITERALS, byte-identical to `video_feed_candidate_idx`'s
> predicate. Postgres uses a partial index only when it can prove the query's `WHERE` implies the
> predicate, and that proof works against literals, not bound parameters. Get it wrong and there is
> no error anywhere — just a sequential scan.

### 4.6 Diversity guard

A **pure post-rank pass** caps 2 videos per creator and 40% per category per page. Pure function,
integer, no I/O — the same discipline as `slice-math.ts`.

> **SHIPPED AS: a PERMUTATION of a fixed 96-row prefix, not a filter over `limit * 3`.**
>
> Dropping capped rows out of a `limit * 3` window breaks offset pagination outright, and it looks
> fine in any single-page test. Ranks 0..11 are fetched for a 4-row page; the cap keeps 0, 1, 4, 7
> and drops the rest; page 2 asks for offset 4 and serves ranks 4..7 — so two videos appear twice
> and four are never served at all. This was observed, not theorised.
>
> Returning a permutation removes the failure class: every input row comes out exactly once, so any
> window of the result is disjoint from any other. Rows breaching a cap are DEMOTED to the tail in
> rank order rather than discarded. The prefix is fixed at 96 rows (four pages of 24) so the cost is
> constant rather than proportional to `page`, and everything past it is the raw ranked offset.
>
> The category cap is floored at one row: `floor(2 × 4000 / 10000)` is 0, and a cap of zero per
> category is not a cap, it is a ban.

### 4.7 Starvation relaxation ladder

On a young catalog those filters can return fewer rows than `limit`. An under-filled homepage is a
real failure mode, and it must degrade in a **stated order** rather than by accident. The service
re-runs deterministically:

| Stage | Drops                                |
| ----- | ------------------------------------ |
| 0     | nothing — full filter                |
| 1     | the 30-day already-watched exclusion |
| 2     | the 180-day recency window           |

> **SHIPPED AS: three stages.** "Drop the diversity cap" is gone, because §4.6's cap is now a
> permutation and a permutation cannot under-fill a page — there is nothing to relax. The two
> stages that remain are genuine FILTERS, which are the only things that can leave a page short.
>
> The under-fill test is deliberately `pageRows.length < limit` and NOT `&& total > offset + …`.
> That second clause reads like a guard against pointless relaxation and instead makes relaxation
> unreachable: `total` is computed under the same filter as the page, so when the filter is what
> emptied the page the total is empty too. A viewer who had watched everything got a blank
> homepage and the ladder never fired.

The stage reached is recorded in the structured log, **never in the response body** — it is an
operational fact about the catalog, not something a client should branch on.

> **WHAT THE LADDER DOES NOT REACH.** §5.2b's two exclusions — `video_not_interested` and
> `creator_mute` — are pushed outside every stage gate and no stage drops them. Everything in the
> table above is a HEURISTIC, a guess about what a viewer would enjoy, and a guess is worth
> abandoning to avoid an empty page. Those two are stated preferences. A dismiss button that
> silently stops working once the catalog runs thin is worse than a short feed, because the viewer
> cannot tell it apart from a broken one.

### 4.8 Modes

| Mode                | Behaviour                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`               | The blended rank of §4.3. Default.                                                                                                                                               |
| `trending`          | `trendingVideoSnapshot` rank order. The Trending chip uses this; Spotlight is a separate curated route (`GET /spotlight/videos`).                                                |
| `recently_uploaded` | `publishedAt DESC` over the candidate pool.                                                                                                                                      |
| `new_to_you`        | `all`, with creators the viewer has already watched excluded and the exploration budget raised to 40.                                                                            |
| `watched`           | The viewer's own counted-view history, most recent first. **401 when anonymous** — serving it off a fingerprint would leak one person's history to everyone behind the same NAT. |

**`watched` is the only mode that returns `watchedAt`**, and the field is OPTIONAL rather than
nullable on `FeedVideoItem`. It is `max(first_beacon_at)` over the viewer's un-hidden counted
sessions — the same expression the mode sorts by, and they must stay the same expression, since
the client groups the list into date headers in one pass over the sorted rows. On every other
mode the key is absent, because the question was never asked; a `null` there would claim "never
watched", which the feed did not look up.

**Hidden sessions are invisible to every per-row "has this viewer watched this" question**:
`mode=watched`, §4.5's already-watched exclusion, and §4.8's new-to-you creator exclusion all
filter `hidden_from_history_at IS NULL`. So removing a video from history makes it recommendable
again, and clearing history resets the new-to-you exclusion — both deliberate. The nightly
affinity snapshots do NOT filter it; they are aggregates on a schedule, so a hide reaches them on
the next run at the earliest.

---

## 5. Routes

### 5.1 Feed — `src/modules/home/feed/feed.routes.ts`, `attachOptionalUser`

| Method | Path               | Limiter                 | Returns                                                                           |
| ------ | ------------------ | ----------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/feed/categories` | `feedCategoriesLimiter` | `[{ slug, label, imageUrl, sortOrder }]` — powers both the chip row and the tiles |
| `GET`  | `/feed/videos`     | `feedReadLimiter`       | One ranked page + `pagination` + echoed `rankSeed`                                |

```ts
const ListFeedVideosQuerySchema = z
    .object({
        mode: z.enum(FEED_MODES).default("all"),
        categorySlug: z.string().regex(SLUG_PATTERN).optional(),
        page: z.coerce.number().int().min(1).max(200).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(24),
        // Echoed from a previous response so page 2 ranks against the same seed as
        // page 1. Absent on a first request; minted server-side and returned.
        rankSeed: z.string().length(32).optional(),
    })
    .strict();
```

**Pagination is offset, not cursor.** A cursor needs a stable sort key and rank is not one — a
keyset over a value that is recomputed per request silently reshuffles page 2. Offset plus a
pinned `rankSeed` gives stability for the length of a session, which is the actual requirement.

Every item carries per-viewer state, computed in the same query by LEFT JOIN on the reverse
indexes of §3.1:

```jsonc
{
    "videoId": "…",
    "youtubeVideoId": "dQw4w9WgXcQ",
    "title": "…",
    "thumbnailUrl": "…",
    "publishedAt": "2026-07-30T09:12:00.000Z", // ISO, never a pre-formatted label — see frontend §3
    "durationSeconds": 412, // null until the median job has ≥5 samples
    "creator": { "id": "…", "handle": "…", "name": "…", "imageUrl": "…" },
    "categories": [{ "slug": "robotics", "label": "Robotics" }],
    "stats": { "viewCount": 25120, "likeCount": 840, "commentCount": 61 },
    "viewerState": { "hasLiked": false, "hasSaved": false, "isSubscribedToCreator": true },
}
```

`viewerState` is embedded, **never a second round trip**. Twenty-four cards must not become
twenty-five requests.

> **SHIPPED AS: no `creator.isVerified`.** No creator-verification concept exists anywhere in the
> schema — `talentProfileSkill.isVerified` is a skill badge on a different subsystem. A hard-coded
> `false` on a trust signal is a claim the platform cannot support, so the key is absent rather
> than present and meaningless. Same call on `GET /feed/watch/:videoId`.

### 5.2 Engagement — `src/modules/home/engagement/engagement.routes.ts`

| Method             | Path                              | Auth                   | Limiter                |
| ------------------ | --------------------------------- | ---------------------- | ---------------------- |
| `POST`             | `/videos/:videoId/view-beacon`    | optional               | `viewBeaconLimiter`    |
| `POST`             | `/videos/:videoId/playback-error` | optional               | `playbackErrorLimiter` |
| `PUT` / `DELETE`   | `/videos/:videoId/like`           | required               | `videoLikeLimiter`     |
| `PUT` / `DELETE`   | `/videos/:videoId/save`           | required               | `videoSaveLimiter`     |
| `POST`             | `/videos/:videoId/share`          | optional               | `videoShareLimiter`    |
| `GET`              | `/videos/:videoId/comments`       | optional               | `feedReadLimiter`      |
| `POST`             | `/videos/:videoId/comments`       | required + idempotency | `commentCreateLimiter` |
| `PATCH` / `DELETE` | `/comments/:commentId`            | required               | `commentUpdateLimiter` |
| `PUT` / `DELETE`   | `/comments/:commentId/like`       | required               | `commentLikeLimiter`   |
| `PUT` / `DELETE`   | `/creators/:creatorId/subscribe`  | required               | `subscribeLimiter`     |
| `GET`              | `/feed/watch/:videoId`            | optional               | `feedReadLimiter`      |
| `GET`              | `/channels/:handle`               | optional               | `feedReadLimiter`      |
| `GET`              | `/channels/:handle/videos`        | optional               | `feedReadLimiter`      |

Comment create is wrapped in `src/middleware/idempotency.ts` — a double-tapped submit button must
not post twice.

> **SHIPPED AS.** The four toggles are `PUT`/`DELETE`, not `POST`/`DELETE`. Each has a per-user
> unique key, so both verbs are idempotent by construction and a double-tap on a slow connection is
> harmless rather than a second like — the call `research-programs.routes.ts` already made for post
> reactions. They carry no body and therefore no body cap.
>
> Every authenticated write additionally carries `requireIdentifiedUser`. `anonymous()` mints real
> sessions, so `requireAuth` alone admits unlimited throwaway identities into counters that feed
> ranking.
>
> `POST /share` stays optional-auth and always writes a row, but moves `videoStats.shareCount`
> **only for a signed-in sharer** — share count feeds §4.1's engagement rate, and §8.1's rule about
> anonymous traffic not moving ranking inputs applies to it as much as to completion.

`GET /feed/watch/:videoId` is the public watch payload. It replaces the frontend's legacy
`src/lib/videos.ts` / `QATOTO_VIDEO_API_URL` path entirely (frontend §8).

> **TWO FIELDS LANDED AFTER §14: `seasons` AND `attachedProducts`.** Both close the same shape of
> gap — data this platform already held, reachable through no public read.
>
> **`seasons` — the anime catalogue, and it needed a NEW public read.** All eleven `/series` routes
> are `requireAuth` and owner-scoped, correctly: `getSeries` returns unreleased episode titles,
> premiere dates and the production schedule. So a viewer on a watch page had no way to learn the
> episode belonged to a series at all, which is why the frontend's season picker was a hardcoded
> placeholder. `loadPublicSeasonsForVideo` is that read, and it is deliberately NOT a route: this
> payload is assembled in one round trip, and the watch page does not learn the series id until the
> first read returns — a `GET /series/:seriesId` would leave the picker permanently one request
> behind its own player.
>
> **`null` and `[]` both mean something.** Null is "not part of a series" — every pitch, demo and
> unaffiliated video. `[]` is a series none of whose episodes are public yet. The client hides the
> picker for one and renders an empty catalogue for the other.
>
> **ONLY PUBLICLY-SERVABLE EPISODES ARE LISTED, and the visible consequence is intended.** An
> episode in review, hidden by a moderator, or with no video yet is omitted entirely — not greyed,
> not titled-without-a-link. Titles are content, and a season picker naming next week's episode is
> an oracle over an unreleased catalogue, which is precisely what this route's 404-covers-everything
> gate exists to prevent. So episode numbers can have gaps. `isPremium` is NOT projected either:
> the column exists, no entitlement model does, and a lock over an episode that plays for free is a
> claim this backend cannot support.
>
> **`attachedProducts` — the read half of a write that already shipped.** `PUT /videos/:videoId/products`
> has written `video_attached_product` with ownership re-verified since the studio landed, and the
> old "deliberately absent" note at the foot of `video-watch.service.ts` recorded surfacing it as a
> follow-up. Each entry is **re-checked for public eligibility at read time** through the store's own
> `resolveEligibleProductCardsByIds`, not trusted from the join row: a seller can unpublish the
> listing, delist the organization or be moderated down, none of which touches the join table. The
> list gets shorter rather than growing a dead card, and the join row survives so re-publishing
> brings it back. `[]` rather than `null` here, unlike `seasons` — every video can carry products,
> so there is no absent-versus-empty distinction to make.

> **`documents` — a third field, and the same shape of gap again.** `video_document` had existed
> since the studio schema did and was read by the STUDIO owner projection and by nothing else, so a
> viewer could never see one. That was half of why the studio's "Attach documents" control was a
> promise nothing kept; the other half was that **nothing wrote the table** (0 rows). STUDIO §6's
> three new document routes are the write half, and this is the read half.
>
> ⚠️ **`downloadPath` IS A PATH ON THIS API, NOT A LINK TO THE BYTES.** The bucket is private and
> `object_storage_key` never reaches the wire. Fetching the path re-runs this same six-term public
> gate and then `302`s to a presigned URL that lives 300 s — which is why the table has **no `url`
> column**: a stored link would keep working after the creator unpublishes the video, because bytes
> do not know a row's visibility changed. Verified live: a signed-out download 404s the moment the
> video goes private, while the owner's still 302s.
>
> **No re-eligibility pass**, unlike `attachedProducts` directly above. A document has no
> independent publication state that could drift out from under the join — it exists or it does not,
> and it dies with its video by cascade. `[]` rather than `null`, for the same reason as products.

### 5.2a Watch history — `src/modules/home/engagement/watch-history.routes.ts`

The write half of `mode=watched`: a viewer editing their own history, behind `/history`.

| Method   | Path                            | Auth     | Limiter               |
| -------- | ------------------------------- | -------- | --------------------- |
| `DELETE` | `/watch-history/videos/:videoId` | required | `watchHistoryLimiter` |
| `PUT`    | `/watch-history/videos/:videoId` | required | `watchHistoryLimiter` |
| `DELETE` | `/watch-history`                | required | `watchHistoryLimiter` |

`DELETE` on a video removes it; `PUT` is Undo. The verb pair on one path is the like/save idiom —
one nullable column with two states, so both directions are idempotent. Clear-all has no undo:
there is no per-call marker to reverse by, and "restore everything hidden" would also resurrect
every card the viewer removed on purpose over the previous 90 days.

> **ITS OWN ROUTER AND ITS OWN MOUNT, NOT `engagementRouter`.** That router mounts at `/videos`
> after the studio router, so every route in it must be two segments deep or more (§5.2, and
> `engagement.routes.order.test.ts`). Clear-all there would be `DELETE /videos/watch-history` —
> single-segment, permanently shadowed by `GET /:videoId`, failing as a 401 that reads as an auth
> bug. The collection is the viewer's anyway, not a video's.
>
> **EVERY WRITE IS A STAMP ON `hidden_from_history_at`, NEVER A `DELETE`, AND THAT IS A VIEW-COUNT
> EXPLOIT.** `video_view_session_unq (video_id, viewer_fingerprint, view_day_bucket)` is the
> anti-replay mechanism: the beacon inserts with `onConflictDoNothing`, so one viewer gets at most
> one countable session per video per UTC day. `video_stats.view_count` is incremental, bumped once
> at the `is_counted_view` flip, and §6's prune states the increment cannot be walked back. Delete a
> row on user request and the loop reopens — remove, re-watch the same day, the unique key no longer
> collides, a fresh row inserts, `view_count` increments again, repeat. The beacon limiters bound
> the rate; they do not close it. This is the same reasoning that makes §8.1's outlier prune zero
> and clear the flag rather than delete.
>
> **No error union, and no 404.** All three writes are scoped to `req.user.id` in the `WHERE`
> clause, so there is no ownership check to forget, and an unknown or never-watched `videoId`
> matches zero rows — which is the state the caller asked for. A 404 would also let any signed-in
> caller probe which uuids are real videos, which §5.4's status policy exists to prevent.
>
> Responses count SESSION ROWS, not cards: one video watched across three UTC days is three rows
> and one card. Hence `hiddenSessionCount` / `restoredSessionCount` / `clearedSessionCount` — so
> nobody renders "Cleared 41 videos" from a number that does not mean that.
>
> `PUT` returning `restoredSessionCount: 0` is a real answer the client must respect: the rows may
> have aged past the 90-day prune between the hide and the undo, in which case the card is gone for
> good.

### 5.2b Feed preferences — "not interested" and "don't recommend channel"

The two NEGATIVE viewer signals, and the first in the schema: every viewer→content and
viewer→creator relation before them records what someone wants more of.

| Method          | Path                              | Auth                  | Limiter                 |
| --------------- | --------------------------------- | --------------------- | ----------------------- |
| `PUT`/`DELETE`  | `/videos/:videoId/not-interested` | session, **not** full | `feedPreferenceLimiter` |
| `PUT`/`DELETE`  | `/creators/:creatorId/mute`       | session, **not** full | `feedPreferenceLimiter` |
| `GET`           | `/users/me/muted-creators`        | session               | —                       |
| `GET`           | `/users/me/not-interested-videos` | session               | —                       |

Tables `video_not_interested (viewer_id, video_id)` and `creator_mute (muter_id, creator_id)`,
both the `creator_subscription` shape: composite PK, one index for the FK cascade, a self-check on
the mute. The PK is what makes both verbs idempotent, so neither route carries an idempotency key
and neither reads a body. Migration `0127_home_feed_preferences`; `0130_not_interested_listing_index`
adds the one index the dismissed-video listing needs, `(viewer_id, created_at DESC, video_id DESC)`.

`PUT` sets, `DELETE` is Undo — the same one-resource-two-states idiom as §5.2a, not a `/restore`
sub-path.

> **NO `requireIdentifiedUser`, ALONE ON THIS ROUTER.** The rule everywhere else exists because
> better-auth's `anonymous()` mints real sessions, so `requireAuth` alone would admit unlimited
> throwaway identities into counters that feed ranking — `likeCount`, `saveCount`,
> `subscriberCount`. Neither of these writes has a counter, and neither changes any feed but the
> caller's own, so the guard would buy no protection: it would only 403 the signed-out viewers
> whose feed §4.4 already personalizes through anonymous topic affinity. `feedPreferenceLimiter`
> carries the weight instead at half like/save's budget — the trade `videoShareLimiter` already
> makes for the one other route reachable without a full account.
>
> **NO COUNTER COLUMN ON EITHER TABLE, and no route reads them in the creator direction.**
> `creator_subscription` moves `creator_stats.subscriber_count` because a subscriber count is
> public social proof a creator benefits from; the mirror image is not a mirror. A visible "hidden
> by N people" is a stick handed to anyone wanting to demoralise a creator, and trivially farmable
> besides. `creator_mute_creatorId_idx` exists for the FK cascade **alone** — a future query using
> it to answer "who muted me" is the thing that note refuses.
>
> **`mode=watched` IS EXEMPT, and the exemption is load-bearing.** §4.5's predicate is shared by
> every mode including the one that renders `/history`. Watch history is a RECORD, not a
> recommendation — a video the viewer dismissed is still a video they watched. Without the
> exemption "not interested" would quietly rewrite their history, which the button does not claim.
>
> **SEARCH IS UNTOUCHED.** `GET /feed/search` carries no per-viewer exclusion by design, and these
> two do not change that: a search is an explicit request for a specific thing, and hiding a result
> someone typed the title of reads as broken rather than as a preference being honoured.
>
> **`GET /users/me/muted-creators` IS WHAT MAKES THE MUTE REVERSIBLE.** A muted creator's videos
> never reach the feed again, so the card carrying the undo control is exactly the card now
> hidden. Without a list nothing anywhere could lift the mute, and a preference a viewer cannot
> withdraw is a trap. Unpaginated: the list is bounded by how many channels one person muted by
> hand. It sits on the users router beside `/users/me/watch-time`, declared before `/:id`.
>
> **`GET /users/me/not-interested-videos` IS THE SAME ARGUMENT, APPLIED TO THE HARDER HALF.** It
> shipped later than the muted list and the gap was a real defect, not a phasing choice: a
> dismissed video is hidden by the same §4.5 predicate, so its undo control also lives on the card
> that is now gone — and unlike a mute, there was no second surface anywhere that could reach it.
> A dismissal was permanent by accident.
>
> **PAGINATED, WHERE THE MUTED LIST IS NOT, AND THE ASYMMETRY IS DELIBERATE.** Muting is an act
> against a whole channel and tops out in the tens, which is why a cursor there would be machinery
> for a page that cannot exist. Dismissing is one tap on one card, done idly, and accumulates
> without bound. Same test, opposite answer. Keyset on `(created_at, video_id)` through
> `lib/instant-cursor.ts` — the tiebreak is not ceremony, since consecutive taps land in the same
> millisecond and a cursor keyed on a non-unique column skips whichever row loses. A malformed
> cursor is `422 CURSOR_MALFORMED`, never a silent first page. The arm is declared on
> `FeedPreferenceError` with the same payload-free shape `VideoCommentError` uses, so the union
> collapses it and the existing mapping answers it.
>
> **NO PUBLIC-VIDEO GATE ON THE READ, and this is the one place the module disagrees with itself.**
> `setVideoNotInterested` gates on `findPublicVideo` so a preference is never stored against
> something the viewer could not have seen. The listing must not: a video that went private or
> unpublished AFTER being dismissed still has a row, and gating would hide exactly the rows nothing
> else can reach — an unliftable preference, which is the trap this route exists to close. Videos
> that are genuinely deleted are already absent, via the FK's `ON DELETE cascade`.

### 5.2b2 Profile-text reporting

The FIFTH report fork, after R&D, commerce, community and video (§5.2c). Same reasoning each time,
and it holds here too: two queues gated by different capabilities in one table is the coupling
capabilities exist to prevent.

**Why it had to exist at all.** `0139` made `user.bio` and `user_profile_link` public the moment they
are written, which diverges from every other public profile text in the schema — `talent_profile`
defaults to `private`, `community_cofounder_profile` to `draft` behind moderation. That divergence is
only defensible with a reactive path, and this is it.

| Method | Path                                 | Auth                          | Limiter               |
| ------ | ------------------------------------ | ----------------------------- | --------------------- |
| `POST` | `/users/:userId/reports`             | full account                  | `userReportLimiter`   |
| `GET`  | `/users/admin/reports`               | `moderate_content` in-service | `contentReviewLimiter` |
| `POST` | `/users/admin/reports/:reportId/decisions` | `moderate_content` in-service | `contentReviewLimiter` |
| `POST` | `/users/admin/profile-text/restore`  | `moderate_content` in-service | `contentReviewLimiter` |
| `GET`  | `/users/me/profile-reports`          | session                       | —                     |

Both `admin` writes take `idempotency({ required: true, scope: "user" })`. Tables `user_report` and
`user_moderation_action`, plus `user.profile_moderation_state`. Migrations `0140_user_report_enums`
(split for `ALTER TYPE … ADD VALUE`), `0141_user_reports` and `0142_user_report_severe_harm`.

> **⚠️ `profile_moderation_state` NOW GOVERNS THREE FIELDS, NOT TWO.** It began as the channel bio
> and `user_profile_link`. `talent_profile.bio` joined them because it was the one other public
> self-description a person controls with no lever over it — so somebody whose channel description
> was hidden could paste the same text into their talent profile and have it render.
>
> **THE GATE IS PER-READ, IN EACH MAPPER**, because the reads live in different domains:
> `channels.service.ts` and `talent-profiles.service.ts`. **A fourth public self-description must
> gate itself** — nothing structural fails if one is added and forgets.
> `community_cofounder_profile` needs no change; its `draft` default reaches the same place by a
> different mechanism.
>
> **THE SUBJECT IS TOLD.** `profileModerationState` rides on the OWNER's read
> (`GET /users/me/channel-profile`) because upholding a report writes an audit entry and an action
> row and reaches the person not at all. Without it, somebody asked to fix a problem would not know
> there was one.
>
> **THE PUBLIC READS SAY NOTHING.** A hidden bio is `null`, indistinguishable from one never
> written. Saying "this description was hidden" hands a reporter a receipt and the subject a
> notification, neither of which a public surface owes anybody.

### 5.2c Video content reporting

The fourth report fork on this platform, after R&D, commerce and community. Each of those
records why it refused to generalize the last, and the reason is always the same: two queues
gated by different capabilities in one table is the coupling capabilities exist to prevent.

| Method | Path                                                    | Auth                          | Limiter                    |
| ------ | ------------------------------------------------------- | ----------------------------- | -------------------------- |
| `POST` | `/videos/:videoId/reports`                              | full account                  | `videoContentReportLimiter` |
| `GET`  | `/videos/admin/content-reports`                         | `moderate_content` in-service | `contentReviewLimiter`     |
| `POST` | `/videos/admin/content-reports/:reportId/decisions`     | `moderate_content` in-service | `contentReviewLimiter`     |
| `POST` | `/videos/admin/content/restore`                         | `moderate_content` in-service | `contentReviewLimiter`     |
| `GET`  | `/users/me/video-reports`                               | session                       | —                          |

Tables `video_content_report` and `video_moderation_action`, plus
`video.moderation_visibility_state`. Migrations `0128_video_moderation_enums` (split for
`ALTER TYPE … ADD VALUE`) and `0129_video_content_reports`.

> **NOTHING AUTO-HIDES, AND THAT IS THE DECISION THE WHOLE FORK TURNS ON.** Commerce hides a
> review, question or answer at three distinct reporters, counted inside the insert's own
> transaction — and never does that to a product, because "delisting a seller's listing is a
> commercial action against their livelihood and requires a human to take it". A video is a
> creator's livelihood by exactly that argument.
>
> So there is no threshold, and the schema is simpler for it: no `action_source` column, no
> nullable moderator, no three-way biconditional CHECK keeping an authorless row honest.
> `moderator_user_id`, `moderator_role_snapshot` and `audit_entry_id` are all NOT NULL, and
> every action is in the platform hash chain — where commerce had to keep automatic hides OUT
> of it, `platform_audit_entry.actor_user_id` being NOT NULL. This is the community/R&D shape,
> chosen on the merits rather than copied.
>
> **NOT A REUSE OF `content_review_action`**, which is already the video moderation log and is
> the reuse that looks obvious. Its `reviewer_id` is NOT NULL, and its `video_id` is NOT NULL
> with a CASCADE — so a decision vanishes when its subject does, which is backwards for an
> audit. `commerce_content_report`'s docblock predicted this failing.
>
> **THE COLUMN ONLY HIDES ANYTHING BECAUSE THREE PREDICATES SAY SO**, and a new read that
> forgets the term serves hidden content with nothing failing: `PUBLICLY_SERVABLE`
> (public-video-gate.ts — every engagement write and the watch payload), `publicVideoPredicate()`
> (feed.service.ts — feed AND search) and `publicVideoPredicateSql()` (spotlight.service.ts).
> `video_feed_candidate_idx` is NOT rebuilt: adding a conjunct still implies its predicate, and
> rebuilding takes a lock over every write to `video`.
>
> **DISMISSING DOES NOT RESTORE**, unlike commerce. There, dismissal must un-hide because a
> threshold could have hidden content with nobody deciding. Here nothing hides a video except a
> moderator, so a dismissal has nothing to undo — and quietly reversing a different moderator's
> decision as a side effect of closing an unrelated report is not a dismissal's job.
> `POST /admin/content/restore` is that, and it exists because a video can be hidden with no
> open report left to dismiss: hidden, reports actioned, later reconsidered. Its `reasonNote` is
> REQUIRED where a decision note is optional — an un-hide with no stated reason is not a record.
>
> **ACTIONING CLOSES EVERY OPEN REPORT ON THE VIDEO**, not only the one clicked. Leaving
> siblings open means the next reviewer re-decides a settled case and the queue never drains.
>
> **`GET /users/me/video-reports` HAS NO PRECEDENT** — commerce, community and R&D all let
> someone file a report and then tell them nothing. Its projection is deliberately narrow: the
> reporter learns their own report's status and nothing about who decided it or how many others
> reported the same video. Naming the moderator makes a takedown personal; exposing the count
> makes brigading measurable.

### 5.2d The library reads — liked, watch later, subscriptions

The three POSITIVE collections, read back. §5.2b's two negative signals shipped with their
listings; these three shipped their WRITE halves in §3.1 and had no listing at all until now.

| Method | Path                       | Auth    | Limiter |
| ------ | -------------------------- | ------- | ------- |
| `GET`  | `/users/me/liked-videos`   | session | —       |
| `GET`  | `/users/me/saved-videos`   | session | —       |
| `GET`  | `/users/me/subscriptions`  | session | —       |

No new table. `video_like`, `video_save` and `creator_subscription` have been filling since
§3.1 through `PUT`/`DELETE /videos/:videoId/like`, `.../save` and `/creators/:creatorId/subscribe`,
and **nothing read a row back** — a viewer could like a video and then have no way to find it
again. `/library` rendered a panel saying exactly that rather than three dead tabs.

Migration `0137_library_reads` adds **two** indexes, not three: `video_like_user_recent_idx`
`(user_id, created_at DESC, video_id DESC)` and `creator_subscription_subscriber_recent_idx`
`(subscriber_id, created_at DESC, creator_id DESC)`.

> **`video_save` DELIBERATELY GETS NO INDEX, and this is the part not to "fix" later.**
> `video_save_userId_idx` is already `(user_id, created_at, video_id)` — it leads with
> `created_at`, unlike `video_like`'s, because §3.1 records that a saved list is RENDERED where a
> like set is only probed for membership. It is ASC where the query is DESC, and that is not a
> mismatch: with `user_id` pinned by equality the planner walks the remaining suffix BACKWARDS,
> which is a complete reverse of every sort column. `EXPLAIN` confirms it — `Index Only Scan
> Backward using video_save_userId_idx`, no Sort node. A duplicate DESC copy would buy nothing and
> cost a write on every save.
>
> **THE TWO VIDEO LISTS ARE PUBLIC-GATED, AND §5.2b's LISTING IS NOT.** That is the sharpest
> disagreement between two functions of the same shape on this surface, and it is the decision
> rather than an inconsistency. A DISMISSAL hides content, so gating its undo list would hide
> exactly the rows a viewer needs to lift the preference — unliftable, which is the trap that
> route exists to close. A LIKE is the opposite signal: a like row for a video the creator has
> since made private hides nothing from anyone, so there is no trap, and rendering its title and
> thumbnail would turn a self-read into an oracle over a creator's WITHDRAWN catalogue. Both lists
> filter on `PUBLICLY_SERVABLE AND published_at <= now()`, passed as the imported fragment so the
> partial index still applies. The membership row survives the filter; un-privating restores the
> card.
>
> **ALL THREE PAGINATE, INCLUDING SUBSCRIPTIONS, WHERE `/me/muted-creators` DOES NOT.** §5.2b's
> test is the one applied: muting is an act against a whole channel and tops out in the tens, so a
> cursor there is machinery for a page that cannot exist. Subscribing is equally deliberate but
> accumulates for years and routinely reaches the hundreds — the same test rules a cursor IN.
> Keyset on `(created_at, id)` through `instant-cursor`, because two rows share a millisecond more
> often than that sounds and a cursor on a non-unique column skips whichever loses the tie.
>
> **NO EXISTENCE GATE AND NO PUBLISHED-VIDEO REQUIREMENT ON THE SUBSCRIPTION LIST.**
> `setCreatorSubscription` checks `user` because storing a subscription to a nonexistent id would
> follow nothing forever; the read needs no check, since `ON DELETE cascade` on both FKs means a
> deleted account takes its rows with it. And a channel with no videos yet is a real thing to
> follow — §3.1 says so — so hiding those rows would make the subscription unliftable from the one
> surface that lists it. `subscriberCount` comes from `leftJoin(creator_stats)` + `COALESCE(…, 0)`:
> a creator whose stats row was never minted is a real creator with zero subscribers, and an
> `innerJoin` would silently drop them out of somebody's list.
>
> **ONE ROW SHAPE FOR THE TWO VIDEO LISTS, with `addedAt` rather than `likedAt`/`savedAt`.** They
> are the same card behind two tabs, and two field names for one instant would fork the client's
> card component to no purpose. Wider than `NotInterestedVideoRow`, which is a recognition row in
> an undo list — these carry `durationSeconds` and `viewCount` because they are cards somebody
> clicks.
>
> **THE FRONTEND IS NOT WIRED YET.** `/library`'s "Not here yet" panel still names all three. That
> is tracked in the frontend `todo.md`; the panel's claim is now false about the backend and true
> about the page.

### 5.2e The channel page — `src/modules/home/channels/`

**THIS SHIPPED AS A BUG FIX, not a feature request**, and the bug is worth recording because it
survived every review of the components that carried it.

`VideoCard` renders a creator's avatar and name as **two separate links** to `/channel/{handle}`,
and `venture-video-reel.tsx` linked the same creator to `/@{handle}`. **Neither route existed.**
Every card in every feed — the home page, the watch page's recommended rail — carried two dead
links, confirmed in a browser as Next's 404 page. The frontend's own library surface had to render
subscribed creators as unclickable text to avoid joining them. Two URL shapes for one destination
is the tell: nobody could have been right, because there was nothing to be right about.

| Method | Path | Auth | Limiter |
| --- | --- | --- | --- |
| `GET` | `/channels` | optional | `feedReadLimiter` |
| `GET` | `/channels/:handle` | optional | `feedReadLimiter` |
| `GET` | `/channels/:handle/videos` | optional | `feedReadLimiter` |

**`GET /channels` — the public channel directory, and its only consumer is `sitemap.ts`.** The
channel page is public and was announced in no sitemap for one reason: there was no public
handle-enumeration read to build a list from. Migration `0144` added `user.is_channel_listed` and
`0145` flipped it to **default TRUE**.

> **THE OPT-IN WAS REVERSED, AND THE REASONING IS WORTH KEEPING BECAUSE IT WAS NOT OVERRULED.**
> `0144` defaulted FALSE on the cofounder directory's argument — a directory of people who did not
> consent to being in it is a decision, not a default. That question is real and this is not it:
> consent matters when publishing facts about somebody who never chose to be listed, whereas a
> channel page is a thing its owner chose to create, is already public, and is already linked from
> every feed card. Indexing it reveals nothing a visitor cannot already reach by clicking.
>
> Opt-in also produced precisely what it predicted: **zero listed channels**, because nobody ticks a
> box they are never shown. The control remains as an opt-OUT, which is stricter than YouTube — it
> indexes channel pages by default with no per-channel toggle.
>
> **IT GOVERNS DISCOVERABILITY, NOT VISIBILITY.** The channel page is reachable either way. Any copy
> implying that switching the flag off makes a channel private is a promise this column cannot keep.
>
> **⚠️ THE VIDEO TERM JOINS `video` UNDER `publicVideoPredicate()` AND DOES NOT READ
> `creator_stats.published_video_count`.** ⚠️ **This is now the ONLY thing that filters the
> directory** — the flag used to exclude nearly everyone and since `0145` excludes almost nobody, so
> the whole defence against a sitemap full of soft 404s rests here. Two reasons, and the second is
> the one that bites: it is a
> counter cache (`project_stats` is LEFT-joined on the product page precisely because 15 of 41
> projects had no row), and it counts the WRONG THING — `publish_status = 'published'` REGARDLESS OF
> VISIBILITY, per its own comment in this file. A creator whose videos are all unlisted has a
> positive count and an empty channel page, and announcing that page files a soft 404, which
> `sitemap.ts`'s header calls worse for the domain than never announcing it. **Verified live**: a
> creator who opted in with no public video was excluded; one with public videos appeared.
>
> **KEYSET ON `(created_at, id)`, not on the handle.** A handle is renameable, and a rename
> mid-crawl would move a row across a page boundary — which is what a keyset cursor exists to stop.
>
> **⚠️ THE SCRUB CLEARS IT, AND NOTHING STRUCTURAL WOULD NOTICE IF IT STOPPED.** `is_channel_listed`
> is a scalar, so `db:verify-anonymization-coverage` cannot see it — see BACKEND_STRUCTURE.md §11's
> "three things the verifier cannot see". An erased account must leave the directory.

Migration `0138_channel_video_listing` adds one partial index,
`video_creator_recent_idx (creator_id, published_at DESC, id DESC)`.

> **`/channels`, NOT `/creators/:handle`.** `creatorRouter` already owns
> `/creators/:creatorId/subscribe`, which takes an **id**; hanging a **handle** off the same prefix
> would put two identifier types on one path and leave the next person to add a route there
> guessing which. Both routes are two segments deep, which §5.2's ⚠️ banner requires — the studio
> router mounts first and its `GET /:videoId` permanently shadows any public single-segment route,
> producing a 401 that reads as an auth bug.
>
> **NOTHING HERE HAS ITS OWN VIDEO PROJECTION.** `feed.service.ts` exports `publicVideoPredicate`,
> `feedSelectClause`, `toFeedVideoItem` and `FeedRow` for this module, so the rows are the feed's
> own `FeedVideoItem` — which is why the frontend renders the grid with `toVideoCardProps` and
> `VideoCard` unchanged. Copying forty lines of select clause would have been two places for a card
> to start disagreeing with itself, on a file whose own note is that getting the status literals
> wrong produces no error, just a sequential scan.
>
> **IT IS A CATALOGUE, NOT A FEED, and every difference is deliberate.** `listFeedVideos` excludes
> what the viewer already watched, drops the viewer's own uploads, applies a recency window and
> relaxes each in stages. All wrong here: a channel shows what the creator published, in publication
> order, to everybody the same. It also applies **no `creator_mute` or `video_not_interested`
> exclusion** — those suppress a creator from a RECOMMENDATION, and arriving at a channel page is
> an explicit request for that creator. `GET /feed/search` makes the same call for the same reason.
>
> **ONE COUNTER ON THE HEADER, and the other two are refused.** `subscriberCount` is already public
> on every watch payload. `publishedVideoCount` counts `publish_status = 'published'` REGARDLESS OF
> VISIBILITY, so it would routinely exceed the grid beneath it and read as a bug — and explaining
> the gap would mean explaining which videos are private. `totalViewCount` is a lifetime figure
> including views of videos since made private or deleted, which is a fact about withdrawn content.
>
> **A CREATOR WITH NO HANDLE HAS NO CHANNEL PAGE**, and that is consistent rather than a gap:
> `toVideoCardProps` already omits `channelHref` entirely for them rather than building
> `/channel/null`. One 404 covers both "no such handle" and "unclaimed handle", so the status is
> not an oracle for which handles exist.
>
> **THE INDEX PREDICATE IS BYTE-IDENTICAL TO `video_feed_candidate_idx`'s**, five terms where the
> application gate has six — `moderation_visibility_state` filters above the index, exactly as it
> already does for the feed. `EXPLAIN` confirms an `Index Scan using video_creator_recent_idx` with
> that column as a `Filter`, and no Sort node.

### 5.2f The three creator self-reads — analytics and the comment inbox

Three routes that shipped in code and appeared in no table until now. They are on the **users**
router, not the videos router, and that placement is forced rather than chosen: `app.ts` mounts
`videosRouter` at `/videos` first, so any two-segment `/videos/X` is permanently shadowed by that
router's `GET /:videoId`. `/users/me/video-reports` records the same constraint.

| Method | Path                       | Auth    | Limiter | Notes                                                                  |
| ------ | -------------------------- | ------- | ------- | ---------------------------------------------------------------------- |
| `GET`  | `/users/me/creator-summary` | session | —       | Lifetime totals behind `/studio/analytics`. **Zero, not null**, for a creator with no `creator_stats` row — see the service for why this is the opposite call to `/me/watch-time` and why both are right. |
| `GET`  | `/users/me/video-analytics` | session | —       | Per-video counters, `?page&limit` only. ⚠️ **No `?sort=`** — `video_stats` has no index to order by, and the query schema is `.strict()`, so sending one is a `422`. |
| `GET`  | `/users/me/video-comments`  | session | —       | Every comment across the caller's own videos, newest first — the data behind `/studio/comments`. |

**THE COUNTERS ARE QATOTO-SIDE.** A YouTube-hosted video's own view count lives in that creator's
YouTube Studio; these count watching that happened HERE, through the §3.3 beacon. Rendering one as
the other would be a number the creator cannot reconcile against either source.

**`/me/video-comments` ADDS NO AUTHORIZATION.** `DELETE /comments/:commentId` has always allowed the
video's creator as well as the comment's author (§8.4); this is the read that finally lets them find
the comment without opening each video in turn. It **includes replies**, which is why migration
`0136` adds a non-partial index — the public thread's index covers top-level comments only, and an
inbox built on it would silently hide most of them.

### 5.3 `live` is not a mode

The chip exists in `filter.tsx` today. Nothing backs it: there is no stream table, no ingest, no
provider, and [STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) §12 puts live streaming
explicitly out of scope. It is **dropped from the seed set and from `feedModeEnum`** rather than
shipped as a permanently empty state — a chip that always returns nothing teaches users the
filters are broken.

`VideoCardProps.isChannelLive` stays in the frontend type (three other surfaces use it) and is
always `false` from the feed mapper.

### 5.4 House conventions, unchanged

Zod schemas live **in the controller** and are exported for tests. `.strict()` on every query
schema, camelCase keys, `z.coerce` with `.default()`. Enum values are snake_case and byte-match
the `pgEnum` labels — `?mode=new_to_you`, never `new-to-you`. Services return `Result<T, E>`;
controllers exhaustively switch the error union. Envelope is the existing `PaginatedResponse`
(`src/types/index.ts:29`). 422 for validation, 401 for missing session, 404 rather than 403 so ids
cannot be probed.

---

## 6. Snapshots and jobs

Snapshot tables mirror `problemClusterScoreSnapshot` (`schema.ts:1968`) — the **component columns
are stored next to the total**, so any score can be explained after the fact rather than
re-derived from data that has since moved.

`userTopicAffinitySnapshot` · `userCreatorAffinitySnapshot` · `videoQualityScoreSnapshot` ·
`trendingVideoSnapshot` (top 200, with a `rank` column — powers `mode=trending`) ·
`platformCategoryPopularitySnapshot`.

Every scheduled job follows the mandatory **tick pattern** (`src/jobs/scheduled-ticks.ts`): the
cron fires a `-tick` queue, the tick quantizes `now` to a UTC boundary and enqueues the real job
with an explicit `asOf` plus an idempotency key derived from it. This is the only place in the
domain where `new Date()` is called.

| Job                                      | Cron               | Why this slot                                                                              |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `recompute-video-durations`              | `08 1 * * *`       | must precede quality — completion needs a denominator                                      |
| `recompute-video-quality-scores`         | `25 1 * * *`       | after durations                                                                            |
| `recompute-platform-category-popularity` | `40 1 * * *`       | after quality; feeds cold start                                                            |
| `recompute-user-affinities`              | `50 1 * * *`       | after popularity                                                                           |
| `recompute-trending-videos`              | `18 * * * *`       | **hourly.** A "trending" chip recomputed nightly is a lie about what it says.              |
| `verify-youtube-video`                   | on demand, backoff | §8.3 deferred verification                                                                 |
| `revalidate-youtube-embeds`              | `10 5 * * *`       | backstop for §8.2                                                                          |
| `prune-engagement-data`                  | `55 4 * * *`       | snapshots at 14 days; `videoViewSession` dropped at 90. **Dry-run by default** — see below |
| `publish-scheduled-videos`               | `* * * * *`        | the `scheduled` → `published` hop (STUDIO §4). **Every minute, deliberately**: a creator who set 09:00 does not accept 09:59, and the sweep is one indexed range scan over rows whose time has come |

Ordering is expressed **by cron time**, not by code — same convention as
`recompute-branch-signals` (`20 3`) running before `recompute-program-stats` (`35 3`).

> **CORRECTION.** An earlier version of this line claimed the slots "do not collide with the 11
> existing crons". That is not achievable and was never true: `sweep-dispute-windows-tick` runs
> `* * * * *`, so every cron on the platform shares its minute with that one, always.
>
> Sharing a minute is also not the thing worth avoiding — a tick does ONE INSERT and each queue is
> its own `singleton`. What matters is not landing a tick on a heavy nightly recompute, and the two
> slots above were moved for exactly that: `08 1` because `refresh-talent-projections-tick` already
> holds `5 * * * *`, and `18 * * * *` because `:35` is `recompute-program-stats-tick` and an hourly
> job must not meet a nightly one 365 times a year.

Definitions in `src/lib/jobs.ts`, handlers bound only in `src/worker.ts`, queues created by
`src/jobs-install.ts`. Failures land in `jobFailure` (`schema.ts:2729`); inspect with
`pnpm jobs:inspect-failures`, and start one by hand with `pnpm jobs:trigger <job-name>`.

> **SHIPPED AS: prune deletes, it does not aggregate — and the counters are protected elsewhere.**
>
> "Aggregated into `videoStats`" was the right instinct pointed at the wrong job. The transactional
> counters need no aggregation: they were maintained as the beacons arrived, so deleting the
> sessions loses per-viewer detail, not totals.
>
> The real hazard is the two inputs the quality job RECOMPUTES from those sessions every night —
> `uniqueViewerCount` and `countedViewsFirst48Hours`. Once prune removes the rows, the engagement
> denominator collapses (engagement _inflates_) and velocity falls to zero, silently re-ranking
> every video older than the window. So both are persisted on `videoStats` and, **past the
> retention horizon only**, held at their stored maximum. Gated on the horizon rather than applied
> always, because inside the window §8.1's outlier prune must still be able to deflate a farmed
> video by clearing `is_counted_view`. `src/lib/engagement-retention.ts` holds the one constant
> both jobs read.
>
> The job is gated behind `ENGAGEMENT_PRUNE_ENABLED`, **default false**: it is the first scheduled
> job in this codebase that deletes domain rows, and while the flag is off it runs its full
> selection and logs what it would remove.

---

## 7. Rate limiters

New limiters via `createLimiter` (`src/middleware/rate-limit.ts:78`), **each with its own store
namespace** — reusing a store instance throws `ERR_ERL_STORE_REUSE`:

`feedReadLimiter` · `viewBeaconBurstLimiter` + `viewBeaconSustainedLimiter` (60/min AND 200/hr —
tightest on the platform, it is the only unauthenticated write) · `playbackErrorLimiter` ·
`videoLikeLimiter` · `videoSaveLimiter` · `videoShareLimiter` · `commentCreateLimiter` ·
`commentUpdateLimiter` · `commentLikeLimiter` · `subscribeLimiter` · `watchHistoryLimiter` ·
`feedPreferenceLimiter` (60/min — half like/save, because §5.2b's four routes are the only
engagement writes reachable without a full account, so this bounds storage growth from throwaway
identities where `requireIdentifiedUser` bounds it everywhere else) · `videoContentReportLimiter`
(20/15min — its OWN namespace, never shared with the R&D or commerce report limiters: a shared
budget means abuse of one product's report surface silently exhausts the other's. The partial
unique index already caps one person at one report per video, so this bounds someone reporting
many DIFFERENT videos, which is the shape brigading takes) · `playlistMutationLimiter`.

> **SHIPPED AS.** `viewBeaconLimiter` is TWO chained limiters, because `LimiterSpec` carries one
> window and `createRateLimitStore` is keyed to it. Burst is declared first so a burst violator's
> `Retry-After` names the minute rather than the hour. Distinct namespaces keep
> express-rate-limit's double-count guard quiet.
>
> **`feedCategoriesLimiter` is deliberately NOT created.** `/feed/categories` is a small,
> viewer-independent, cacheable list; an IP-keyed bucket on the front page's data source is a
> self-inflicted outage the first time real traffic arrives from behind a corporate NAT. If it ever
> needs protection the answer is a cache in front of it, not a bucket that cannot tell a NAT from
> an attacker. `feedReadLimiter` IS applied to `/feed/videos`, `/feed/watch/:videoId` and the
> comment list, because those are per-viewer and no cache absorbs them.
>
> Every limiter uses the default `userKey`, which already falls back to `ipKeyGenerator(req.ip)` —
> so `attachOptionalUser` must run BEFORE the limiter, or signed-in viewers land in the shared NAT
> bucket.

All must be registered in `src/middleware/rate-limit-coverage.test.ts`.

> **CORRECTION.** That test used to count exported limiters against store registrations and never
> inspect a route, so the claim that it "will fail the build" if a route lacks a limiter was false.
> It now also walks every mounted router and asserts each mutating route carries one, against an
> explicit allowlist of the 49 pre-existing routes that do not. The claim is true as of that case.

---

## 8. Integrity — every known abuse and failure, and what actually happens

### 8.1 Beacon farming inside the clamp

The clamp of §3.3 bounds what one session can claim. It does not stop someone opening many
sessions. Three layers, none of which is a heuristic:

1. **Engagement divides by unique viewers**, not views (§4.1). Inflating view count inflates the
   denominator too.
2. **Sessions with `viewerId IS NULL` never contribute to `completionBasisPointsSum`.** Anonymous
   watch time counts toward `viewCount` — it is real traffic — but it cannot move the component
   that carries 40 of 100 points. Farming therefore requires real accounts, which is a much more
   expensive attack than a headless browser loop.
3. A nightly **outlier prune** zeroes sessions from a fingerprint that touched more than N videos
   of a single creator in one day.

### 8.2 Embedding disabled → dead player

A creator can disable embedding on youtube.com at any moment, and Qatoto finds out only by asking.
A nightly re-check job (which is what
[STUDIO_BACKEND_STRUCTURE.md](STUDIO_BACKEND_STRUCTURE.md) §5.1 proposed) means up to 24 hours of
serving a dead player in the feed.

**Fast path:** the IFrame API's `onError` fires with a code — 101/150 (embedding disallowed) or
100 (not found). The client POSTs it to `/videos/:videoId/playback-error`. At **≥3 distinct
fingerprints** the server flips `uploadStatus: "failed"`, which drops the row from the candidate
pool immediately. Three distinct reporters, because one client's error report is one client's
claim (Rule 1).

`revalidate-youtube-embeds` stays as the backstop for videos nobody happens to be watching.

### 8.3 oEmbed outage blocks uploads — **SHIPPED**

> ⚠️ **THIS SECTION PROPOSED A FIX THAT HAS SINCE SHIPPED, AND READ AS FUTURE WORK UNTIL
> 2026-08-27.** It opened "Today, `POST /videos` hard-fails … New column, new flow", which sent a
> reader looking for work that is already done. All three pieces are live: `isSourceVerified` is on
> `studio.video` (`schema/studio.ts:252`), `videos.service.ts` defers on `YOUTUBE_VERIFY_FAILED`
> rather than hard-failing (`:957`), and `verify-youtube-video` is a registered worker job.
> Rewritten in the present tense; the design below is unchanged because it is what was built.

The problem it solved: hard-failing with `502 YOUTUBE_VERIFY_FAILED` was the correct trade against
storing an unverified id, but it threw away the creator's work whenever YouTube had an outage.

The column that fixed it:

```ts
isSourceVerified: boolean("is_source_verified").default(false).notNull(),
```

The 11-character id is parsed and stored regardless — the charset CHECK still applies, so SSRF is
still closed at the storage layer. The row is created as `draft` with `isSourceVerified: false`,
and the `verify-youtube-video` job retries with backoff.

⚠️ **ONLY `YOUTUBE_VERIFY_FAILED` DEFERS.** A malformed URL and an unavailable video stay hard
errors, because those are things the creator must fix — deferring them would queue a retry that can
never succeed. `createDailyLog` copies this asymmetry deliberately (R&D §22). **Publish is refused while the flag is
false**, and the candidate pool (§4.5) requires it true. The invariant "no unverified id in a
published row" is preserved without discarding the upload.

### 8.4 Everything else

| Problem                                | Handling                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New video scores 0 on 40% of the scale | The sample ramp (§4.2) plus the 4-of-24 exploration quota (§4.4)                                                                                                                                                                                                                                                                                                                        |
| Under-filled page on a small catalog   | The relaxation ladder (§4.7), logged by stage                                                                                                                                                                                                                                                                                                                                           |
| Filter bubble                          | Exploration budget with a no-affinity boost, 2-per-creator and 40%-per-category page caps (§4.6)                                                                                                                                                                                                                                                                                        |
| Fingerprint privacy                    | Daily-rotating salt, raw IP never stored, sessions dropped at 90 days (§3.2)                                                                                                                                                                                                                                                                                                            |
| Double-submitted comment               | `idempotencyRecord` via existing middleware (§5.2)                                                                                                                                                                                                                                                                                                                                      |
| **Comment moderation**                 | **A deliberate gap in v1.** Ships with `areCommentsEnabled` respected, a per-user rate limiter, a 2000-char cap, one-level threading and author-or-creator tombstone delete. There is **no reporting flow and no automated moderation**. `video.commentModeration` and `video.commentSortOrder` remain unbacked preference columns and this doc says so rather than implying they work. |

---

## 9. Build order

| Phase | Scope                                                                                                                                  | Done when                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1     | `contentCategory` + `videoCategory` + seed + `GET /feed/categories`; `isSourceVerified` + `verify-youtube-video`; studio `categoryIds` | `curl /feed/categories` returns the seeded rows                                                          |
| 2     | Engagement tables + `videoStats` + write routes + beacon clamping + playback-error                                                     | Like/comment/beacon persist; counters move in the same transaction                                       |
| 3     | `feed-score.ts` / `trending-score.ts` / `affinity-score.ts` + snapshots + jobs + `GET /feed/videos`                                    | `curl '/feed/videos?limit=24'` ranks for both anonymous and authed; Spotlight is `GET /spotlight/videos` |

Phases 1–3 show nothing to a user until the frontend lands (frontend §9). Phase 2 of the frontend
work is what starts producing the completion data phase 3 here depends on — until real watch
sessions exist, quality runs on likes and velocity with completion ramped near zero, and that is
expected, not a bug.

## 10. Verification

```bash
pnpm db:generate && pnpm db:migrate    # NEVER drizzle-kit push — it emits DROP SCHEMA for pgboss
pnpm jobs:install                      # the only process with migrate:true
pnpm start & pnpm start:worker
curl -s localhost:8000/ready           # must still pass its pgboss version probe
```

- Trigger each new job by hand with `pnpm jobs:trigger <job-name>` and inspect
  `pnpm jobs:inspect-failures`. The trigger goes through `sendJob`, so the payload is re-validated
  and re-running an `asOf` a tick already fired is a no-op rather than a duplicate run.
- Verify the clamp directly: POST a beacon claiming `positionSeconds: 9999` one second after the
  previous one and confirm `watchedSeconds` moved by ≤ `1 + GRACE_SECONDS`.
- Verify the unique index: POST two view-beacons for the same video from the same fingerprint on
  the same day and confirm one session row exists, not two.
- Verify determinism: run `pnpm jobs:trigger recompute-video-quality-scores` twice with the same
  `asOf` and confirm the job logs **no** `NON-DETERMINISTIC score` error.

    > **CORRECTION.** The original recipe — "diff the snapshot rows, they must be byte-identical" —
    > cannot fail. The insert is `onConflictDoNothing` on `(videoId, asOf)`, so the second run writes
    > nothing and the rows are identical by construction whether or not the scorer is deterministic.
    > The comparison now lives INSIDE the job: when the insert is suppressed it reads what is stored
    > and checks it against what was just computed, so the check runs on every replay in production
    > rather than only when somebody remembers a script. To see it fail, edit one snapshot row's
    > total by hand and re-run.

- Confirm `rate-limit-coverage.test.ts` passes — it fails if any new route lacks a limiter.

Per [CLAUDE.md](CLAUDE.md), **no tests are written unless explicitly requested.**
