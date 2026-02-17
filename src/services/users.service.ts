import { query } from "#src/db/index.js";

/**
 * Fetch all users from the database.
 */
export async function getAllUsers() {
  const result = await query("SELECT id, email, created_at FROM users LIMIT 100");
  return result.rows;
}

/**
 * Fetch a single user by ID.
 */
export async function getUserById(id: string) {
  const result = await query(
    "SELECT id, email, created_at FROM users WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}
