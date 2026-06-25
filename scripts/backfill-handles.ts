/**
 * Backfill placeholder handles for users who predate the auto-placeholder hook.
 *
 * The Better Auth user-create hook (src/lib/auth.ts) only fires on NEW signups,
 * so any user created before it shipped has `handle = NULL` and the frontend falls
 * back to a hardcoded default. This one-off assigns each of them a unique
 * randomized handle via the same generator the hook uses (assignPlaceholderHandle),
 * which is idempotent (WHERE handle IS NULL) and never clobbers an existing handle.
 *
 * Usage:
 *   npm run db:backfill-handles            # DRY RUN — lists who would change
 *   npm run db:backfill-handles -- --apply # actually assigns handles
 */
import "dotenv/config";
import { isNull } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
import { assignPlaceholderHandle } from "#src/services/handle.service.js";

async function main(): Promise<void> {
  const shouldApply = process.argv.includes("--apply");

  const usersWithoutHandle = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(isNull(user.handle));

  if (usersWithoutHandle.length === 0) {
    console.log("Every user already has a handle. Nothing to do.");
    return;
  }

  console.log(`Found ${usersWithoutHandle.length} user(s) without a handle:`);

  if (!shouldApply) {
    for (const candidate of usersWithoutHandle) {
      console.log(`  ${candidate.id}  ${candidate.email}  name=${JSON.stringify(candidate.name)}`);
    }
    console.log("\nDRY RUN — nothing assigned. Re-run with `-- --apply` to assign handles.");
    return;
  }

  for (const candidate of usersWithoutHandle) {
    const result = await assignPlaceholderHandle(candidate.id, candidate.name, candidate.email);
    if (result.success) {
      console.log(`  ${candidate.email}  →  ${result.value ?? "(already had one)"}`);
    } else {
      console.error(`  ${candidate.email}  →  FAILED (${result.error.type})`);
    }
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Handle backfill failed:", error);
    await pool.end();
    process.exit(1);
  });
