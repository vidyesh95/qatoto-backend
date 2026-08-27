import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { user, userProfileLink } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

/**
 * The channel profile a creator writes about themselves — `GET|PATCH /users/me/channel-profile`.
 *
 * ## WHY THIS IS NOT A WIDENING OF `PATCH /users/me`
 *
 * That body is `.strict()` with a REQUIRED `fullName`. Adding these two fields would mean making
 * every field optional, at which point `updateUserName(id, name)` stops describing the handler and
 * its response — which literally says "Name updated successfully" — stops being true. The links half
 * is also a replace-the-set write in a transaction, which is a different shape from a single-column
 * patch. Every other capability on this router already has its own path.
 *
 * ## THE LINKS WRITE IS DELETE-ALL-THEN-INSERT, IN ONE TRANSACTION
 *
 * Not a diff. The client sends the complete list in the order it wants, and `sortOrder` is assigned
 * from the array index — so the server never has to reconcile two orderings and the caller never has
 * to send an id it did not mint. `user_profile_link_position_uidx` makes a half-applied write
 * impossible rather than merely unlikely: two rows claiming one slot cannot commit.
 *
 * That is also why the route needs no idempotency key. Sending the same body twice produces exactly
 * the same rows, which is what idempotent means.
 *
 * ## THERE IS NO MODERATION BRANCH HERE, ON PURPOSE
 *
 * `profileModerationState` gates the PUBLIC read. A creator whose profile a moderator has hidden can
 * still see and edit their own text — hiding it from them as well would mean they could not fix the
 * thing they were asked to fix.
 */
export interface ChannelProfileView {
  readonly bio: string | null;
  readonly links: readonly { readonly label: string; readonly url: string }[];
  /**
   * Whether a moderator has hidden this text from the public channel page.
   *
   * ⚠️ IT IS ON THE OWNER'S READ BECAUSE OTHERWISE NOBODY EVER TELLS THEM. Upholding a report
   * flips the state, writes an audit entry and an action row — and reaches the person not at all.
   * Without this field the editor renders their description exactly as it did before, so somebody
   * asked to fix a problem would not know there was one, and "they can still edit it" would be a
   * technically true sentence describing a dead end.
   */
  readonly profileModerationState: typeof user.$inferSelect.profileModerationState;
  /**
   * Whether this creator has asked to be listed in the public sitemap.
   *
   * ON THIS READ RATHER THAN A SETTINGS ROUTE OF ITS OWN, because being findable is a
   * channel-profile decision and this is the route that owns the public-profile columns. A separate
   * endpoint would mean two writes for one screen and two chances for them to disagree.
   */
  readonly isChannelListed: boolean;
}

export type ChannelProfileError = { readonly type: "USER_NOT_FOUND" };

export async function getMyChannelProfile(
  userId: string,
): Promise<Result<ChannelProfileView, ChannelProfileError>> {
  const [row] = await db
    .select({
      bio: user.bio,
      profileModerationState: user.profileModerationState,
      isChannelListed: user.isChannelListed,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) return { success: false, error: { type: "USER_NOT_FOUND" } };

  const links = await db
    .select({ label: userProfileLink.label, url: userProfileLink.url })
    .from(userProfileLink)
    .where(eq(userProfileLink.userId, userId))
    .orderBy(asc(userProfileLink.sortOrder));

  // THE OWNER SEES THEIR OWN TEXT WHATEVER THE STATE — hiding it from them too would mean they
  // could not fix the thing they were asked to fix. What the state changes is that they are TOLD.
  return {
    success: true,
    value: {
      bio: row.bio,
      links,
      profileModerationState: row.profileModerationState,
      isChannelListed: row.isChannelListed,
    },
  };
}

export async function replaceMyChannelProfile(
  userId: string,
  input: {
    readonly bio: string | null;
    readonly links: readonly { readonly label: string; readonly url: string }[];
    readonly isChannelListed: boolean;
  },
): Promise<Result<ChannelProfileView, ChannelProfileError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(user)
      .set({ bio: input.bio, isChannelListed: input.isChannelListed })
      // SCOPED TO A LIVE ACCOUNT, not to an id alone. An anonymized row must never accept new
      // public text — the scrub is the one write that outranks this one, and a race between an
      // in-flight edit and the erasure must resolve in the erasure's favour. Unreachable in
      // practice, since anonymization revokes every session, which is exactly why it is cheap.
      .where(and(eq(user.id, userId), isNull(user.anonymizedAt)))
      .returning({ id: user.id });
    if (!updated) return { status: "missing" as const };

    await transaction.delete(userProfileLink).where(eq(userProfileLink.userId, userId));

    if (input.links.length > 0) {
      await transaction.insert(userProfileLink).values(
        input.links.map((link, linkIndex) => ({
          userId,
          label: link.label,
          url: link.url,
          // ASSIGNED HERE, never accepted from the client. The array's order IS the creator's
          // order, and letting a caller name its own positions would let two links collide on
          // `user_profile_link_position_uidx` for no gain.
          sortOrder: linkIndex,
        })),
      );
    }

    return { status: "saved" as const };
  });

  if (outcome.status === "missing") {
    return { success: false, error: { type: "USER_NOT_FOUND" } };
  }
  return getMyChannelProfile(userId);
}
