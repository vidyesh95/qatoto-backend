import { asc, eq } from "drizzle-orm";

import { query } from "#src/db/index.js";
import { db } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";
import { deleteUserAvatar, uploadUserAvatar, type CloudinaryError } from "#src/lib/cloudinary.js";
import { validateAndNormalizeAvatar, type AvatarValidationError } from "#src/lib/image.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
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
 * Every active user's id, email and join date. **STAFF ONLY.**
 *
 * ## ⚠️ THIS WAS AN UNAUTHENTICATED ENDPOINT THAT RETURNED 100 REAL EMAIL ADDRESSES
 *
 * `GET /users` needed no session and answered with the address of every account on the
 * platform, a hundred at a time. That is a disclosure of personal data to anybody who
 * knew the path, with no lawful basis and nothing in the logs to distinguish a crawler
 * from an attacker. `docs/BACKEND_STRUCTURE.md` had it filed under "Later (NOT now)".
 *
 * ## WHY `view_platform_metrics` AND NOT A NEW CAPABILITY
 *
 * That capability already gates `GET /admin/metrics/users`, and its own definition
 * explains the reasoning this route needs verbatim: it "answers 'who watches the most'
 * and 'who has gone quiet' with NAMED ACCOUNTS… a behavioural dossier on identifiable
 * people". A list of every address on the platform is the same kind of thing, so it
 * belongs behind the same `admin`-only grant rather than a second one that would have to
 * be kept in step with it.
 *
 * ## THE SELECT LIST STAYS NARROW
 *
 * Do NOT widen it to `SELECT *` or add owner-only columns. Staff access is a lawful basis
 * for reading an address; it is not a reason to hand over everything else too. New
 * owner-only fields belong on PublicUser, returned by the session-guarded `/users/me*`
 * routes.
 *
 * `deactivated_at IS NULL` (Privacy Part 3): an account inside its 30-day deletion window
 * stops being listed. The many author joins that project `user.name` are NOT filtered and
 * deliberately so — attribution keeps its name until the scrub, which is what makes the
 * scrub the real event. The `user_deactivatedAt_idx` partial index serves this predicate.
 */
export async function listUsersForStaff(
  callerUserId: string,
): Promise<Result<readonly PublicUserListRow[], PlatformAccessError>> {
  const authorized = await requirePlatformCapability(callerUserId, "view_platform_metrics");
  if (!authorized.success) return authorized;

  return { success: true, value: await getAllUsers() };
}

/**
 * The raw read. NOT EXPORTED — every caller must come through
 * {@link listUsersForStaff}, so the capability check cannot be forgotten at a new site.
 */
async function getAllUsers(): Promise<readonly PublicUserListRow[]> {
  const result = await query<PublicUserListRow>(
    'SELECT id, email, created_at FROM "user" WHERE deactivated_at IS NULL LIMIT 100',
  );
  return result.rows;
}

/**
 * One user by id. **STAFF ONLY**, for the reason {@link listUsersForStaff} sets out — this
 * leaked the same addresses, one row per request instead of a hundred.
 *
 * A DEACTIVATED ACCOUNT READS AS NOT FOUND, not as an empty profile. The distinction
 * matters: 404 is also what a never-existed id returns, so the response cannot be used to
 * probe whether a particular account is mid-deletion.
 */
export async function getUserByIdForStaff(
  callerUserId: string,
  id: string,
): Promise<Result<PublicUserListRow | null, PlatformAccessError>> {
  const authorized = await requirePlatformCapability(callerUserId, "view_platform_metrics");
  if (!authorized.success) return authorized;

  return { success: true, value: await getUserById(id) };
}

/** The raw read. NOT EXPORTED — see {@link getUserByIdForStaff}. */
async function getUserById(id: string): Promise<PublicUserListRow | null> {
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
