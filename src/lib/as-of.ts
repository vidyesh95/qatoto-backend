/**
 * Quantization of the reference instant every scheduled job runs against.
 *
 * R_AND_D_BACKEND_STRUCTURE.md §4c rule 3: "every job is a pure function of
 * `(data, asOf)`". Jobs take an explicit quantized instant, store it on every row they
 * write, and re-run to an identical result. `new Date()` read inside a job is therefore
 * not an input — it is a hidden source of divergence, and the whole point of this module
 * is that the caller quantizes ONCE at the job boundary and passes the result down.
 *
 * Two rules this file exists to enforce:
 *
 *   1. Truncation reads the calendar through `getUTC*` and rebuilds it through `Date.UTC`,
 *      NEVER through `getFullYear` / `getHours` / `Date.parse` of a zoneless string. Every
 *      table in this domain uses a plain `timestamp` (no zone), which node-postgres parses
 *      in the PROCESS's local zone. A worker on a non-UTC host that truncated with local
 *      getters would write `asOf` values a UTC host can never reproduce — the job would
 *      still "succeed", the rows would still look plausible, and the audit hash chain
 *      (§4c) covering them would silently stop matching. Nothing throws; the numbers just
 *      quietly disagree between two machines.
 *   2. No float, and no `Math.round` / `Math.floor`. Day arithmetic here is exact `bigint`
 *      arithmetic on epoch milliseconds, because the only interesting subtraction in this
 *      module is one whose remainder is provably zero — see
 *      `wholeDaysBetweenUtcDayStarts` for why that proof holds in UTC and would not hold
 *      in a project's local zone.
 *
 * Scope boundary worth stating out loud: a "UTC day" here is the JOB's reference day, not
 * a project's calendar day. `project_stats.projectTimeZone` (§6) exists precisely because
 * a streak must be folded in the team's own zone, where days are 23 or 25 hours long. Do
 * NOT reach for these functions to decide whether two daily logs fall on "the same day"
 * for a member — that is a different question with a different, DST-aware answer.
 */

/**
 * Milliseconds in every UTC day, without exception.
 *
 * This constant is only sound because of two facts that are easy to assume and wrong
 * elsewhere: UTC has no DST, so no UTC day is 23 or 25 hours long; and the Unix time value
 * JavaScript exposes ignores leap seconds, so a leap second does not add a 86,401st second
 * to the epoch count. In a named zone like `America/New_York` neither holds, and day
 * arithmetic there needs a calendar library and a documented rounding rule. In UTC it
 * needs neither.
 */
const MILLISECONDS_PER_UTC_DAY = 86_400_000n;

/**
 * Rebuilds a truncated `Date` whose year falls in 0–99 CE.
 *
 * `Date.UTC` treats a year argument of 0–99 as an offset from 1900 — `Date.UTC(50, 0, 1)`
 * is 1950, not the year 50. `getUTCFullYear` returns the literal year, so feeding one
 * straight into the other silently moves such an instant by 1,900 years and returns a
 * perfectly valid `Date` while doing it. No timestamp this domain generates lands there,
 * which is exactly why the trap would never be noticed if a corrupt or synthetic instant
 * ever did.
 *
 * The month and day-of-month MUST be re-applied in the same `setUTCFullYear` call rather
 * than left to survive from the `Date.UTC` result, because the 1900-offset remap can land
 * on a year whose LEAP RULE differs from the literal year's. Exactly one such year exists
 * in 0–99: year 0 is divisible by 400 and therefore a leap year, while its remap target
 * 1900 is divisible by 100 but not 400 and is NOT. `Date.UTC(0, 1, 29)` consequently
 * overflows to 1900-03-01, and a bare `setUTCFullYear(0)` then yields 0000-03-01 — a valid
 * `Date` on the WRONG CALENDAR DAY, silently, for an input (0000-02-29) that genuinely
 * exists. Passing month and day explicitly sets all three fields atomically against the
 * literal year, so no intermediate value has to be representable in the remap target.
 *
 * The mutation is local to an object this module just constructed — CLAUDE.md §3.4 bans
 * mutating INPUTS, not building a return value in two steps.
 */
function restoreLiteralUtcYear(
  truncatedInstant: Date,
  literalUtcYear: number,
  literalUtcMonthIndex: number,
  literalUtcDayOfMonth: number,
): Date {
  if (literalUtcYear >= 0 && literalUtcYear <= 99) {
    truncatedInstant.setUTCFullYear(literalUtcYear, literalUtcMonthIndex, literalUtcDayOfMonth);
  }
  return truncatedInstant;
}

/**
 * Rejects an Invalid Date before it can propagate as a silent NaN.
 *
 * `new Date("2026-13-45")` is a `Date` as far as the type system is concerned, and every
 * `getUTC*` call on it returns NaN, which `Date.UTC` happily turns into another Invalid
 * Date. The corruption would travel all the way into an `asOf` column as `null` or a
 * driver-level error thousands of rows later. Failing at the boundary is the only place
 * the stack trace still points at the caller who produced it.
 *
 * @throws if `instant` holds a non-finite time value — an unrecoverable programmer error
 *         (CLAUDE.md §3.3): a job's reference instant is constructed by us, never parsed
 *         from a request body, so an invalid one means broken code rather than bad input.
 */
function requireValidInstant(instant: Date, functionName: string, parameterName: string): number {
  const epochMilliseconds = instant.getTime();

  if (!Number.isFinite(epochMilliseconds)) {
    throw new Error(`${functionName}: ${parameterName} must be a valid Date, got Invalid Date`);
  }

  return epochMilliseconds;
}

/**
 * Truncates `instant` down to the start of its UTC day (00:00:00.000Z).
 *
 * "Down" is unconditional and never rounds: an instant one millisecond before midnight
 * belongs to the day that is ending, not the one about to begin. Rounding to the NEAREST
 * day would make a job's `asOf` depend on what time of night the scheduler happened to
 * fire, which is precisely the non-determinism §4c rule 3 removes.
 *
 * Returns a NEW `Date`; the input is never mutated. Callers routinely hold onto the
 * un-truncated instant for logging, and a truncation that mutated in place would rewrite
 * their copy too.
 *
 * @throws if `instant` is an Invalid Date (see `requireValidInstant`).
 */
export function truncateToUtcDayStart(instant: Date): Date {
  requireValidInstant(instant, "truncateToUtcDayStart", "instant");

  const literalUtcYear = instant.getUTCFullYear();
  const literalUtcMonthIndex = instant.getUTCMonth();
  const literalUtcDayOfMonth = instant.getUTCDate();
  const dayStart = new Date(Date.UTC(literalUtcYear, literalUtcMonthIndex, literalUtcDayOfMonth));

  return restoreLiteralUtcYear(
    dayStart,
    literalUtcYear,
    literalUtcMonthIndex,
    literalUtcDayOfMonth,
  );
}

/**
 * Truncates `instant` down to the start of its UTC hour (mm:ss.mmm zeroed).
 *
 * The hourly grain exists for jobs that run more often than daily — `sweep-dispute-windows`
 * and the ingest-side recomputes (§4e) — which still must not vary with the second the
 * scheduler fired. Same downward, never-rounding rule as `truncateToUtcDayStart`, for the
 * same reason.
 *
 * Deliberately built through `Date.UTC` rather than by subtracting `epochMs % 3_600_000`:
 * both are correct in UTC, but the `Date.UTC` form states the intent in calendar terms and
 * cannot be mistaken for something that would also work in a zone with sub-hour offsets
 * (India is UTC+05:30; Nepal is UTC+05:45).
 *
 * Returns a NEW `Date`; the input is never mutated.
 *
 * @throws if `instant` is an Invalid Date (see `requireValidInstant`).
 */
export function truncateToUtcHourStart(instant: Date): Date {
  requireValidInstant(instant, "truncateToUtcHourStart", "instant");

  const literalUtcYear = instant.getUTCFullYear();
  const literalUtcMonthIndex = instant.getUTCMonth();
  const literalUtcDayOfMonth = instant.getUTCDate();
  const hourStart = new Date(
    Date.UTC(literalUtcYear, literalUtcMonthIndex, literalUtcDayOfMonth, instant.getUTCHours()),
  );

  return restoreLiteralUtcYear(
    hourStart,
    literalUtcYear,
    literalUtcMonthIndex,
    literalUtcDayOfMonth,
  );
}

/**
 * Asserts that `instant` sits exactly on a UTC day boundary and returns its epoch ms.
 *
 * @throws if it does not — an unrecoverable programmer error (CLAUDE.md §3.3). Silently
 *         truncating a stray instant here would be worse than failing: the caller's two
 *         arguments are supposed to be day-quantized `asOf` values, so a non-boundary one
 *         means an un-quantized `new Date()` leaked into a job. Absorbing it would hide
 *         the leak and hand back a day count that a re-run computes differently.
 */
function requireUtcDayBoundary(instant: Date, parameterName: string): number {
  const epochMilliseconds = requireValidInstant(
    instant,
    "wholeDaysBetweenUtcDayStarts",
    parameterName,
  );

  if (BigInt(epochMilliseconds) % MILLISECONDS_PER_UTC_DAY !== 0n) {
    throw new Error(
      `wholeDaysBetweenUtcDayStarts: ${parameterName} must be exactly on a UTC day boundary, got ${instant.toISOString()}`,
    );
  }

  return epochMilliseconds;
}

/**
 * Counts whole days from `earlier` to `later`, both of which must already be UTC day starts.
 *
 * There is NO rounding rule in this function, and that absence is the entire argument for
 * quantizing in UTC rather than in a project's local zone. Both arguments are multiples of
 * 86,400,000 ms, so their difference is too, and the division has no remainder — nothing
 * ever has to decide whether 23.5 days is 23 or 24. Ask the same question in
 * `America/New_York` and a span crossing a spring-forward is 86,400,000 ms short of a whole
 * number of days, at which point the answer depends on a rounding convention that
 * TypeScript and Postgres would have to be made to agree on. Refusing non-boundary inputs
 * is what buys that exactness; it is a precondition, not a defensive nicety.
 *
 * The result is NEGATIVE when `later` precedes `earlier`, and zero when they are the same
 * day. That is deliberate — window-bound checks read more honestly as a signed offset than
 * as an absolute distance plus a separate direction flag — but it does mean a caller
 * treating the return value as a duration must check the sign itself. Exact `bigint`
 * division is used rather than `Math.floor`, which would round a negative span the wrong
 * way (`Math.floor(-1.0)` is fine, but the habit is what §4c bans).
 *
 * @throws if either argument is an Invalid Date, or is not exactly on a UTC day boundary
 *         (see `requireUtcDayBoundary`).
 */
export function wholeDaysBetweenUtcDayStarts(earlier: Date, later: Date): number {
  const earlierEpochMilliseconds = requireUtcDayBoundary(earlier, "earlier");
  const laterEpochMilliseconds = requireUtcDayBoundary(later, "later");

  const elapsedMilliseconds = BigInt(laterEpochMilliseconds) - BigInt(earlierEpochMilliseconds);

  // Exact by construction: both operands are multiples of MILLISECONDS_PER_UTC_DAY, so the
  // remainder is zero and BigInt's truncating `/` cannot bias the sign of the result.
  return Number(elapsedMilliseconds / MILLISECONDS_PER_UTC_DAY);
}
