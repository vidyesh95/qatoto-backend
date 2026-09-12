import { and, asc, count, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  showcaseLaunch,
  showcaseLaunchStats,
  showcaseLaunchTeamMember,
  showcaseLaunchWriteUpImage,
  user,
} from "#src/db/schema.js";
import {
  decodeShowcaseFeedCursor,
  encodeShowcaseFeedCursor,
  type ShowcaseFeedSort,
} from "#src/modules/home/blueprints/showcase-feed-cursor.js";
import type { Result } from "#src/types/index.js";

/**
 * The PUBLIC reads behind `/blueprints/showcase` — the feed, the slug list and one launch.
 *
 * THE VISIBILITY RULE IS THE WHOLE SECURITY SURFACE OF THIS FILE, and it is one predicate:
 * `moderation_state = 'published'`. A launch in any other state has never been decided in the
 * reader's favour, and two of those states — `pending_review` and `rejected` — contain a maker's
 * unpublished work. Every query below applies it, including the facet counts: a tag chip promising
 * three launches that resolves to two is a count the reader can see is wrong, and the way that
 * happens is a facet query that forgets the gate the list applies.
 *
 * NOTHING HERE READS THE CALLER. There is no `viewerState` in the payload because the frontend
 * offers no control that would need one — its vote box is deliberately a `<span>` rather than a
 * `<button>` — so these routes take no session and the answer is identical for every visitor.
 *
 * ⚠️ `top` CURRENTLY PRODUCES THE SAME ORDER AS `newest`, and that is correct rather than broken.
 * Its leading key is `upvote_count` from `showcase_launch_stats`, no route writes that table yet,
 * so every row ties at 0 and the order falls through to the `launchedAt DESC, id ASC` tie-break.
 * Do NOT "fix" this by ranking on likes or views: the sort is still a total order, and substituting
 * a different number would make the chip mean something other than what it says.
 */

/** One tag and how many published launches carry it. Mirrors the frontend's `FacetBucket`. */
export interface ShowcaseTagFacet {
  readonly value: string;
  readonly count: number;
}

/** One launch as the feed renders it — the frontend's `ShowcaseBlueprint`, byte for byte. */
export interface PublicShowcaseView {
  readonly id: string;
  readonly slug: string;
  readonly category: "showcase";
  readonly title: string;
  readonly summary: string;
  readonly tagline: string;
  readonly writeUp: string | null;
  readonly thumbnailUrl: string;
  /** Nullable because `user.handle` and `user.image` are — see the docblock on `buildAuthor`. */
  readonly author: {
    readonly displayName: string;
    readonly handle: string | null;
    readonly avatarUrl: string | null;
  };
  readonly viewCount: number;
  readonly likeCount: number;
  readonly upvoteCount: number;
  readonly commentCount: number;
  readonly difficulty: (typeof showcaseLaunch.$inferSelect)["difficulty"];
  readonly cadFormat: string | null;
  readonly billOfMaterialsCostRange: {
    readonly minimumInCents: number;
    readonly maximumInCents: number;
    readonly currency: string;
  } | null;
  readonly tags: readonly string[];
  readonly createdAt: Date;
  readonly launchedAt: Date;
  readonly writeUpImages: readonly {
    readonly url: string;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly blurDataUrl: string | null;
  }[];
  readonly team: readonly {
    readonly displayName: string;
    readonly handle: string;
    readonly role: string;
  }[];
  readonly builtFromBlueprintSlug: string | null;
  readonly callToAction: { readonly label: string; readonly url: string } | null;
}

export interface PublicShowcaseFeedPage {
  readonly items: readonly PublicShowcaseView[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
  readonly tagFacets: readonly ShowcaseTagFacet[];
}

export type ShowcaseFeedError = { readonly type: "SHOWCASE_FEED_CURSOR_MALFORMED" };
export type ShowcaseDetailError = { readonly type: "SHOWCASE_LAUNCH_NOT_FOUND" };

/** Every published launch, whatever the filter — the population both the list and facets read. */
function publishedLaunchCondition(): SQL {
  return eq(showcaseLaunch.moderationState, "published");
}

/**
 * The author, carried as three nullable-tolerant fields rather than a join that could drop a row.
 *
 * `user.handle` and `user.image` are BOTH NULLABLE, and neither is guaranteed by anything upstream:
 * `requireIdentifiedUser` proves the account is not anonymous and holds a credential, which says
 * nothing about a handle or a photo. So a launch can be submitted, moderated and published by an
 * account with neither. They travel as `null` rather than as a placeholder URL or a substituted id
 * — a made-up avatar is a lie the page repeats, and substituting the user id would leak an internal
 * identifier into a public `@mention`.
 */
function buildAuthor(row: {
  readonly authorDisplayName: string;
  readonly authorHandle: string | null;
  readonly authorAvatarUrl: string | null;
}): PublicShowcaseView["author"] {
  return {
    displayName: row.authorDisplayName,
    handle: row.authorHandle,
    avatarUrl: row.authorAvatarUrl,
  };
}

type LaunchRow = {
  readonly launch: typeof showcaseLaunch.$inferSelect;
  readonly authorDisplayName: string;
  readonly authorHandle: string | null;
  readonly authorAvatarUrl: string | null;
  readonly upvoteCount: number;
  readonly viewCount: number;
  readonly likeCount: number;
  readonly commentCount: number;
};

/** The select list every read shares, so the feed and the detail cannot drift apart. */
const PUBLIC_LAUNCH_COLUMNS = {
  launch: showcaseLaunch,
  authorDisplayName: user.name,
  authorHandle: user.handle,
  authorAvatarUrl: user.image,
  // `coalesce` rather than a written row: no route moves these counters yet, so most launches have
  // no stats row at all and 0 is the true answer rather than a placeholder.
  upvoteCount: sql<number>`coalesce(${showcaseLaunchStats.upvoteCount}, 0)`.mapWith(Number),
  viewCount: sql<number>`coalesce(${showcaseLaunchStats.viewCount}, 0)`.mapWith(Number),
  likeCount: sql<number>`coalesce(${showcaseLaunchStats.likeCount}, 0)`.mapWith(Number),
  commentCount: sql<number>`coalesce(${showcaseLaunchStats.commentCount}, 0)`.mapWith(Number),
};

function buildLaunchView(
  row: LaunchRow,
  teamRows: readonly (typeof showcaseLaunchTeamMember.$inferSelect)[],
  imageRows: readonly (typeof showcaseLaunchWriteUpImage.$inferSelect)[],
): PublicShowcaseView {
  const { launch } = row;
  const hasCostRange =
    launch.billOfMaterialsMinimumCents !== null &&
    launch.billOfMaterialsMaximumCents !== null &&
    launch.billOfMaterialsCurrency !== null;

  return {
    id: launch.id,
    // Non-null for every published launch: the decision CHECK moves `public_slug` and the state
    // together, so `published` and a slug are the same fact.
    slug: launch.publicSlug ?? launch.id,
    category: "showcase",
    title: launch.title,
    summary: launch.summary,
    tagline: launch.tagline,
    writeUp: launch.writeUp,
    thumbnailUrl: launch.headingImageUrl,
    author: buildAuthor(row),
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    upvoteCount: row.upvoteCount,
    commentCount: row.commentCount,
    difficulty: launch.difficulty,
    // No column: a launch names no CAD format, and the contract already allows null.
    cadFormat: null,
    billOfMaterialsCostRange:
      hasCostRange &&
      launch.billOfMaterialsMinimumCents !== null &&
      launch.billOfMaterialsMaximumCents !== null &&
      launch.billOfMaterialsCurrency !== null
        ? {
            minimumInCents: launch.billOfMaterialsMinimumCents,
            maximumInCents: launch.billOfMaterialsMaximumCents,
            currency: launch.billOfMaterialsCurrency,
          }
        : null,
    tags: launch.tags,
    createdAt: launch.createdAt,
    launchedAt: launch.launchedAt,
    writeUpImages: imageRows.map((imageRow) => ({
      url: imageRow.url,
      widthPx: imageRow.widthPx,
      heightPx: imageRow.heightPx,
      blurDataUrl: imageRow.blurDataUrl,
    })),
    team: teamRows.map((teamRow) => ({
      displayName: teamRow.displayName,
      handle: teamRow.handle,
      role: teamRow.role,
    })),
    builtFromBlueprintSlug: launch.builtFromBlueprintSlug,
    callToAction:
      launch.callToActionLabel !== null && launch.callToActionUrl !== null
        ? { label: launch.callToActionLabel, url: launch.callToActionUrl }
        : null,
  };
}

/**
 * The keyset predicate for one page, in whichever order the caller asked for.
 *
 * ⚠️ `newest` IS A MIXED-DIRECTION KEYSET — `launched_at DESC, id ASC` — because the frontend's
 * comparator breaks ties on the id ascending. The predicate has to mirror the ORDER BY exactly, or
 * a page boundary that lands mid-tie will skip or repeat a launch.
 */
function buildKeysetCondition(sort: ShowcaseFeedSort, rawCursor: string): SQL | null {
  const cursor = decodeShowcaseFeedCursor(rawCursor, sort);
  if (cursor === null) return null;

  switch (cursor.sort) {
    case "newest":
      return (
        or(
          lt(showcaseLaunch.launchedAt, cursor.launchedAt),
          and(eq(showcaseLaunch.launchedAt, cursor.launchedAt), gt(showcaseLaunch.id, cursor.id)),
        ) ?? null
      );
    case "top": {
      const upvoteExpression = sql`coalesce(${showcaseLaunchStats.upvoteCount}, 0)`;
      return (
        or(
          lt(upvoteExpression, cursor.upvoteCount),
          and(
            eq(upvoteExpression, cursor.upvoteCount),
            or(
              lt(showcaseLaunch.launchedAt, cursor.launchedAt),
              and(
                eq(showcaseLaunch.launchedAt, cursor.launchedAt),
                gt(showcaseLaunch.id, cursor.id),
              ),
            ),
          ),
        ) ?? null
      );
    }
    default: {
      const exhaustiveCheck: never = cursor;
      throw new Error(`Unhandled showcase feed cursor: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** Loads the team rows and write-up images for a page of launches, two queries rather than 2N. */
async function loadLaunchChildren(launchIds: readonly string[]): Promise<{
  readonly teamRows: readonly (typeof showcaseLaunchTeamMember.$inferSelect)[];
  readonly imageRows: readonly (typeof showcaseLaunchWriteUpImage.$inferSelect)[];
}> {
  if (launchIds.length === 0) return { teamRows: [], imageRows: [] };

  const [teamRows, imageRows] = await Promise.all([
    db
      .select()
      .from(showcaseLaunchTeamMember)
      .where(inArray(showcaseLaunchTeamMember.launchId, [...launchIds]))
      .orderBy(asc(showcaseLaunchTeamMember.launchId), asc(showcaseLaunchTeamMember.position)),
    db
      .select()
      .from(showcaseLaunchWriteUpImage)
      .where(inArray(showcaseLaunchWriteUpImage.launchId, [...launchIds]))
      .orderBy(asc(showcaseLaunchWriteUpImage.createdAt), asc(showcaseLaunchWriteUpImage.id)),
  ]);

  return { teamRows, imageRows };
}

/**
 * Tag counts across every published launch — the whole category, never the page.
 *
 * Counting the page would make the chips disagree with the list the moment there is a second page,
 * which is the one thing a facet count cannot do.
 */
async function loadTagFacets(): Promise<readonly ShowcaseTagFacet[]> {
  const tagExpression = sql<string>`unnest(${showcaseLaunch.tags})`;
  const facetRows = await db
    .select({ value: tagExpression, count: count() })
    .from(showcaseLaunch)
    .where(publishedLaunchCondition())
    .groupBy(tagExpression)
    .orderBy(desc(count()), asc(tagExpression));

  return facetRows.map((facetRow) => ({ value: facetRow.value, count: Number(facetRow.count) }));
}

export async function listPublicShowcases(input: {
  readonly sort: ShowcaseFeedSort;
  readonly limit: number;
  readonly tag: string | undefined;
  readonly cursor: string | undefined;
}): Promise<Result<PublicShowcaseFeedPage, ShowcaseFeedError>> {
  const conditions: SQL[] = [publishedLaunchCondition()];

  if (input.tag !== undefined) {
    // `@>` so the tag is matched as an array element rather than as a substring of one.
    conditions.push(sql`${showcaseLaunch.tags} @> ARRAY[${input.tag}]::text[]`);
  }

  if (input.cursor !== undefined) {
    const keysetCondition = buildKeysetCondition(input.sort, input.cursor);
    // A cursor this server did not mint, or one minted under the other sort. Refused rather than
    // dropped: silently restarting a feed shows the reader duplicates and reads as a backend bug.
    if (keysetCondition === null) {
      return { success: false, error: { type: "SHOWCASE_FEED_CURSOR_MALFORMED" } };
    }
    conditions.push(keysetCondition);
  }

  const upvoteExpression = sql`coalesce(${showcaseLaunchStats.upvoteCount}, 0)`;
  const orderBy =
    input.sort === "top"
      ? [desc(upvoteExpression), desc(showcaseLaunch.launchedAt), asc(showcaseLaunch.id)]
      : [desc(showcaseLaunch.launchedAt), asc(showcaseLaunch.id)];

  const [launchRows, tagFacets] = await Promise.all([
    db
      .select(PUBLIC_LAUNCH_COLUMNS)
      .from(showcaseLaunch)
      .innerJoin(user, eq(user.id, showcaseLaunch.authorUserId))
      .leftJoin(showcaseLaunchStats, eq(showcaseLaunchStats.launchId, showcaseLaunch.id))
      .where(and(...conditions))
      .orderBy(...orderBy)
      // One more than asked for, so "is there another page" needs no second count query.
      .limit(input.limit + 1),
    loadTagFacets(),
  ]);

  const hasMore = launchRows.length > input.limit;
  const pageRows = hasMore ? launchRows.slice(0, input.limit) : launchRows;
  const { teamRows, imageRows } = await loadLaunchChildren(pageRows.map((row) => row.launch.id));

  const items = pageRows.map((row) =>
    buildLaunchView(
      row,
      teamRows.filter((teamRow) => teamRow.launchId === row.launch.id),
      imageRows.filter((imageRow) => imageRow.launchId === row.launch.id),
    ),
  );

  // Minted from the last RETURNED row, never the over-fetched one: encoding the extra row would
  // skip a launch on every page boundary.
  const lastRow = pageRows.at(-1);
  const nextCursor =
    hasMore && lastRow
      ? encodeShowcaseFeedCursor(
          input.sort === "top"
            ? {
                sort: "top",
                upvoteCount: lastRow.upvoteCount,
                launchedAt: lastRow.launch.launchedAt,
                id: lastRow.launch.id,
              }
            : { sort: "newest", launchedAt: lastRow.launch.launchedAt, id: lastRow.launch.id },
        )
      : null;

  return { success: true, value: { items, page: { nextCursor, hasMore }, tagFacets } };
}

/** One published launch by its public slug. */
export async function getPublicShowcaseBySlug(
  publicSlug: string,
): Promise<Result<PublicShowcaseView, ShowcaseDetailError>> {
  const [launchRow] = await db
    .select(PUBLIC_LAUNCH_COLUMNS)
    .from(showcaseLaunch)
    .innerJoin(user, eq(user.id, showcaseLaunch.authorUserId))
    .leftJoin(showcaseLaunchStats, eq(showcaseLaunchStats.launchId, showcaseLaunch.id))
    .where(and(publishedLaunchCondition(), eq(showcaseLaunch.publicSlug, publicSlug)))
    .limit(1);

  if (!launchRow) return { success: false, error: { type: "SHOWCASE_LAUNCH_NOT_FOUND" } };

  const { teamRows, imageRows } = await loadLaunchChildren([launchRow.launch.id]);
  return { success: true, value: buildLaunchView(launchRow, teamRows, imageRows) };
}

/**
 * Every published slug, for the frontend's `generateStaticParams`.
 *
 * Unpaged on purpose: it is one short string per published launch, the caller needs all of them at
 * once to prerender, and a cursor would mean a build step that pages.
 */
export async function listPublicShowcaseSlugs(): Promise<readonly string[]> {
  const slugRows = await db
    .select({ publicSlug: showcaseLaunch.publicSlug })
    .from(showcaseLaunch)
    .where(publishedLaunchCondition())
    .orderBy(desc(showcaseLaunch.launchedAt), asc(showcaseLaunch.id));

  return slugRows.flatMap((slugRow) => (slugRow.publicSlug === null ? [] : [slugRow.publicSlug]));
}
