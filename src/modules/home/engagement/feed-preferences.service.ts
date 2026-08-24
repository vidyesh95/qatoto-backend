import { and, desc, eq, lt, or } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { creatorMute, user, video, videoNotInterested } from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { findPublicVideo } from "#src/modules/studio/public-video-gate.js";
import type { Result } from "#src/types/index.js";

/**
 * Feed preferences — the two NEGATIVE viewer signals.
 *
 * `PUT`/`DELETE /videos/:videoId/not-interested` and `PUT`/`DELETE /creators/:creatorId/mute`,
 * idempotent by verb for the same reason subscribe is: the composite primary key on each
 * table is the mechanism, so neither verb needs an idempotency key and a double-tap on a
 * slow connection is a no-op rather than an error.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO, and why it is shorter than
 * `creator-subscriptions.service.ts` despite the identical shape:
 *
 * NO COUNTER IS TOUCHED. Subscribe mints and moves `creatorStats.subscriberCount`; there is
 * no mirror here and there must not be. A public "muted by N people" is a stick handed to
 * anyone who wants to demoralise a creator, and it is trivially farmable with throwaway
 * accounts besides. Nothing reads either table in the creator direction.
 *
 * NO OUTCOME COUNT IS RETURNED. `SubscriptionOutcome` carries `subscriberCount` because the
 * caller renders it. These return the flag alone — there is no number to show and inventing
 * one ("hidden 4 videos from this channel") would be a claim about a feed nobody has fetched.
 *
 * THE WRITES ARE NOT TRANSACTIONAL. Subscribe needs a transaction because it reads a video,
 * writes a row and moves a counter as one unit. Each function here performs exactly one
 * statement against one table after its gate; a transaction around a single statement buys
 * nothing but a round trip.
 */

export type FeedPreferenceError =
  | { readonly type: "VIDEO_NOT_FOUND"; readonly videoId: string }
  | { readonly type: "CREATOR_NOT_FOUND"; readonly creatorId: string }
  | { readonly type: "SELF_MUTE_FORBIDDEN"; readonly creatorId: string }
  // THE SAME PAYLOAD-FREE ARM `VideoCommentError` DECLARES, and declaring it again is
  // correct rather than duplication: TypeScript collapses two arms whose payloads match, so
  // `EngagementDomainError` still has ONE `CURSOR_MALFORMED` and the existing 422 case in
  // `engagement-error-response.ts` already answers it. A differently-shaped arm here — say
  // one carrying the raw cursor — would fork into a second literal needing its own mapping.
  | { readonly type: "CURSOR_MALFORMED" };

export interface NotInterestedOutcome {
  readonly isNotInterested: boolean;
}

export interface CreatorMuteOutcome {
  readonly isMuted: boolean;
}

/** One muted channel, as `GET /users/me/muted-creators` returns it. */
export interface MutedCreatorRow {
  readonly id: string;
  readonly handle: string | null;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly mutedAt: Date;
}

/**
 * One dismissed video, as `GET /users/me/not-interested-videos` returns it.
 *
 * TWO NULLABLE FIELDS, AND NEITHER IS AN OVERSIGHT. `video.thumbnailUrl` is nullable on the
 * table — a video whose oEmbed lookup returned no image is a real video — and `creatorHandle`
 * is nullable for the reason `MutedCreatorRow.handle` is: an account with no handle is a real
 * account. A caller must branch rather than build `/channel/${handle}` from either.
 *
 * NO `viewerState`, NO COUNTS, NO CATEGORY LIST. This is a row in an undo list, not a feed
 * card. Everything here exists to let somebody recognise which video they dismissed.
 */
export interface NotInterestedVideoRow {
  readonly videoId: string;
  readonly title: string;
  readonly thumbnailUrl: string | null;
  readonly creatorName: string;
  readonly creatorHandle: string | null;
  readonly dismissedAt: Date;
}

/**
 * "Not interested" — hides one video from one viewer's feed, permanently and outside the
 * ranker's relaxation ladder.
 *
 * GATED ON `findPublicVideo` exactly as `setVideoSave` is, and for a reason that is not
 * about authorization: an ungated write would happily store a preference against a private
 * id, an unpublished id or an id that never existed, and the row would sit there forever
 * filtering nothing. A 404 here also keeps the route from becoming an existence oracle for
 * a creator's unreleased catalogue — the §5.4 status policy in
 * `engagement-error-response.ts` states that line once for the whole surface.
 *
 * NO TRANSACTION, and no gate INSIDE one, unlike `setVideoSave`. That function holds the
 * gate and its write together because a video unpublished in between would otherwise take
 * a counter with it. Nothing here is counted, so the worst a race can do is store a
 * preference for a video that stopped being public a millisecond ago — which the feed will
 * never surface anyway, because it is no longer a candidate.
 */
export async function setVideoNotInterested(input: {
  readonly viewerId: string;
  readonly videoId: string;
  readonly shouldBeSet: boolean;
}): Promise<Result<NotInterestedOutcome, FeedPreferenceError>> {
  const publicVideo = await findPublicVideo(db, input.videoId);
  if (publicVideo === null) {
    return { success: false, error: { type: "VIDEO_NOT_FOUND", videoId: input.videoId } };
  }

  if (input.shouldBeSet) {
    await db
      .insert(videoNotInterested)
      .values({ viewerId: input.viewerId, videoId: input.videoId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(videoNotInterested)
      .where(
        and(
          eq(videoNotInterested.viewerId, input.viewerId),
          eq(videoNotInterested.videoId, input.videoId),
        ),
      );
  }

  // The requested state, not a count of affected rows. Zero rows means the preference was
  // ALREADY in the state asked for, which is the same answer — that is what idempotent means
  // here, and reporting it as a failure would make Undo look broken on a double-tap.
  return { success: true, value: { isNotInterested: input.shouldBeSet } };
}

/**
 * "Don't recommend channel" — hides every video by one creator from one viewer's feed.
 *
 * EXISTENCE, NOT CREATOR-NESS. Checks the `user` row rather than "has published a video",
 * the same call `setCreatorSubscription` makes: a channel with nothing on it yet is a real
 * thing to want out of your feed, and a viewer who muted someone before their first upload
 * should not have that silently forgotten.
 */
export async function setCreatorMute(input: {
  readonly muterId: string;
  readonly creatorId: string;
  readonly shouldBeSet: boolean;
}): Promise<Result<CreatorMuteOutcome, FeedPreferenceError>> {
  // Checked in TypeScript before the write rather than caught as a CHECK violation. The
  // constraint stays as the backstop — it is what makes this true at rest — but a 23514
  // climbing out of a service is an unhandled 500, not a clean 403. Same reasoning, and the
  // same wording, as the self-subscription guard.
  if (input.muterId === input.creatorId) {
    return { success: false, error: { type: "SELF_MUTE_FORBIDDEN", creatorId: input.creatorId } };
  }

  const [targetCreator] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, input.creatorId))
    .limit(1);

  if (!targetCreator) {
    return { success: false, error: { type: "CREATOR_NOT_FOUND", creatorId: input.creatorId } };
  }

  if (input.shouldBeSet) {
    await db
      .insert(creatorMute)
      .values({ muterId: input.muterId, creatorId: input.creatorId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(creatorMute)
      .where(
        and(eq(creatorMute.muterId, input.muterId), eq(creatorMute.creatorId, input.creatorId)),
      );
  }

  return { success: true, value: { isMuted: input.shouldBeSet } };
}

/**
 * The viewer's own muted channels — `GET /users/me/muted-creators`.
 *
 * THIS ROUTE IS WHAT MAKES THE MUTE BUTTON REVERSIBLE, which is why it exists at all. A
 * muted creator's videos never appear in the feed again, so the card carrying the "undo"
 * control is exactly the card that is now hidden. Without a list there is no surface
 * anywhere that can lift the mute, and a preference a viewer cannot withdraw is a trap.
 *
 * NOT PAGINATED. The list is bounded by how many channels one person has bothered to mute
 * by hand, which is tens at the very most; a cursor here would be machinery for a page that
 * cannot exist. Newest first, because the one a viewer wants to undo is almost always the
 * one they just set.
 */
export async function listMutedCreators(muterId: string): Promise<readonly MutedCreatorRow[]> {
  const rows = await db
    .select({
      id: user.id,
      handle: user.handle,
      name: user.name,
      imageUrl: user.image,
      mutedAt: creatorMute.createdAt,
    })
    .from(creatorMute)
    .innerJoin(user, eq(user.id, creatorMute.creatorId))
    .where(eq(creatorMute.muterId, muterId))
    .orderBy(desc(creatorMute.createdAt));

  return rows;
}

/**
 * The viewer's own dismissed videos — `GET /users/me/not-interested-videos`.
 *
 * THE SAME ARGUMENT `listMutedCreators` MAKES, applied to the harder half. A dismissed video
 * never reaches the feed again, so the card carrying the undo control is exactly the card now
 * hidden; the in-menu Undo only works while that card is still on screen, which stops being
 * true the moment the reader scrolls. Without this route a dismissal is permanent by accident
 * rather than by choice.
 *
 * PAGINATED, WHERE THE MUTED LIST IS NOT — and the asymmetry is the point rather than an
 * inconsistency. Muting is a deliberate act against a whole channel and tops out in the tens.
 * Dismissing is one tap on one card, done idly, thousands of times over a year. The same
 * "machinery for a page that cannot exist" test that rules a cursor OUT there rules it IN
 * here. Keyset on `(createdAt, videoId)` via the shared `instant-cursor` codec, because two
 * dismissals seconds apart can land in the same millisecond and a cursor keyed on a
 * non-unique column silently skips whichever row loses the tie.
 *
 * NO PUBLIC-VIDEO GATE, deliberately, and this is the one place this module disagrees with
 * `setVideoNotInterested` directly above. That write gates on `findPublicVideo` so a
 * preference is never stored against something the viewer could not have seen. This READ
 * must not: a video that went private, or unpublished, AFTER being dismissed still has a row,
 * and gating would hide exactly the rows a viewer cannot otherwise reach — an unliftable
 * preference, which is the trap this whole route exists to close. Videos that are genuinely
 * gone are already gone from here, by the `ON DELETE cascade` on the foreign key.
 *
 * The `innerJoin` on `user` is therefore the only row filter, and it drops nothing in
 * practice: `video.creatorId` is `NOT NULL` and cascades with the account.
 */
export async function listNotInterestedVideos(input: {
  readonly viewerId: string;
  readonly limit: number;
  readonly cursor: string | null;
}): Promise<
  Result<
    { readonly rows: readonly NotInterestedVideoRow[]; readonly nextCursor: string | null },
    FeedPreferenceError
  >
> {
  const decodedCursor = input.cursor === null ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== null && decodedCursor === null) {
    return { success: false, error: { type: "CURSOR_MALFORMED" } };
  }

  // Newest first, so the dismissal somebody regrets — almost always the one they just made —
  // is on the first page. The tiebreak sorts the same direction as the instant; a cursor
  // whose two columns disagree on direction skips rows at every page boundary.
  const cursorCondition =
    decodedCursor === null
      ? undefined
      : or(
          lt(videoNotInterested.createdAt, decodedCursor.instant),
          and(
            eq(videoNotInterested.createdAt, decodedCursor.instant),
            lt(videoNotInterested.videoId, decodedCursor.id),
          ),
        );

  // One extra row, exactly as the comment listing does it: its presence is what proves a next
  // page exists, without a COUNT over every dismissal the viewer ever made.
  const rows = await db
    .select({
      videoId: video.id,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      creatorName: user.name,
      creatorHandle: user.handle,
      dismissedAt: videoNotInterested.createdAt,
    })
    .from(videoNotInterested)
    .innerJoin(video, eq(video.id, videoNotInterested.videoId))
    .innerJoin(user, eq(user.id, video.creatorId))
    .where(and(eq(videoNotInterested.viewerId, input.viewerId), cursorCondition))
    .orderBy(desc(videoNotInterested.createdAt), desc(videoNotInterested.videoId))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor =
    rows.length > input.limit && lastRow !== undefined
      ? encodeInstantCursor({ instant: lastRow.dismissedAt, id: lastRow.videoId })
      : null;

  return { success: true, value: { rows: pageRows, nextCursor } };
}
