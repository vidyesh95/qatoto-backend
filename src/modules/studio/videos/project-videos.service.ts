import { and, count, desc, eq, lte, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { user, video } from "#src/db/schema.js";
import { PUBLICLY_SERVABLE } from "#src/modules/studio/public-video-gate.js";

/**
 * THE VENTURE REEL — every public video a research project has claimed (§11i).
 *
 * The read half of `video.researchProjectId`, and the reason the column is worth having:
 * a venture page assembles its own film reel without anyone curating a list, because the
 * videos already say which venture they belong to.
 *
 * WHY THIS IS NOT `listFeedVideos`. That function is ranking machinery — rank seed,
 * exploration quota, diversity permutation, per-creator caps — and its query schema is
 * `.strict()` with no id facet, so it cannot be narrowed to one project at all. `searchVideos`
 * is full-text. Neither can answer "this venture's videos", so this is a third, small read,
 * shaped like `listActiveSpotlightVideos`: a predicate, a projection, an order.
 *
 * IT IMPORTS `PUBLICLY_SERVABLE` RATHER THAN RE-TYPING IT. The feed and spotlight each keep
 * their own byte-identical raw-SQL copy because they alias the table as `v`; this one does
 * not, so it can use the exported predicate and cannot drift from it. A slot that fails the
 * gate must never reach a visitor, or the rail links to a watch page that 404s.
 */
export interface ProjectVideoRow {
  readonly videoId: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  readonly publishedAt: Date | null;
  readonly durationSeconds: number | null;
  readonly creator: {
    readonly handle: string | null;
    readonly name: string;
    readonly imageUrl: string | null;
  };
}

export interface ProjectVideoPage {
  readonly rows: readonly ProjectVideoRow[];
  readonly total: number;
}

/**
 * NO `viewerState`, DELIBERATELY. The feed's `FeedVideoItem` carries `hasLiked`/`hasSaved`/
 * `isSubscribedToCreator`, which cost three per-viewer probes and which this rail renders
 * nowhere. Projecting them anyway would mean shipping `false` to every signed-out visitor —
 * a negative the client has no basis for, which is the same error the product schemas' first
 * rule calls out. A rail links; it does not toggle.
 *
 * Takes a projectId rather than a slug because the caller has already resolved and
 * authorized the project — the draft gate lives in the controller, next to the session.
 */
export async function listProjectVideos(
  researchProjectId: string,
  filter: { readonly page: number; readonly limit: number },
): Promise<ProjectVideoPage> {
  const predicate = and(
    eq(video.researchProjectId, researchProjectId),
    PUBLICLY_SERVABLE,
    lte(video.publishedAt, sql`now()`),
  );

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        videoId: video.id,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        publishedAt: video.publishedAt,
        durationSeconds: video.durationSeconds,
        creatorHandle: user.handle,
        creatorName: user.name,
        creatorImageUrl: user.image,
      })
      .from(video)
      .innerJoin(user, eq(user.id, video.creatorId))
      .where(predicate)
      // Ends in a unique column (§4c rule 4) — two videos published in the same millisecond
      // are one tap apart, and a sort that ties drops whichever row loses it.
      .orderBy(desc(video.publishedAt), desc(video.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db.select({ value: count() }).from(video).where(predicate),
  ]);

  return {
    rows: rows.map((row) => ({
      videoId: row.videoId,
      title: row.title,
      thumbnailUrl: row.thumbnailUrl,
      publishedAt: row.publishedAt,
      durationSeconds: row.durationSeconds,
      creator: {
        handle: row.creatorHandle,
        name: row.creatorName,
        imageUrl: row.creatorImageUrl,
      },
    })),
    total: totals?.value ?? 0,
  };
}
