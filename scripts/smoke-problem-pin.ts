/**
 * Proves the reporter's coarse map pin survives the real write path (§19.1).
 *
 *   pnpm run db:smoke-problem-pin
 *
 * WHAT IT IS REALLY GUARDING is the server-side re-quantization in `createProblemSubmission`. The
 * browser rounds to ~110 m before sending, but CLAUDE.md §0 is explicit that a client-side check
 * "exists only for fast UX feedback" — a hostile client simply skips it and posts six decimals. The
 * defence is the second rounding on receipt, and that only exists against a real INSERT: a unit
 * test can check `quantizePublishedMicrodegrees` in isolation, but not that the service actually
 * calls it on the way to the column.
 *
 * It also pins down the three things the pin must NOT reach. `latitude_microdegrees` is the
 * clustering job's OUTPUT and `country_code` is the geography the opportunity score reads; a client
 * claim must land in neither, or §6 is broken. And `chooseSubmissionPoint` must prefer a nearby pin
 * while discarding a distant one, because a pin that disagrees with the geocode would centre a row
 * in one country while labelling it another.
 *
 * ⚠️ UNLIKE `smoke-scoped-checkout`, THIS ONE CLEANS UP AFTER ITSELF. `problem_submission` carries
 * no append-only trigger, so the row it writes is deleted before it exits — deliberately, because
 * a stray submission would be picked up by the clustering job and become a pin on the public map.
 * If the script dies between the insert and the delete, the id is printed above the failure.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { problemSubmission, researchCategory, user } from "#src/db/schema.js";
import { isIdentifiedUser } from "#src/middleware/require-identified-user.js";
import { CreateProblemReportSchema } from "#src/modules/rnd/discovery/problem-clusters.schemas.js";
import * as clustersService from "#src/modules/rnd/discovery/problem-clusters.service.js";
import { chooseSubmissionPoint } from "#src/modules/rnd/discovery/submission-point.js";

/**
 * DELIBERATELY OFF THE 1,000-MICRODEGREE GRID — 19.076543 / 72.877654 degrees.
 *
 * This is what a client that skipped the browser-side rounding posts. If it comes back out of the
 * database unchanged, the server-side defence is not running.
 */
const OFF_GRID_PIN = {
  approxLatitudeMicrodegrees: 19_076_543,
  approxLongitudeMicrodegrees: 72_877_654,
};
const EXPECTED_STORED_LATITUDE = 19_077_000;
const EXPECTED_STORED_LONGITUDE = 72_878_000;

/** A geocoded point ~4 km from the pin: inside the matcher, so the pin must win. */
const NEARBY_GEOCODE = { latitudeMicrodegrees: 19_040_000, longitudeMicrodegrees: 72_877_000 };
/** Delhi, ~1,150 km away: outside the matcher, so the geocode must win. */
const DISTANT_GEOCODE = { latitudeMicrodegrees: 28_600_000, longitudeMicrodegrees: 77_200_000 };

function check(label: string, passed: boolean, detail: string): boolean {
  console.log(`${passed ? "  ok  " : "  FAIL"}  ${label} — ${detail}`);
  return passed;
}

/** The route demands an IDENTIFIED account, so the smoke reports as one rather than any user row. */
async function findIdentifiedReporter(): Promise<string | null> {
  const candidates = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`coalesce(${user.isAnonymous}, false) = false`)
    .limit(25);

  for (const candidate of candidates) {
    if (await isIdentifiedUser(candidate.id)) return candidate.id;
  }
  return null;
}

async function main(): Promise<void> {
  let failures = 0;

  const reporterUserId = await findIdentifiedReporter();
  if (reporterUserId === null) {
    console.log("  FAIL  no identified user to report as — seed one first");
    await pool.end();
    return;
  }

  const [category] = await db
    .select({ id: researchCategory.id })
    .from(researchCategory)
    .where(eq(researchCategory.status, "approved"))
    .limit(1);
  if (!category) {
    console.log("  FAIL  no approved research_category to report against");
    await pool.end();
    return;
  }

  // 1. The wire contract. Half a pin is refused before anything is written.
  const halfPin = CreateProblemReportSchema.safeParse({
    title: "Smoke test — half a pin",
    categoryId: category.id,
    description:
      "A latitude with no longitude is a point that does not exist, and the only thing anyone could do with one is guess the other half.",
    locationText: "Mumbai, India",
    approxLatitudeMicrodegrees: OFF_GRID_PIN.approxLatitudeMicrodegrees,
  });
  if (
    !check("half a pin is refused by the request schema", !halfPin.success, "422 at the schema")
  ) {
    failures += 1;
  }

  const parsed = CreateProblemReportSchema.safeParse({
    title: "Smoke test — coarse pin write path",
    categoryId: category.id,
    description:
      "Temporary row written to verify the coarse pin end to end. It is deleted before this script exits.",
    locationText: "Mumbai, India",
    ...OFF_GRID_PIN,
  });
  if (!parsed.success) {
    console.log("  FAIL  the schema refused a whole pin —", JSON.stringify(parsed.error));
    await pool.end();
    return;
  }

  // 2. The real service: quantization and insert.
  const receipt = await clustersService.createProblemSubmission(reporterUserId, parsed.data);
  console.log(`  wrote submission ${receipt.submissionId} (deleted at the end of this run)`);

  try {
    const [row] = await db
      .select({
        approxLatitudeMicrodegrees: problemSubmission.approxLatitudeMicrodegrees,
        approxLongitudeMicrodegrees: problemSubmission.approxLongitudeMicrodegrees,
        latitudeMicrodegrees: problemSubmission.latitudeMicrodegrees,
        countryCode: problemSubmission.countryCode,
        regionId: problemSubmission.regionId,
      })
      .from(problemSubmission)
      .where(eq(problemSubmission.id, receipt.submissionId));
    if (!row) {
      console.log("  FAIL  the row was not found after insert");
      failures += 1;
    } else {
      if (
        !check(
          "an off-grid pin is re-quantized on receipt",
          row.approxLatitudeMicrodegrees === EXPECTED_STORED_LATITUDE &&
            row.approxLongitudeMicrodegrees === EXPECTED_STORED_LONGITUDE,
          `sent ${String(OFF_GRID_PIN.approxLatitudeMicrodegrees)}, stored ${String(row.approxLatitudeMicrodegrees)}`,
        )
      ) {
        failures += 1;
      }

      if (
        !check(
          "the pin does not reach the job's own coordinates",
          row.latitudeMicrodegrees === null,
          "latitude_microdegrees still NULL",
        )
      ) {
        failures += 1;
      }

      if (
        !check(
          "the pin does not reach the geography the score reads",
          row.countryCode === null && row.regionId === null,
          "country_code and region_id still NULL",
        )
      ) {
        failures += 1;
      }

      // 3. What the clustering job would do with the stored pin.
      const storedPin = {
        latitudeMicrodegrees: row.approxLatitudeMicrodegrees ?? 0,
        longitudeMicrodegrees: row.approxLongitudeMicrodegrees ?? 0,
      };
      if (
        !check(
          "a pin that agrees with the geocode is preferred",
          chooseSubmissionPoint(NEARBY_GEOCODE, storedPin) === storedPin,
          "4km apart",
        )
      ) {
        failures += 1;
      }
      if (
        !check(
          "a pin that disagrees is discarded",
          chooseSubmissionPoint(DISTANT_GEOCODE, storedPin) === DISTANT_GEOCODE,
          "Mumbai pin against a Delhi geocode",
        )
      ) {
        failures += 1;
      }
    }
  } finally {
    // 4. Always remove it: a stray submission would be clustered and become a public pin.
    await db.delete(problemSubmission).where(eq(problemSubmission.id, receipt.submissionId));
  }

  const remaining = await db
    .select({ id: problemSubmission.id })
    .from(problemSubmission)
    .where(eq(problemSubmission.id, receipt.submissionId));
  if (!check("the smoke row is removed", remaining.length === 0, "nothing left behind")) {
    failures += 1;
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${String(failures)} CHECK(S) FAILED`}`);
  await pool.end();
}

await main();
