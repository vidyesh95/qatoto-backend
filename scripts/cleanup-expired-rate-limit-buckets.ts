/**
 * Hourly sweep of dead rate-limit buckets (§11l.2 item 7).
 *
 * A bucket row is a live rate-limit window. Once `expires_at` has passed, the next request
 * for that key rolls the window in place — the row is never READ again, only overwritten —
 * so this sweep is purely housekeeping to keep the table small.
 *
 * The table is largely self-limiting: an active key rewrites its own row rather than adding
 * one, so only ABANDONED keys accumulate. The steady state is roughly "distinct keys seen in
 * the last fifteen minutes", which is small. A cache still must not grow forever.
 *
 * NOT A pg-boss JOB, deliberately. That queue exists for replayable work carrying a quantized
 * `asOf` (src/lib/jobs.ts), and a DELETE of dead cache rows is neither — routing it there
 * would cost a queue, a dead-letter queue, a payload schema, a handler and a cron entry, and
 * would tie a security control's storage hygiene to the worker process being up.
 *
 * Wire this into cron (hourly):
 *   npm run db:cleanup-rate-limit-buckets
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";
import { purgeExpiredRateLimitBuckets } from "#src/middleware/rate-limit-store.js";

async function main(): Promise<void> {
  const removedCount = await purgeExpiredRateLimitBuckets();
  console.log(`Removed ${removedCount} expired rate-limit bucket(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Rate-limit bucket cleanup failed:", error);
    await pool.end();
    process.exit(1);
  });
