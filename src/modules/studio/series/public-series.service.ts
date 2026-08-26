import { and, asc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { animeEpisode, animeSeason, animeSeries, video } from "#src/db/schema.js";
import { PUBLICLY_SERVABLE } from "#src/modules/studio/public-video-gate.js";

/**
 * The ONLY public read of an anime series anywhere on the platform.
 *
 * WHY IT HAD TO EXIST. All eleven `/series` routes are `requireAuth` and owner-scoped — the
 * studio owns that surface, and correctly so: `getSeries` returns unreleased episode titles,
 * premiere dates and the whole production schedule. There was therefore NO way for a viewer on
 * a watch page to learn that the episode they are watching is part of a series, which is why
 * the season picker on that page was a hardcoded placeholder rather than an unfinished screen.
 *
 * IT IS NOT A ROUTE, AND THAT IS THE DESIGN. This is read from inside
 * `GET /feed/watch/:videoId`, whose header states the rule it follows: the payload is assembled
 * in one round trip. A separate `GET /series/:seriesId` would be strictly worse here — the watch
 * page does not learn the series id until the first read returns, so the picker would always be
 * one request behind the player it belongs to.
 *
 * ONE PROJECTION, DELIBERATELY NARROWER THAN THE OWNER'S. See `PublicSeasonSummary` for what is
 * left out and why. The rule to hold: everything here is derivable from an episode a stranger
 * can already watch.
 */

/** One episode a stranger may watch, as the watch page's season picker renders it. */
export interface PublicEpisodeSummary {
  readonly episodeId: string;
  /**
   * NOT NULLABLE, unlike `animeEpisode.videoId` on the table. An episode with no video is not
   * listed at all — see `loadPublicSeasonsForVideo` — so by the time a row reaches this shape
   * its video exists AND is publicly servable. A nullable field here would invite a client to
   * render an unclickable row that this projection can never produce.
   */
  readonly videoId: string;
  readonly episodeNumber: number;
  readonly episodeTitle: string;
  /**
   * When the episode went live in `/anime`, which is on APPROVAL rather than on publish, so it
   * can differ from the video's own `publishedAt`. Null for an episode approved before the
   * column existed; the client sorts on `episodeNumber` regardless and uses this only as a
   * label.
   */
  readonly releasedAt: Date | null;
}

/**
 * One season, with only the episodes a stranger may watch.
 *
 * THREE FIELDS OF THE OWNER'S `AnimeSeasonSummary` ARE MISSING, and each omission is a rule:
 *
 *   `isPremium` — the column exists; NO entitlement model, tier or paywall does, anywhere in
 *      the codebase. Projecting it would put a lock on an episode that plays for free, which
 *      is a claim the backend cannot back. It ships when something enforces it.
 *   `premiereDate` — an announced date for an episode that has not released is production
 *      schedule, not catalogue. The rows it describes are not listed here either.
 *   `audioMode`, `audioLanguage`, `ageRating` — real facts, and they belong on a dedicated
 *      anime surface rather than on a season picker whose job is navigation. Adding them here
 *      would make this projection the anime page's read by accident.
 */
export interface PublicSeasonSummary {
  readonly seasonId: string;
  readonly seasonLabel: string;
  readonly position: number;
  readonly episodes: readonly PublicEpisodeSummary[];
}

/**
 * The series a video belongs to, as seasons and publicly-watchable episodes — or `null` when
 * the video is not an anime episode at all.
 *
 * `null` AND `[]` MEAN DIFFERENT THINGS AND BOTH ARE REACHABLE. Null is "this is not part of a
 * series", which is every pitch, demo and unaffiliated video on the platform; an empty array
 * would be a series whose seasons are all unreleased. A client hides the picker for the first
 * and shows an empty catalogue for the second, so collapsing them loses a real distinction.
 *
 * ONLY PUBLICLY-SERVABLE EPISODES ARE LISTED, and this is the load-bearing rule. An episode in
 * review, hidden by a moderator, or with no video attached yet is omitted ENTIRELY — not
 * greyed, not listed without a link. Titles are content: a season picker that names next
 * week's episode is an oracle over an unreleased catalogue, which is precisely what this
 * route's 404-covers-everything gate exists to prevent. The consequence is visible and
 * intended — episode numbers can have gaps, because a withdrawn episode leaves one.
 *
 * The video the caller is watching passed the same gate to get here, so it is always present
 * in its own list.
 *
 * TWO QUERIES, NOT N+1. One resolves video -> episode -> season -> series through
 * `anime_episode_videoId_unq`; the second walks the whole tree from the series id through
 * `anime_season_seriesId_idx` and `anime_episode_seasonId_idx`. Every index already exists,
 * so this adds no migration.
 */
export async function loadPublicSeasonsForVideo(
  videoId: string,
): Promise<readonly PublicSeasonSummary[] | null> {
  const [seriesRef] = await db
    .select({ seriesId: animeSeries.id })
    .from(animeEpisode)
    .innerJoin(animeSeason, eq(animeSeason.id, animeEpisode.seasonId))
    .innerJoin(animeSeries, eq(animeSeries.id, animeSeason.seriesId))
    .where(eq(animeEpisode.videoId, videoId))
    .limit(1);

  if (!seriesRef) return null;

  // The gate rides in the JOIN, not the WHERE — same shape as the venture join on the watch
  // payload, and for the same reason. In a WHERE it would drop the SEASON whenever one of its
  // episodes is unreleased; here it drops only that episode's row, leaving the season standing
  // with the episodes that are public.
  const rows = await db
    .select({
      seasonId: animeSeason.id,
      seasonLabel: animeSeason.seasonLabel,
      position: animeSeason.position,
      episodeId: animeEpisode.id,
      episodeVideoId: animeEpisode.videoId,
      episodeNumber: animeEpisode.episodeNumber,
      episodeTitle: animeEpisode.episodeTitle,
      releasedAt: animeEpisode.releasedAt,
      publicVideoId: video.id,
    })
    .from(animeSeason)
    .leftJoin(animeEpisode, eq(animeEpisode.seasonId, animeSeason.id))
    .leftJoin(video, and(eq(video.id, animeEpisode.videoId), PUBLICLY_SERVABLE))
    .where(eq(animeSeason.seriesId, seriesRef.seriesId))
    .orderBy(asc(animeSeason.position), asc(animeEpisode.episodeNumber));

  const seasonsById = new Map<
    string,
    { season: PublicSeasonSummary; episodes: PublicEpisodeSummary[] }
  >();
  for (const row of rows) {
    let entry = seasonsById.get(row.seasonId);
    if (entry === undefined) {
      const episodes: PublicEpisodeSummary[] = [];
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

    // `publicVideoId` is null when the episode has no video OR its video failed the gate — the
    // left join collapses both into the same absence, which is the answer either way. It is
    // also null on the synthetic row a season with no episodes produces, and checking it is
    // what keeps that season in the list with an empty episode array rather than dropping it.
    //
    // ALL FOUR TERMS, even though the last two are NOT NULL on the table. They are nullable in
    // this row type only because of the left join, and TypeScript is right to insist: the
    // alternative is a `?? 0` fallback that fabricates an episode number in a branch that
    // cannot run, which is exactly the kind of invented value this codebase refuses elsewhere.
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
      releasedAt: row.releasedAt,
    });
  }

  return [...seasonsById.values()].map((entry) => entry.season);
}
