/**
 * Exercises the Postgres rate-limit store against a REAL database
 * (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 7).
 *
 * WHY A SCRIPT AND NOT A TEST — the reason the other seven `db:verify-*` scripts give: the
 * vitest suite mocks `#src/db/index.js` wholesale, so `rate-limit-store.test.ts` can prove
 * things about TypeScript and nothing about Postgres. And the claims that matter here are
 * exactly the ones TypeScript cannot make:
 *
 *   * concurrent increments on one bucket do not lose updates (the row lock),
 *   * an expired bucket ROLLS rather than accumulating (the CASE arms),
 *   * `expires_at` survives the round trip through a `timestamp without time zone` column
 *     and the OID-1114 parser in src/db/index.ts still reading it as UTC,
 *   * an oversized key does not blow the btree index row limit.
 *
 * A store whose SQL has never run is not a store worth shipping. The limiters are the
 * signup and credential-stuffing defenses, so "it typechecked" is not the bar.
 *
 * Writes and then removes its own rows under a probe namespace; touches nothing else.
 *
 *   pnpm db:verify-rate-limit-store
 *
 * Exits non-zero if any guarantee is missing, so it can gate a deploy.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { rateLimitBucket } from "#src/db/schema.js";
import {
  PostgresRateLimitStore,
  purgeExpiredRateLimitBuckets,
} from "#src/middleware/rate-limit-store.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const PROBE_NAMESPACE = "__verifyProbe";
const WINDOW_MS = 60_000;

function buildProbeStore(): PostgresRateLimitStore {
  // Constructed directly rather than through `createRateLimitStore`, which would refuse the
  // namespace on a second run in the same process and returns undefined outside production.
  const store = new PostgresRateLimitStore(PROBE_NAMESPACE, WINDOW_MS);
  store.init({ windowMs: WINDOW_MS });
  return store;
}

async function clearProbeRows(): Promise<void> {
  await db.execute(sql`DELETE FROM ${rateLimitBucket} WHERE namespace = ${PROBE_NAMESPACE}`);
}

async function readProbeRow(
  bucketKey: string,
): Promise<{ hit_count: number; expires_at: Date } | undefined> {
  const result = await db.execute<{ hit_count: number; expires_at: Date }>(sql`
    SELECT hit_count, expires_at FROM ${rateLimitBucket}
    WHERE namespace = ${PROBE_NAMESPACE} AND bucket_key = ${bucketKey}
  `);
  return result.rows[0];
}

async function checkCounting(outcomes: CheckOutcome[]): Promise<void> {
  const store = buildProbeStore();
  await clearProbeRows();

  const first = await store.increment("counting");
  const second = await store.increment("counting");
  const third = await store.increment("counting");

  outcomes.push({
    label: "sequential increments count up from 1",
    passed: first.totalHits === 1 && second.totalHits === 2 && third.totalHits === 3,
    detail: `${String(first.totalHits)}, ${String(second.totalHits)}, ${String(third.totalHits)}`,
  });

  const resetTimeIsStable =
    first.resetTime !== undefined &&
    third.resetTime !== undefined &&
    first.resetTime.getTime() === third.resetTime.getTime();
  outcomes.push({
    label: "the window does NOT slide forward on every hit",
    passed: resetTimeIsStable,
    detail: resetTimeIsStable
      ? "resetTime held across three hits"
      : "resetTime moved — a sliding window never closes and the limit never applies",
  });

  // The UTC round trip: written by Postgres as `now() AT TIME ZONE 'UTC'`, stored in a
  // `timestamp without time zone`, read back through the OID-1114 parser. An hour out here
  // means the parser and the writer disagree and every window is wrong by the offset.
  const expectedExpiry = Date.now() + WINDOW_MS;
  const skewMs =
    first.resetTime === undefined
      ? Number.NaN
      : Math.abs(first.resetTime.getTime() - expectedExpiry);
  outcomes.push({
    label: "expires_at survives the UTC round trip",
    passed: skewMs < 5_000,
    detail: Number.isNaN(skewMs)
      ? "no resetTime returned"
      : `${String(Math.round(skewMs))}ms from expected`,
  });
}

async function checkWindowRollover(outcomes: CheckOutcome[]): Promise<void> {
  const store = buildProbeStore();
  await clearProbeRows();

  // A bucket whose window closed a minute ago, as if the caller went quiet and came back.
  await db.execute(sql`
    INSERT INTO ${rateLimitBucket} (namespace, bucket_key, hit_count, expires_at)
    VALUES (${PROBE_NAMESPACE}, 'rollover', 99, (now() AT TIME ZONE 'UTC') - interval '1 minute')
  `);

  const rolled = await store.increment("rollover");
  const movedForward = rolled.resetTime !== undefined && rolled.resetTime.getTime() > Date.now();

  outcomes.push({
    label: "an expired bucket RESTARTS at 1 rather than resuming at 100",
    passed: rolled.totalHits === 1,
    detail: `totalHits ${String(rolled.totalHits)} — 100 would mean a caller is locked out forever`,
  });
  outcomes.push({
    label: "the rolled bucket gets a fresh expiry",
    passed: movedForward,
    detail: movedForward ? "expires in the future" : "expiry stayed in the past",
  });
}

async function checkConcurrency(outcomes: CheckOutcome[]): Promise<void> {
  const store = buildProbeStore();
  await clearProbeRows();

  // The claim the row lock makes. A read-modify-write store would land well under 20 here,
  // and every lost update is a request that spent nobody's budget.
  const attempts = 20;
  await Promise.all(Array.from({ length: attempts }, async () => store.increment("concurrent")));

  const row = await readProbeRow("concurrent");
  outcomes.push({
    label: "20 concurrent increments land on exactly 20",
    passed: row?.hit_count === attempts,
    detail: `hit_count ${String(row?.hit_count ?? "missing")} of ${String(attempts)}`,
  });
}

async function checkOversizedKey(outcomes: CheckOutcome[]): Promise<void> {
  const store = buildProbeStore();
  await clearProbeRows();

  // `emailKey` reads an unbounded body field before any validation runs, so this is the
  // attacker-triggerable case. Unhashed it raises 54000, "index row size exceeds btree
  // maximum", and takes the OTP route down.
  const oversizedKey = `${"a".repeat(5000)}@example.com`;
  try {
    const result = await store.increment(oversizedKey);
    outcomes.push({
      label: "a 5,000-character key is accepted, not a btree failure",
      passed: result.totalHits === 1,
      detail: `totalHits ${String(result.totalHits)}`,
    });
  } catch (error) {
    outcomes.push({
      label: "a 5,000-character key is accepted, not a btree failure",
      passed: false,
      detail: `threw: ${String(error)}`,
    });
  }
}

async function checkResetAndPurge(outcomes: CheckOutcome[]): Promise<void> {
  const store = buildProbeStore();
  await clearProbeRows();

  await store.increment("resettable");
  await store.resetKey("resettable");
  outcomes.push({
    label: "resetKey removes the bucket",
    passed: (await readProbeRow("resettable")) === undefined,
    detail: "the row is gone",
  });

  await store.increment("one");
  await store.increment("two");
  await store.resetAll();
  const remaining = await db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM ${rateLimitBucket} WHERE namespace = ${PROBE_NAMESPACE}
  `);
  outcomes.push({
    label: "resetAll clears this namespace",
    passed: Number(remaining.rows[0]?.n ?? -1) === 0,
    detail: `${remaining.rows[0]?.n ?? "?"} row(s) left`,
  });

  // The sweep's grace period: a row that expired one minute ago must SURVIVE, because the
  // request path may still be contending for it; one that expired two hours ago must not.
  await db.execute(sql`
    INSERT INTO ${rateLimitBucket} (namespace, bucket_key, hit_count, expires_at) VALUES
      (${PROBE_NAMESPACE}, 'recentlyExpired', 1, (now() AT TIME ZONE 'UTC') - interval '1 minute'),
      (${PROBE_NAMESPACE}, 'longExpired',     1, (now() AT TIME ZONE 'UTC') - interval '2 hours')
  `);
  await purgeExpiredRateLimitBuckets();

  outcomes.push({
    label: "the sweep takes long-dead rows and spares recently-expired ones",
    passed:
      (await readProbeRow("longExpired")) === undefined &&
      (await readProbeRow("recentlyExpired")) !== undefined,
    detail: "one-hour grace period holds",
  });
}

async function main(): Promise<void> {
  const outcomes: CheckOutcome[] = [];

  try {
    await checkCounting(outcomes);
    await checkWindowRollover(outcomes);
    await checkConcurrency(outcomes);
    await checkOversizedKey(outcomes);
    await checkResetAndPurge(outcomes);
  } finally {
    await clearProbeRows();
  }

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(outcomes.length)} rate-limit store guarantees hold.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} guarantees are MISSING.`,
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await pool.end();
    // Deliberately NOT process.exit(0) — the exit code is set above, and forcing it here
    // would truncate a pending stdout flush. Same tail as the other verify-* scripts.
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Rate-limit store verification failed:", error);
    await pool.end();
    process.exit(1);
  });
