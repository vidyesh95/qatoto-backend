/**
 * Daily off-peak sweep of dead handle reservations.
 *
 * A reservation is parked for 14 days when a user changes away from a handle, so
 * they can revert and nobody else can grab it in the meantime (see
 * src/modules/auth/handles/handle.service.ts). Once `expires_at < NOW()` the hold is dead:
 * lazy reads already treat it as available and the set transaction overwrites it,
 * so this sweep is purely housekeeping to keep the table small.
 *
 * Wire this into cron (e.g. once daily off-peak):
 *   npm run db:cleanup-handle-reservations
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";
import { purgeExpiredHandleReservations } from "#src/modules/auth/handles/handle.service.js";

async function main(): Promise<void> {
  const removedCount = await purgeExpiredHandleReservations();
  console.log(`Removed ${removedCount} expired handle reservation(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Handle reservation cleanup failed:", error);
    await pool.end();
    process.exit(1);
  });
