import { and, asc, count, countDistinct, desc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { animeEpisode, animeSeason, animeSeries } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type {
  CreateEpisodeInput,
  CreateSeasonInput,
  CreateSeriesInput,
  UpdateEpisodeInput,
  UpdateSeasonInput,
  UpdateSeriesInput,
} from "#src/modules/studio/series/series.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * The anime catalog: series → season → episode (docs/STUDIO_BACKEND_STRUCTURE.md §4, §6).
 *
 * Episodes are normally created through the UPLOAD flow, which links a new video to a new
 * `anime_episode` row. These endpoints exist for catalog management at /studio/series —
 * renaming a season, fixing an episode number, retiring a series.
 *
 * OWNERSHIP IS ALWAYS PROVEN THROUGH THE SERIES. A season belongs to a series and an
 * episode to a season, so every nested operation joins back to `animeSeries.ownerId`
 * rather than trusting the id in the path. That join is also why the routes nest the ids
 * (`/series/:seriesId/seasons/:seasonId`) instead of exposing bare season ids: the
 * ownership chain is visible in the URL and provable in one query.
 *
 * §6 sketches `POST /seasons/:id/episodes` at the ROOT, which — mounted on a router at
 * /series — would actually serve /series/seasons/:id/episodes, so the documented path
 * would 404. Nesting fixes that and needs no second root mount.
 */

export type SeriesNotFoundError = { type: "SERIES_NOT_FOUND"; seriesId: string };

export type AnimeSeriesError =
  | SeriesNotFoundError
  | { type: "SEASON_NOT_FOUND"; seasonId: string }
  | { type: "EPISODE_NOT_FOUND"; episodeId: string }
  | { type: "SEASON_LABEL_TAKEN"; seasonLabel: string }
  // Same literal AND same payload as the videos service's variant, so the two collapse
  // into one arm in the mapper. Deliberate: a duplicate episode number means the same
  // thing and must render identically whichever route produced it.
  | { type: "EPISODE_NUMBER_TAKEN"; episodeNumber: number };

type SeriesRow = typeof animeSeries.$inferSelect;

export interface AnimeEpisodeSummary {
  readonly id: string;
  readonly videoId: string | null;
  readonly episodeNumber: number;
  readonly episodeTitle: string;
  readonly isPremium: boolean;
  readonly premiereDate: Date | null;
  readonly audioMode: "subbed" | "dubbed" | null;
  readonly audioLanguage: string | null;
  readonly ageRating: string | null;
  readonly releasedAt: Date | null;
}

export interface AnimeSeasonSummary {
  readonly id: string;
  readonly seasonLabel: string;
  readonly position: number;
  readonly episodes: readonly AnimeEpisodeSummary[];
}

export interface PublicSeries {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly posterUrl: string | null;
  readonly genreTags: readonly string[];
  readonly status: SeriesRow["status"];
  readonly seasons: readonly AnimeSeasonSummary[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SeriesListRow {
  readonly id: string;
  readonly title: string;
  readonly posterUrl: string | null;
  readonly status: SeriesRow["status"];
  /** Shown on the studio card. Already a column on this table; it was simply not projected. */
  readonly genreTags: readonly string[];
  readonly seasonCount: number;
  /**
   * Episodes across every season.
   *
   * A SECOND `countDistinct`, not `count()`. The query already left-joins seasons, so joining
   * episodes as well multiplies the rows — a plain `count(animeSeason.id)` would then report
   * seasons × episodes. Counting DISTINCT ids on both is what keeps each honest.
   */
  readonly episodeCount: number;
  readonly updatedAt: Date;
}

export interface SeriesPage {
  readonly rows: readonly SeriesListRow[];
  readonly total: number;
}

function ownedSeriesPredicate(ownerId: string, seriesId: string) {
  return and(eq(animeSeries.id, seriesId), eq(animeSeries.ownerId, ownerId));
}

/** Proves the caller owns the series a season sits under, in one join. */
async function loadOwnedSeason(
  ownerId: string,
  seriesId: string,
  seasonId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: animeSeason.id })
    .from(animeSeason)
    .innerJoin(animeSeries, eq(animeSeries.id, animeSeason.seriesId))
    .where(
      and(
        eq(animeSeason.id, seasonId),
        eq(animeSeason.seriesId, seriesId),
        eq(animeSeries.ownerId, ownerId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadOwnedSeries(ownerId: string, seriesId: string): Promise<PublicSeries | null> {
  const [row] = await db
    .select()
    .from(animeSeries)
    .where(ownedSeriesPredicate(ownerId, seriesId))
    .limit(1);
  if (!row) return null;

  const seasonRows = await db
    .select()
    .from(animeSeason)
    .where(eq(animeSeason.seriesId, seriesId))
    .orderBy(asc(animeSeason.position), asc(animeSeason.seasonLabel));

  const episodeRows =
    seasonRows.length === 0
      ? []
      : await db
          .select({
            id: animeEpisode.id,
            seasonId: animeEpisode.seasonId,
            videoId: animeEpisode.videoId,
            episodeNumber: animeEpisode.episodeNumber,
            episodeTitle: animeEpisode.episodeTitle,
            isPremium: animeEpisode.isPremium,
            premiereDate: animeEpisode.premiereDate,
            audioMode: animeEpisode.audioMode,
            audioLanguage: animeEpisode.audioLanguage,
            ageRating: animeEpisode.ageRating,
            releasedAt: animeEpisode.releasedAt,
          })
          .from(animeEpisode)
          .innerJoin(animeSeason, eq(animeSeason.id, animeEpisode.seasonId))
          .where(eq(animeSeason.seriesId, seriesId))
          .orderBy(asc(animeEpisode.episodeNumber));

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    posterUrl: row.posterUrl,
    genreTags: row.genreTags,
    status: row.status,
    seasons: seasonRows.map((season) => ({
      id: season.id,
      seasonLabel: season.seasonLabel,
      position: season.position,
      episodes: episodeRows
        .filter((episode) => episode.seasonId === season.id)
        .map(({ seasonId: _seasonId, ...episode }) => episode),
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createSeries(
  ownerId: string,
  input: CreateSeriesInput,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const [created] = await db
    .insert(animeSeries)
    .values({
      ownerId,
      title: input.title,
      description: input.description,
      posterUrl: input.posterUrl,
      genreTags: [...input.genreTags],
      status: input.status,
    })
    .returning({ id: animeSeries.id });

  if (!created) throw new Error("Insert returned no anime series row");

  const loaded = await loadOwnedSeries(ownerId, created.id);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId: created.id } };
  return { success: true, value: loaded };
}

export async function listMySeries(
  ownerId: string,
  page: number,
  limit: number,
): Promise<SeriesPage> {
  const offset = (page - 1) * limit;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: animeSeries.id,
        title: animeSeries.title,
        posterUrl: animeSeries.posterUrl,
        status: animeSeries.status,
        genreTags: animeSeries.genreTags,
        seasonCount: countDistinct(animeSeason.id),
        episodeCount: countDistinct(animeEpisode.id),
        updatedAt: animeSeries.updatedAt,
      })
      .from(animeSeries)
      .leftJoin(animeSeason, eq(animeSeason.seriesId, animeSeries.id))
      .leftJoin(animeEpisode, eq(animeEpisode.seasonId, animeSeason.id))
      .where(eq(animeSeries.ownerId, ownerId))
      .groupBy(animeSeries.id)
      .orderBy(desc(animeSeries.updatedAt))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(animeSeries).where(eq(animeSeries.ownerId, ownerId)),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}

export async function getSeries(
  ownerId: string,
  seriesId: string,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const loaded = await loadOwnedSeries(ownerId, seriesId);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: loaded };
}

export async function updateSeries(
  ownerId: string,
  seriesId: string,
  patch: UpdateSeriesInput,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const scalarUpdates: Partial<typeof animeSeries.$inferInsert> = {};
  if (patch.title !== undefined) scalarUpdates.title = patch.title;
  if (patch.description !== undefined) scalarUpdates.description = patch.description;
  if (patch.posterUrl !== undefined) scalarUpdates.posterUrl = patch.posterUrl;
  if (patch.genreTags !== undefined) scalarUpdates.genreTags = [...patch.genreTags];
  if (patch.status !== undefined) scalarUpdates.status = patch.status;

  if (Object.keys(scalarUpdates).length > 0) {
    const updated = await db
      .update(animeSeries)
      .set(scalarUpdates)
      .where(ownedSeriesPredicate(ownerId, seriesId))
      .returning({ id: animeSeries.id });
    if (updated.length === 0) {
      return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
    }
  }

  const loaded = await loadOwnedSeries(ownerId, seriesId);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: loaded };
}

/**
 * Deletes a series and, by cascade, its seasons and episodes.
 *
 * The VIDEOS survive: `anime_episode.videoId` is `set null` on the video side, and this
 * cascade runs the other way — deleting the catalog entry never deletes the uploads.
 */
export async function deleteSeries(
  ownerId: string,
  seriesId: string,
): Promise<Result<{ deleted: true }, AnimeSeriesError>> {
  const deleted = await db
    .delete(animeSeries)
    .where(ownedSeriesPredicate(ownerId, seriesId))
    .returning({ id: animeSeries.id });

  if (deleted.length === 0)
    return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: { deleted: true } };
}

export async function createSeason(
  ownerId: string,
  seriesId: string,
  input: CreateSeasonInput,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const [ownedSeries] = await db
    .select({ id: animeSeries.id })
    .from(animeSeries)
    .where(ownedSeriesPredicate(ownerId, seriesId))
    .limit(1);
  if (!ownedSeries) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };

  try {
    // Position defaults to the end of the list when the client does not say.
    const [tail] = await db
      .select({ value: count() })
      .from(animeSeason)
      .where(eq(animeSeason.seriesId, seriesId));

    await db.insert(animeSeason).values({
      seriesId,
      seasonLabel: input.seasonLabel,
      position: input.position ?? tail?.value ?? 0,
    });
  } catch (error) {
    // anime_season_label_unq. Translated rather than re-thrown so the catalog editor can
    // say "you already have a Season 1" instead of surfacing a 500.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "SEASON_LABEL_TAKEN", seasonLabel: input.seasonLabel },
      };
    }
    throw error;
  }

  const loaded = await loadOwnedSeries(ownerId, seriesId);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: loaded };
}

export async function updateSeason(
  ownerId: string,
  seriesId: string,
  seasonId: string,
  patch: UpdateSeasonInput,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const ownedSeason = await loadOwnedSeason(ownerId, seriesId, seasonId);
  if (!ownedSeason) return { success: false, error: { type: "SEASON_NOT_FOUND", seasonId } };

  const scalarUpdates: Partial<typeof animeSeason.$inferInsert> = {};
  if (patch.seasonLabel !== undefined) scalarUpdates.seasonLabel = patch.seasonLabel;
  if (patch.position !== undefined) scalarUpdates.position = patch.position;

  if (Object.keys(scalarUpdates).length > 0) {
    try {
      await db.update(animeSeason).set(scalarUpdates).where(eq(animeSeason.id, seasonId));
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          success: false,
          error: { type: "SEASON_LABEL_TAKEN", seasonLabel: patch.seasonLabel ?? "" },
        };
      }
      throw error;
    }
  }

  const loaded = await loadOwnedSeries(ownerId, seriesId);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: loaded };
}

export async function deleteSeason(
  ownerId: string,
  seriesId: string,
  seasonId: string,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const ownedSeason = await loadOwnedSeason(ownerId, seriesId, seasonId);
  if (!ownedSeason) return { success: false, error: { type: "SEASON_NOT_FOUND", seasonId } };

  await db.delete(animeSeason).where(eq(animeSeason.id, seasonId));

  const loaded = await loadOwnedSeries(ownerId, seriesId);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: loaded };
}

export async function createEpisode(
  ownerId: string,
  seriesId: string,
  seasonId: string,
  input: CreateEpisodeInput,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const ownedSeason = await loadOwnedSeason(ownerId, seriesId, seasonId);
  if (!ownedSeason) return { success: false, error: { type: "SEASON_NOT_FOUND", seasonId } };

  try {
    await db.insert(animeEpisode).values({
      seasonId,
      episodeNumber: input.episodeNumber,
      episodeTitle: input.episodeTitle,
      isPremium: input.isPremium,
      releaseScheduleDay: input.releaseScheduleDay,
      releaseScheduleTime: input.releaseScheduleTime,
      premiereDate: input.premiereDate,
      audioMode: input.audioMode,
      audioLanguage: input.audioLanguage,
      ageRating: input.ageRating,
    });
  } catch (error) {
    // anime_episode_unq (seasonId, episodeNumber). The index is the race-safe authority;
    // a check-then-insert here would be a TOCTOU between two catalog tabs.
    if (isUniqueViolation(error)) {
      return {
        success: false,
        error: { type: "EPISODE_NUMBER_TAKEN", episodeNumber: input.episodeNumber },
      };
    }
    throw error;
  }

  const loaded = await loadOwnedSeries(ownerId, seriesId);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: loaded };
}

/**
 * Catalog-side episode edit. Note what is NOT patchable here: `videoId`. Linking an
 * episode to an upload happens in the upload flow, where the caller's ownership of the
 * VIDEO is proven; accepting it here would let a series owner attach someone else's video
 * to their catalog.
 */
export async function updateEpisode(
  ownerId: string,
  seriesId: string,
  seasonId: string,
  episodeId: string,
  patch: UpdateEpisodeInput,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const ownedSeason = await loadOwnedSeason(ownerId, seriesId, seasonId);
  if (!ownedSeason) return { success: false, error: { type: "SEASON_NOT_FOUND", seasonId } };

  const [ownedEpisode] = await db
    .select({ id: animeEpisode.id })
    .from(animeEpisode)
    .where(and(eq(animeEpisode.id, episodeId), eq(animeEpisode.seasonId, seasonId)))
    .limit(1);
  if (!ownedEpisode) return { success: false, error: { type: "EPISODE_NOT_FOUND", episodeId } };

  const scalarUpdates: Partial<typeof animeEpisode.$inferInsert> = {};
  if (patch.episodeNumber !== undefined) scalarUpdates.episodeNumber = patch.episodeNumber;
  if (patch.episodeTitle !== undefined) scalarUpdates.episodeTitle = patch.episodeTitle;
  if (patch.isPremium !== undefined) scalarUpdates.isPremium = patch.isPremium;
  if (patch.releaseScheduleDay !== undefined) {
    scalarUpdates.releaseScheduleDay = patch.releaseScheduleDay;
  }
  if (patch.releaseScheduleTime !== undefined) {
    scalarUpdates.releaseScheduleTime = patch.releaseScheduleTime;
  }
  if (patch.premiereDate !== undefined) scalarUpdates.premiereDate = patch.premiereDate;
  if (patch.audioMode !== undefined) scalarUpdates.audioMode = patch.audioMode;
  if (patch.audioLanguage !== undefined) scalarUpdates.audioLanguage = patch.audioLanguage;
  if (patch.ageRating !== undefined) scalarUpdates.ageRating = patch.ageRating;

  if (Object.keys(scalarUpdates).length > 0) {
    try {
      await db.update(animeEpisode).set(scalarUpdates).where(eq(animeEpisode.id, episodeId));
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          success: false,
          error: { type: "EPISODE_NUMBER_TAKEN", episodeNumber: patch.episodeNumber ?? -1 },
        };
      }
      throw error;
    }
  }

  const loaded = await loadOwnedSeries(ownerId, seriesId);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: loaded };
}

export async function deleteEpisode(
  ownerId: string,
  seriesId: string,
  seasonId: string,
  episodeId: string,
): Promise<Result<PublicSeries, AnimeSeriesError>> {
  const ownedSeason = await loadOwnedSeason(ownerId, seriesId, seasonId);
  if (!ownedSeason) return { success: false, error: { type: "SEASON_NOT_FOUND", seasonId } };

  const deleted = await db
    .delete(animeEpisode)
    .where(and(eq(animeEpisode.id, episodeId), eq(animeEpisode.seasonId, seasonId)))
    .returning({ id: animeEpisode.id });
  if (deleted.length === 0)
    return { success: false, error: { type: "EPISODE_NOT_FOUND", episodeId } };

  const loaded = await loadOwnedSeries(ownerId, seriesId);
  if (!loaded) return { success: false, error: { type: "SERIES_NOT_FOUND", seriesId } };
  return { success: true, value: loaded };
}
