/**
 * The public anime catalogue — what `/anime/series` and `/anime/series/:seriesSlug` serve.
 *
 * WHY THIS FILE EXISTS. All eleven `/series` routes are `requireAuth` and owner-scoped:
 * that surface is the studio, and `series.service.ts`'s `PublicSeries` is a MISNOMER — it
 * is the owner's projection and returns unreleased episode titles, premiere dates and the
 * whole production schedule. There was no way for a stranger to read a series at all.
 *
 * `public-series.service.ts` is the nearest thing that existed, and this file is its
 * sibling rather than its replacement. That one is keyed by VIDEO id and is called from
 * inside `GET /feed/watch/:videoId`; it deliberately omits every series-level field, and
 * its own header names the reason: adding them "would make this projection the anime page's
 * read by accident". This IS the anime page's read, so the series-level fields live here.
 *
 * THREE RULES INHERITED FROM IT VERBATIM, because they are about the data and not about the
 * surface:
 *
 *   1. THE GATE RIDES IN THE JOIN, NEVER IN THE WHERE. In a WHERE it drops the whole SEASON
 *      as soon as one of its episodes is unreleased; in the JOIN it drops only that
 *      episode's row and leaves the season standing.
 *   2. AN EPISODE A STRANGER CANNOT WATCH IS NOT LISTED AT ALL — not greyed, not shown
 *      without a link. Titles are content, and a catalogue that names next week's episode
 *      is an oracle over an unreleased catalogue. The visible consequence is intended:
 *      episode numbers can have gaps, because a withdrawn episode leaves one.
 *   3. `isPremium` IS NOT PROJECTED. The column exists; no entitlement model, tier or
 *      paywall does, anywhere in this codebase. Rendering a lock on an episode that plays
 *      for free is a claim the backend cannot back. It ships when something enforces it.
 *
 * WHAT IS ADDED HERE, and why each is safe: `title`, `description`, `posterUrl`,
 * `genreTags` and `status` are series-level authored copy about a show a stranger can
 * already watch; `thumbnailUrl` and `durationSeconds` come off that same watchable video;
 * `audioMode`, `audioLanguage` and `ageRating` are facts about a released episode, which is
 * exactly the "dedicated anime surface" the sibling file said they belonged on.
 *
 * A SERIES IS PUBLIC IFF IT HAS AT LEAST ONE PUBLICLY-SERVABLE EPISODE. There is no
 * `is_published` column on `anime_series` and this file does not add one: publicness is
 * already derived bottom-up from `video`, and a second, admin-set flag would be free to
 * disagree with it. A series with nothing watchable is a 404, not an empty page.
 */

import { and, asc, countDistinct, desc, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { animeEpisode, animeSeason, animeSeries, video } from "#src/db/schema.js";
import { PUBLICLY_SERVABLE } from "#src/modules/studio/public-video-gate.js";

/** One episode a stranger may watch. */
export interface PublicAnimeEpisode {
  readonly episodeId: string;
  /**
   * NOT NULLABLE. An episode with no publicly-servable video is not listed, so by the time
   * a row reaches this shape its video exists and is watchable. A nullable field here would
   * invite a client to render an unclickable row this projection can never produce.
   */
  readonly videoId: string;
  readonly episodeNumber: number;
  readonly episodeTitle: string;
  readonly thumbnailUrl: string | null;
  readonly durationSeconds: number | null;
  readonly audioMode: "subbed" | "dubbed" | null;
  readonly audioLanguage: string | null;
  readonly ageRating: string | null;
  /**
   * When the episode went live in `/anime`, which is on APPROVAL rather than on publish, so
   * it can differ from the video's own `publishedAt`. Null for an episode approved before
   * the column existed; the client sorts on `episodeNumber` regardless.
   */
  readonly releasedAt: Date | null;
}

export interface PublicAnimeSeason {
  readonly seasonId: string;
  readonly seasonLabel: string;
  readonly position: number;
  readonly episodes: readonly PublicAnimeEpisode[];
}

/** One row of `GET /anime/series` — no seasons, no episodes. */
export interface PublicAnimeSeriesCard {
  readonly seriesSlug: string;
  readonly title: string;
  readonly posterUrl: string | null;
  readonly genreTags: readonly string[];
  readonly status: "ongoing" | "completed" | "hiatus";
  readonly watchableEpisodeCount: number;
  readonly updatedAt: Date;
}

/** What `GET /anime/series/:seriesSlug` returns. */
export interface PublicAnimeSeriesDetail {
  readonly seriesSlug: string;
  readonly title: string;
  readonly description: string | null;
  readonly posterUrl: string | null;
  readonly genreTags: readonly string[];
  readonly status: "ongoing" | "completed" | "hiatus";
  readonly seasons: readonly PublicAnimeSeason[];
  readonly updatedAt: Date;
}

export interface ListPublicAnimeSeriesInput {
  readonly page: number;
  readonly limit: number;
}

export interface PublicAnimeSeriesPage {
  readonly rows: readonly PublicAnimeSeriesCard[];
  readonly total: number;
}

/**
 * `GET /anime/series` — every series with something watchable in it.
 *
 * The frontend needs this for two jobs beyond browsing: `generateStaticParams` on the
 * detail route (an EMPTY list there fails the build under `cacheComponents`, so it must be
 * a real read that can legitimately answer nothing) and the sitemap.
 *
 * `countDistinct` over the joined episode rows is what makes "has something watchable" and
 * "how many" one query instead of two. `HAVING count > 0` is implicit in the inner join:
 * a series whose every episode failed the gate contributes no rows at all.
 */
export async function listPublicAnimeSeries(
  input: ListPublicAnimeSeriesInput,
): Promise<PublicAnimeSeriesPage> {
  const offset = (input.page - 1) * input.limit;

  const rows = await db
    .select({
      seriesSlug: animeSeries.slug,
      title: animeSeries.title,
      posterUrl: animeSeries.posterUrl,
      genreTags: animeSeries.genreTags,
      status: animeSeries.status,
      watchableEpisodeCount: countDistinct(animeEpisode.id),
      updatedAt: animeSeries.updatedAt,
    })
    .from(animeSeries)
    .innerJoin(animeSeason, eq(animeSeason.seriesId, animeSeries.id))
    .innerJoin(animeEpisode, eq(animeEpisode.seasonId, animeSeason.id))
    .innerJoin(video, and(eq(video.id, animeEpisode.videoId), PUBLICLY_SERVABLE))
    .groupBy(
      animeSeries.id,
      animeSeries.slug,
      animeSeries.title,
      animeSeries.posterUrl,
      animeSeries.genreTags,
      animeSeries.status,
      animeSeries.updatedAt,
    )
    .orderBy(desc(animeSeries.updatedAt), asc(animeSeries.slug))
    .limit(input.limit)
    .offset(offset);

  // COUNT OVER THE SAME JOIN, not over `anime_series`. Counting the base table would report
  // series with nothing watchable and hand the client a page count it can never reach.
  const [totalRow] = await db
    .select({ total: sql<number>`count(DISTINCT ${animeSeries.id})::int` })
    .from(animeSeries)
    .innerJoin(animeSeason, eq(animeSeason.seriesId, animeSeries.id))
    .innerJoin(animeEpisode, eq(animeEpisode.seasonId, animeSeason.id))
    .innerJoin(video, and(eq(video.id, animeEpisode.videoId), PUBLICLY_SERVABLE));

  return { rows, total: totalRow?.total ?? 0 };
}

/**
 * `GET /anime/series/:seriesSlug` — the detail tree, or `null` for 404.
 *
 * TWO QUERIES, NOT N+1: one resolves the slug to a series row, the second walks the whole
 * tree through `anime_season_seriesId_idx` and `anime_episode_seasonId_idx`.
 *
 * A SEASON WITH NO WATCHABLE EPISODES IS DROPPED, unlike in `loadPublicSeasonsForVideo`
 * where an empty season stays because the caller is a navigation picker that has already
 * proven the series is watchable. Here an empty season is a heading with nothing under it
 * on a page a stranger arrived at cold, and the whole series 404s if every season is empty.
 */
export async function loadPublicAnimeSeries(
  seriesSlug: string,
): Promise<PublicAnimeSeriesDetail | null> {
  const [seriesRow] = await db
    .select({
      id: animeSeries.id,
      seriesSlug: animeSeries.slug,
      title: animeSeries.title,
      description: animeSeries.description,
      posterUrl: animeSeries.posterUrl,
      genreTags: animeSeries.genreTags,
      status: animeSeries.status,
      updatedAt: animeSeries.updatedAt,
    })
    .from(animeSeries)
    .where(eq(animeSeries.slug, seriesSlug))
    .limit(1);

  if (!seriesRow) return null;

  // The gate rides in the JOIN, not the WHERE — in a WHERE it would drop the whole season
  // as soon as one of its episodes is unreleased.
  const rows = await db
    .select({
      seasonId: animeSeason.id,
      seasonLabel: animeSeason.seasonLabel,
      position: animeSeason.position,
      episodeId: animeEpisode.id,
      episodeNumber: animeEpisode.episodeNumber,
      episodeTitle: animeEpisode.episodeTitle,
      audioMode: animeEpisode.audioMode,
      audioLanguage: animeEpisode.audioLanguage,
      ageRating: animeEpisode.ageRating,
      releasedAt: animeEpisode.releasedAt,
      publicVideoId: video.id,
      thumbnailUrl: video.thumbnailUrl,
      durationSeconds: video.durationSeconds,
    })
    .from(animeSeason)
    .leftJoin(animeEpisode, eq(animeEpisode.seasonId, animeSeason.id))
    .leftJoin(video, and(eq(video.id, animeEpisode.videoId), PUBLICLY_SERVABLE))
    .where(eq(animeSeason.seriesId, seriesRow.id))
    .orderBy(asc(animeSeason.position), asc(animeEpisode.episodeNumber));

  const seasonsById = new Map<
    string,
    { season: PublicAnimeSeason; episodes: PublicAnimeEpisode[] }
  >();

  for (const row of rows) {
    let entry = seasonsById.get(row.seasonId);
    if (entry === undefined) {
      const episodes: PublicAnimeEpisode[] = [];
      entry = {
        season: {
          seasonId: row.seasonId,
          seasonLabel: row.seasonLabel,
          position: row.position,
          episodes,
        },
        episodes,
      };
      seasonsById.set(row.seasonId, entry);
    }

    // `publicVideoId` is null when the episode has no video OR its video failed the gate —
    // the left join collapses both into the same absence, which is the answer either way.
    // It is also null on the synthetic row a season with no episodes produces.
    //
    // ALL FOUR TERMS, even though the last two are NOT NULL on the table: they are nullable
    // in this row type only because of the left join, and the alternative is a `?? 0`
    // fallback that fabricates an episode number in a branch that cannot run.
    if (
      row.episodeId === null ||
      row.publicVideoId === null ||
      row.episodeNumber === null ||
      row.episodeTitle === null
    ) {
      continue;
    }

    entry.episodes.push({
      episodeId: row.episodeId,
      videoId: row.publicVideoId,
      episodeNumber: row.episodeNumber,
      episodeTitle: row.episodeTitle,
      thumbnailUrl: row.thumbnailUrl,
      durationSeconds: row.durationSeconds,
      audioMode: row.audioMode,
      audioLanguage: row.audioLanguage,
      ageRating: row.ageRating,
      releasedAt: row.releasedAt,
    });
  }

  const seasons = [...seasonsById.values()]
    .filter((entry) => entry.episodes.length > 0)
    .map((entry) => entry.season);

  // Nothing watchable anywhere in the series is a 404, not an empty page: the series is not
  // public yet, and saying so with an empty catalogue confirms the show exists.
  if (seasons.length === 0) return null;

  return {
    seriesSlug: seriesRow.seriesSlug,
    title: seriesRow.title,
    description: seriesRow.description,
    posterUrl: seriesRow.posterUrl,
    genreTags: seriesRow.genreTags,
    status: seriesRow.status,
    seasons,
    updatedAt: seriesRow.updatedAt,
  };
}
