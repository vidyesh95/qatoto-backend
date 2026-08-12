/**
 * Bulk-expires stale pending applications and invites.
 *
 * CORRECTNESS DOES NOT DEPEND ON THIS SCRIPT. `status` is authoritative, every write
 * path already carries `AND (expires_at IS NULL OR expires_at > now())`, and
 * `POST /applications` self-heals by expiring the caller's own stale row before
 * inserting. So a missed run means rows sit in `pending` past their date — visibly
 * stale in a founder's queue, but never wrongly accepted.
 *
 * That is deliberate. The alternative — reporting "expired" on read while the row is
 * physically `pending` — collides with `project_application_live_role_unq`: the API
 * would tell a user their application expired, they would re-apply, and the INSERT
 * would 23505 against the row still sitting there.
 *
 * Wire into cron (hourly is plenty):
 *   pnpm db:expire-stale-project-requests
 */
import "dotenv/config";
import { pool } from "#src/db/index.js";
import { expireStaleRequests } from "#src/modules/rnd/projects/project-applications.service.js";

async function main(): Promise<void> {
  const { applications, invites } = await expireStaleRequests();

  if (applications === 0 && invites === 0) {
    console.log("No stale applications or invites. Nothing to do.");
    return;
  }

  console.log(`Expired ${applications} application(s) and ${invites} invite(s).`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Expiring stale project requests failed:", error);
    await pool.end();
    process.exit(1);
  });
