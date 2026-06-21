/**
 * One-time cleanup for password-less orphan users left by the OLD OTP signup flow.
 *
 * Before `disableSignUp: true` + the atomic POST /signup/complete endpoint, calling
 * `sign-in/email-otp` created a verified `user` row with NO `account` row. If the
 * browser closed before a password was set, that user was stranded: it can't log in
 * (no credential) and /signup/complete now returns 409 (email already exists).
 *
 * An orphan is precisely a `user` with ZERO `account` rows and `isAnonymous` not true:
 *   - email+password users  → have a `credential` account row.
 *   - OAuth users           → have a `google` / `github` account row.
 *   - anonymous users       → `isAnonymous = true` (left alone).
 * The new atomic flow creates user + credential in one step, so it never makes these.
 *
 * Usage:
 *   npm run db:cleanup-orphans            # DRY RUN — lists orphans, deletes nothing
 *   npm run db:cleanup-orphans -- --delete  # actually deletes them (FK cascades sessions)
 */
import "dotenv/config";

import { and, eq, isNull, notExists, or, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";

const orphanPredicate = and(
  notExists(db.select({ exists: sql`1` }).from(account).where(eq(account.userId, user.id))),
  or(isNull(user.isAnonymous), eq(user.isAnonymous, false)),
);

async function main(): Promise<void> {
  const shouldDelete = process.argv.includes("--delete");

  const orphans = await db
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(orphanPredicate);

  if (orphans.length === 0) {
    console.log("No orphan users found. Nothing to do.");
    return;
  }

  console.log(`Found ${orphans.length} orphan user(s) (verified email, no account/password):`);
  for (const orphan of orphans) {
    console.log(`  ${orphan.id}  ${orphan.email}  verified=${orphan.emailVerified}  created=${orphan.createdAt.toISOString()}`);
  }

  if (!shouldDelete) {
    console.log("\nDRY RUN — nothing deleted. Re-run with `-- --delete` to remove these rows.");
    return;
  }

  // FK `session.userId ... onDelete: "cascade"` removes any dangling sessions.
  const deleted = await db.delete(user).where(orphanPredicate).returning({ id: user.id });
  console.log(`\nDeleted ${deleted.length} orphan user(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Cleanup failed:", error);
    await pool.end();
    process.exit(1);
  });
