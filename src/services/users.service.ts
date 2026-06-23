import { eq } from "drizzle-orm";

import { query } from "#src/db/index.js";
import { db } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
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
  readonly emailVerified: boolean;
}

/**
 * Domain failures for {@link updateUserName}. The session always resolves to a
 * real user, so USER_NOT_FOUND only fires on a row deleted mid-request.
 */
export type UpdateUserNameError = { type: "USER_NOT_FOUND"; userId: string };

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
    .returning({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      emailVerified: user.emailVerified,
    });

  if (!updatedUser) {
    return { success: false, error: { type: "USER_NOT_FOUND", userId } };
  }

  return { success: true, value: updatedUser };
}
