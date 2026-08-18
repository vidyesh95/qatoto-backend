import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * §3.3a — the viewer's own watch-time read.
 *
 * WHAT THESE PIN, AND WHAT THEY DELIBERATELY DO NOT. The SQL itself is Postgres's business and is
 * covered by `db:verify-watch-metrics-constraints` against a real database; the vitest suite mocks
 * `#src/db/index.js` wholesale and could not evaluate a `date_trunc` if it wanted to. What lives in
 * TypeScript, and therefore here, is the MAPPING from driver rows to the response — and that layer
 * carries the two rules §3.3a states in prose and nothing else enforces:
 *
 *   1. `null` for an account with no rows, never `0`. Zero means "we watched you watch nothing".
 *   2. `thisYear` is the SUM of two disjoint sources — the hour table inside its 90-day retention
 *      and the daily rollup outside it. Dropping either half is invisible: the number stays
 *      plausible and just gets smaller.
 *
 * Every numeric column here arrives as a STRING. The aggregates are cast `::bigint`, and node-pg
 * hands bigint back as text to avoid a silent precision loss at 2^53 — so a missing `Number()`
 * would concatenate rather than add, and `"30" + "45"` is `"3045"` seconds of watching.
 */

interface ExecuteResult {
  readonly rows: readonly Record<string, unknown>[];
}

const executeMock = vi.fn<(query: unknown) => Promise<ExecuteResult>>();

vi.mock("#src/db/index.js", () => ({ db: { execute: executeMock } }));

const { getViewerWatchTime } = await import("#src/modules/home/engagement/watch-time.service.js");

/** The service issues exactly three statements, in this order: totals, daily series, histogram. */
function stubQueries(
  totalsRow: Record<string, unknown> | undefined,
  dailyRows: readonly Record<string, unknown>[] = [],
  hourRows: readonly Record<string, unknown>[] = [],
): void {
  executeMock
    .mockResolvedValueOnce({ rows: totalsRow === undefined ? [] : [totalsRow] })
    .mockResolvedValueOnce({ rows: dailyRows })
    .mockResolvedValueOnce({ rows: hourRows });
}

const EMPTY_HISTOGRAM = Array.from({ length: 24 }, (_unused, hour) => ({
  hour,
  watched_seconds: "0",
}));

describe("getViewerWatchTime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null totals — not zero — for an account with no rows at all", async () => {
    stubQueries(
      {
        today: null,
        this_week: null,
        this_month: null,
        this_year_recent: null,
        this_year_archived: null,
        has_any_row: false,
      },
      [],
      EMPTY_HISTOGRAM,
    );

    const watchTime = await getViewerWatchTime("usr_never_watched", "UTC");

    expect(watchTime.totals).toEqual({
      today: null,
      thisWeek: null,
      thisMonth: null,
      thisYear: null,
    });
  });

  it("returns a real zero for an account that has rows but watched nothing today", async () => {
    stubQueries(
      {
        today: null,
        this_week: "120",
        this_month: "120",
        this_year_recent: "120",
        this_year_archived: null,
        has_any_row: true,
      },
      [],
      EMPTY_HISTOGRAM,
    );

    const watchTime = await getViewerWatchTime("usr_quiet_today", "UTC");

    // The DISTINCTION this whole test file exists for: a null aggregate over an account that HAS
    // history is a genuine zero, and rendering it as "no data" would be a different claim.
    expect(watchTime.totals.today).toBe(0);
    expect(watchTime.totals.thisWeek).toBe(120);
  });

  it("sums both halves of the year across the retention boundary", async () => {
    stubQueries(
      {
        today: "30",
        this_week: "300",
        this_month: "1200",
        // Inside the 90-day hour table...
        this_year_recent: "1200",
        // ...and the part of the same year only the rollup still holds.
        this_year_archived: "4800",
        has_any_row: true,
      },
      [],
      EMPTY_HISTOGRAM,
    );

    const watchTime = await getViewerWatchTime("usr_long_history", "UTC");

    // 6000, not 1200 (rollup dropped), not 4800 (hour table dropped), and emphatically not the
    // string "12004800" that a missing Number() would produce.
    expect(watchTime.totals.thisYear).toBe(6000);
  });

  it("counts the archived half even when the hour table holds nothing for the year", async () => {
    stubQueries(
      {
        today: null,
        this_week: null,
        this_month: null,
        this_year_recent: null,
        this_year_archived: "9000",
        has_any_row: true,
      },
      [],
      EMPTY_HISTOGRAM,
    );

    // A viewer who watched in January and stopped: the hour table pruned their rows at 90 days,
    // and the rollup is the only thing left that can answer. Returning null here would tell them
    // the year never happened.
    expect((await getViewerWatchTime("usr_dormant", "UTC")).totals.thisYear).toBe(9000);
  });

  it("converts the driver's bigint strings to numbers in the series and the histogram", async () => {
    stubQueries(
      {
        today: "45",
        this_week: "45",
        this_month: "45",
        this_year_recent: "45",
        this_year_archived: null,
        has_any_row: true,
      },
      [
        { date: "2026-08-17", watched_seconds: "0" },
        { date: "2026-08-18", watched_seconds: "45" },
      ],
      EMPTY_HISTOGRAM.map((bucket) => (bucket.hour === 20 ? { hour: 20, watched_seconds: "45" } : bucket)),
    );

    const watchTime = await getViewerWatchTime("usr_one_sitting", "Asia/Kolkata");

    expect(watchTime.dailySeries).toEqual([
      { date: "2026-08-17", watchedSeconds: 0 },
      { date: "2026-08-18", watchedSeconds: 45 },
    ]);
    // Densified to 24 buckets by the SQL, so the shape is fixed regardless of what was watched.
    expect(watchTime.hourHistogram).toHaveLength(24);
    expect(watchTime.hourHistogram[20]).toBe(45);
    expect(watchTime.hourHistogram[3]).toBe(0);
  });

  it("reports the hour-detail retention so a surface need not restate 90", async () => {
    const { ACTIVITY_HOUR_RETENTION_DAYS } = await import("#src/lib/engagement-retention.js");
    stubQueries(
      {
        today: null,
        this_week: null,
        this_month: null,
        this_year_recent: null,
        this_year_archived: null,
        has_any_row: false,
      },
      [],
      EMPTY_HISTOGRAM,
    );

    const watchTime = await getViewerWatchTime("usr_never_watched", "UTC");

    expect(watchTime.hourDetailRetentionDays).toBe(ACTIVITY_HOUR_RETENTION_DAYS);
  });
});
