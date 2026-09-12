import { getTableName, is, Table } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ⚠️ ONE FILE, ONE JOB: fail if a withheld company name ever reaches a reader.
 *
 * A first-hand writer may keep a company's name from READERS — an NDA is the ordinary reason — and a
 * moderator still sees it. `toPublicCompany` in the read service is the only thing standing between
 * those two facts, and a serializer is exactly the kind of guarantee that rots one read at a time:
 * somebody adds a fifth public read, forgets the call, and every other test in the suite stays
 * green.
 *
 * SO THIS TEST DOES NOT MOCK THE SERVICE. It mocks the DATABASE, puts a distinctive sentinel in the
 * one column that is supposed to be withheld, and drives the REAL routes through the REAL
 * controllers and the REAL serializer with supertest — then sweeps the RAW RESPONSE BYTES. Anything
 * less proves only that a mock returned what it was handed.
 *
 * ⚠️ AND IT ASSERTS THE OTHER DIRECTION TOO. A test that only proves absence passes on a serializer
 * that dropped the field entirely, or on a read that returns no companies at all — both of which
 * would break the page while looking like a security win. So the moderator queue must return the
 * sentinel, and the public reads must still return the company's OTHER fields.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * The needle. Distinctive enough that a substring hit cannot be a coincidence, and deliberately
 * unlike anything else in the fixture below.
 */
const WITHHELD_NAME_SENTINEL = "Zarquon Precision Toolroom";
/** The company beside it, which a reader IS meant to see — the control for the sweep. */
const NAMED_COMPANY = "Norrfall Bracketworks";

const CREATED_AT = new Date("2026-03-04T09:00:00.000Z");
const CASE_STUDY_SLUG = "budget-for-the-second-mould";

/** The chainable stand-in for a drizzle query builder — awaitable, every method returns itself. */
interface QueryBuilderStub extends Promise<Record<string, unknown>[]> {
  from: (table: unknown) => QueryBuilderStub;
  innerJoin: () => QueryBuilderStub;
  leftJoin: () => QueryBuilderStub;
  groupBy: () => QueryBuilderStub;
  orderBy: () => QueryBuilderStub;
  limit: () => QueryBuilderStub;
  where: () => QueryBuilderStub;
  for: () => QueryBuilderStub;
}

const databaseState = vi.hoisted((): { rowsByTable: Record<string, Record<string, unknown>[]> } => ({
  rowsByTable: {},
}));

const selectMock = vi.fn<(columns?: unknown) => unknown>((columns) => {
  const selectedColumns = Object.keys(columns ?? {});

  let settleRows: ((rows: Record<string, unknown>[]) => void) | undefined;
  const rowsPromise = new Promise<Record<string, unknown>[]>((resolve) => {
    settleRows = resolve;
  });

  const builder: QueryBuilderStub = Object.assign(rowsPromise, {
    from: (table: unknown) => {
      if (!is(table, Table)) throw new Error("select().from() was handed something that is not a table");
      const tableName = getTableName(table);
      const rows = databaseState.rowsByTable[tableName] ?? [];
      /*
       * PROJECTED TO THE SELECTED COLUMNS, which matters more here than anywhere else: a stub that
       * handed back whole rows would put the sentinel in a payload the real query never selected,
       * and the sweep would fail on correct code.
       */
      settleRows?.(
        selectedColumns.length === 0
          ? rows
          : rows.map((row) =>
              Object.fromEntries(selectedColumns.flatMap((column) => (column in row ? [[column, row[column]]] : []))),
            ),
      );
      return builder;
    },
    innerJoin: () => builder,
    leftJoin: () => builder,
    groupBy: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    where: () => builder,
    for: () => builder,
  });
  return builder;
});

vi.mock("#src/db/index.js", () => ({ db: { select: selectMock } }));

/** Granted, so the queue is reachable — the point here is the payload, not the gate. */
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: () =>
    Promise.resolve({
      success: true,
      value: { staffUserId: "user_moderator", platformRole: "admin" },
    }),
}));

function buildCaseStudyRow(): Record<string, unknown> {
  return {
    caseStudy: {
      id: "case_study_1",
      publicSlug: CASE_STUDY_SLUG,
      title: "Budget for a second mould, not a perfect first one",
      titleNormalized: "budget for a second mould, not a perfect first one",
      oneLineAction: "Plan the bridge tool into the schedule.",
      summary: "A cable bracket had eleven mounting variants and no way to test them.",
      problem: "Committing to steel meant committing to a variant list.",
      context: "A three-person spin-out working with a local mould shop.",
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
      authorAvatarUrl: null,
      moderationState: "published",
      moderatorNote: null,
      reviewedByUserId: null,
      reviewedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    accountDisplayName: null,
    accountHandle: null,
    accountAvatarUrl: null,
    // The moderator queue selects these two aliases from its inner join.
    authorDisplayName: "Amara",
    authorHandle: "amara-builds",
  };
}

/** Two companies: one withheld — the needle — and one named, which must survive. */
function buildCompanyRows(): Record<string, unknown>[] {
  return [
    {
      id: "company_1",
      caseStudyId: "case_study_1",
      position: 0,
      name: NAMED_COMPANY,
      isNameWithheld: false,
      authorRelationship: "first_hand",
      locationLabel: "Gothenburg",
      yearLabel: "2024",
    },
    {
      id: "company_2",
      caseStudyId: "case_study_1",
      position: 1,
      name: WITHHELD_NAME_SENTINEL,
      isNameWithheld: true,
      authorRelationship: "first_hand",
      locationLabel: "Bergen",
      yearLabel: "2024",
    },
  ];
}

function seedOneCaseStudy(): void {
  databaseState.rowsByTable = {
    case_study: [buildCaseStudyRow()],
    case_study_stats: [{ caseStudyId: "case_study_1", viewCount: 120, likeCount: 9, updatedAt: CREATED_AT }],
    case_study_action_step: [{ id: "step_1", caseStudyId: "case_study_1", position: 0, body: "Quoted a bridge tool" }],
    case_study_pitfall: [
      {
        id: "pitfall_1",
        caseStudyId: "case_study_1",
        position: 0,
        body: "Assumed the steel quote would hold",
      },
    ],
    case_study_evidence_company: buildCompanyRows(),
    case_study_outcome_metric: [
      {
        id: "metric_1",
        caseStudyId: "case_study_1",
        position: 0,
        label: "Units shipped",
        kind: "count",
        countAmount: 4200,
        moneyAmountCents: null,
        moneyCurrency: null,
        basisPoints: null,
      },
    ],
    case_study_source: [
      {
        id: "source_1",
        caseStudyId: "case_study_1",
        position: 0,
        label: "Run-by-run cost breakdown",
        publisherLabel: "Norrfall build log",
        url: "https://example.test/qatoto/run-costs",
      },
    ],
    case_study_related_lesson: [],
  };
}

/** Every public case-study route, so a new one added without a sweep entry is a visible omission. */
const PUBLIC_CASE_STUDY_PATHS = [
  "/blueprints/case-studies",
  "/blueprints/case-studies?discipline=tooling",
  "/blueprints/case-studies/options",
  "/blueprints/case-studies/slugs",
  `/blueprints/case-studies/${CASE_STUDY_SLUG}`,
] as const;

describe("the withheld company name", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    seedOneCaseStudy();
    signOut();
    await resetRateLimiters();
  });

  /**
   * ⚠️ THE SWEEP. Raw bytes, every public route, signed out — which is how a reader arrives.
   */
  it("appears in no public response body", async () => {
    const leakingPaths: string[] = [];

    for (const path of PUBLIC_CASE_STUDY_PATHS) {
      const response = await request(app).get(path);
      const rawBody = JSON.stringify(response.body);
      if (rawBody.includes(WITHHELD_NAME_SENTINEL)) leakingPaths.push(path);
    }

    expect(leakingPaths, "no public route may serve a withheld company name").toEqual([]);
  });

  /** Signed IN changes nothing: these reads take no session, so there is nothing to personalise. */
  it("appears in no public response body for a signed-in reader either", async () => {
    signInAs();
    const leakingPaths: string[] = [];

    for (const path of PUBLIC_CASE_STUDY_PATHS) {
      const response = await request(app).get(path);
      if (JSON.stringify(response.body).includes(WITHHELD_NAME_SENTINEL)) leakingPaths.push(path);
    }

    expect(leakingPaths, "being signed in must not unlock a withheld name").toEqual([]);
  });

  /**
   * ⚠️ THE OTHER DIRECTION, WITHOUT WHICH THE SWEEP IS NEARLY WORTHLESS. A serializer that dropped
   * `evidenceCompanies` entirely, or a read that returned no case studies at all, would pass the
   * sweep and break the page. So the withheld company must still be THERE, with `name: null` and
   * its place and year intact — that is what the detail page renders as "Name withheld".
   */
  it("still serves the withheld company as a row with a null name", async () => {
    const response = await request(app).get(`/blueprints/case-studies/${CASE_STUDY_SLUG}`);

    expect(response.status).toBe(200);
    expect(response.body.data.caseStudy.evidenceCompanies).toEqual([
      { name: NAMED_COMPANY, locationLabel: "Gothenburg", yearLabel: "2024" },
      { name: null, locationLabel: "Bergen", yearLabel: "2024" },
    ]);
  });

  /** And the named company must survive, or "withhold everything" would pass. */
  it("still serves a company whose name was not withheld", async () => {
    const response = await request(app).get(`/blueprints/case-studies/${CASE_STUDY_SLUG}`);

    expect(JSON.stringify(response.body)).toContain(NAMED_COMPANY);
  });

  it("serves the withheld company on the index too, with its name nulled", async () => {
    const response = await request(app).get("/blueprints/case-studies");

    expect(response.status).toBe(200);
    expect(response.body.data.items[0].evidenceCompanies).toEqual([
      { name: NAMED_COMPANY, locationLabel: "Gothenburg", yearLabel: "2024" },
      { name: null, locationLabel: "Bergen", yearLabel: "2024" },
    ]);
  });

  /**
   * ⚠️ THE MODERATOR MUST SEE IT. A company nobody at Qatoto can see is a claim nobody can check,
   * which is the whole reason the real name is stored rather than discarded. This is also the
   * assertion that distinguishes "withheld" from "deleted": if the serializer ever dropped the
   * field instead of nulling it, the sweep above would still pass and this would fail.
   */
  it("is returned to a moderator, with the withheld flag beside it", async () => {
    signInAs();

    const response = await request(app).get("/blueprints/admin/case-studies/review-queue");

    expect(response.status).toBe(200);
    const rawBody = JSON.stringify(response.body);
    expect(rawBody, "the review queue must serve the real name").toContain(WITHHELD_NAME_SENTINEL);
    expect(rawBody, "and the flag, so the card can mark it").toContain("isNameWithheld");
  });
});
