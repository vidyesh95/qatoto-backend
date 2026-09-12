import { getTableName, is, Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * UNIT tests for the four public case-study reads.
 *
 * ⚠️ THE GATE IS WHAT THIS FILE IS FOR. Ordering and paging fail loudly; a gate fails silently and
 * publishes somebody's unreviewed or rejected work. So it is asserted POSITIVELY (this state is
 * admitted) and NEGATIVELY (this one is not) on every read — because "published is in the predicate"
 * passes just as happily on a gate that admits everything, which is how the showcase round's gate
 * went untested until deleting it broke nothing.
 *
 * THE WITHHELD COMPANY NAME IS *NOT* THIS FILE'S JOB. `case-study-withheld-name.test.ts` owns it and
 * proves it at the route level over raw bytes, which is the only layer where "no reader sees this"
 * is a real claim.
 *
 * THE DATABASE STUB dispatches rows by which TABLE a query reads and, where one table serves several
 * reads, by which columns it selected — and it PROJECTS to those columns, because a stub that
 * returned whole rows would make several of these assertions pass on code that never selected them.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));

interface CapturedQuery {
  readonly tableName: string;
  readonly selectedColumns: readonly string[];
  readonly conditionText: string;
  readonly orderByText: string;
  readonly limit: number | null;
}

/**
 * Every primitive bound into a drizzle expression, as one searchable string.
 *
 * A CYCLE-SAFE DEEP WALK, because a condition holds column objects that point back at their table,
 * so `JSON.stringify` throws on it.
 *
 * ⚠️ FOUR KEYS ARE SKIPPED, AND EACH ONE IS A NEGATIVE ASSERTION THAT WOULD OTHERWISE BE A LIE.
 * A column points back at its `table`, whose `moderation_state` column carries every `enumValues`
 * label; and `moderation_state` carries `.default("pending_review")`, which the walk finds as
 * `default` / `defaultValue`. So the string for a perfectly-gated query contains `published`,
 * `rejected` AND `pending_review` — the first two from the schema, the third from a column default
 * — and a `not.toContain("pending_review")` assertion fails on correct code while
 * `toContain("published")` passes on a query with NO GATE AT ALL.
 *
 * The teardown round hit this with `enumValues` and measured it. This round hit it again with the
 * column default, which is the same mistake wearing a different key: the walk must see the
 * PREDICATE and nothing the schema happens to hang off a column.
 */
const UNWALKED_CONDITION_KEYS = new Set(["table", "enumValues", "default", "defaultValue"]);
function describeExpression(expression: unknown): string {
  const pending: unknown[] = [expression];
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

interface QueryBuilderStub extends Promise<Record<string, unknown>[]> {
  from: (table: unknown) => QueryBuilderStub;
  innerJoin: () => QueryBuilderStub;
  leftJoin: () => QueryBuilderStub;
  orderBy: (...orderByArguments: readonly unknown[]) => QueryBuilderStub;
  limit: (limit: number) => QueryBuilderStub;
  where: (condition: unknown) => QueryBuilderStub;
}

const databaseState = vi.hoisted(
  (): {
    caseStudyRows: Record<string, unknown>[];
    slugRows: Record<string, unknown>[];
    optionRows: Record<string, unknown>[];
    childRowsByTable: Record<string, Record<string, unknown>[]>;
    queries: CapturedQuery[];
  } => ({
    caseStudyRows: [],
    slugRows: [],
    optionRows: [],
    childRowsByTable: {},
    queries: [],
  }),
);

/**
 * `case_study` serves five different reads, told apart by the columns they name: the options select
 * a title beside the slug, the prerender list and the related-lesson resolver select the slug pair,
 * and the index and detail select the whole row.
 */
function rowsFor(tableName: string, selectedColumns: readonly string[]): Record<string, unknown>[] {
  const rows = ((): Record<string, unknown>[] => {
    if (tableName !== "case_study") return databaseState.childRowsByTable[tableName] ?? [];
    if (selectedColumns.includes("title") && selectedColumns.includes("slug")) {
      return databaseState.optionRows;
    }
    if (selectedColumns.includes("slug")) return databaseState.slugRows;
    return databaseState.caseStudyRows;
  })();

  if (selectedColumns.length === 0) return rows;
  return rows.map((row) =>
    Object.fromEntries(selectedColumns.flatMap((column) => (column in row ? [[column, row[column]]] : []))),
  );
}

const selectMock = vi.fn<(columns?: unknown) => unknown>((columns) => {
  const selectedColumns = Object.keys(columns ?? {});
  const capture: {
    tableName: string;
    conditionText: string;
    orderByText: string;
    limit: number | null;
  } = { tableName: "", conditionText: "", orderByText: "", limit: null };

  databaseState.queries.push({
    selectedColumns,
    get tableName() {
      return capture.tableName;
    },
    get conditionText() {
      return capture.conditionText;
    },
    get orderByText() {
      return capture.orderByText;
    },
    get limit() {
      return capture.limit;
    },
  });

  let settleRows: ((rows: Record<string, unknown>[]) => void) | undefined;
  const rowsPromise = new Promise<Record<string, unknown>[]>((resolve) => {
    settleRows = resolve;
  });

  const builder: QueryBuilderStub = Object.assign(rowsPromise, {
    from: (table: unknown) => {
      if (!is(table, Table)) throw new Error("select().from() was handed something that is not a table");
      capture.tableName = getTableName(table);
      settleRows?.(rowsFor(capture.tableName, selectedColumns));
      return builder;
    },
    innerJoin: () => builder,
    leftJoin: () => builder,
    orderBy: (...orderByArguments: readonly unknown[]) => {
      capture.orderByText = describeExpression(orderByArguments);
      return builder;
    },
    limit: (limit: number) => {
      capture.limit = limit;
      return builder;
    },
    where: (condition: unknown) => {
      capture.conditionText = describeExpression(condition);
      return builder;
    },
  });
  return builder;
});

vi.mock("#src/db/index.js", () => ({ db: { select: selectMock } }));

const CREATED_AT = new Date("2026-03-04T09:00:00.000Z");
const CASE_STUDY_SLUG = "budget-for-the-second-mould";

/** One joined row as the index and detail reads select it. */
function buildCaseStudyRow(
  overrides: { readonly caseStudy?: Record<string, unknown> } & Record<string, unknown> = {},
): Record<string, unknown> {
  const { caseStudy: caseStudyOverrides, ...rowOverrides } = overrides;
  return {
    caseStudy: {
      id: "case_study_1",
      publicSlug: CASE_STUDY_SLUG,
      title: "Budget for a second mould, not a perfect first one",
      oneLineAction: "Plan the bridge tool into the schedule.",
      summary: "A cable bracket had eleven mounting variants.",
      problem: "Committing to steel meant committing to a variant list.",
      context: "A three-person spin-out.",
      discipline: "tooling",
      sector: "Industrial components",
      outcomeSummary: null,
      timelineLabel: "14 months",
      authorRelationship: "first_hand",
      acceptedStatementIds: ["was_part_of_it", "figures_from_records"],
      tags: ["tooling"],
      capitalRaisedAmountCents: null,
      capitalRaisedCurrency: null,
      authorUserId: null,
      authorDisplayName: "Amara",
      authorHandle: "amara-builds",
      authorAvatarUrl: "/dummy/avatar.avif",
      moderationState: "published",
      moderatorNote: null,
      reviewedByUserId: null,
      reviewedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      ...caseStudyOverrides,
    },
    accountDisplayName: null,
    accountHandle: null,
    accountAvatarUrl: null,
    ...rowOverrides,
  };
}

function resetDatabaseState(): void {
  databaseState.caseStudyRows = [];
  databaseState.slugRows = [];
  databaseState.optionRows = [];
  databaseState.childRowsByTable = {};
  databaseState.queries = [];
}

async function importService(): Promise<
  typeof import("#src/modules/home/blueprints/case-study-public-read.service.js")
> {
  return import("#src/modules/home/blueprints/case-study-public-read.service.js");
}

/** The index and detail reads are the ones selecting the whole `case_study` row. */
function caseStudyTableQuery(): CapturedQuery | undefined {
  return databaseState.queries.find((query) => query.tableName === "case_study" && query.selectedColumns.length === 4);
}

const NO_FILTERS = { discipline: undefined, limit: 6, cursor: undefined } as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetDatabaseState();
});

describe("the visibility gate", () => {
  it("admits published and flagged on the index", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { listPublicCaseStudies } = await importService();

    await listPublicCaseStudies(NO_FILTERS);

    const condition = caseStudyTableQuery()?.conditionText ?? "";
    expect(condition, "a published case study must be listable").toContain("published");
    /*
     * `flagged` IS ADMITTED, deliberately. A report is an allegation nobody has ruled on, and
     * delisting on the strength of one would turn the report control into a takedown control.
     */
    expect(condition, "a flagged case study stays listable").toContain("flagged");
  });

  /**
   * ⚠️ THE NEGATIVE HALF, without which the case above is nearly worthless: "published is in the
   * predicate" passes on a gate that admits everything.
   */
  it("keeps pending_review and rejected out of the index", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { listPublicCaseStudies } = await importService();

    await listPublicCaseStudies(NO_FILTERS);

    const condition = caseStudyTableQuery()?.conditionText ?? "";
    expect(condition, "unreviewed work is nobody's to read").not.toContain("pending_review");
    expect(condition, "rejected work is nobody's to read").not.toContain("rejected");
  });

  it("binds the same gate into the detail read", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { getPublicCaseStudyBySlug } = await importService();

    await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);

    const condition = caseStudyTableQuery()?.conditionText ?? "";
    expect(condition).toContain("published");
    expect(condition).toContain("flagged");
    expect(condition).not.toContain("pending_review");
  });

  it("binds the gate into the slug list and the options", async () => {
    databaseState.slugRows = [{ slug: "one-a" }];
    databaseState.optionRows = [{ slug: "one-a", title: "One" }];
    const { listPublicCaseStudySlugs, listCaseStudyOptions } = await importService();

    await listPublicCaseStudySlugs();
    const slugCondition =
      databaseState.queries.find((query) => query.selectedColumns.includes("slug"))?.conditionText ?? "";

    resetDatabaseState();
    databaseState.optionRows = [{ slug: "one-a", title: "One" }];
    await listCaseStudyOptions();
    const optionCondition =
      databaseState.queries.find((query) => query.selectedColumns.includes("title"))?.conditionText ?? "";

    expect(slugCondition, "the prerender list must be gated").toContain("published");
    expect(slugCondition).not.toContain("rejected");
    expect(optionCondition, "the composer's select must be gated").toContain("published");
    expect(optionCondition).not.toContain("rejected");
  });

  /**
   * ⚠️ THE SAME GATE GUARDS THE WRITE PATH'S RELATED-LESSON CHECK, which is why it lives in this
   * module. A related lesson is a recommendation the new case study makes to its readers, so
   * pointing at something nobody may read is a dead link the author cannot see. The foreign key
   * proves the row EXISTS; only this query proves it is visible.
   */
  it("binds the gate into the write path's related-lesson check", async () => {
    databaseState.optionRows = [];
    const { findUnresolvableRelatedSlugs } = await importService();

    const unresolvable = await findUnresolvableRelatedSlugs(["no-such-lesson"]);

    const condition = databaseState.queries.find((query) => query.tableName === "case_study")?.conditionText ?? "";
    expect(condition, "the related-lesson check must use the same gate").toContain("published");
    expect(condition).not.toContain("pending_review");
    expect(unresolvable).toEqual(["no-such-lesson"]);
  });

  it("admits neither draft, quarantined nor removed anywhere", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { listPublicCaseStudies, getPublicCaseStudyBySlug } = await importService();

    await listPublicCaseStudies(NO_FILTERS);
    await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);

    const everyCondition = databaseState.queries.map((query) => query.conditionText).join("|");
    expect(everyCondition, "a draft never leaves the browser").not.toContain("draft");
    expect(everyCondition, "this arm has no quarantine").not.toContain("quarantined");
    expect(everyCondition, "a removed case study is gone").not.toContain("removed");
  });
});

describe("the related lessons", () => {
  it("resolves in the AUTHOR's order, not the query's", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    databaseState.childRowsByTable = {
      case_study_related_lesson: [
        { id: "edge_1", caseStudyId: "case_study_1", position: 0, relatedPublicSlug: "second-one" },
        { id: "edge_2", caseStudyId: "case_study_1", position: 1, relatedPublicSlug: "first-one" },
      ],
    };
    // Returned in the opposite order, as a query with no ORDER BY on the resolver would.
    databaseState.optionRows = [
      { slug: "first-one", title: "First one" },
      { slug: "second-one", title: "Second one" },
    ];
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);
    if (!result.success) throw new Error("the case study must be found");

    /*
     * "IT RESOLVES SLUGS; IT DOES NOT RANK." The authored list is the answer, so the resolver must
     * not let the database's return order become the page's order.
     */
    expect(result.value.relatedLessons.map((lesson) => lesson.slug)).toEqual(["second-one", "first-one"]);
  });

  /** An unresolvable edge is an absence, and absence renders nothing — never a dead row. */
  it("drops an edge whose target is not visible", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    databaseState.childRowsByTable = {
      case_study_related_lesson: [
        { id: "edge_1", caseStudyId: "case_study_1", position: 0, relatedPublicSlug: "gone-away" },
        { id: "edge_2", caseStudyId: "case_study_1", position: 1, relatedPublicSlug: "still-here" },
      ],
    };
    databaseState.optionRows = [{ slug: "still-here", title: "Still here" }];
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);
    if (!result.success) throw new Error("the case study must be found");

    expect(result.value.relatedLessons).toEqual([{ slug: "still-here", title: "Still here" }]);
    // The authored list survives intact beside the resolution — it says what the author named.
    expect(result.value.caseStudy.relatedLessonSlugs).toEqual(["gone-away", "still-here"]);
  });

  it("makes no query at all when the author named none", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);
    if (!result.success) throw new Error("the case study must be found");

    expect(result.value.relatedLessons).toEqual([]);
    expect(
      databaseState.queries.filter(
        (query) => query.tableName === "case_study" && query.selectedColumns.includes("title"),
      ),
      "an empty list needs no resolution query",
    ).toEqual([]);
  });
});

describe("the serializer", () => {
  it("takes the byline from the denormalised arm when there is no account", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);
    if (!result.success) throw new Error("the case study must be found");

    expect(result.value.caseStudy.author).toEqual({
      displayName: "Amara",
      handle: "amara-builds",
      avatarUrl: "/dummy/avatar.avif",
    });
  });

  it("takes the byline from the joined account when there is one", async () => {
    databaseState.caseStudyRows = [
      buildCaseStudyRow({
        caseStudy: {
          authorUserId: "user_1",
          authorDisplayName: null,
          authorHandle: null,
          authorAvatarUrl: null,
        },
        accountDisplayName: "Priya",
        accountHandle: "priya-builds",
        accountAvatarUrl: null,
      }),
    ];
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);
    if (!result.success) throw new Error("the case study must be found");

    expect(result.value.caseStudy.author).toEqual({
      displayName: "Priya",
      handle: "priya-builds",
      avatarUrl: null,
    });
  });

  /**
   * ⚠️ A THROW, NOT A FALLBACK. `user.name ?? row.authorDisplayName` would paper over a joined
   * account that came back empty — which `case_study_author_arm_ck` says is impossible, so the
   * honest answer is a 500 rather than a byline nobody wrote.
   */
  it("throws rather than inventing a byline when the account join came back empty", async () => {
    databaseState.caseStudyRows = [
      buildCaseStudyRow({
        caseStudy: { authorUserId: "user_1", authorDisplayName: null, authorHandle: null },
        accountDisplayName: null,
      }),
    ];
    const { getPublicCaseStudyBySlug } = await importService();

    await expect(getPublicCaseStudyBySlug(CASE_STUDY_SLUG)).rejects.toThrow("names an account with no display name");
  });

  it("rebuilds all three figure kinds", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    databaseState.childRowsByTable = {
      case_study_outcome_metric: [
        {
          id: "m1",
          caseStudyId: "case_study_1",
          position: 0,
          label: "Units",
          kind: "count",
          countAmount: 4200,
          moneyAmountCents: null,
          moneyCurrency: null,
          basisPoints: null,
        },
        {
          id: "m2",
          caseStudyId: "case_study_1",
          position: 1,
          label: "Spend",
          kind: "money",
          countAmount: null,
          moneyAmountCents: 1_000_000_000,
          moneyCurrency: "INR",
          basisPoints: null,
        },
        {
          id: "m3",
          caseStudyId: "case_study_1",
          position: 2,
          label: "Returns",
          kind: "percentage",
          countAmount: null,
          moneyAmountCents: null,
          moneyCurrency: null,
          basisPoints: -1200,
        },
      ],
    };
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);
    if (!result.success) throw new Error("the case study must be found");

    expect(result.value.caseStudy.outcomeMetrics.map((metric) => metric.value)).toEqual([
      { kind: "count", amount: 4200 },
      // One crore of paise — the figure `bigint` exists for.
      { kind: "money", amountInCents: 1_000_000_000, currency: "INR" },
      // A negative percentage is legal: a figure can go down.
      { kind: "percentage", basisPoints: -1200 },
    ]);
  });

  /** `case_study_outcome_metric_kind_ck` ties each kind to its columns, so this cannot happen. */
  it("throws on a figure whose kind and columns disagree", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    databaseState.childRowsByTable = {
      case_study_outcome_metric: [
        {
          id: "m1",
          caseStudyId: "case_study_1",
          position: 0,
          label: "Units",
          kind: "count",
          countAmount: null,
          moneyAmountCents: null,
          moneyCurrency: null,
          basisPoints: null,
        },
      ],
    };
    const { getPublicCaseStudyBySlug } = await importService();

    await expect(getPublicCaseStudyBySlug(CASE_STUDY_SLUG)).rejects.toThrow("its CHECK should have refused it");
  });

  it("serves zeroed counters when the stats sidecar is missing", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);
    if (!result.success) throw new Error("the case study must be found");

    expect(result.value.caseStudy.viewCount).toBe(0);
    expect(result.value.caseStudy.likeCount).toBe(0);
  });

  it("serialises createdAt as an ISO string", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);
    if (!result.success) throw new Error("the case study must be found");

    expect(result.value.caseStudy.createdAt).toBe(CREATED_AT.toISOString());
  });

  it("answers not found for a slug nothing visible carries", async () => {
    const { getPublicCaseStudyBySlug } = await importService();

    const result = await getPublicCaseStudyBySlug("no-such-lesson");

    expect(result.success).toBe(false);
    expect(result.success ? null : result.error.type).toBe("CASE_STUDY_NOT_FOUND");
  });
});

describe("the index's filter and paging", () => {
  it("binds the discipline filter", async () => {
    const { listPublicCaseStudies } = await importService();

    await listPublicCaseStudies({ ...NO_FILTERS, discipline: "quality" });

    expect(caseStudyTableQuery()?.conditionText).toContain("quality");
  });

  it("over-fetches one row beyond the requested limit", async () => {
    const { listPublicCaseStudies } = await importService();

    await listPublicCaseStudies({ ...NO_FILTERS, limit: 6 });

    expect(caseStudyTableQuery()?.limit).toBe(7);
  });

  it("trims the over-fetched row and reports that more remain", async () => {
    databaseState.caseStudyRows = [
      buildCaseStudyRow({ caseStudy: { id: "cs_1" } }),
      buildCaseStudyRow({ caseStudy: { id: "cs_2" } }),
      buildCaseStudyRow({ caseStudy: { id: "cs_3" } }),
    ];
    const { listPublicCaseStudies } = await importService();

    const page = await listPublicCaseStudies({ ...NO_FILTERS, limit: 2 });

    expect(page.success && page.value.items).toHaveLength(2);
    expect(page.success && page.value.page.hasMore).toBe(true);
  });

  /** Encoding the over-fetched row would skip a case study on every page boundary. */
  it("mints the cursor from the last returned row, not the over-fetched one", async () => {
    databaseState.caseStudyRows = [
      buildCaseStudyRow({ caseStudy: { id: "cs_1" } }),
      buildCaseStudyRow({ caseStudy: { id: "cs_2" } }),
      buildCaseStudyRow({ caseStudy: { id: "cs_3" } }),
    ];
    const { listPublicCaseStudies } = await importService();

    const page = await listPublicCaseStudies({ ...NO_FILTERS, limit: 2 });

    expect(page.success && page.value.page.nextCursor).toBe(`${String(CREATED_AT.getTime())}_cs_2`);
  });

  it("reports no cursor on a short page", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { listPublicCaseStudies } = await importService();

    const page = await listPublicCaseStudies(NO_FILTERS);

    expect(page.success && page.value.page).toEqual({ nextCursor: null, hasMore: false });
  });

  /**
   * ⚠️ A MIXED-DIRECTION KEYSET — `created_at DESC, id ASC` — so the predicate must bind BOTH the
   * instant and the id. Binding the instant alone skips or repeats whichever row loses a tie.
   */
  it("binds the cursor's instant and id into the keyset predicate", async () => {
    const { listPublicCaseStudies } = await importService();

    await listPublicCaseStudies({
      ...NO_FILTERS,
      cursor: `${String(CREATED_AT.getTime())}_cs_7`,
    });

    const condition = caseStudyTableQuery()?.conditionText ?? "";
    expect(condition).toContain(`date:${CREATED_AT.toISOString()}`);
    expect(condition).toContain("cs_7");
  });

  it("orders by the created instant and then the id", async () => {
    const { listPublicCaseStudies } = await importService();

    await listPublicCaseStudies(NO_FILTERS);

    const orderByText = caseStudyTableQuery()?.orderByText ?? "";
    expect(orderByText).toContain("created_at");
    expect(orderByText).toContain("id");
  });

  /** Refused, never a silent first page: a list that quietly restarts shows duplicates. */
  it("refuses a cursor this server did not mint", async () => {
    const { listPublicCaseStudies } = await importService();

    const page = await listPublicCaseStudies({ ...NO_FILTERS, cursor: "not-a-cursor" });

    expect(page.success).toBe(false);
    expect(page.success ? null : page.error.type).toBe("CASE_STUDY_INDEX_CURSOR_MALFORMED");
  });

  it("orders the options by title", async () => {
    databaseState.optionRows = [{ slug: "one-a", title: "One" }];
    const { listCaseStudyOptions } = await importService();

    await listCaseStudyOptions();

    const orderByText =
      databaseState.queries.find((query) => query.selectedColumns.includes("title"))?.orderByText ?? "";
    expect(orderByText, "the select's order must match the frontend's localeCompare").toContain("title");
  });

  it("orders every child list by position", async () => {
    databaseState.caseStudyRows = [buildCaseStudyRow()];
    const { getPublicCaseStudyBySlug } = await importService();

    await getPublicCaseStudyBySlug(CASE_STUDY_SLUG);

    for (const tableName of [
      "case_study_action_step",
      "case_study_pitfall",
      "case_study_evidence_company",
      "case_study_outcome_metric",
      "case_study_source",
      "case_study_related_lesson",
    ]) {
      const orderByText = databaseState.queries.find((query) => query.tableName === tableName)?.orderByText ?? "";
      expect(orderByText, `${tableName} must be ordered by position`).toContain("position");
    }
  });
});
