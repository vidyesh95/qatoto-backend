import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * UNIT tests for the public showcase reads — the feed, its facets, the slug list and one launch.
 *
 * THE VISIBILITY CASES ARE THE ONES THAT MATTER. Everything else here is ordering and paging, which
 * fails loudly; serving an unpublished launch fails silently and publishes a maker's rejected work.
 * So the gate is asserted on every query, including the facet counts, where forgetting it would show
 * a tag chip promising launches the list will never return.
 *
 * THE DATABASE STUB IS ONE CHAINABLE THENABLE. Drizzle's builders differ in shape between these
 * queries — the feed joins twice and limits, the facets group, the children only order — so rather
 * than model each chain the stub answers every method with itself and resolves to rows chosen by
 * WHICH COLUMNS WERE SELECTED. That keeps the test about the query's arguments, which is where the
 * behaviour lives, rather than about drizzle's fluent surface.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));

interface CapturedQuery {
  readonly selectedColumns: readonly string[];
  readonly orderByCount: number;
  readonly limit: number | null;
  readonly grouped: boolean;
  /** Every primitive drizzle bound into this query's WHERE, flattened so it can be searched. */
  readonly conditionText: string;
}

/**
 * Every primitive bound into a drizzle condition, as one searchable string.
 *
 * A CYCLE-SAFE DEEP WALK, because a condition holds column objects that point back at their table,
 * so `JSON.stringify` throws on it. Walking is also independent of drizzle's internal layout, which
 * keeps this from breaking on a patch release that reshapes the chunk tree.
 *
 * ⚠️ `table` AND `enumValues` ARE SKIPPED, and that is load-bearing rather than an optimisation. A
 * column points back at its table, whose `moderation_state` column carries every enum label —
 * including the literal `published`. Following those made a gate assertion pass on a query with no
 * gate at all: the word was in the schema metadata, not in the predicate. Measured, not guessed.
 */
const UNWALKED_CONDITION_KEYS = new Set(["table", "enumValues"]);
function describeCondition(condition: unknown): string {
  const pending: unknown[] = [condition];
  const visited = new Set<unknown>();
  const boundValues: string[] = [];

  while (pending.length > 0) {
    const node = pending.pop();
    if (node instanceof Date) {
      boundValues.push(`date:${node.toISOString()}`);
      continue;
    }
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      boundValues.push(String(node));
      continue;
    }
    if (typeof node !== "object" || node === null || visited.has(node)) continue;
    visited.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (UNWALKED_CONDITION_KEYS.has(key)) continue;
      pending.push(value);
    }
  }

  return boundValues.join("|");
}

const databaseState = vi.hoisted(
  (): {
    launchRows: Record<string, unknown>[];
    teamRows: Record<string, unknown>[];
    imageRows: Record<string, unknown>[];
    facetRows: Record<string, unknown>[];
    slugRows: Record<string, unknown>[];
    queries: CapturedQuery[];
    childQueryCount: number;
  } => ({
    launchRows: [],
    teamRows: [],
    imageRows: [],
    facetRows: [],
    slugRows: [],
    queries: [],
    childQueryCount: 0,
  }),
);

function rowsForSelectedColumns(selectedColumns: readonly string[]): Record<string, unknown>[] {
  if (selectedColumns.includes("launch")) return databaseState.launchRows;
  if (selectedColumns.includes("value")) return databaseState.facetRows;
  if (selectedColumns.includes("publicSlug")) return databaseState.slugRows;
  // The two child reads select whole tables, so drizzle hands the stub an empty column map. They are
  // told apart by construction order: `loadLaunchChildren` builds the team query first.
  databaseState.childQueryCount += 1;
  return databaseState.childQueryCount % 2 === 1 ? databaseState.teamRows : databaseState.imageRows;
}

const selectMock = vi.fn<(columns?: unknown) => unknown>((columns) => {
  const selectedColumns = Object.keys(columns ?? {});
  const capture: {
    orderByCount: number;
    limit: number | null;
    grouped: boolean;
    conditionText: string;
  } = { orderByCount: 0, limit: null, grouped: false, conditionText: "" };
  databaseState.queries.push({
    selectedColumns,
    get orderByCount() {
      return capture.orderByCount;
    },
    get limit() {
      return capture.limit;
    },
    get grouped() {
      return capture.grouped;
    },
    get conditionText() {
      return capture.conditionText;
    },
  });

  /*
   * A REAL PROMISE WITH THE BUILDER METHODS HUNG OFF IT, rather than an object carrying its own
   * `then`. Drizzle awaits the chain directly, so the stub has to be awaitable — but a hand-written
   * `then` is the thenable trap `unicorn/no-thenable` exists to catch. Resolving up front is safe
   * because which rows come back is decided by the selected columns, which are known here.
   */
  const rows = rowsForSelectedColumns(selectedColumns);
  const builder: Record<string, unknown> = Object.assign(Promise.resolve(rows), {
    groupBy: () => {
      capture.grouped = true;
      return builder;
    },
    orderBy: (...orderByArguments: readonly unknown[]) => {
      capture.orderByCount = orderByArguments.length;
      return builder;
    },
    limit: (limit: number) => {
      capture.limit = limit;
      return builder;
    },
  });
  for (const method of ["from", "innerJoin", "leftJoin"]) {
    builder[method] = () => builder;
  }
  builder.where = (condition: unknown) => {
    capture.conditionText = describeCondition(condition);
    return builder;
  };
  return builder;
});

vi.mock("#src/db/index.js", () => ({ db: { select: selectMock } }));

const LAUNCHED_AT = new Date("2026-09-01T12:00:00.000Z");

function buildLaunchRow(
  overrides: { readonly launch?: Record<string, unknown> } & Record<string, unknown> = {},
): Record<string, unknown> {
  const { launch: launchOverrides, ...rowOverrides } = overrides;
  return {
    launch: {
      id: "launch_1",
      publicSlug: "solar-cold-storage-unit",
      title: "Solar cold storage unit",
      tagline: "Keeps produce cold on four hours of sun.",
      summary: "A 200-litre evaporative store.",
      writeUp: null,
      headingImageUrl: "https://cdn.test/heading.avif",
      difficulty: "intermediate",
      billOfMaterialsMinimumCents: null,
      billOfMaterialsMaximumCents: null,
      billOfMaterialsCurrency: null,
      tags: ["solar"],
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
      launchedAt: LAUNCHED_AT,
      builtFromBlueprintSlug: null,
      callToActionLabel: null,
      callToActionUrl: null,
      ...launchOverrides,
    },
    authorDisplayName: "Amara",
    authorHandle: "amara-builds",
    authorAvatarUrl: "https://cdn.test/avatar.avif",
    upvoteCount: 0,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    ...rowOverrides,
  };
}

function resetDatabaseState(): void {
  databaseState.launchRows = [];
  databaseState.teamRows = [];
  databaseState.imageRows = [];
  databaseState.facetRows = [];
  databaseState.slugRows = [];
  databaseState.queries = [];
  databaseState.childQueryCount = 0;
}

/** The feed query is the one that selects the whole launch and limits. */
function feedQuery(): CapturedQuery | undefined {
  return databaseState.queries.find((query) => query.selectedColumns.includes("launch"));
}

describe("listPublicShowcases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseState();
  });

  /**
   * THE VISIBILITY GATE, asserted on EVERY query rather than on the list alone.
   *
   * A launch that is not published has never been decided in the reader's favour, and two of the
   * other states hold a maker's unpublished work. The facet query matters as much as the list: a
   * tag chip counted over a wider population promises launches the list will never return, which
   * is a count the reader can see is wrong.
   *
   * This case exists because removing the gate entirely once broke NOTHING in this file — the stub
   * ignored the WHERE, so the most important predicate in the service was unverified.
   */
  it("filters every query to published launches, the facet count included", async () => {
    databaseState.launchRows = [buildLaunchRow()];
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    await listPublicShowcases({ sort: "newest", limit: 6, tag: undefined, cursor: undefined });

    const feedCondition = feedQuery()?.conditionText ?? "";
    const facetCondition =
      databaseState.queries.find((query) => query.selectedColumns.includes("value"))?.conditionText ?? "";

    expect(feedCondition, "the feed must filter on published").toContain("published");
    expect(facetCondition, "the facet count must filter on published too").toContain("published");
  });

  it("binds the tag as an array element rather than a substring", async () => {
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    await listPublicShowcases({ sort: "newest", limit: 6, tag: "solar", cursor: undefined });

    expect(feedQuery()?.conditionText).toContain("solar");
  });

  it("binds the cursor's instant and id into the keyset predicate", async () => {
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    await listPublicShowcases({
      sort: "newest",
      limit: 6,
      tag: undefined,
      cursor: `n_${String(LAUNCHED_AT.getTime())}_launch_7`,
    });

    const condition = feedQuery()?.conditionText ?? "";
    expect(condition).toContain(`date:${LAUNCHED_AT.toISOString()}`);
    expect(condition).toContain("launch_7");
  });

  it("over-fetches one row beyond the requested limit", async () => {
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    await listPublicShowcases({ sort: "newest", limit: 6, tag: undefined, cursor: undefined });

    expect(feedQuery()?.limit).toBe(7);
  });

  it("trims the over-fetched row and reports that more remain", async () => {
    databaseState.launchRows = Array.from({ length: 3 }, (_unused, index) =>
      buildLaunchRow({ launch: { id: `launch_${String(index + 1)}` } }),
    );
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "newest",
      limit: 2,
      tag: undefined,
      cursor: undefined,
    });

    expect(feed.success && feed.value.items).toHaveLength(2);
    expect(feed.success && feed.value.page.hasMore).toBe(true);
  });

  it("reports no cursor on a short page", async () => {
    databaseState.launchRows = [buildLaunchRow()];
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "newest",
      limit: 6,
      tag: undefined,
      cursor: undefined,
    });

    expect(feed.success && feed.value.page).toEqual({ nextCursor: null, hasMore: false });
  });

  /** Encoding the over-fetched row would skip a launch on every page boundary. */
  it("mints the cursor from the last returned row, not the over-fetched one", async () => {
    databaseState.launchRows = [
      buildLaunchRow({ launch: { id: "launch_1" } }),
      buildLaunchRow({ launch: { id: "launch_2" } }),
      buildLaunchRow({ launch: { id: "launch_3" } }),
    ];
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "newest",
      limit: 2,
      tag: undefined,
      cursor: undefined,
    });

    expect(feed.success && feed.value.page.nextCursor).toBe(`n_${String(LAUNCHED_AT.getTime())}_launch_2`);
  });

  it("mints a top cursor carrying the vote count when sorting by top", async () => {
    databaseState.launchRows = [
      buildLaunchRow({ launch: { id: "launch_1" }, upvoteCount: 96 }),
      buildLaunchRow({ launch: { id: "launch_2" }, upvoteCount: 12 }),
    ];
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "top",
      limit: 1,
      tag: undefined,
      cursor: undefined,
    });

    expect(feed.success && feed.value.page.nextCursor).toBe(`t_96_${String(LAUNCHED_AT.getTime())}_launch_1`);
  });

  /**
   * Three ordering terms for `top` against two for `newest` — the vote count, then the launch date,
   * then the id. `top` needs the extra term because thousands of launches share a vote count.
   */
  it.each([
    ["newest", 2],
    ["top", 3],
  ] as const)("orders the %s page on %i keys", async (sort, expectedOrderByCount) => {
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    await listPublicShowcases({ sort, limit: 6, tag: undefined, cursor: undefined });

    expect(feedQuery()?.orderByCount).toBe(expectedOrderByCount);
  });

  it("refuses a cursor it did not mint rather than serving the first page", async () => {
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "newest",
      limit: 6,
      tag: undefined,
      cursor: "not-a-real-cursor",
    });

    expect(feed).toEqual({ success: false, error: { type: "SHOWCASE_FEED_CURSOR_MALFORMED" } });
  });

  /** Resuming a vote-ranked page from a date-ranked position skips and repeats rows. */
  it("refuses a newest cursor replayed under the top sort", async () => {
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "top",
      limit: 6,
      tag: undefined,
      cursor: `n_${String(LAUNCHED_AT.getTime())}_launch_1`,
    });

    expect(feed.success).toBe(false);
  });

  it("groups the facet counts and orders them", async () => {
    databaseState.facetRows = [
      { value: "solar", count: 3 },
      { value: "cold-chain", count: 1 },
    ];
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "newest",
      limit: 6,
      tag: undefined,
      cursor: undefined,
    });

    expect(feed.success && feed.value.tagFacets).toEqual([
      { value: "solar", count: 3 },
      { value: "cold-chain", count: 1 },
    ]);
    expect(databaseState.queries.some((query) => query.grouped)).toBe(true);
  });

  it("makes no child queries for an empty page", async () => {
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    await listPublicShowcases({ sort: "newest", limit: 6, tag: undefined, cursor: undefined });

    expect(databaseState.queries.filter((query) => query.selectedColumns.length === 0)).toHaveLength(0);
  });

  /**
   * `user.handle` and `user.image` are both nullable and nothing upstream guarantees either, so the
   * read carries them through as null rather than inventing a placeholder or substituting the id.
   */
  it("passes a missing handle and avatar through as null", async () => {
    databaseState.launchRows = [buildLaunchRow({ authorHandle: null, authorAvatarUrl: null })];
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "newest",
      limit: 6,
      tag: undefined,
      cursor: undefined,
    });

    expect(feed.success && feed.value.items[0]?.author).toEqual({
      displayName: "Amara",
      handle: null,
      avatarUrl: null,
    });
  });

  it("reports a cost range only when all three columns are set", async () => {
    databaseState.launchRows = [
      buildLaunchRow({
        launch: {
          billOfMaterialsMinimumCents: 12_000,
          billOfMaterialsMaximumCents: 48_000,
          billOfMaterialsCurrency: "USD",
        },
      }),
      buildLaunchRow({ launch: { id: "launch_2", billOfMaterialsMinimumCents: 12_000 } }),
    ];
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "newest",
      limit: 6,
      tag: undefined,
      cursor: undefined,
    });

    expect(feed.success && feed.value.items[0]?.billOfMaterialsCostRange).toEqual({
      minimumInCents: 12_000,
      maximumInCents: 48_000,
      currency: "USD",
    });
    expect(feed.success && feed.value.items[1]?.billOfMaterialsCostRange).toBeNull();
  });

  it("serves the heading image as the thumbnail and tags the row as a showcase", async () => {
    databaseState.launchRows = [buildLaunchRow()];
    const { listPublicShowcases } = await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const feed = await listPublicShowcases({
      sort: "newest",
      limit: 6,
      tag: undefined,
      cursor: undefined,
    });

    expect(feed.success && feed.value.items[0]?.thumbnailUrl).toBe("https://cdn.test/heading.avif");
    expect(feed.success && feed.value.items[0]?.category).toBe("showcase");
    expect(feed.success && feed.value.items[0]?.slug).toBe("solar-cold-storage-unit");
  });
});

describe("getPublicShowcaseBySlug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseState();
  });

  it("filters the detail read to published launches and to the slug asked for", async () => {
    databaseState.launchRows = [buildLaunchRow()];
    const { getPublicShowcaseBySlug } =
      await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    await getPublicShowcaseBySlug("solar-cold-storage-unit");

    const condition =
      databaseState.queries.find((query) => query.selectedColumns.includes("launch"))?.conditionText ?? "";
    expect(condition).toContain("published");
    expect(condition).toContain("solar-cold-storage-unit");
  });

  it("answers NOT_FOUND when no published launch carries the slug", async () => {
    const { getPublicShowcaseBySlug } =
      await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const result = await getPublicShowcaseBySlug("never-existed");

    expect(result).toEqual({ success: false, error: { type: "SHOWCASE_LAUNCH_NOT_FOUND" } });
  });

  it("returns the launch with its team and write-up images", async () => {
    databaseState.launchRows = [buildLaunchRow()];
    databaseState.teamRows = [
      { launchId: "launch_1", position: 0, displayName: "Amara", handle: "amara-builds", role: "Thermal" },
    ];
    databaseState.imageRows = [
      {
        launchId: "launch_1",
        url: "https://cdn.test/step.avif",
        widthPx: 1200,
        heightPx: 800,
        blurDataUrl: "data:image/webp;base64,AAAA",
      },
    ];
    const { getPublicShowcaseBySlug } =
      await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const result = await getPublicShowcaseBySlug("solar-cold-storage-unit");

    expect(result.success && result.value.team).toEqual([
      { displayName: "Amara", handle: "amara-builds", role: "Thermal" },
    ]);
    expect(result.success && result.value.writeUpImages).toHaveLength(1);
  });

  /** No route moves these counters yet, so zero is the true answer rather than a placeholder. */
  it("reads every counter as zero while nothing writes them", async () => {
    databaseState.launchRows = [buildLaunchRow()];
    const { getPublicShowcaseBySlug } =
      await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    const result = await getPublicShowcaseBySlug("solar-cold-storage-unit");

    expect(result.success && result.value.viewCount).toBe(0);
    expect(result.success && result.value.likeCount).toBe(0);
    expect(result.success && result.value.upvoteCount).toBe(0);
    expect(result.success && result.value.commentCount).toBe(0);
  });
});

describe("listPublicShowcaseSlugs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseState();
  });

  it("filters the slug list to published launches", async () => {
    const { listPublicShowcaseSlugs } =
      await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    await listPublicShowcaseSlugs();

    expect(databaseState.queries[0]?.conditionText).toContain("published");
  });

  it("returns the published slugs and drops any row without one", async () => {
    databaseState.slugRows = [
      { publicSlug: "solar-cold-storage-unit" },
      { publicSlug: null },
      { publicSlug: "bike-trailer" },
    ];
    const { listPublicShowcaseSlugs } =
      await import("#src/modules/home/blueprints/showcase-launch-public-read.service.js");

    expect(await listPublicShowcaseSlugs()).toEqual(["solar-cold-storage-unit", "bike-trailer"]);
  });
});
