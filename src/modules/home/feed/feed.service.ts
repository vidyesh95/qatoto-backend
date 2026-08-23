import { desc, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  platformCategoryPopularitySnapshot,
  userCreatorAffinitySnapshot,
  userTopicAffinitySnapshot,
} from "#src/db/schema.js";
import {
  applyDiversityCaps,
  FEED_RANK_COMPONENT_BUDGETS,
  feedRankExpression,
  NEW_TO_YOU_RANK_COMPONENT_BUDGETS,
  reserveExplorationSlots,
} from "#src/lib/feed-score.js";
import { logger } from "#src/lib/logger.js";
import { escapeLikePattern } from "#src/lib/sql-pattern.js";
import { utcDateFromRow, utcTimestamp } from "#src/lib/sql-time.js";
import {
  ANONYMOUS_AFFINITY_WINDOW_DAYS,
  computeAffinityScorePoints,
  COLD_START_POPULARITY_DAMPING_PERCENT,
} from "#src/modules/home/affinity-score.js";
import type { Result } from "#src/types/index.js";

/**
 * The one ranked page the entire homepage reads — HOME_BACKEND_STRUCTURE.md §4, §5.1.
 *
 * ## Rule 3: there is ONE feed route
 *
 * Recommended and Explore are a FRONTEND SLICE of this page, not two response fields.
 * Spotlight is this route with `?mode=trending&limit=3`. The filter chips are this route
 * with `?categorySlug=`. One ranking contract, one cache story, and exactly one place a
 * ranking bug can live.
 *
 * ## Where the arithmetic is, and why
 *
 * The blended rank of §4.3 is an integer SQL expression rendered by `feed-score.ts`, which
 * owns the budgets and the recency ladder. Ranking in TypeScript instead would mean
 * fetching every candidate above the requested offset — page 200 at limit 50 pulls 30,000
 * rows to return 50. The ladder-based inputs it reads (quality, affinity) were computed in
 * pure TypeScript by the nightly jobs, where they can be unit-tested.
 *
 * ## Pagination is offset, not cursor
 *
 * A cursor needs a stable sort key and rank is not one — a keyset over a value recomputed
 * per request silently reshuffles page 2. Offset plus a pinned `rankSeed` gives stability
 * for the length of a session, which is the actual requirement.
 */

export const FEED_MODES = [
  "all",
  "trending",
  "new_to_you",
  "recently_uploaded",
  "watched",
] as const;
export type FeedMode = (typeof FEED_MODES)[number];

// NOT a pgEnum. §3.1 lists `feed_mode` as one, but it backs a QUERY PARAMETER and no column
// stores it — a Postgres type nothing can be assigned to is a migration nobody can reverse
// cheaply. Values stay snake_case so they byte-match the doc's wire contract.

export type FeedError = {
  readonly type: "WATCH_HISTORY_REQUIRES_SESSION";
};

export interface FeedVideoItem {
  readonly videoId: string;
  readonly youtubeVideoId: string | null;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  readonly publishedAt: Date | null;
  readonly durationSeconds: number | null;
  readonly creator: {
    readonly id: string;
    readonly handle: string | null;
    readonly name: string;
    readonly imageUrl: string | null;
  };
  readonly categories: readonly { readonly slug: string; readonly label: string }[];
  readonly stats: {
    readonly viewCount: number;
    readonly likeCount: number;
    readonly commentCount: number;
  };
  readonly viewerState: {
    readonly hasLiked: boolean;
    readonly hasSaved: boolean;
    readonly isSubscribedToCreator: boolean;
  };
  /** Always false (§5.3). Nothing backs live streaming and this doc says so. */
  readonly isChannelLive: false;
  /**
   * When this viewer last started watching, and PRESENT ONLY ON `mode=watched`.
   *
   * OPTIONAL RATHER THAN `Date | null`, because absence here is not a fact about the
   * viewer. On `mode=all` the question was never asked; a `null` would claim "never
   * watched", which the feed has no idea about and did not look up.
   *
   * It is `max(first_beacon_at)` over the viewer's un-hidden counted sessions — the
   * same expression `orderByClause` sorts on, and they must stay the same expression:
   * the client groups this list into date headers in one pass, so a value that
   * disagrees with the sort key makes a date group end and then reappear further down.
   */
  readonly watchedAt?: Date;
}

export interface ListFeedVideosInput {
  readonly mode: FeedMode;
  readonly categorySlug: string | null;
  readonly page: number;
  readonly limit: number;
  readonly viewerUserId: string | null;
  readonly viewerFingerprint: string;
  readonly rankSeed: string;
}

export interface FeedPage {
  readonly rows: readonly FeedVideoItem[];
  readonly total: number;
  readonly rankSeed: string;
  /** Logged, NEVER put in the response body. See `RELAXATION_STAGES`. */
  readonly relaxationStage: number;
}

/** §4.5's window. Beyond it, only a currently-trending video stays in the pool. */
const CANDIDATE_RECENCY_WINDOW_DAYS = 180;

/** §4.5's exclusion: don't re-serve something this viewer already finished. */
const ALREADY_WATCHED_EXCLUSION_DAYS = 30;

/** §4.6's caps. */
const MAXIMUM_ROWS_PER_CREATOR = 2;
const MAXIMUM_CATEGORY_SHARE_BASIS_POINTS = 4_000;

/** §4.4's traffic pool: reserved slots for genuinely new videos. */
const EXPLORATION_SLOTS_PER_PAGE = 4;
const EXPLORATION_FRESHNESS_HOURS = 72;
const EXPLORATION_MAXIMUM_COUNTED_VIEWS = 50;

/**
 * How deep the diversified prefix goes — four pages of 24.
 *
 * §4.6's caps and §4.4's quota are both PERMUTATIONS of a fixed prefix of the ranking, and
 * this is that prefix. Everything past it is served as the raw ranked offset.
 *
 * WHY A PREFIX AND NOT A PER-PAGE WINDOW. A post-rank pass over a window wider than the
 * page breaks offset pagination outright: the rows it demotes on page 1 are exactly the
 * rows page 2's offset lands on, so a viewer sees some videos twice and others never. A
 * permutation of a FIXED prefix has no such boundary — every page slices one deterministic
 * sequence, and the sequence past row 96 is untouched.
 *
 * Bounded and constant, not proportional to `page`: any request inside the prefix fetches
 * 96 rows, whether it is page 1 or page 4.
 */
const DIVERSIFIED_PREFIX_ROWS = 96;

/**
 * §4.7's relaxation ladder, in the order it degrades.
 *
 * An under-filled homepage is a real failure mode on a young catalog, and it must degrade
 * in a STATED order rather than by accident. The stage reached goes in the structured log
 * and NEVER in the response body — it is an operational fact about the catalog, not
 * something a client should branch on.
 *
 * NOTE WHAT IS NOT HERE. §4.7 lists "drop the diversity cap" as stage 1. It is gone,
 * because the cap is now a permutation and a permutation cannot under-fill a page — there
 * is nothing to relax. Every stage that remains is a genuine FILTER, which is the only kind
 * of thing that can leave a page short.
 *
 * ORDER IS BY CONSEQUENCE, LOOSEST LAST. The gates below read `< 1`, `< 2`, `< 3`, so a
 * higher stage is a weaker filter. Creator self-exclusion is last because it is the only one
 * that changes WHOSE content a viewer sees rather than HOW MUCH — the other two return
 * videos the viewer would have been shown anyway, just older or already watched. It exists
 * for the young-catalog case it was found in: a solo creator whose feed is empty because
 * every video in the catalog is their own. At any real catalog size the page fills long
 * before stage 3 and nobody is ever shown their own uploads.
 *
 * WHAT THE LADDER DOES NOT REACH: the two feed-preference exclusions — `video_not_interested`
 * and `creator_mute` — are pushed OUTSIDE every stage gate and no stage drops them. Every
 * filter listed above is a heuristic, a guess about what a viewer would enjoy, and a guess is
 * worth abandoning to avoid an empty page. Those two are stated preferences, and a dismiss
 * button that silently stops working on a thin catalog is worse than a short feed — the
 * viewer cannot tell it apart from a broken one.
 */
const RELAXATION_STAGES = [
  "full filter",
  "already-watched exclusion dropped",
  "180-day window dropped",
  "creator self-exclusion dropped",
] as const;

/**
 * Which snapshot generation to read.
 *
 * RESOLVED INDEPENDENTLY PER TABLE, not assumed to be one shared value. The three nightly
 * jobs are separate queue entries and one can fail while the others succeed; a feed that
 * silently read a missing snapshot as zero would be Rule 5 violated at the worst possible
 * place — it would tell a viewer with real, computed affinity that they have none.
 *
 * ## Why three builder reads and not one `db.execute` with three `max()` subselects
 *
 * `db.execute<{ as_of: Date }>` is a CLAIM, not a parse instruction: the raw driver row is
 * whatever node-pg produced, and the annotation does not convert it. These values are then
 * fed back into a query as timestamps, so a string arriving where a Date was promised is a
 * runtime failure in the rendering, not a type error at the boundary.
 *
 * Reading the real COLUMN through the query builder goes through drizzle's timestamp
 * mapping and yields an actual `Date`. `recompute-opportunity-scores.ts` records the same
 * hazard against `sql<Date>\`max(…)\`` and makes the same call. Each read is an index-only
 * scan of one row on an indexed column.
 */
async function latestSnapshotAsOf(
  table:
    | typeof userTopicAffinitySnapshot
    | typeof userCreatorAffinitySnapshot
    | typeof platformCategoryPopularitySnapshot,
): Promise<Date | null> {
  const [row] = await db
    .select({ asOf: table.asOf })
    .from(table)
    .orderBy(desc(table.asOf))
    .limit(1);
  return row?.asOf ?? null;
}

async function resolveSnapshotGenerations(): Promise<{
  readonly topicAffinityAsOf: Date | null;
  readonly creatorAffinityAsOf: Date | null;
  readonly popularityAsOf: Date | null;
}> {
  const [topicAffinityAsOf, creatorAffinityAsOf, popularityAsOf] = await Promise.all([
    latestSnapshotAsOf(userTopicAffinitySnapshot),
    latestSnapshotAsOf(userCreatorAffinitySnapshot),
    latestSnapshotAsOf(platformCategoryPopularitySnapshot),
  ]);

  return { topicAffinityAsOf, creatorAffinityAsOf, popularityAsOf };
}

type AnonymousAffinityRow = {
  readonly category_id: string;
  readonly counted_view_count: number;
  readonly completion_bp_sum: number;
  readonly completion_sample_count: number;
};

/**
 * §4.4's anonymous cold start — affinity computed IN-REQUEST from the viewer's fingerprint.
 *
 * WHY THIS IS WORTH A QUERY ON THE HOT PATH. Most first visits are logged out. Without it
 * an anonymous visitor's feed is a flat popularity list forever, no matter what they
 * watch; with it, it starts responding after two or three videos.
 *
 * Seven days, not the 90 the signed-in snapshot uses: a fingerprint is a per-day bucket key
 * over an IP and a user agent, so a 90-day profile keyed on one is a profile of a coffee
 * shop rather than a person.
 *
 * The scoring runs through the SAME pure module the nightly job uses — the alternative
 * would be a second copy of the ladders written in SQL, and the two would drift.
 */
async function computeAnonymousTopicAffinity(
  viewerFingerprint: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await db.execute<AnonymousAffinityRow>(sql`
    SELECT
      vc.category_id,
      count(*)::int                                    AS counted_view_count,
      COALESCE(sum(s.completion_basis_points), 0)::int AS completion_bp_sum,
      count(*)::int                                    AS completion_sample_count
    FROM video_view_session AS s
    JOIN video_category AS vc ON vc.video_id = s.video_id
    WHERE s.viewer_fingerprint = ${viewerFingerprint}
      AND s.is_counted_view
      AND s.first_beacon_at >= now() - make_interval(days => ${ANONYMOUS_AFFINITY_WINDOW_DAYS})
    GROUP BY vc.category_id
  `);

  return new Map(
    rows.rows.map((row) => [
      row.category_id,
      computeAffinityScorePoints({
        countedViewCount: row.counted_view_count,
        completionBasisPointsSum: row.completion_bp_sum,
        completionSampleCount: row.completion_sample_count,
        // An anonymous viewer has no likes, saves or subscriptions to read — those all
        // require an account. Zero here is a true statement, not a fabricated one.
        likeCount: 0,
        saveCount: 0,
        isSubscribedToCreator: false,
        // THESE TWO ZEROES ARE NOT THE SAME KIND OF ZERO as the three above, and the
        // difference is worth stating rather than letting the shared line imply otherwise.
        // Like and save are gated by `requireIdentifiedUser`, so an anonymous session
        // genuinely CANNOT have them. The two feed preferences are deliberately NOT gated
        // that way — an anonymous session can dismiss a video and mute a creator — so a
        // nonzero count may really exist and this zero is a limitation, not a fact.
        //
        // It is the right limitation to accept here. This function is keyed on a
        // FINGERPRINT, which is all §4.4's cold start has; the preferences are keyed on a
        // user id, and threading one in would mean two different identity models deciding
        // one score. Nothing is lost that the viewer can see: §4.5's `NOT EXISTS` still
        // removes the dismissed video and the muted creator from the candidate pool for
        // anyone carrying a session. Only the topic DAMPING is skipped, which is the
        // softer half and the half that needs a durable profile to be worth computing.
        dismissalCount: 0,
        isCreatorMuted: false,
      }).totalPoints,
    ]),
  );
}

/**
 * The topic-affinity term, as SQL.
 *
 * `max` over the video's ≤3 categories (§4.3): a video tagged Robotics and Toys should
 * rank on whichever the viewer actually likes, not on the average of the two.
 *
 * The COALESCE chain IS §4.4's cold start: this viewer's affinity, else damped platform
 * popularity, else 0. A signed-in viewer with no history lands on the middle branch, which
 * is a sensible feed that is not *claiming* to be personalized.
 */
function topicAffinityExpression(input: {
  readonly viewerUserId: string | null;
  readonly topicAffinityAsOf: Date | null;
  readonly popularityAsOf: Date | null;
  readonly anonymousAffinity: ReadonlyMap<string, number>;
}): SQL {
  const popularityFallback =
    input.popularityAsOf === null
      ? sql`NULL::int`
      : sql`(
          SELECT pop.popularity_points * ${COLD_START_POPULARITY_DAMPING_PERCENT} / 100
          FROM platform_category_popularity_snapshot AS pop
          WHERE pop.category_id = vc.category_id AND pop.as_of = ${utcTimestamp(input.popularityAsOf)}
        )`;

  const viewerAffinity =
    input.viewerUserId !== null && input.topicAffinityAsOf !== null
      ? sql`(
          SELECT ta.affinity_points
          FROM user_topic_affinity_snapshot AS ta
          WHERE ta.user_id = ${input.viewerUserId}
            AND ta.category_id = vc.category_id
            AND ta.as_of = ${utcTimestamp(input.topicAffinityAsOf)}
        )`
      : input.anonymousAffinity.size > 0
        ? // The in-request anonymous map, inlined as a VALUES list rather than a temp
          // table. It is at most a couple of dozen rows and it lives for one query.
          sql`(
            SELECT anon.affinity_points FROM (VALUES ${sql.join(
              [...input.anonymousAffinity].map(
                ([categoryId, points]) => sql`(${categoryId}::text, ${points}::int)`,
              ),
              sql`, `,
            )}) AS anon(category_id, affinity_points)
            WHERE anon.category_id = vc.category_id
          )`
        : sql`NULL::int`;

  return sql`COALESCE((
    SELECT max(COALESCE(${viewerAffinity}, ${popularityFallback}, 0))
    FROM video_category AS vc
    WHERE vc.video_id = v.id
  ), 0)`;
}

/**
 * §4.3's no-affinity boost: is this video's subject UNFAMILIAR to this viewer?
 *
 * True when the viewer has no measured affinity for any of the video's categories. That is
 * a sharper question than "is `topicAffinityPoints` zero" — that value has already passed
 * through the cold-start popularity fallback, so a zero there can mean "we substituted the
 * platform average", which is not the same as "they have never watched this subject".
 *
 * An UNTAGGED video counts as unfamiliar (`NOT EXISTS` over an empty set is true), which is
 * the right answer: it belongs to no subject the viewer has an opinion about.
 *
 * A viewer with NO affinity data at all — a brand-new account, or an anonymous first visit
 * — gets the boost on every candidate. It therefore cancels out and changes no ordering,
 * which is correct: with nothing to escape, there is no bubble to break.
 */
function hasNoTopicAffinityExpression(input: {
  readonly viewerUserId: string | null;
  readonly topicAffinityAsOf: Date | null;
  readonly anonymousAffinity: ReadonlyMap<string, number>;
}): SQL {
  if (input.viewerUserId !== null && input.topicAffinityAsOf !== null) {
    return sql`NOT EXISTS (
      SELECT 1
      FROM video_category AS bvc
      JOIN user_topic_affinity_snapshot AS bta
        ON bta.category_id = bvc.category_id
       AND bta.user_id = ${input.viewerUserId}
       AND bta.as_of = ${utcTimestamp(input.topicAffinityAsOf)}
      WHERE bvc.video_id = v.id
    )`;
  }

  if (input.anonymousAffinity.size > 0) {
    return sql`NOT EXISTS (
      SELECT 1
      FROM video_category AS bvc
      WHERE bvc.video_id = v.id
        AND bvc.category_id IN (${sql.join(
          [...input.anonymousAffinity.keys()].map((categoryId) => sql`${categoryId}`),
          sql`, `,
        )})
    )`;
  }

  // No affinity data of any kind: every video is unfamiliar, so the boost is uniform and
  // the ordering is unchanged.
  return sql`true`;
}

/**
 * The creator-affinity term.
 *
 * ZERO FOR AN ANONYMOUS VIEWER, and deliberately not approximated from their session
 * history. Creator affinity's whole job is to surface people you follow; a fingerprint
 * cannot follow anyone, and inventing a value from three watches would put a creator's
 * back catalogue in front of somebody who watched one video by accident.
 */
function creatorAffinityExpression(input: {
  readonly viewerUserId: string | null;
  readonly creatorAffinityAsOf: Date | null;
}): SQL {
  if (input.viewerUserId === null || input.creatorAffinityAsOf === null) {
    return sql`0`;
  }
  return sql`COALESCE((
    SELECT ca.affinity_points
    FROM user_creator_affinity_snapshot AS ca
    WHERE ca.user_id = ${input.viewerUserId}
      AND ca.creator_id = v.creator_id
      AND ca.as_of = ${utcTimestamp(input.creatorAffinityAsOf)}
  ), 0)`;
}

/**
 * "This video may be shown to a stranger" — and nothing else.
 *
 * ⚠️ THE FIVE STATUS TERMS ARE SPELLED OUT AS LITERALS, byte-identical to
 * `video_feed_candidate_idx`'s predicate (schema.ts). Postgres uses a partial index only
 * when it can PROVE the query's WHERE implies the predicate, and that proof works against
 * literals, not bound parameters. See the long note on `candidatePoolPredicate` below.
 *
 * SHARED BY THE FEED AND BY SEARCH, which is why it is its own function: two copies of five
 * literals is two chances for one of them to drift out of the index's predicate, and the
 * penalty for drift is a silent sequential scan rather than an error.
 *
 * IT DELIBERATELY CARRIES NOTHING ELSE. The recency window, the already-watched exclusion
 * and the creator self-exclusion are FEED RANKING decisions, not visibility ones — search
 * must return an eight-month-old video the viewer already watched and uploaded themselves,
 * because they typed its title.
 */
function publicVideoPredicate(): SQL {
  return sql`v.publish_status = 'published'
        AND v.visibility = 'public'
        AND v.upload_status = 'ready'
        AND v.is_source_verified = true
        AND v.review_status IN ('not_required', 'approved')
        AND v.moderation_visibility_state = 'visible'
        AND v.published_at IS NOT NULL AND v.published_at <= now()`;
}

/**
 * §4.5's candidate pool.
 *
 * ⚠️ THE FIVE STATUS TERMS ARE SPELLED OUT AS LITERALS, byte-identical to
 * `video_feed_candidate_idx`'s predicate (schema.ts). Postgres uses a partial index only
 * when it can PROVE the query's WHERE implies the predicate, and that proof works against
 * literals, not bound parameters — `review_status = ANY($1)` does not imply
 * `review_status IN ('not_required','approved')` as far as the planner is concerned.
 *
 * Get this wrong and there is no error anywhere. There is just a sequential scan, and it
 * is the single most likely way this route ships broken.
 */
function candidatePoolPredicate(input: {
  readonly viewerUserId: string | null;
  readonly viewerFingerprint: string;
  readonly categorySlug: string | null;
  readonly relaxationStage: number;
  readonly mode: FeedMode;
}): SQL {
  const conditions: SQL[] = [publicVideoPredicate()];

  // THE TWO STATED PREFERENCES, and the only conditions here with no stage gate — see the
  // note on RELAXATION_STAGES for why the ladder must not reach them.
  //
  // `mode=watched` IS EXEMPT, and the exemption is the whole reason `mode` is a parameter.
  // This function is shared by every mode including the one that renders /history, and watch
  // history is a RECORD rather than a recommendation: a video the viewer dismissed is still
  // a video they watched. Suppressing it here would make "not interested" quietly rewrite
  // their history, which the button does not claim and no viewer would expect.
  //
  // Anonymous viewers are skipped because there is nothing to key on — a better-auth
  // anonymous SESSION carries a real `user.id` and does get these exclusions; only a caller
  // with no session at all falls through, and they have written no preference to honour.
  if (input.viewerUserId !== null && input.mode !== "watched") {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM video_not_interested AS ni
      WHERE ni.video_id = v.id AND ni.viewer_id = ${input.viewerUserId}
    )`);
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM creator_mute AS cm
      WHERE cm.creator_id = v.creator_id AND cm.muter_id = ${input.viewerUserId}
    )`);
  }

  // A creator's own videos are never in their feed. Nothing enforces this downstream, and
  // without it the highest-affinity creator for any creator is themselves.
  //
  // Dropped at the LAST relaxation stage, and only there. On a catalog where one account
  // uploaded everything, this predicate alone empties that account's homepage — an empty
  // page is worse than a page of your own uploads, but only once nothing else can fill it.
  if (input.viewerUserId !== null && input.relaxationStage < 3) {
    conditions.push(sql`v.creator_id <> ${input.viewerUserId}`);
  }

  if (input.categorySlug !== null) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM video_category AS fc
      JOIN content_category AS cc ON cc.id = fc.category_id
      WHERE fc.video_id = v.id AND cc.slug = ${input.categorySlug} AND cc.is_active
    )`);
  }

  // Stage 2 drops the recency window. Until then: the last 180 days, OR anything currently
  // trending — the escape hatch that stops an evergreen hit falling off a cliff at day 181.
  if (input.relaxationStage < 2) {
    conditions.push(sql`(
      v.published_at > now() - make_interval(days => ${CANDIDATE_RECENCY_WINDOW_DAYS})
      OR EXISTS (
        SELECT 1 FROM video_stats AS ts
        WHERE ts.video_id = v.id AND ts.trending_rank IS NOT NULL
      )
    )`);
  }

  // Stage 1 drops the already-watched exclusion.
  //
  // ⚠️ KEYED ON `viewer_id` WHEN SIGNED IN, `viewer_fingerprint` ONLY WHEN NOT.
  //
  // The fingerprint ROTATES DAILY by construction (viewer-fingerprint.ts), so keying a
  // 30-day lookback on it would silently match nothing older than today — the exclusion
  // would appear to work, and quietly re-serve a signed-in viewer everything they watched
  // last week. For an anonymous viewer the fingerprint IS the only identity there is, and
  // the same rotation means their exclusion is honestly same-day only.
  if (input.relaxationStage < 1) {
    const viewerMatch =
      input.viewerUserId !== null
        ? sql`ws.viewer_id = ${input.viewerUserId}`
        : sql`ws.viewer_fingerprint = ${input.viewerFingerprint}`;
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM video_view_session AS ws
      WHERE ws.video_id = v.id
        AND ws.is_counted_view
        AND ws.hidden_from_history_at IS NULL
        AND ${viewerMatch}
        AND ws.first_beacon_at > now() - make_interval(days => ${ALREADY_WATCHED_EXCLUSION_DAYS})
    )`);
  }

  return sql.join(conditions, sql` AND `);
}

type FeedRow = {
  readonly video_id: string;
  readonly youtube_video_id: string | null;
  readonly title: string;
  readonly thumbnail_url: string | null;
  /**
   * A STRING at runtime, not a Date — drizzle disables the temporal type parsers on every
   * prepared query and `db.execute` has no column codec to recover with. Declaring it
   * `Date | null` here is what let `'2026-08-02 17:36:54.105'` reach the wire. `utcDateFromRow`
   * in `toFeedVideoItem` is the conversion; `src/lib/sql-time.ts` has the full account.
   */
  readonly published_at: string | Date | null;
  readonly duration_seconds: number | null;
  readonly creator_id: string;
  readonly creator_handle: string | null;
  readonly creator_name: string;
  readonly creator_image_url: string | null;
  readonly view_count: number;
  readonly like_count: number;
  readonly comment_count: number;
  readonly has_liked: boolean;
  readonly has_saved: boolean;
  readonly is_subscribed_to_creator: boolean;
  readonly category_slugs: readonly string[] | null;
  readonly category_labels: readonly string[] | null;
  /**
   * SELECTED ONLY BY `mode=watched` — the lateral join that supplies it exists in no
   * other query, so this is `undefined` (key absent) everywhere else rather than null.
   *
   * A string at runtime for the same reason as `published_at` above; `utcDateFromRow`
   * is the conversion. Do not declare it `Date`.
   */
  readonly watched_at?: string | Date | null;
};

type TotalRow = { readonly total: number };

function toFeedVideoItem(row: FeedRow): FeedVideoItem {
  const slugs = row.category_slugs ?? [];
  const labels = row.category_labels ?? [];
  return {
    videoId: row.video_id,
    youtubeVideoId: row.youtube_video_id,
    title: row.title,
    thumbnailUrl: row.thumbnail_url,
    // A real Date, so `JSON.stringify` emits ISO 8601 with an explicit `Z` — the same shape
    // `GET /feed/watch/:id` sends for this column. Without it the two routes disagreed.
    publishedAt: utcDateFromRow(row.published_at),
    // NULL until `recompute-video-durations` has five samples. Never substituted with a
    // client's `reportedDurationSeconds` — that number comes from the hostile side.
    durationSeconds: row.duration_seconds,
    creator: {
      id: row.creator_id,
      handle: row.creator_handle,
      name: row.creator_name,
      imageUrl: row.creator_image_url,
    },
    categories: slugs.map((slug, index) => ({ slug, label: labels[index] ?? slug })),
    stats: {
      viewCount: row.view_count,
      likeCount: row.like_count,
      commentCount: row.comment_count,
    },
    // `false`, not `null`, for an anonymous viewer — definitionally true of them, not a
    // stand-in for a value we failed to look up.
    viewerState: {
      hasLiked: row.has_liked,
      hasSaved: row.has_saved,
      isSubscribedToCreator: row.is_subscribed_to_creator,
    },
    isChannelLive: false,
    // KEY-PRESENT-OR-ABSENT, never a null. `watched_at` is selected by exactly one query
    // (`mode=watched`), so `undefined` here means nobody asked — see the field's own note
    // on `FeedVideoItem`. `JSON.stringify` drops the key entirely, which is the contract
    // the frontend's `watchedAt: z.iso.datetime().optional()` parses.
    ...(row.watched_at === undefined || row.watched_at === null
      ? {}
      : { watchedAt: utcDateFromRow(row.watched_at) ?? undefined }),
  };
}

/**
 * The per-viewer flags and the card's own columns. Shared by every mode and by search.
 *
 * `isWatchHistory` appends `watched.watched_at`, and it is a parameter rather than
 * something read off the mode because the `watched` alias only exists in ONE query —
 * the `mode=watched` page read, which is the only one that adds the lateral join.
 * Selecting it unconditionally is a `relation "watched" does not exist` on every other
 * call, including search.
 */
function feedSelectClause(viewerUserId: string | null, isWatchHistory = false): SQL {
  const viewerFlag = (tableName: SQL, userColumn: SQL): SQL =>
    viewerUserId === null
      ? sql`false`
      : sql`EXISTS (SELECT 1 FROM ${tableName} AS f WHERE f.video_id = v.id AND ${userColumn})`;

  return sql`
    v.id AS video_id,
    v.youtube_video_id,
    v.title,
    v.thumbnail_url,
    v.published_at,
    v.duration_seconds,
    v.creator_id,
    u.handle AS creator_handle,
    u.name   AS creator_name,
    u.image  AS creator_image_url,
    COALESCE(vs.view_count, 0)    AS view_count,
    COALESCE(vs.like_count, 0)    AS like_count,
    COALESCE(vs.comment_count, 0) AS comment_count,
    ${viewerFlag(sql`video_like`, sql`f.user_id = ${viewerUserId}`)}  AS has_liked,
    ${viewerFlag(sql`video_save`, sql`f.user_id = ${viewerUserId}`)}  AS has_saved,
    ${
      viewerUserId === null
        ? sql`false`
        : sql`EXISTS (
            SELECT 1 FROM creator_subscription AS cs
            WHERE cs.creator_id = v.creator_id AND cs.subscriber_id = ${viewerUserId}
          )`
    } AS is_subscribed_to_creator,
    (
      SELECT array_agg(cc.slug ORDER BY cc.sort_order, cc.slug)
      FROM video_category AS vc JOIN content_category AS cc ON cc.id = vc.category_id
      WHERE vc.video_id = v.id
    ) AS category_slugs,
    (
      SELECT array_agg(cc.label ORDER BY cc.sort_order, cc.slug)
      FROM video_category AS vc JOIN content_category AS cc ON cc.id = vc.category_id
      WHERE vc.video_id = v.id
    ) AS category_labels
    ${isWatchHistory ? sql`, watched.watched_at AS watched_at` : sql``}
  `;
}

/** How each mode orders its page. Every one ends in a unique column. */
function orderByClause(mode: FeedMode, rankExpression: SQL): SQL {
  switch (mode) {
    case "trending":
      // NULLS LAST is not needed: the mode's predicate already excludes unranked rows.
      return sql`vs.trending_rank ASC, v.id ASC`;
    case "recently_uploaded":
      return sql`v.published_at DESC, v.id DESC`;
    case "watched":
      return sql`watched_at DESC, v.id DESC`;
    case "all":
    case "new_to_you":
      return sql`${rankExpression} DESC, v.published_at DESC, v.id DESC`;
    default: {
      const exhaustiveCheck: never = mode;
      throw new Error(`Unhandled feed mode: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function listFeedVideos(
  input: ListFeedVideosInput,
): Promise<Result<FeedPage, FeedError>> {
  if (input.mode === "watched" && input.viewerUserId === null) {
    // §4.8: serving watch history off a fingerprint would hand one person's history to
    // everyone behind the same NAT.
    return { success: false, error: { type: "WATCH_HISTORY_REQUIRES_SESSION" } };
  }

  const generations = await resolveSnapshotGenerations();
  const anonymousAffinity =
    input.viewerUserId === null && input.mode !== "recently_uploaded"
      ? await computeAnonymousTopicAffinity(input.viewerFingerprint)
      : new Map<string, number>();

  const rankExpression = feedRankExpression(
    {
      qualityPoints: sql`vs.quality_score_points`,
      topicAffinityPoints: topicAffinityExpression({
        viewerUserId: input.viewerUserId,
        topicAffinityAsOf: generations.topicAffinityAsOf,
        popularityAsOf: generations.popularityAsOf,
        anonymousAffinity,
      }),
      creatorAffinityPoints: creatorAffinityExpression({
        viewerUserId: input.viewerUserId,
        creatorAffinityAsOf: generations.creatorAffinityAsOf,
      }),
      publishedAt: sql`v.published_at`,
      videoId: sql`v.id`,
      hasNoTopicAffinity: hasNoTopicAffinityExpression({
        viewerUserId: input.viewerUserId,
        topicAffinityAsOf: generations.topicAffinityAsOf,
        anonymousAffinity,
      }),
    },
    {
      rankSeed: input.rankSeed,
      budgets:
        input.mode === "new_to_you"
          ? NEW_TO_YOU_RANK_COMPONENT_BUDGETS
          : FEED_RANK_COMPONENT_BUDGETS,
    },
  );

  const offset = (input.page - 1) * input.limit;

  // Inside the diversified prefix a request fetches the WHOLE prefix and slices it, so the
  // caps and the quota act on one deterministic sequence every page agrees on. Past it,
  // the raw ranked offset — untouched by either pass, and therefore disjoint from it.
  const isInsideDiversifiedPrefix =
    input.mode === "all" && offset + input.limit <= DIVERSIFIED_PREFIX_ROWS;

  for (let relaxationStage = 0; relaxationStage < RELAXATION_STAGES.length; relaxationStage += 1) {
    const modePredicate = modeSpecificPredicate(input);
    const wherePredicate = sql`${candidatePoolPredicate({
      viewerUserId: input.viewerUserId,
      viewerFingerprint: input.viewerFingerprint,
      categorySlug: input.categorySlug,
      relaxationStage,
      mode: input.mode,
    })}${modePredicate === null ? sql`` : sql` AND ${modePredicate}`}`;

    const fetchLimit = isInsideDiversifiedPrefix ? DIVERSIFIED_PREFIX_ROWS : input.limit;
    const fetchOffset = isInsideDiversifiedPrefix ? 0 : offset;

    const watchedJoin =
      input.mode === "watched"
        ? sql`JOIN LATERAL (
            SELECT max(ws.first_beacon_at) AS watched_at
            FROM video_view_session AS ws
            WHERE ws.video_id = v.id
              AND ws.viewer_id = ${input.viewerUserId}
              AND ws.is_counted_view
              AND ws.hidden_from_history_at IS NULL
          ) AS watched ON true`
        : sql``;

    const [pageResult, totalResult] = await Promise.all([
      db.execute<FeedRow>(sql`
        SELECT ${feedSelectClause(input.viewerUserId, input.mode === "watched")}
        FROM video AS v
        JOIN "user" AS u ON u.id = v.creator_id
        LEFT JOIN video_stats AS vs ON vs.video_id = v.id
        ${watchedJoin}
        WHERE ${wherePredicate}
        ORDER BY ${orderByClause(input.mode, rankExpression)}
        LIMIT ${fetchLimit} OFFSET ${fetchOffset}
      `),
      db.execute<TotalRow>(sql`
        SELECT count(*)::int AS total
        FROM video AS v
        JOIN "user" AS u ON u.id = v.creator_id
        LEFT JOIN video_stats AS vs ON vs.video_id = v.id
        WHERE ${wherePredicate}
      `),
    ]);

    const total = totalResult.rows[0]?.total ?? 0;
    const rankedRows = pageResult.rows.map((row) => {
      const item = toFeedVideoItem(row);
      return {
        ...item,
        creatorId: item.creator.id,
        categorySlugs: item.categories.map((category) => category.slug),
      };
    });

    let pageRows = rankedRows;

    if (isInsideDiversifiedPrefix) {
      // Both passes are PERMUTATIONS of the prefix, so slicing it below can neither
      // duplicate a video across pages nor drop one out of the feed entirely.
      const diversified = applyDiversityCaps(rankedRows, {
        pageSize: input.limit,
        maxRowsPerCreator: MAXIMUM_ROWS_PER_CREATOR,
        maxCategoryShareBasisPoints: MAXIMUM_CATEGORY_SHARE_BASIS_POINTS,
      });
      const withQuota = reserveExplorationSlots(diversified, await fetchFreshCandidateIds(input), {
        slotsPerPage: EXPLORATION_SLOTS_PER_PAGE,
      });
      pageRows = withQuota.slice(offset, offset + input.limit);
    }

    // Only a genuine FILTER can leave a page short — the permutations above cannot.
    //
    // DELIBERATELY NOT `&& total > offset + pageRows.length`. That guard looks like it
    // avoids pointless relaxation, and instead makes relaxation UNREACHABLE: `total` is
    // computed under the SAME filter as the page, so when the filter is what emptied the
    // page, the total is empty too and the condition is false. A viewer who has watched
    // everything in the catalog would get a blank homepage and the ladder would never
    // fire. The last-stage check below is what bounds this to three queries.
    const isUnderFilled = pageRows.length < input.limit;
    const isLastStage = relaxationStage === RELAXATION_STAGES.length - 1;

    if (!isUnderFilled || isLastStage) {
      if (relaxationStage > 0) {
        logger.warn("feed: served under a relaxed filter", {
          mode: input.mode,
          page: input.page,
          relaxationStage,
          relaxationReason: RELAXATION_STAGES[relaxationStage],
          returnedCount: pageRows.length,
        });
      }

      return {
        success: true,
        value: {
          rows: pageRows.map(
            ({ creatorId: _creatorId, categorySlugs: _categorySlugs, ...item }) => item,
          ),
          total,
          rankSeed: input.rankSeed,
          relaxationStage,
        },
      };
    }
  }

  // Unreachable: the loop returns on its last stage. Present so the function is total.
  throw new Error("listFeedVideos: relaxation ladder exhausted without returning");
}

/** The extra predicate a mode adds on top of the candidate pool, or null for none. */
function modeSpecificPredicate(input: ListFeedVideosInput): SQL | null {
  switch (input.mode) {
    case "trending":
      return sql`vs.trending_rank IS NOT NULL`;
    case "watched":
      // `hidden_from_history_at IS NULL` must match the lateral join's copy of this
      // predicate exactly. THIS one is also what the count query runs — the lateral is
      // only in the page query — so a mismatch would leave `pagination.total` counting
      // rows the page can never show, and the last page would come back empty.
      return sql`EXISTS (
        SELECT 1 FROM video_view_session AS ws
        WHERE ws.video_id = v.id
          AND ws.viewer_id = ${input.viewerUserId}
          AND ws.is_counted_view
          AND ws.hidden_from_history_at IS NULL
      )`;
    case "new_to_you": {
      // §4.8: creators the viewer has already watched are excluded outright, and the
      // exploration budget is raised to 40 (applied in the rank expression).
      //
      // Same identity rule as the already-watched exclusion above, and for the same
      // reason: a daily-rotating fingerprint cannot answer "have I ever watched this
      // creator", which is the entire question this mode asks.
      const viewerMatch =
        input.viewerUserId !== null
          ? sql`ws.viewer_id = ${input.viewerUserId}`
          : sql`ws.viewer_fingerprint = ${input.viewerFingerprint}`;
      // Hidden sessions do not count as having watched the creator either: a viewer who
      // clears their whole history and then sees the same creators surface as "new to
      // you" has been told the clear did nothing.
      return sql`NOT EXISTS (
        SELECT 1 FROM video_view_session AS ws
        JOIN video AS wv ON wv.id = ws.video_id
        WHERE wv.creator_id = v.creator_id
          AND ${viewerMatch}
          AND ws.is_counted_view
          AND ws.hidden_from_history_at IS NULL
      )`;
    }
    case "all":
    case "recently_uploaded":
      return null;
    default: {
      const exhaustiveCheck: never = input.mode;
      throw new Error(`Unhandled feed mode: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * §4.4's traffic pool: which recent uploads are still almost unseen.
 *
 * Returns IDS ONLY. The quota pass promotes rows that are already inside the diversified
 * prefix rather than injecting rows from outside it, so it needs to recognise a fresh
 * video, not fetch one — and fetching one would be the injection that duplicates a video
 * across pages.
 */
async function fetchFreshCandidateIds(input: ListFeedVideosInput): Promise<ReadonlySet<string>> {
  const rows = await db.execute<{ readonly id: string }>(sql`
    SELECT v.id
    FROM video AS v
    LEFT JOIN video_stats AS vs ON vs.video_id = v.id
    WHERE ${candidatePoolPredicate({
      viewerUserId: input.viewerUserId,
      viewerFingerprint: input.viewerFingerprint,
      categorySlug: input.categorySlug,
      // DELIBERATELY PINNED AT 0, not threaded from the caller's ladder stage. This is a
      // recognition probe, not a page: it answers "is this video fresh and near-unseen",
      // and it only ever narrows a set the page query already produced. Relaxing it would
      // widen the exploration pool as a side effect of the page being short, which is a
      // different decision than the one the ladder is making.
      relaxationStage: 0,
      // Threaded, unlike the stage above, so a dismissed video or a muted creator is never
      // promoted into the exploration quota by a probe that did not know about them.
      mode: input.mode,
    })}
      AND v.published_at > now() - make_interval(hours => ${EXPLORATION_FRESHNESS_HOURS})
      AND COALESCE(vs.view_count, 0) < ${EXPLORATION_MAXIMUM_COUNTED_VIEWS}
  `);

  return new Set(rows.rows.map((row) => row.id));
}

/* -------------------------------------------------------------------------- */
/* Search                                                                       */
/* -------------------------------------------------------------------------- */

export interface SearchVideosInput {
  readonly query: string;
  readonly page: number;
  readonly limit: number;
  readonly viewerUserId: string | null;
}

export interface SearchVideoPage {
  readonly rows: readonly FeedVideoItem[];
  readonly total: number;
}

/**
 * `GET /feed/search` — relevance over `video.search_document`.
 *
 * ## It is not the feed with a WHERE clause
 *
 * Everything §4 does is deliberately absent here. No rank seed, no exploration quota, no
 * diversity permutation, no relaxation ladder. A viewer who typed "beni" is not browsing;
 * shuffling their results to give an unseen creator a chance is a bug wearing a feature's
 * clothes, and a ladder cannot help when a short page means "we do not have it" rather than
 * "the filter was too tight".
 *
 * The visibility predicate is `publicVideoPredicate` alone — no 180-day window, no
 * already-watched exclusion, and no creator self-exclusion. A creator searching for their own
 * upload must find it, which is exactly what the feed's pool is built to prevent.
 *
 * ## What is being matched
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it accepts quoted phrases, `or` and
 * `-excluded` from a person typing into a box, and it does not raise on syntax a person will
 * inevitably produce. `to_tsquery` would answer a 500 to an unbalanced quote.
 *
 * THE CREATOR TERM IS SEPARATE AND CANNOT BE OTHERWISE. `search_document` is a GENERATED
 * column, and a generated expression may only reference its own row — the handle and display
 * name live on `"user"`. So a name match is an OR branch evaluated at query time, and it
 * contributes a fixed rank rather than a `ts_rank_cd`, because there is no document to
 * measure coverage against.
 *
 * ## The stopword hole
 *
 * `websearch_to_tsquery('english', 'the a of')` is a VALID, EMPTY tsquery, and an empty
 * tsquery matches nothing. Left alone, searching "The Who" answers zero results with no
 * indication that the words were thrown away. `numnode() = 0` detects it and the query falls
 * back to a literal `ILIKE` over the title, which is what the reader meant. The pattern is
 * escaped — an unescaped `%` from a client turns a search box into a full-table-scan
 * selector.
 */
export async function searchVideos(input: SearchVideosInput): Promise<SearchVideoPage> {
  const tsQuery = sql`websearch_to_tsquery('english', ${input.query})`;
  const likePattern = `%${escapeLikePattern(input.query)}%`;

  // One expression, referenced by the WHERE, the ORDER BY and the count. Postgres evaluates
  // `numnode()` once per row-free constant folding, so this costs nothing per row.
  const hasUsableTsQuery = sql`numnode(${tsQuery}) > 0`;

  const matchPredicate = sql`(
    (${hasUsableTsQuery} AND (
      v.search_document @@ ${tsQuery}
      OR to_tsvector('english', coalesce(u.name, '') || ' ' || coalesce(u.handle, '')) @@ ${tsQuery}
    ))
    OR (NOT ${hasUsableTsQuery} AND (
      v.title ILIKE ${likePattern}
      OR coalesce(u.handle, '') ILIKE ${likePattern}
      OR coalesce(u.name, '') ILIKE ${likePattern}
    ))
  )`;

  const wherePredicate = sql`${publicVideoPredicate()} AND ${matchPredicate}`;

  // `32` is `ts_rank_cd`'s "divide by the document length" normalisation: without it a long
  // description outranks a title purely by containing more words, which inverts the weights
  // the generated column was built to express.
  //
  // The creator term adds a FLAT bonus rather than a measured rank. It is deliberately small
  // enough to sit below a real title hit and large enough to beat a passing mention in a
  // description — a search for a creator's handle should surface their videos, not the ones
  // that merely name-drop them.
  const rankExpression = sql`
    ts_rank_cd(v.search_document, ${tsQuery}, 32)
    + CASE
        WHEN ${hasUsableTsQuery}
         AND to_tsvector('english', coalesce(u.name, '') || ' ' || coalesce(u.handle, '')) @@ ${tsQuery}
        THEN 0.05
        ELSE 0
      END
  `;

  const offset = (input.page - 1) * input.limit;

  const [pageResult, totalResult] = await Promise.all([
    db.execute<FeedRow>(sql`
      SELECT ${feedSelectClause(input.viewerUserId)}
      FROM video AS v
      JOIN "user" AS u ON u.id = v.creator_id
      LEFT JOIN video_stats AS vs ON vs.video_id = v.id
      WHERE ${wherePredicate}
      ORDER BY ${rankExpression} DESC, v.published_at DESC, v.id DESC
      LIMIT ${input.limit} OFFSET ${offset}
    `),
    db.execute<TotalRow>(sql`
      SELECT count(*)::int AS total
      FROM video AS v
      JOIN "user" AS u ON u.id = v.creator_id
      WHERE ${wherePredicate}
    `),
  ]);

  return {
    rows: pageResult.rows.map((row) => toFeedVideoItem(row)),
    total: totalResult.rows[0]?.total ?? 0,
  };
}
