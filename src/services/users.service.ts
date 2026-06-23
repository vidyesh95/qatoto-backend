import { eq } from "drizzle-orm";

import { query } from "#src/db/index.js";
import { db } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
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
const PUBLIC_USER_COLUMNS = {
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
 * Fetch all users from the database.
 */
export async function getAllUsers() {
  const result = await query('SELECT id, email, created_at FROM "user" LIMIT 100');
  return result.rows;
}

/**
 * Fetch a single user by ID.
 */
export async function getUserById(id: string) {
  const result = await query('SELECT id, email, created_at FROM "user" WHERE id = $1', [id]);
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
