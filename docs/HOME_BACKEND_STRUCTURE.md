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
copies `src/lib/opportunity-score.ts` exactly and for exactly the same reason.

**Rule 3 — There is one feed route.** `GET /feed/videos` returns one ranked page. Recommended and
Explore are a **frontend slice** of that page (frontend §5), not two response fields. Spotlight is
the same route with `?mode=trending&limit=3`. One ranking contract, one cache story, one place a
ranking bug can live.

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
| Owner-scoped `/videos` CRUD, publish, review                 | `src/routes/videos.routes.ts:38-120` | ✅ built, **all `requireAuth`**                                                  |
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
| `videoLike`           | PK `(videoId, userId)`, **reverse index `(userId, videoId)`**                                                 | The reverse index is what turns "which of these 24 cards have I liked?" into one join. Copies `researchProgramPostReaction` (`schema.ts:8621`). |
| `videoSave`           | same                                                                                                          | Watch-later.                                                                                                                                    |
| `videoComment`        | `id`; index `(videoId, createdAt DESC) WHERE parent_comment_id IS NULL`, index `(parentCommentId, createdAt)` | One level of threading only. `isDeleted` + `deletedAt` tombstone so deleting a parent does not orphan its replies. `body` CHECK length 1..2000. |
| `videoCommentLike`    | PK `(commentId, userId)`                                                                                      |                                                                                                                                                 |
| `videoShare`          | `id`; index `(videoId, createdAt)`                                                                            | `channel` enum, `userId` nullable.                                                                                                              |
| `creatorSubscription` | PK `(subscriberId, creatorId)`, reverse index, CHECK `subscriber <> creator`                                  |                                                                                                                                                 |
| `videoPlaybackError`  | `id`; unique `(videoId, viewerFingerprint, reportDayBucket)`                                                  | Feeds the fast dead-player path, §8.2.                                                                                                          |
| `videoStats`          | PK `videoId`                                                                                                  | Counter cache. §3.4.                                                                                                                            |
| `creatorStats`        | PK `userId`                                                                                                   | `subscriberCount`, `publishedVideoCount`, `totalViewCount`.                                                                                     |

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
// src/services/feed.service.ts, with the same snake_case labels so the wire contract is unchanged.
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

Three new pure modules beside `src/lib/opportunity-score.ts`: `feed-score.ts`, `trending-score.ts`,
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

| Component         | Budget | Source                                                                                    |
| ----------------- | ------ | ----------------------------------------------------------------------------------------- |
| `videoQuality`    | 35     | `videoQualityScoreSnapshot`                                                               |
| `topicAffinity`   | 25     | max over the video's ≤3 categories                                                        |
| `creatorAffinity` | 15     | `userCreatorAffinitySnapshot`                                                             |
| `recency`         | 15     | hours since `publishedAt`: `<6→15, <24→13, <72→10, <168→7, <336→4, <720→2, else 0`        |
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
> what the mode *means*: stop ranking on how deep in the bubble you already are.

**`rankSeed = hash(userId ?? viewerFingerprint, asOfDay)`**, echoed in every response and accepted
back on the next page request. This is what makes exploration deterministic — Rule 2 forbids
`Math.random()`, and it would be wrong here anyway: a random exploration term reshuffles the feed
between page 1 and page 2 and shows the same video twice.

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

### 4.8 Modes

| Mode                | Behaviour                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`               | The blended rank of §4.3. Default.                                                                                                                                               |
| `trending`          | `trendingVideoSnapshot` rank order. `limit=3` is what Spotlight asks for.                                                                                                        |
| `recently_uploaded` | `publishedAt DESC` over the candidate pool.                                                                                                                                      |
| `new_to_you`        | `all`, with creators the viewer has already watched excluded and the exploration budget raised to 40.                                                                            |
| `watched`           | The viewer's own counted-view history, most recent first. **401 when anonymous** — serving it off a fingerprint would leak one person's history to everyone behind the same NAT. |

---

## 5. Routes

### 5.1 Feed — `src/routes/feed.routes.ts`, `attachOptionalUser`

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

### 5.2 Engagement — `src/routes/engagement.routes.ts`

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
`trendingVideoSnapshot` (top 200, with a `rank` column — Spotlight is `rank <= 3`) ·
`platformCategoryPopularitySnapshot`.

Every scheduled job follows the mandatory **tick pattern** (`src/jobs/scheduled-ticks.ts`): the
cron fires a `-tick` queue, the tick quantizes `now` to a UTC boundary and enqueues the real job
with an explicit `asOf` plus an idempotency key derived from it. This is the only place in the
domain where `new Date()` is called.

| Job                                      | Cron               | Why this slot                                                                           |
| ---------------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `recompute-video-durations`              | `08 1 * * *`       | must precede quality — completion needs a denominator                                   |
| `recompute-video-quality-scores`         | `25 1 * * *`       | after durations                                                                         |
| `recompute-platform-category-popularity` | `40 1 * * *`       | after quality; feeds cold start                                                         |
| `recompute-user-affinities`              | `50 1 * * *`       | after popularity                                                                        |
| `recompute-trending-videos`              | `18 * * * *`       | **hourly.** A "trending" chip recomputed nightly is a lie about what it says.           |
| `verify-youtube-video`                   | on demand, backoff | §8.3 deferred verification                                                              |
| `revalidate-youtube-embeds`              | `10 5 * * *`       | backstop for §8.2                                                                       |
| `prune-engagement-data`                  | `55 4 * * *`       | snapshots at 14 days; `videoViewSession` dropped at 90. **Dry-run by default** — see below |

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
> denominator collapses (engagement *inflates*) and velocity falls to zero, silently re-ranking
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
`commentUpdateLimiter` · `commentLikeLimiter` · `subscribeLimiter`.

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

### 8.3 oEmbed outage blocks uploads

Today, `POST /videos` hard-fails with `502 YOUTUBE_VERIFY_FAILED` when the oEmbed call fails.
That is the correct trade against storing an unverified id — but it means an outage at YouTube
throws away the creator's work.

New column, new flow:

```ts
isSourceVerified: boolean("is_source_verified").default(false).notNull(),
```

The 11-character id is parsed and stored regardless — the charset CHECK still applies, so SSRF is
still closed at the storage layer. The row is created as `draft` with `isSourceVerified: false`,
and a `verify-youtube-video` job retries with backoff. **Publish is refused while the flag is
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

| Phase | Scope                                                                                                                                  | Done when                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1     | `contentCategory` + `videoCategory` + seed + `GET /feed/categories`; `isSourceVerified` + `verify-youtube-video`; studio `categoryIds` | `curl /feed/categories` returns the seeded rows                                                           |
| 2     | Engagement tables + `videoStats` + write routes + beacon clamping + playback-error                                                     | Like/comment/beacon persist; counters move in the same transaction                                        |
| 3     | `feed-score.ts` / `trending-score.ts` / `affinity-score.ts` + snapshots + jobs + `GET /feed/videos`                                    | `curl '/feed/videos?limit=24'` ranks for both anonymous and authed; `?mode=trending&limit=3` is Spotlight |

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
