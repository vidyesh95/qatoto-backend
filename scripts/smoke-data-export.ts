/**
 * Proves the export path end to end against real object storage.
 *
 * Separate from `smoke-privacy.ts` because it needs Backblaze credentials and actually
 * uploads a file — and because the thing it proves is different: that the archive builds,
 * gzips, uploads, presigns, downloads, and un-gzips into the six categories the panel
 * claims. The account it creates is destroyed either way.
 *
 *   pnpm db:smoke-data-export
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { isObjectStorageConfigured } from "#src/lib/object-storage.js";
import {
  assembleDataExport,
  purgeDataExportsForUser,
  readLatestDataExport,
  requestDataExport,
} from "#src/modules/auth/privacy/data-export.service.js";

let failureCount = 0;
function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

async function main(): Promise<void> {
  if (!isObjectStorageConfigured()) {
    console.log("SKIP  object storage is not configured; nothing to prove.");
    return;
  }

  const id = `export-smoke-${randomUUID()}`;
  await db.insert(user).values({
    id,
    name: "Export Smoke",
    email: `${id}@privacy-smoke.invalid`,
    emailVerified: false,
    handle: `xsmoke_${id.slice(-10)}`,
  });

  try {
    const requested = await requestDataExport(id);
    check("export accepted", requested.success, JSON.stringify(requested));
    if (!requested.success) return;

    const second = await requestDataExport(id);
    check(
      "a second export is refused while one is in flight",
      !second.success && second.error.type === "EXPORT_ALREADY_IN_FLIGHT",
      second.success ? "it succeeded" : second.error.type,
    );

    await assembleDataExport(requested.value.requestId);

    const ready = await readLatestDataExport(id);
    check("the archive is ready", ready?.state === "ready", String(ready?.state));
    check(
      "a download link was minted",
      typeof ready?.downloadUrl === "string" && ready.downloadUrl.length > 0,
      ready?.downloadUrl ? `${ready.downloadUrl.slice(0, 60)}…` : "none",
    );
    check(
      "the archive has a size and an expiry",
      (ready?.byteSize ?? 0) > 0 && ready?.expiresAt != null,
      `${String(ready?.byteSize)} bytes, expires ${String(ready?.expiresAt)}`,
    );

    if (ready?.downloadUrl) {
      const response = await fetch(ready.downloadUrl);
      const downloaded = Buffer.from(await response.arrayBuffer());
      check("the link downloads", response.ok, `HTTP ${String(response.status)}`);

      // Parsed as `unknown` and NARROWED BY A CHECK, not asserted. The archive is our own
      // output, but it arrived over the network from object storage — and CLAUDE.md's rule
      // about never asserting a shape onto a payload does not have a "we wrote it" clause.
      const parsed: unknown = JSON.parse(gunzipSync(downloaded).toString("utf8"));
      const document: Record<string, unknown> =
        typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
      // Every top-level key `buildExportDocument` returns. This list had fallen behind by five
      // keys before schema 2 added `whatYouBought`, which is the failure it exists to catch.
      const expectedKeys = [
        "readme",
        "manifest",
        "whoYouAre",
        "yourChannelLinks",
        "yourVideoDocuments",
        "howYouSignIn",
        "whatYouDoHere",
        "howMuchYouWatch",
        "productPagesYouLookedAt",
        "supportYouAskedFor",
        "feedbackYouSent",
        "premiumAiAccess",
        "whatYouBought",
        "workYouHaveDone",
        "whatYouPublish",
        "settingsOnThisDevice",
      ];
      const missing = expectedKeys.filter((key) => !(key in document));
      check(
        "every promised category is present",
        missing.length === 0,
        missing.length === 0 ? expectedKeys.join(", ") : `missing: ${missing.join(", ")}`,
      );

      const serialized = JSON.stringify(document);
      /**
       * SNAKE_CASE, BECAUSE `db.execute` RETURNS RAW COLUMN NAMES. The first version of this
       * assertion looked for `"accessToken"`, which the export can never contain under any
       * circumstance — so half the guard was a no-op that would have stayed green if
       * somebody added `access_token` to the linked-accounts select.
       */
      const credentialColumns = [
        '"password"',
        '"access_token"',
        '"refresh_token"',
        '"id_token"',
        '"public_key"',
      ];
      const leaked = credentialColumns.filter((column) => serialized.includes(column));
      check(
        "no credential leaked into the archive",
        leaked.length === 0,
        leaked.length === 0
          ? `none of ${credentialColumns.join(", ")}`
          : `LEAKED: ${leaked.join(", ")}`,
      );

      /**
       * Schema 2's and schema 3's deliberate omissions, checked the same way: each is a column the
       * orders, cart, effort, receipt, pay and video sections must never select (see
       * `manifest.exclusions`).
       *
       * ⚠️ **AGAINST THIS FIXTURE THE CHECK IS VACUOUS, AND AN EARLIER VERSION OF THIS COMMENT SAID
       * OTHERWISE.** `db.execute` returns column names only as keys of the rows it returns, and the
       * fixture account owns no orders, receipts, ledger rows or videos — so an empty section
       * serializes as `[]` whether or not its SELECT names an excluded column. It catches a leak
       * only for an account that has rows in that section. Proving the property for every section
       * would need the fixture to own one row of each, which this smoke does not seed.
       */
      const excludedColumns = [
        '"counterparty_address_snapshot"',
        '"buyer_qualification_state"',
        '"buyer_qualification_reasons"',
        '"idempotency_key"',
        '"provider_payment_ref"',
        '"settlement_account_ref"',
        '"application_fee_in_cents"',
        '"encrypted_document_id"',
        '"override_reason"',
        '"overridden_by_user_id"',
        '"perceptual_hash"',
        '"device_fingerprint_hash"',
        '"stored_image_public_id"',
        '"generated_by_model"',
        '"prompt_version"',
        '"model_name"',
        '"proposed_by_user_id"',
        '"recorded_by_user_id"',
        '"video_asset_id"',
      ];
      const excludedLeaked = excludedColumns.filter((column) => serialized.includes(column));
      check(
        "no excluded order, payment, effort, receipt, pay or video column leaked",
        excludedLeaked.length === 0,
        excludedLeaked.length === 0
          ? `none of ${excludedColumns.length} columns`
          : `LEAKED: ${excludedLeaked.join(", ")}`,
      );
    }

    const purged = await purgeDataExportsForUser(id);
    check("the archive is purged on anonymization", purged >= 1, `${String(purged)} archive(s)`);
  } finally {
    await db.execute(sql`DELETE FROM data_export_request WHERE user_id = ${id}`);
    await db.execute(sql`DELETE FROM handle_reservations WHERE user_id = ${id}`);
    await db.delete(user).where(eq(user.id, id));
  }

  console.log(
    failureCount === 0 ? "\nAll data-export smoke assertions passed." : `\n${failureCount} FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    // THE SEND-ONLY pg-boss INSTANCE KEEPS ITS OWN POOL, and it is what left the first
    // version of this script hanging after every assertion had passed: `requestDataExport`
    // enqueues a job, which lazily starts that instance, which then holds the event loop
    // open long after `pool.end()`. Stopping it first is the whole fix.
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Data export smoke failed:", error);
    await stopSendOnlyBoss().catch(() => undefined);
    await pool.end();
    process.exit(1);
  });
