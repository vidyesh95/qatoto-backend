import { asc, eq } from "drizzle-orm";

import { query } from "#src/db/index.js";
import { db } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";
import { deleteUserAvatar, uploadUserAvatar, type CloudinaryError } from "#src/lib/cloudinary.js";
import { validateAndNormalizeAvatar, type AvatarValidationError } from "#src/lib/image.js";
import type { Result } from "#src/types/index.js";

/**
 * Public-facing shape of a user. Excludes anything sensitive; this is what the
 * frontend reads back to refresh its session view.
 */
export interface PublicUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly imageSource: "oauth" | "user" | null;
  readonly emailVerified: boolean;
}

/**
 * Columns that make up a {@link PublicUser}. Shared by every `.returning(...)`
 * so the read-back shape can't drift between mutations.
 */
export const PUBLIC_USER_COLUMNS = {
  id: user.id,
  name: user.name,
  email: user.email,
  image: user.image,
  imageSource: user.imageSource,
  emailVerified: user.emailVerified,
} as const;

/**
 * Domain failures for {@link updateUserName}. The session always resolves to a
 * real user, so USER_NOT_FOUND only fires on a row deleted mid-request.
 */
export type UpdateUserNameError = { type: "USER_NOT_FOUND"; userId: string };

/**
 * Domain failures for {@link updateUserPhoto}: the upload can be rejected at
 * validation (bad/oversized image), at the storage provider, or the user row can
 * vanish mid-request. Each maps to a distinct HTTP status in the controller.
 */
export type UpdateUserPhotoError =
  | AvatarValidationError
  | CloudinaryError
  | { type: "USER_NOT_FOUND"; userId: string };

/** Domain failures for {@link deleteUserPhoto}. */
export type DeleteUserPhotoError = CloudinaryError | { type: "USER_NOT_FOUND"; userId: string };

/**
 * A user row as exposed by the public, cross-user list/get reads. Mirrors the
 * deliberately narrow SELECT list below — it carries NO owner-only columns.
 */
export interface PublicUserListRow {
  readonly id: string;
  readonly email: string;
  readonly created_at: Date; // pg `timestamp` column → Date at runtime
}

/**
 * Fetch all users from the database. Public, cross-user read.
 *
 * SECURITY: the SELECT list is deliberately narrow (id, email, created_at). Do
 * NOT widen it to `SELECT *` or add owner-only columns — they would leak here.
 * New owner-only fields belong on PublicUser (returned by the session-guarded
 * /users/me* routes), never on this list.
 *
 * `deactivated_at IS NULL` (Privacy Part 3): an account inside its 30-day deletion
 * window stops being visible to other people, and this route plus {@link getUserById}
 * are the only cross-user, user-shaped reads on the platform. The many author joins
 * that project `user.name` are NOT filtered and deliberately so — attribution keeps
 * its name until the scrub, which is what makes the scrub the real event. The
 * `user_deactivatedAt_idx` partial index serves this predicate.
 */
export async function getAllUsers(): Promise<readonly PublicUserListRow[]> {
  const result = await query<PublicUserListRow>(
    'SELECT id, email, created_at FROM "user" WHERE deactivated_at IS NULL LIMIT 100',
  );
  return result.rows;
}

/**
 * Fetch a single user by ID. Public, cross-user read.
 *
 * SECURITY: same narrow-SELECT invariant as {@link getAllUsers} — never add any
 * owner-only field to this projection.
 *
 * A DEACTIVATED ACCOUNT READS AS NOT FOUND, not as an empty profile. The distinction
 * matters: 404 is also what a never-existed id returns, so the response cannot be used
 * to probe whether a particular account is mid-deletion.
 */
export async function getUserById(id: string): Promise<PublicUserListRow | null> {
  const result = await query<PublicUserListRow>(
    'SELECT id, email, created_at FROM "user" WHERE id = $1 AND deactivated_at IS NULL',
    [id],
  );
  return result.rows[0] || null;
}

/**
 * Overwrite the user's display name. This is the user-set source of truth: it
 * deliberately overrides any value OAuth seeded at first sign-in. `userId` MUST
 * come from the server-derived session (CLAUDE.md §1.1) — never a client field.
 *
 * `fullName` is assumed already parsed/trimmed by the controller's Zod schema.
 */
export async function updateUserName(
  userId: string,
  fullName: string,
): Promise<Result<PublicUser, UpdateUserNameError>> {
  const [updatedUser] = await db
    .update(user)
    // Mark the name as user-owned so OAuth account linking won't overwrite it.
    .set({ name: fullName, nameSetByUser: true })
    .where(eq(user.id, userId))
    .returning(PUBLIC_USER_COLUMNS);

  if (!updatedUser) {
    return { success: false, error: { type: "USER_NOT_FOUND", userId } };
  }

  return { success: true, value: updatedUser };
}

/**
 * One linked provider as shown in the settings panel: which provider, and the
 * email that provider knows the user by. `email` is null when we have not yet
 * resolved one (an old OAuth row the backfill has not reached, or a provider that
 * exposed no usable address). Tokens and the raw provider accountId are
 * deliberately absent — the UI never needs them (CLAUDE.md §1.1).
 */
export interface LinkedAccount {
  readonly providerId: string;
  readonly email: string | null;
}

/**
 * List the caller's linked providers with each one's resolved email, for
 * GET /users/me/linked-accounts. `userId` and `userEmail` MUST come from the
 * server-derived session (CLAUDE.md §1.1) — never client input — so a caller can
 * only ever read their OWN linked accounts.
 *
 * The credential ("email-password") account has no provider email of its own; its
 * address IS the user's primary login email, so we resolve it from `userEmail`
 * (the session value) rather than the column — that can never drift from the real
 * login email. OAuth rows return their stored `account.email`.
 */
export async function getLinkedAccounts(
  userId: string,
  userEmail: string,
): Promise<readonly LinkedAccount[]> {
  const rows = await db
    .select({ providerId: account.providerId, email: account.email })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(asc(account.createdAt));

  return rows.map((row) => ({
    providerId: row.providerId,
    email: row.providerId === "credential" ? userEmail : row.email,
  }));
}

/**
 * Set the user's profile photo from raw uploaded bytes. Validates + normalizes
 * the image (strips EXIF, bounds size — see lib/image), uploads to Cloudinary,
 * then records the URL and stamps `imageSource = "user"`. That stamp is the lock
 * from CLAUDE.md §1.1: OAuth must never overwrite a user-owned photo (enforced by
 * `updateUserInfoOnLink: false` in src/lib/auth.ts, mirroring nameSetByUser).
 *
 * `userId` MUST come from the server-derived session, never a client field.
 */
export async function updateUserPhoto(
  userId: string,
  rawImageBytes: Buffer,
): Promise<Result<PublicUser, UpdateUserPhotoError>> {
  const validation = await validateAndNormalizeAvatar(rawImageBytes);
  if (!validation.success) {
    return { success: false, error: validation.error };
  }

  const upload = await uploadUserAvatar(userId, validation.value.buffer);
  if (!upload.success) {
    return { success: false, error: upload.error };
  }

  const [updatedUser] = await db
    .update(user)
    .set({ image: upload.value.secureUrl, imageSource: "user" })
    .where(eq(user.id, userId))
    .returning(PUBLIC_USER_COLUMNS);

  if (!updatedUser) {
    return { success: false, error: { type: "USER_NOT_FOUND", userId } };
  }

  return { success: true, value: updatedUser };
}

/**
 * Remove the user's photo: delete the Cloudinary asset and clear both `image`
 * and `imageSource` (reset to the no-photo placeholder state). We intentionally
 * do NOT re-derive the old OAuth picture here — a fresh OAuth sign-in or the
 * backfill script re-seeds it; clearing imageSource unlocks that re-seed.
 */
export async function deleteUserPhoto(
  userId: string,
): Promise<Result<PublicUser, DeleteUserPhotoError>> {
  const deletion = await deleteUserAvatar(userId);
  if (!deletion.success) {
    return { success: false, error: deletion.error };
  }

  const [updatedUser] = await db
    .update(user)
    .set({ image: null, imageSource: null })
    .where(eq(user.id, userId))
    .returning(PUBLIC_USER_COLUMNS);

  if (!updatedUser) {
    return { success: false, error: { type: "USER_NOT_FOUND", userId } };
  }

  return { success: true, value: updatedUser };
}
