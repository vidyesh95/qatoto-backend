import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { type ClientRateLimitInfo, type Options, type Store } from "express-rate-limit";

import { isRateLimitStoreShared } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { rateLimitBucket } from "#src/db/schema.js";
import { errorFields, logger } from "#src/lib/logger.js";

/**
 * A rate-limit store every API instance shares (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 7).
 *
 * WHAT WAS WRONG. All 36 limiters used express-rate-limit's default in-process MemoryStore.
 * With more than one instance that is not a bound — an attacker who can reach a second
 * instance gets a second budget — and the counters reset on every restart, so each deploy
 * issued a fresh OTP and credential-stuffing allowance. §11l.2 recorded only the first half.
 *
 * WHY HAND-WRITTEN rather than `rate-limit-postgresql`. That package opens its own pool and
 * creates its own schema outside the migration chain. src/db/index.ts records that the
 * managed instance reports `max_connections = 20` FOR THE WHOLE SERVER, so a second pool
 * converts an invisible in-pool wait into "sorry, too many clients already"; and DDL outside
 * `drizzle-kit migrate` breaks the invariant that the migrations describe the database. This
 * store shares the existing `db` — one query on an already-DB-bound request, zero new sockets.
 *
 * ONE INSTANCE PER LIMITER, NOT ONE SHARED OBJECT. express-rate-limit throws
 * `ERR_ERL_STORE_REUSE` if the same store object is handed to two limiters. Each instance
 * therefore carries its own `namespace`, which is also what keeps 36 limiters' buckets apart,
 * and its own `prefix`, which is what stops the library's double-count check from firing when
 * `/signup/start`'s two stacked limiters produce the same key string from an IP and an email.
 */

/**
 * Long enough for a uuid, an IPv6 /56 or any real email; short enough to stay well inside a
 * btree index row (~2704 bytes). `rate_limit_bucket_key_ck` asserts it in the database.
 */
const MAXIMUM_BUCKET_KEY_LENGTH = 256;

/**
 * How long a DB failure keeps the whole process on the memory fallback.
 *
 * NOT A TUNING KNOB — a correctness requirement. src/db/index.ts sets
 * `connectionTimeoutMillis: 10000`, so under pool exhaustion a bare try/catch would add ten
 * seconds to EVERY rate-limited request and the limiter would become the outage. Retrying at
 * most once every five seconds bounds that to one slow request per window.
 */
const DEGRADED_MODE_DURATION_MS = 5_000;

/**
 * Process-wide, not per-store: all 36 instances share one connection pool, so a failure in
 * any of them is evidence about all of them and there is no point in each rediscovering it.
 */
let degradedUntilEpochMs = 0;

/** Namespaces already claimed, so a copy-pasted one fails at boot rather than silently. */
const claimedNamespaces = new Set<string>();

/**
 * The per-process fallback used while the database is unreachable.
 *
 * HAND-ROLLED RATHER THAN express-rate-limit's `MemoryStore`, for one reason: `MemoryStore`
 * is initialized from a full `Options` object, and this store only ever learns `windowMs`.
 * Reaching for the library's store would mean either fabricating twenty option fields or
 * asserting a partial one through `as`, which CLAUDE.md §2 bans outright. Twenty lines of
 * Map is cheaper than either, and it is the same accounting.
 */
class InMemoryBuckets {
  private readonly buckets = new Map<string, { hitCount: number; expiresAtEpochMs: number }>();

  increment(key: string, windowMs: number): ClientRateLimitInfo {
    const now = Date.now();
    const existing = this.buckets.get(key);
    // An expired bucket ROLLS rather than resuming, matching the SQL's CASE arms.
    const bucket =
      existing && existing.expiresAtEpochMs > now
        ? { hitCount: existing.hitCount + 1, expiresAtEpochMs: existing.expiresAtEpochMs }
        : { hitCount: 1, expiresAtEpochMs: now + windowMs };

    this.buckets.set(key, bucket);
    return { totalHits: bucket.hitCount, resetTime: new Date(bucket.expiresAtEpochMs) };
  }

  decrement(key: string): void {
    const existing = this.buckets.get(key);
    if (existing && existing.expiresAtEpochMs > Date.now()) {
      this.buckets.set(key, { ...existing, hitCount: Math.max(existing.hitCount - 1, 0) });
    }
  }

  resetKey(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }
}

export interface RateLimitStoreRegistration {
  readonly namespace: string;
  readonly storeKind: "postgres" | "memory";
}

/**
 * Every limiter built through `createLimiter`, in declaration order.
 *
 * Exists so a test can assert that the number of exported limiters equals the number of
 * registrations — an inline `rateLimit({ … })` added later raises the first count and not the
 * second, which is the only way to catch a limiter that quietly skipped the shared store.
 */
const registrations: RateLimitStoreRegistration[] = [];

export function rateLimitStoreRegistrations(): readonly RateLimitStoreRegistration[] {
  return registrations;
}

/**
 * Bounds the key length before it can reach a btree.
 *
 * `emailKey` reads `req.body.email` with no cap and runs BEFORE the controller validates
 * anything, so an oversized key is attacker-triggerable on the OTP path. Hashing is
 * deterministic, so the same caller keeps the same bucket.
 */
export function normalizeBucketKey(rawKey: string): string {
  if (rawKey.length <= MAXIMUM_BUCKET_KEY_LENGTH) return rawKey;
  return `sha256:${createHash("sha256").update(rawKey).digest("hex")}`;
}

/**
 * `now()` is `timestamptz`; assigning it to a `timestamp without time zone` column casts it
 * through the SESSION TimeZone, which this repo asserts for the Node process
 * (src/config/index.ts) but never for the database session. `AT TIME ZONE 'UTC'` pins it
 * regardless, which is what the OID-1114 parser in src/db/index.ts assumes on the way back.
 *
 * Postgres time rather than a JS `Date` for a second reason: a shared store needs a shared
 * clock. Two instances with skewed clocks would disagree about whether a window had rolled.
 */
const nowUtc = sql`(now() AT TIME ZONE 'UTC')`;

export class PostgresRateLimitStore implements Store {
  /** A database is shared by definition; the library uses this for its double-count check. */
  readonly localKeys = false;
  readonly prefix: string;

  private windowMs: number;
  private readonly fallback = new InMemoryBuckets();

  constructor(
    private readonly namespace: string,
    windowMs: number,
  ) {
    this.windowMs = windowMs;
    this.prefix = `${namespace}:`;
  }

  /**
   * Takes only what it reads. Declaring the parameter as `Pick<Options, "windowMs">` still
   * satisfies `Store["init"]` — a function accepting less is usable where one accepting the
   * whole object is expected — and it lets a test call this without fabricating twenty
   * unrelated option fields or asserting a partial object through `as`.
   */
  init(options: Pick<Options, "windowMs">): void {
    // The limiter's own windowMs wins over the constructor's: `init` is what the library
    // considers authoritative, and the two differ only if a caller passed them separately.
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const bucketKey = normalizeBucketKey(key);
    if (this.isDegraded()) return this.fallback.increment(bucketKey, this.windowMs);

    try {
      // ONE statement, one round trip, atomic. `ON CONFLICT DO UPDATE` takes a row lock, so
      // concurrent increments on one bucket serialize and no update is lost — unlike
      // src/middleware/idempotency.ts, this needs no `isUniqueViolation` handling, because
      // `DO UPDATE` subsumes the 23505 case rather than raising it.
      //
      // The CASE arms are the window rollover: an expired bucket restarts at 1 with a fresh
      // expiry instead of needing a separate read, delete and insert.
      const [row] = await db
        .insert(rateLimitBucket)
        .values({
          namespace: this.namespace,
          bucketKey,
          hitCount: 1,
          expiresAt: sql`${nowUtc} + make_interval(secs => ${this.windowMs / 1000})`,
        })
        .onConflictDoUpdate({
          target: [rateLimitBucket.namespace, rateLimitBucket.bucketKey],
          set: {
            hitCount: sql`CASE WHEN ${rateLimitBucket.expiresAt} <= ${nowUtc} THEN 1 ELSE ${rateLimitBucket.hitCount} + 1 END`,
            expiresAt: sql`CASE WHEN ${rateLimitBucket.expiresAt} <= ${nowUtc} THEN excluded.expires_at ELSE ${rateLimitBucket.expiresAt} END`,
          },
        })
        .returning({
          hitCount: rateLimitBucket.hitCount,
          expiresAt: rateLimitBucket.expiresAt,
        });

      if (!row) throw new Error("rate_limit_bucket upsert returned no row");
      return { totalHits: row.hitCount, resetTime: row.expiresAt };
    } catch (error) {
      this.enterDegradedMode(error);
      return this.fallback.increment(bucketKey, this.windowMs);
    }
  }

  async decrement(key: string): Promise<void> {
    const bucketKey = normalizeBucketKey(key);
    if (this.isDegraded()) {
      this.fallback.decrement(bucketKey);
      return;
    }

    try {
      // Floored at zero, and scoped to a LIVE window: decrementing an expired bucket would
      // resurrect it with a stale expiry. Reached only via skipFailedRequests /
      // skipSuccessfulRequests, which no limiter sets today — but the library requires it.
      await db.execute(sql`
        UPDATE ${rateLimitBucket}
        SET hit_count = GREATEST(hit_count - 1, 0)
        WHERE namespace = ${this.namespace}
          AND bucket_key = ${bucketKey}
          AND expires_at > ${nowUtc}
      `);
    } catch (error) {
      this.enterDegradedMode(error);
      this.fallback.decrement(bucketKey);
    }
  }

  async resetKey(key: string): Promise<void> {
    const bucketKey = normalizeBucketKey(key);
    if (this.isDegraded()) {
      this.fallback.resetKey(bucketKey);
      return;
    }

    try {
      await db.execute(sql`
        DELETE FROM ${rateLimitBucket}
        WHERE namespace = ${this.namespace} AND bucket_key = ${bucketKey}
      `);
    } catch (error) {
      this.enterDegradedMode(error);
      this.fallback.resetKey(bucketKey);
    }
  }

  /** Scoped to this limiter — the instance IS the namespace, so this cannot reset a sibling. */
  async resetAll(): Promise<void> {
    await db.execute(sql`DELETE FROM ${rateLimitBucket} WHERE namespace = ${this.namespace}`);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const rows = await db.execute<{ hit_count: number; expires_at: Date }>(sql`
      SELECT hit_count, expires_at FROM ${rateLimitBucket}
      WHERE namespace = ${this.namespace}
        AND bucket_key = ${normalizeBucketKey(key)}
        AND expires_at > ${nowUtc}
    `);

    const row = rows.rows[0];
    return row ? { totalHits: row.hit_count, resetTime: row.expires_at } : undefined;
  }

  /**
   * Drops the fallback's buckets and nothing else. The pool belongs to src/db/index.ts and
   * outlives every limiter — ending it here would take the whole application's database with
   * it, which is why this does not touch it.
   */
  shutdown(): void {
    this.fallback.clear();
  }

  /** True while a recent failure says the database is not worth trying yet. */
  private isDegraded(): boolean {
    return Date.now() < degradedUntilEpochMs;
  }

  /**
   * FAIL-DEGRADED, which is neither fail-open nor fail-closed.
   *
   * Fail-closed (the library's default) turns a hiccup in a bookkeeping table into a 500 on
   * a request that would otherwise have succeeded — including every signup. Fail-open is
   * defensible for a TOTAL outage, since the request dies at its next query anyway, but not
   * for a partial one: a lock or a statement timeout on this one table would mean unbounded
   * OTP sends while the rest of the database is healthy, which is exactly what an attacker
   * would try to induce. Falling back to memory keeps the bound and merely makes it
   * per-process, which is what shipped before this change.
   */
  private enterDegradedMode(error: unknown): void {
    const wasHealthy = !this.isDegraded();
    degradedUntilEpochMs = Date.now() + DEGRADED_MODE_DURATION_MS;

    // On the TRANSITION only. Logging per request would turn a database blip into a second
    // incident in the log pipeline.
    if (wasHealthy) {
      logger.error("rate-limit store degraded to per-process memory", {
        namespace: this.namespace,
        degradedForMs: DEGRADED_MODE_DURATION_MS,
        ...errorFields(error),
      });
    }
  }
}

/**
 * The store for one limiter, or `undefined` in dev and test so the library builds its own
 * MemoryStore (see `isRateLimitStoreShared` for why those environments stay local).
 *
 * THROWS ON A DUPLICATE NAMESPACE, at module load. Two limiters sharing a namespace would
 * silently merge their buckets — a stricter limit on one route and a looser one on another,
 * both wrong — which is a worse bug than the one this file fixes and is invisible at runtime.
 */
export function createRateLimitStore(namespace: string, windowMs: number): Store | undefined {
  if (claimedNamespaces.has(namespace)) {
    throw new Error(
      `Duplicate rate-limit namespace "${namespace}" — two limiters would share one bucket.`,
    );
  }
  claimedNamespaces.add(namespace);
  registrations.push({ namespace, storeKind: isRateLimitStoreShared ? "postgres" : "memory" });

  return isRateLimitStoreShared ? new PostgresRateLimitStore(namespace, windowMs) : undefined;
}

/**
 * Deletes buckets whose window closed over an hour ago. Called by
 * `pnpm db:cleanup-rate-limit-buckets`.
 *
 * The grace period is deliberate: deleting a row that expired one second ago and deleting it
 * an hour later are semantically identical, because either way the next request opens a new
 * window — and the hour keeps the sweep off rows the request path is actively contending for.
 */
export async function purgeExpiredRateLimitBuckets(): Promise<number> {
  const deleted = await db
    .delete(rateLimitBucket)
    .where(sql`${rateLimitBucket.expiresAt} < ${nowUtc} - interval '1 hour'`)
    .returning({ namespace: rateLimitBucket.namespace });

  return deleted.length;
}

/** Test seam: lets a suite start from a known state rather than a previous case's failure. */
export function resetRateLimitStoreDegradation(): void {
  degradedUntilEpochMs = 0;
}
