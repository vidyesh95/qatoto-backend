import { getTableName, is, Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * UNIT tests for the five public teardown reads.
 *
 * ⚠️ THE TWO GATES ARE WHAT THIS FILE IS FOR. Ordering and paging fail loudly; a gate fails
 * silently, and the two failure modes here are opposite and both bad — advertising a teardown under
 * an unresolved rights claim, or 404-ing a URL that a quarantine was supposed to leave working. So
 * the gates are asserted POSITIVELY (this state is admitted) and NEGATIVELY (this one is not), on
 * every query including the facet counts, and one case exists purely to fail if the two predicates
 * are ever merged into one.
 *
 * That emphasis is not theoretical. On the showcase round, deleting the visibility predicate broke
 * NOTHING in its test file, because the stub ignored the WHERE.
 *
 * THE DATABASE STUB IS ONE CHAINABLE PROMISE, dispatching rows by WHICH TABLE the query reads and,
 * where one table serves two reads, by which columns it selected. Drizzle's builders differ in
 * shape across these eleven queries, so modelling each chain would make the test about drizzle's
 * fluent surface rather than about the arguments, which is where the behaviour lives.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));

interface CapturedQuery {
  readonly tableName: string;
  readonly selectedColumns: readonly string[];
  readonly conditionText: string;
  readonly orderByText: string;
  readonly limit: number | null;
  readonly grouped: boolean;
}

/**
 * Every primitive bound into a drizzle expression, as one searchable string.
 *
 * A CYCLE-SAFE DEEP WALK, because a condition holds column objects that point back at their table,
 * so `JSON.stringify` throws on it. Walking is also independent of drizzle's internal layout, which
 * keeps this from breaking on a patch release that reshapes the chunk tree.
 *
 * ⚠️ `table` AND `enumValues` ARE SKIPPED, and that is load-bearing rather than an optimisation. A
 * column points back at its table, whose `moderation_state` column carries every enum label —
 * including `published` and `quarantined`. Following those made a gate assertion pass on a query
 * with NO GATE AT ALL on the showcase round: the word was in the schema metadata, not in the
 * predicate. Measured there, inherited here.
 */
const UNWALKED_CONDITION_KEYS = new Set(["table", "enumValues"]);
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

const databaseState = vi.hoisted(
  (): {
    teardownRows: Record<string, unknown>[];
    facetRows: Record<string, unknown>[];
    slugRows: Record<string, unknown>[];
    optionRows: Record<string, unknown>[];
    childRowsByTable: Record<string, Record<string, unknown>[]>;
    queries: CapturedQuery[];
  } => ({
    teardownRows: [],
    facetRows: [],
    slugRows: [],
    optionRows: [],
    childRowsByTable: {},
    queries: [],
  }),
);

/**
 * Which rows a query gets back.
 *
 * `teardown` serves four different reads, told apart by the columns they name: the facets select
 * `value`, the options select a title beside the slug, the prerender list selects the slug alone,
 * and the index and detail select the whole row. Every other table serves one read, or two whose
 * rows are the same shape — a claim target is a subset of a document row, not a different row.
 */
function rowsFor(tableName: string, selectedColumns: readonly string[]): Record<string, unknown>[] {
  const rows = ((): Record<string, unknown>[] => {
    if (tableName !== "teardown") return databaseState.childRowsByTable[tableName] ?? [];
    if (selectedColumns.includes("value")) return databaseState.facetRows;
    if (selectedColumns.includes("title")) return databaseState.optionRows;
    if (selectedColumns.includes("slug")) return databaseState.slugRows;
    return databaseState.teardownRows;
  })();

  /*
   * ⚠️ THE PROJECTION IS PART OF THE STUB'S JOB, not a nicety. Drizzle returns only the columns a
   * query named, and a stub that hands back whole rows makes "this route serves no URL" untestable:
   * the URL would be in the payload because the stub put it there, and the assertion would fail on
   * a route that was already correct. Projecting makes the select list itself the thing under test.
   */
  if (selectedColumns.length === 0) return rows;
  return rows.map((row) =>
    Object.fromEntries(selectedColumns.flatMap((column) => (column in row ? [[column, row[column]]] : []))),
  );
}

/** The chainable stand-in for a drizzle query builder — awaitable, and every method returns itself. */
interface QueryBuilderStub extends Promise<Record<string, unknown>[]> {
  from: (table: unknown) => QueryBuilderStub;
  innerJoin: () => QueryBuilderStub;
  leftJoin: () => QueryBuilderStub;
  groupBy: () => QueryBuilderStub;
  orderBy: (...orderByArguments: readonly unknown[]) => QueryBuilderStub;
  limit: (limit: number) => QueryBuilderStub;
  where: (condition: unknown) => QueryBuilderStub;
}

const selectMock = vi.fn<(columns?: unknown) => unknown>((columns) => {
  const selectedColumns = Object.keys(columns ?? {});
  const capture: {
    tableName: string;
    conditionText: string;
    orderByText: string;
    limit: number | null;
    grouped: boolean;
  } = { tableName: "", conditionText: "", orderByText: "", limit: null, grouped: false };

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
    get grouped() {
      return capture.grouped;
    },
  });

  /*
   * A REAL PROMISE WITH THE BUILDER METHODS HUNG OFF IT, rather than an object carrying its own
   * `then` — a hand-written `then` is the thenable trap `unicorn/no-thenable` exists to catch. The
   * rows are not known at `select()` time here (the table is named by `from()`), so the promise is
   * deferred and settled the moment the table is known.
   *
   * ⚠️ A DEFERRED PROMISE, not `Promise.withResolvers`: this repository's `lib` is below es2024, so
   * that helper exists at runtime and not in the type system — `pnpm test` green, `pnpm typecheck`
   * red. The executor runs synchronously, so `settleRows` is assigned before anything can call it.
   *
   * ⚠️ AND THE BUILDER IS TYPED AS AN INTERFACE EXTENDING `Promise`, not as `Record<string,
   * unknown>`. `Promise` is an interface, so it carries no implicit index signature and the record
   * annotation is a TS2322 that only `tsconfig.test.json` sees. The interface also self-types the
   * chain, so a method returning the wrong thing is a compile error rather than a runtime
   * `undefined is not a function`.
   */
  let settleRows: ((rows: Record<string, unknown>[]) => void) | undefined;
  const rowsPromise = new Promise<Record<string, unknown>[]>((resolve) => {
    settleRows = resolve;
  });

  const builder: QueryBuilderStub = Object.assign(rowsPromise, {
    innerJoin: () => builder,
    leftJoin: () => builder,
    from: (table: unknown) => {
      // Drizzle's own type guard rather than a cast — an assertion here would let a future refactor
      // hand this stub something that is not a table and get an empty string back in silence.
      if (!is(table, Table)) throw new Error("select().from() was handed something that is not a table");
      capture.tableName = getTableName(table);
      settleRows?.(rowsFor(capture.tableName, selectedColumns));
      return builder;
    },
    groupBy: () => {
      capture.grouped = true;
      return builder;
    },
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
const SURVEYED_AT = new Date("2026-02-01T00:00:00.000Z");
const ATTESTED_AT = new Date("2026-02-02T00:00:00.000Z");

/** One stored teardown row — every column the read touches, so an override is one field wide. */
function buildTeardownRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "teardown_1",
    slug: "solar-cold-storage-controller-teardown",
    title: "Solar cold storage controller teardown",
    summary: "A survey of the controller board and its housing.",
    thumbnailUrl: "/dummy/teardowns/controller.avif",
    authorDisplayName: "Amara",
    authorHandle: "amara-builds",
    authorAvatarUrl: "/dummy/avatars/amara.avif",
    difficulty: "intermediate",
    cadFormat: "STEP / Fusion 360",
    tags: ["solar", "electronics"],
    partCount: 148,
    subjectKind: "existing_physical_product",
    moderationState: "published",
    billOfMaterialsMinimumCents: 4500,
    billOfMaterialsMaximumCents: 9900,
    billOfMaterialsCurrency: "USD",
    provenanceKind: "community_reverse_engineered",
    provenanceSubjectProductName: "ColdChain CC-200",
    provenanceUnitAcquisition: "retail_purchase",
    provenanceSurveyMethods: ["dimensional_survey", "empirical_teardown"],
    provenanceSurveyedAt: SURVEYED_AT,
    provenanceLicenceName: null,
    provenanceLicenceUrl: null,
    provenanceAuthorizationNote: null,
    provenanceAttestationAcceptedAt: ATTESTED_AT,
    provenanceNotes: "Two units measured.",
    repairabilityFastenerUniformityScore: 7,
    repairabilityFastenerUniformityNote: "Two drive types.",
    repairabilityToolAccessibilityScore: 6,
    repairabilityToolAccessibilityNote: "One captive screw.",
    repairabilityDisassemblyStepCountScore: 8,
    repairabilityDisassemblyStepCountNote: "Six steps to the board.",
    repairabilityModularIndependenceScore: 5,
    repairabilityModularIndependenceNote: "Board and housing are one unit.",
    repairabilityOverallScore: 7,
    telemetryFactorOfSafety: 2.4,
    telemetryPeakVonMisesStressMegapascals: 38.2,
    telemetryMaxDisplacementMicrometres: 120,
    telemetryThermalDeltaKelvin: -4.5,
    telemetryRatedLoadNewtons: 220,
    telemetrySource: "author_reported",
    storeProductClassCategorySlug: "cold-chain-controllers",
    storeProductClassLabel: "Cold-chain controllers",
    walkthroughVideoSource: "youtube",
    walkthroughYoutubeVideoId: "abcdefghijk",
    walkthroughPosterUrl: "/dummy/teardowns/poster.avif",
    walkthroughDurationSeconds: 615,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function buildStatsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    teardownId: "teardown_1",
    viewCount: 4210,
    likeCount: 96,
    commentCount: 12,
    saveCount: 31,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function buildCompositeAssemblyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "assembly_1",
    teardownId: "teardown_1",
    kind: "composite",
    explosionAxisX: 0,
    explosionAxisY: 1,
    explosionAxisZ: 0,
    modelUrl: "/dummy/models/controller.glb",
    modelByteSize: 482_000,
    ...overrides,
  };
}

function buildCompositePartRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "part_1",
    assemblyId: "assembly_1",
    assemblyKind: "composite",
    parentPartId: null,
    position: 0,
    label: "Housing shell",
    material: "6063-T5 aluminium",
    manufacturingMethod: "extrusion",
    explosionDirectionX: 0,
    explosionDirectionY: 1,
    explosionDirectionZ: 0,
    explosionDistanceMm: 24,
    layerIndex: 0,
    stressRating: 0.4,
    calloutText: null,
    nodeName: "housing_shell",
    modelUrl: null,
    modelByteSize: null,
    placementPositionX: null,
    placementPositionY: null,
    placementPositionZ: null,
    placementRotationX: null,
    placementRotationY: null,
    placementRotationZ: null,
    ...overrides,
  };
}

function buildDocumentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc_1",
    teardownId: "teardown_1",
    position: 0,
    kind: "schematic",
    title: "Controller schematic",
    url: "/dummy/documents/controller-schematic.pdf",
    byteSize: 240_000,
    pageCount: 4,
    ...overrides,
  };
}

function buildManufacturingFileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "mfg_1",
    teardownId: "teardown_1",
    position: 0,
    kind: "step",
    title: "Housing STEP",
    url: "/dummy/manufacturing/housing.step",
    byteSize: 980_000,
    ...overrides,
  };
}

function buildFastenerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fastener_1",
    teardownId: "teardown_1",
    position: 0,
    standardCode: "ISO 14581",
    sizeLabel: "M3 × 8",
    drive: "torx",
    quantity: 8,
    supplierLabel: "Fastenal",
    supplierUrl: "https://fastenal.test/m3x8",
    ...overrides,
  };
}

function buildStepRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "step_1",
    teardownId: "teardown_1",
    stepNumber: 1,
    title: "Remove the lid",
    description: "Back out the eight M3 torx screws.",
    assemblyId: "assembly_1",
    focusedPartId: "part_1",
    ...overrides,
  };
}

function buildMaterialRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "material_1",
    teardownId: "teardown_1",
    position: 0,
    appliesToLabel: "Housing shell",
    designation: "6063-T5",
    designationSource: "measured_spectroscopy",
    materialClass: "metal_alloy",
    process: "extrusion",
    finish: "Clear anodised",
    assemblyId: "assembly_1",
    partId: "part_1",
    ...overrides,
  };
}

function buildElementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "element_1",
    materialId: "material_1",
    position: 0,
    symbol: "Al",
    minimumPercent: 97.5,
    maximumPercent: 99.1,
    analysisMethod: "xrf",
    instrumentLabel: "Niton XL2",
    operatorNote: null,
    ...overrides,
  };
}

function resetDatabaseState(): void {
  databaseState.teardownRows = [];
  databaseState.facetRows = [];
  databaseState.slugRows = [];
  databaseState.optionRows = [];
  databaseState.childRowsByTable = {};
  databaseState.queries = [];
}

/** Gives one teardown the whole tree, so a withholding case has something to withhold. */
function seedFullTree(): void {
  databaseState.childRowsByTable = {
    teardown_stats: [buildStatsRow()],
    teardown_assembly: [buildCompositeAssemblyRow()],
    teardown_part: [buildCompositePartRow()],
    teardown_document: [buildDocumentRow()],
    teardown_manufacturing_file: [buildManufacturingFileRow()],
    teardown_fastener: [buildFastenerRow()],
    teardown_assembly_step: [buildStepRow()],
    teardown_material: [buildMaterialRow()],
    teardown_material_element: [buildElementRow()],
  };
}

/** The index and detail reads are the ones selecting the whole `teardown` row. */
function teardownTableQuery(): CapturedQuery | undefined {
  return databaseState.queries.find((query) => query.tableName === "teardown" && query.selectedColumns.length === 0);
}

function facetQuery(): CapturedQuery | undefined {
  return databaseState.queries.find((query) => query.selectedColumns.includes("value"));
}

async function importService(): Promise<typeof import("#src/modules/home/blueprints/teardown-public-read.service.js")> {
  return import("#src/modules/home/blueprints/teardown-public-read.service.js");
}

const NO_FILTERS = {
  difficulty: undefined,
  media: undefined,
  tag: undefined,
  limit: 8,
  cursor: undefined,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetDatabaseState();
});

describe("the two visibility gates", () => {
  /**
   * The LIST gate, on the index AND on the facets.
   *
   * A tag chip counted over a wider population promises teardowns the list will never return, which
   * is a count the reader can see is wrong — and counting a quarantined teardown would advertise
   * the existence of exactly the one nobody is supposed to be steered toward.
   */
  it("filters the index and its facets to the listable states", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    const { listPublicTeardowns } = await importService();

    await listPublicTeardowns(NO_FILTERS);

    const indexCondition = teardownTableQuery()?.conditionText ?? "";
    const facetCondition = facetQuery()?.conditionText ?? "";

    expect(indexCondition, "the index must admit published").toContain("published");
    expect(indexCondition, "the index must admit flagged").toContain("flagged");
    expect(facetCondition, "the facets must admit published").toContain("published");
    expect(facetCondition, "the facets must admit flagged").toContain("flagged");
  });

  /**
   * ⚠️ THE NEGATIVE HALF, and without it the case above is nearly worthless: "published is in the
   * predicate" passes just as happily on a gate that admits everything.
   */
  it("keeps quarantined and pending_review out of the index and the facets", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    const { listPublicTeardowns } = await importService();

    await listPublicTeardowns(NO_FILTERS);

    const indexCondition = teardownTableQuery()?.conditionText ?? "";
    const facetCondition = facetQuery()?.conditionText ?? "";

    expect(indexCondition, "the index must not advertise a quarantined teardown").not.toContain("quarantined");
    expect(indexCondition, "the index must not show unreviewed work").not.toContain("pending_review");
    expect(facetCondition, "the facets must not count a quarantined teardown").not.toContain("quarantined");
  });

  /** The READABLE gate on the detail read: a quarantine withholds files, not the address. */
  it("admits a quarantined teardown to the detail read", async () => {
    databaseState.teardownRows = [buildTeardownRow({ moderationState: "quarantined" })];
    const { getPublicTeardownBySlug } = await importService();

    await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");

    const condition = teardownTableQuery()?.conditionText ?? "";
    expect(condition, "the detail read must admit quarantined").toContain("quarantined");
    expect(condition, "the detail read must still refuse unreviewed work").not.toContain("pending_review");
  });

  /**
   * The prerender list uses READABLE too, which is why it returns ELEVEN slugs where the index
   * would list ten. Prerendering only the advertised ones would leave the quarantined page to a
   * runtime miss — and the whole point of withholding rather than deleting is that the address
   * keeps working.
   */
  it("puts the quarantined slug in the prerender list", async () => {
    databaseState.slugRows = [{ slug: "one" }, { slug: "two" }];
    const { listPublicTeardownSlugs } = await importService();

    const slugs = await listPublicTeardownSlugs();

    const condition =
      databaseState.queries.find((query) => query.selectedColumns.includes("slug"))?.conditionText ?? "";
    expect(condition, "the prerender list must admit quarantined").toContain("quarantined");
    expect(slugs).toEqual(["one", "two"]);
  });

  /** The composer's select is a recommendation, so it uses LIST rather than READABLE. */
  it("keeps a quarantined teardown out of the composer's options", async () => {
    databaseState.optionRows = [{ slug: "one", title: "One" }];
    const { listTeardownOptions } = await importService();

    await listTeardownOptions();

    const condition =
      databaseState.queries.find((query) => query.selectedColumns.includes("title"))?.conditionText ?? "";
    expect(condition, "the options must admit published").toContain("published");
    expect(condition, "the options must not name a quarantined teardown").not.toContain("quarantined");
  });

  /**
   * ⚠️ THIS CASE EXISTS TO FAIL IF THE TWO GATES ARE EVER FACTORED INTO ONE PREDICATE.
   *
   * They differ by exactly one label, which is precisely the shape somebody "de-duplicates". Merged
   * either way the result is a real defect — a quarantined teardown advertised on the index, or a
   * live URL that 404s — and both would leave every other case in this file green.
   */
  it("does not let the list gate and the readable gate be the same predicate", async () => {
    const { listTeardownOptions, listPublicTeardownSlugs } = await importService();

    /*
     * THE COMPARISON IS BETWEEN THE TWO GATE-ONLY READS on purpose. The index carries filters and
     * the detail carries a slug, so comparing those two would pass on a merged gate simply because
     * the slug is in one of them — vacuously, which is how this case was first written and why it
     * survived the probe that merged the gates. `options` and `slugs` add nothing to their WHERE,
     * so any difference between these two strings IS the difference between the gates.
     */
    await listTeardownOptions();
    const listCondition =
      databaseState.queries.find((query) => query.selectedColumns.includes("title"))?.conditionText ?? "";

    resetDatabaseState();
    await listPublicTeardownSlugs();
    const readableCondition =
      databaseState.queries.find((query) => query.selectedColumns.includes("slug"))?.conditionText ?? "";

    expect(listCondition, "the list gate must be bound at all").toContain("published");
    expect(readableCondition, "the readable gate must be bound at all").toContain("published");
    expect(listCondition, "the two gates must not be the same predicate").not.toEqual(readableCondition);
  });

  /** Four states neither gate may ever admit. Three of them hold somebody's withdrawn work. */
  it("admits neither draft, rejected nor removed anywhere", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    const { listPublicTeardowns, getPublicTeardownBySlug } = await importService();

    await listPublicTeardowns(NO_FILTERS);
    await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");

    const everyCondition = databaseState.queries.map((query) => query.conditionText).join("|");
    expect(everyCondition, "draft never leaves the browser").not.toContain("draft");
    expect(everyCondition, "a rejected teardown is nobody's to read").not.toContain("rejected");
    expect(everyCondition, "a removed teardown is gone").not.toContain("removed");
  });
});

describe("the quarantine withholding", () => {
  /**
   * ⚠️ FIELD BY FIELD, because "withhold the payload" is the kind of rule that rots one field at a
   * time. Each of these is a file, a figure or a link that an unresolved rights claim is ABOUT.
   *
   * `repairabilityIndex` is in this list for a specific reason: the frontend gated the other nine
   * and not this one, which was invisible only because the one quarantined fixture carries none.
   */
  it("withholds every disputed field from a quarantined teardown", async () => {
    databaseState.teardownRows = [buildTeardownRow({ moderationState: "quarantined" })];
    seedFullTree();
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    expect(result.success, "the quarantined teardown must still be reachable").toBe(true);
    if (!result.success) return;

    expect(result.value.assembly).toBeNull();
    expect(result.value.documents).toEqual([]);
    expect(result.value.manufacturingFiles).toEqual([]);
    expect(result.value.fasteners).toEqual([]);
    expect(result.value.assemblySteps).toEqual([]);
    expect(result.value.materials).toEqual([]);
    expect(result.value.simulationTelemetry).toBeNull();
    expect(result.value.walkthroughVideo).toBeNull();
    expect(result.value.billOfMaterialsCostRange).toBeNull();
    expect(result.value.repairabilityIndex).toBeNull();
  });

  /**
   * THE OTHER HALF, and without it "withhold everything" would pass.
   *
   * Every field here renders on the quarantined page: the notice needs `moderationState`, the header
   * an unconditional `thumbnailUrl`, the byline the author, the decision row `difficulty`, and the
   * chip derives from `provenance` — which is not nullable in the contract, so withholding it would
   * be a parse failure rather than a redaction.
   *
   * `partCount`, `cadFormat` and `storeProductClass` survive on the frontend's own reasoning: a
   * quarantine is a claim about the publisher's FILES; it says nothing about whether a market for
   * the product exists.
   */
  it("still serves everything the quarantined page renders", async () => {
    databaseState.teardownRows = [buildTeardownRow({ moderationState: "quarantined" })];
    seedFullTree();
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    expect(result.success, "the quarantined teardown must still be reachable").toBe(true);
    if (!result.success) return;

    expect(result.value.moderationState).toBe("quarantined");
    expect(result.value.thumbnailUrl).toBe("/dummy/teardowns/controller.avif");
    expect(result.value.author.displayName).toBe("Amara");
    expect(result.value.difficulty).toBe("intermediate");
    expect(result.value.tags).toEqual(["solar", "electronics"]);
    expect(result.value.partCount).toBe(148);
    expect(result.value.cadFormat).toBe("STEP / Fusion 360");
    expect(result.value.storeProductClass).toEqual({
      categorySlug: "cold-chain-controllers",
      label: "Cold-chain controllers",
    });
    expect(result.value.provenance.kind).toBe("community_reverse_engineered");
    expect(result.value.viewCount).toBe(4210);
  });

  /** A `flagged` teardown is listed AND served whole — flagging is not quarantining. */
  it("withholds nothing from a flagged teardown", async () => {
    databaseState.teardownRows = [buildTeardownRow({ moderationState: "flagged" })];
    seedFullTree();
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    expect(result.success, "a flagged teardown must be readable").toBe(true);
    if (!result.success) return;

    expect(result.value.documents).toHaveLength(1);
    expect(result.value.assembly).not.toBeNull();
    expect(result.value.repairabilityIndex).not.toBeNull();
  });
});

describe("the detail serializer", () => {
  it("rebuilds the composite assembly, its vectors and its parts", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    seedFullTree();
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    if (!result.success) throw new Error("the teardown must be found");
    const { assembly } = result.value;
    if (assembly === null) throw new Error("the assembly must survive on a published teardown");

    expect(assembly.kind).toBe("composite");
    expect(assembly.explosionAxis).toEqual([0, 1, 0]);
    expect(assembly.parts).toHaveLength(1);
    expect(assembly.parts[0]?.explosionDirection).toEqual([0, 1, 0]);
  });

  /**
   * ⚠️ AN ASSEMBLY WITH NO PARTS SERIALISES AS `null`, NOT AS `{ parts: [] }`.
   *
   * The frontend's `AssemblySchema` carries `.min(1)`, so an empty array is a page that refuses to
   * parse rather than a viewer with nothing in it. A row whose children all vanished is the same
   * fact as no assembly at all.
   */
  it("serialises a part-less assembly as null rather than an empty parts array", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    seedFullTree();
    databaseState.childRowsByTable.teardown_part = [];
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    expect(result.success, "the teardown must be found").toBe(true);
    if (!result.success) return;

    expect(result.value.assembly).toBeNull();
  });

  /** A NULL weight range is "present but not quantified" — a different claim from zero percent. */
  it("keeps an unquantified element range null rather than zeroing it", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    seedFullTree();
    databaseState.childRowsByTable.teardown_material_element = [
      buildElementRow({ minimumPercent: null, maximumPercent: null, instrumentLabel: null }),
    ];
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    expect(result.success, "the teardown must be found").toBe(true);
    if (!result.success) return;

    expect(result.value.materials[0]?.elements[0]?.weightPercentRange).toBeNull();
  });

  /** A missing stats sidecar is a bug, but zero is still the honest number to serve. */
  it("serves zeroed counters when the stats sidecar is missing", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    seedFullTree();
    databaseState.childRowsByTable.teardown_stats = [];
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    expect(result.success, "the teardown must be found").toBe(true);
    if (!result.success) return;

    expect(result.value.viewCount).toBe(0);
    expect(result.value.likeCount).toBe(0);
    expect(result.value.commentCount).toBe(0);
    expect(result.value.saveCount).toBe(0);
  });

  /** The three instants travel as ISO strings, which is what the frontend's `z.iso.datetime()` parses. */
  it("serialises the instants as ISO strings", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    seedFullTree();
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    expect(result.success, "the teardown must be found").toBe(true);
    if (!result.success) return;

    expect(result.value.createdAt).toBe(CREATED_AT.toISOString());
    expect(result.value.provenance.surveyedAt).toBe(SURVEYED_AT.toISOString());
    expect(result.value.provenance.attestationAcceptedAt).toBe(ATTESTED_AT.toISOString());
  });

  /**
   * `video_source` carries `hosted`, but `BlueprintVideoSchema` is a ONE-ARM union — a `hosted` row
   * would be a detail-page parse failure in the browser, not a field the page ignores. The column
   * CHECK makes this unreachable; dropping the video is the right answer the day it is widened.
   */
  it("drops a walkthrough video whose source is not youtube", async () => {
    databaseState.teardownRows = [buildTeardownRow({ walkthroughVideoSource: "hosted" })];
    seedFullTree();
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");
    expect(result.success, "the teardown must be found").toBe(true);
    if (!result.success) return;

    expect(result.value.walkthroughVideo).toBeNull();
  });

  it("answers not found for a slug no readable teardown carries", async () => {
    const { getPublicTeardownBySlug } = await importService();

    const result = await getPublicTeardownBySlug("no-such-teardown");

    expect(result.success).toBe(false);
    expect(result.success ? null : result.error.type).toBe("TEARDOWN_NOT_FOUND");
  });

  /** Steps by number and parts by position, so the page cannot render a disassembly out of order. */
  it("orders the steps by number and the parts by position", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    seedFullTree();
    const { getPublicTeardownBySlug } = await importService();

    await getPublicTeardownBySlug("solar-cold-storage-controller-teardown");

    const stepOrder =
      databaseState.queries.find((query) => query.tableName === "teardown_assembly_step")?.orderByText ?? "";
    const partOrder = databaseState.queries.find((query) => query.tableName === "teardown_part")?.orderByText ?? "";

    expect(stepOrder, "steps must be ordered by step number").toContain("step_number");
    expect(partOrder, "parts must be ordered by position").toContain("position");
  });
});

describe("the index's filters and paging", () => {
  it("binds the tag as an array element rather than a substring", async () => {
    const { listPublicTeardowns } = await importService();

    await listPublicTeardowns({ ...NO_FILTERS, tag: "solar" });

    expect(teardownTableQuery()?.conditionText).toContain("solar");
  });

  it("binds the difficulty filter", async () => {
    const { listPublicTeardowns } = await importService();

    await listPublicTeardowns({ ...NO_FILTERS, difficulty: "advanced" });

    expect(teardownTableQuery()?.conditionText).toContain("advanced");
  });

  /** Three predicates over the data, never three stored booleans nobody keeps true. */
  it("turns each media filter into its own predicate", async () => {
    const { listPublicTeardowns } = await importService();

    /*
     * A semi-join shows up as a SUBQUERY the service built, which the stub sees as its own
     * `select().from()` — so counting the queries against a child table is a direct reading of
     * whether `EXISTS` was used, without depending on how drizzle lays out a condition tree.
     */
    function semiJoinCount(tableName: string): number {
      return databaseState.queries.filter(
        (query) => query.tableName === tableName && query.selectedColumns.includes("present"),
      ).length;
    }

    await listPublicTeardowns({ ...NO_FILTERS, media: "assembly" });
    const assemblySemiJoins = semiJoinCount("teardown_assembly");

    resetDatabaseState();
    await listPublicTeardowns({ ...NO_FILTERS, media: "documents" });
    const documentSemiJoins = semiJoinCount("teardown_document");

    resetDatabaseState();
    await listPublicTeardowns({ ...NO_FILTERS, media: "video" });
    const videoSemiJoins = semiJoinCount("teardown_assembly") + semiJoinCount("teardown_document");
    const videoCondition = teardownTableQuery()?.conditionText ?? "";

    resetDatabaseState();
    await listPublicTeardowns(NO_FILTERS);
    const unfilteredCondition = teardownTableQuery()?.conditionText ?? "";

    expect(assemblySemiJoins, "?media=assembly must semi-join the assembly table").toBe(1);
    expect(documentSemiJoins, "?media=documents must semi-join the document table").toBe(1);
    expect(videoSemiJoins, "?media=video must answer from a column, not a semi-join").toBe(0);
    expect(videoCondition, "?media=video must still add a predicate of its own").not.toEqual(unfilteredCondition);
  });

  it("over-fetches one row beyond the requested limit", async () => {
    const { listPublicTeardowns } = await importService();

    await listPublicTeardowns({ ...NO_FILTERS, limit: 8 });

    expect(teardownTableQuery()?.limit).toBe(9);
  });

  it("trims the over-fetched row and reports that more remain", async () => {
    databaseState.teardownRows = [
      buildTeardownRow({ id: "teardown_1" }),
      buildTeardownRow({ id: "teardown_2" }),
      buildTeardownRow({ id: "teardown_3" }),
    ];
    const { listPublicTeardowns } = await importService();

    const page = await listPublicTeardowns({ ...NO_FILTERS, limit: 2 });

    expect(page.success && page.value.items).toHaveLength(2);
    expect(page.success && page.value.page.hasMore).toBe(true);
  });

  /** Encoding the over-fetched row would skip a teardown on every page boundary. */
  it("mints the cursor from the last returned row, not the over-fetched one", async () => {
    databaseState.teardownRows = [
      buildTeardownRow({ id: "teardown_1" }),
      buildTeardownRow({ id: "teardown_2" }),
      buildTeardownRow({ id: "teardown_3" }),
    ];
    const { listPublicTeardowns } = await importService();

    const page = await listPublicTeardowns({ ...NO_FILTERS, limit: 2 });

    expect(page.success && page.value.page.nextCursor).toBe(`${String(CREATED_AT.getTime())}_teardown_2`);
  });

  it("reports no cursor on a short page", async () => {
    databaseState.teardownRows = [buildTeardownRow()];
    const { listPublicTeardowns } = await importService();

    const page = await listPublicTeardowns(NO_FILTERS);

    expect(page.success && page.value.page).toEqual({ nextCursor: null, hasMore: false });
  });

  /**
   * ⚠️ THE KEYSET IS MIXED-DIRECTION — `created_at DESC, id ASC` — so the predicate must bind BOTH
   * the instant and the id. Binding the instant alone skips or repeats whichever row loses a tie.
   */
  it("binds the cursor's instant and id into the keyset predicate", async () => {
    const { listPublicTeardowns } = await importService();

    await listPublicTeardowns({
      ...NO_FILTERS,
      cursor: `${String(CREATED_AT.getTime())}_teardown_7`,
    });

    const condition = teardownTableQuery()?.conditionText ?? "";
    expect(condition).toContain(`date:${CREATED_AT.toISOString()}`);
    expect(condition).toContain("teardown_7");
  });

  it("orders by the created instant and then the id", async () => {
    const { listPublicTeardowns } = await importService();

    await listPublicTeardowns(NO_FILTERS);

    const orderByText = teardownTableQuery()?.orderByText ?? "";
    expect(orderByText).toContain("created_at");
    expect(orderByText).toContain("id");
  });

  /** Refused, never a silent first page: a list that quietly restarts shows the reader duplicates. */
  it("refuses a cursor this server did not mint", async () => {
    const { listPublicTeardowns } = await importService();

    const page = await listPublicTeardowns({ ...NO_FILTERS, cursor: "not-a-cursor" });

    expect(page.success).toBe(false);
    expect(page.success ? null : page.error.type).toBe("TEARDOWN_INDEX_CURSOR_MALFORMED");
  });

  /**
   * The facets are counted over the whole listable category, never the page and never the active
   * filter. Counting under `?tag=` would make every chip but the selected one read zero.
   */
  it("counts the facets over the category rather than the filtered page", async () => {
    databaseState.facetRows = [{ value: "solar", count: 7 }];
    const { listPublicTeardowns } = await importService();

    await listPublicTeardowns({ ...NO_FILTERS, tag: "solar", difficulty: "advanced" });

    const facetCondition = facetQuery()?.conditionText ?? "";
    expect(facetQuery()?.grouped, "the facet query must group").toBe(true);
    expect(facetCondition, "the facets must ignore the active tag").not.toContain("solar");
    expect(facetCondition, "the facets must ignore the active difficulty").not.toContain("advanced");
  });
});

describe("the claim targets", () => {
  /**
   * ⚠️ IDS AND TITLES, AND NOTHING THAT COULD BE A LINK. This route is the one way a rights holder
   * can still name a specific file on a teardown whose payload is withheld, so it has to be
   * provably incapable of handing that file over.
   */
  it("serves ids and titles with no URL-shaped value anywhere", async () => {
    databaseState.teardownRows = [buildTeardownRow({ moderationState: "quarantined" })];
    databaseState.childRowsByTable = {
      teardown_document: [buildDocumentRow()],
      teardown_manufacturing_file: [buildManufacturingFileRow()],
      teardown_part: [buildCompositePartRow()],
    };
    const { getTeardownClaimTargets } = await importService();

    const result = await getTeardownClaimTargets("solar-cold-storage-controller-teardown");
    expect(result.success, "a quarantined teardown must still accept a claim").toBe(true);
    if (!result.success) return;

    const serialised = JSON.stringify(result.value);
    expect(serialised, "no https link may appear").not.toContain("https:");
    expect(serialised, "no site-relative asset path may appear").not.toContain("/dummy/");
    expect(result.value.documents.map((document) => document.id)).toEqual(["doc_1"]);
    expect(result.value.manufacturingFiles.map((file) => file.title)).toEqual(["Housing STEP"]);
    expect(result.value.parts.map((part) => part.label)).toEqual(["Housing shell"]);
  });

  it("answers not found for a teardown no reader may reach", async () => {
    const { getTeardownClaimTargets } = await importService();

    const result = await getTeardownClaimTargets("no-such-teardown");

    expect(result.success).toBe(false);
    expect(result.success ? null : result.error.type).toBe("TEARDOWN_NOT_FOUND");
  });
});
