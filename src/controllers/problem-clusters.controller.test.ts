import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The service imports the db pool, which pulls in the config env parser; the jobs module
// pulls in pg-boss. Both are stubbed so these tests exercise the CONTROLLER only.
type ClustersService = typeof import("#src/services/problem-clusters.service.js");

vi.mock("#src/services/problem-clusters.service.js", () => ({
  listProblemClusters: vi.fn<ClustersService["listProblemClusters"]>(),
  findProblemCluster: vi.fn<ClustersService["findProblemCluster"]>(),
  createProblemSubmission: vi.fn<ClustersService["createProblemSubmission"]>(),
  checkCategoryUsable: vi.fn<ClustersService["checkCategoryUsable"]>(),
  listMyProblemSubmissions: vi.fn<ClustersService["listMyProblemSubmissions"]>(),
}));

vi.mock("#src/lib/jobs.js", () => ({
  sendJob: vi.fn<typeof import("#src/lib/jobs.js").sendJob>(),
  JOB_NAMES: { geocodeAndClusterSubmission: "geocode-and-cluster-submission" },
  idempotencyKeyFor: { geocodeAndClusterSubmission: (id: string) => `geocode:${id}` },
}));

const clustersService = await import("#src/services/problem-clusters.service.js");
const jobs = await import("#src/lib/jobs.js");
const { createProblemReport, listProblemClusters } = await import("#src/controllers/problem-clusters.controller.js");
const { CreateProblemReportSchema } = await import("#src/schemas/problem-clusters.schemas.js");

const checkCategoryUsableMock = vi.mocked(clustersService.checkCategoryUsable);
const createProblemSubmissionMock = vi.mocked(clustersService.createProblemSubmission);
const listProblemClustersMock = vi.mocked(clustersService.listProblemClusters);
const sendJobMock = vi.mocked(jobs.sendJob);

function createRequestStub(overrides: Partial<Request>): Request {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { body: {}, query: {}, params: {}, ...overrides } as unknown as Request;
}

/**
 * A full session user, because `req.user` is a complete shape and the controller must be
 * exercised against the real one. Only `id` is ever read — but building the whole thing
 * keeps the test honest about what the middleware actually attaches.
 */
function createSessionUser(userId: string): NonNullable<Request["user"]> {
  return {
    id: userId,
    email: `${userId}@example.invalid`,
    name: "Test Reporter",
    emailVerified: true,
    handle: null,
  };
}

function createResponseStub(): {
  readonly response: Response;
  readonly statusSpy: ReturnType<typeof vi.fn>;
  readonly jsonSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn<(body: unknown) => void>();
  const statusSpy = vi.fn<(code: number) => { json: typeof jsonSpy }>(() => ({ json: jsonSpy }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const response = { status: statusSpy, json: jsonSpy } as unknown as Response;
  return { response, statusSpy, jsonSpy };
}

const VALID_REPORT_BODY = {
  title: "Fresh produce spoils before reaching market",
  categoryId: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a01",
  description:
    "Vendors lose a third of their tomatoes and leafy greens in transit because no affordable cold storage exists.",
  locationText: "Nakuru, Kenya",
};

/**
 * THE ZERO-TRUST SWEEP (R_AND_D_BACKEND_STRUCTURE.md §17 step 7).
 *
 * §0 says the client never sends a value the server owns. `.strict()` is what enforces it,
 * and this suite is the proof — every key below is one the CURRENT frontend fabricates or
 * that an attacker would try, and every one must be a 422 rather than a silent overwrite.
 *
 * The four the live `report-problem-sheet.tsx` invents in the browser today are
 * `countryCode: ""`, `mapPosition: {50,50}`, `reportCount: 1` and `opportunityScore: 40`.
 */
describe("CreateProblemReportSchema — server-owned keys are rejected", () => {
  const REJECTED_SERVER_OWNED_KEYS: readonly (readonly [string, unknown])[] = [
    // Geography: server-geocoded, and it feeds the opportunity score.
    ["countryCode", "US"],
    ["latitudeMicrodegrees", 1_000_000],
    ["longitudeMicrodegrees", 1_000_000],
    ["mapPosition", { leftPercent: 50, topPercent: 50 }],
    // Ranking signals: job-computed, never asserted.
    ["opportunityScore", 99],
    ["opportunityScorePoints", 99],
    ["reportCount", 342],
    ["distinctReporterCount", 342],
    // Identity: §13 — every actor id is req.user.id and nothing else.
    ["reporterUserId", "some-other-user"],
    ["userId", "some-other-user"],
    // Lifecycle: owned by the clustering job.
    ["status", "clustered"],
    ["clusterId", "11111111-1111-4111-8111-111111111111"],
    ["clusteredAt", "2026-01-01T00:00:00.000Z"],
    // Moderator-owned.
    ["countsTowardDistinctReporters", true],
    ["pinIconKey", "water"],
  ];

  it.each(REJECTED_SERVER_OWNED_KEYS)("rejects a client-supplied %s", (keyName, value) => {
    const parsed = CreateProblemReportSchema.safeParse({
      ...VALID_REPORT_BODY,
      [keyName]: value,
    });

    expect(parsed.success).toBe(false);
    // `.strict()` reports unknown keys as an object-level issue naming the key, which is
    // what lets respondValidationFailed tell the client WHICH field was refused.
    // Stringifying the whole result avoids a conditional expect — an assertion inside a
    // narrowing branch silently passes when the branch is never entered, which for a
    // security sweep is the one failure mode that matters.
    expect(JSON.stringify(parsed)).toContain(keyName);
  });

  it("accepts the four legitimate fields and nothing else", () => {
    const parsed = CreateProblemReportSchema.safeParse(VALID_REPORT_BODY);

    expect(parsed).toEqual({
      success: true,
      data: {
        title: VALID_REPORT_BODY.title,
        categoryId: VALID_REPORT_BODY.categoryId,
        description: VALID_REPORT_BODY.description,
        locationText: VALID_REPORT_BODY.locationText,
      },
    });
  });

  it("rejects a location that is only whitespace", () => {
    expect(CreateProblemReportSchema.safeParse({ ...VALID_REPORT_BODY, locationText: "   " }).success).toBe(false);
  });
});

describe("createProblemReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("responds 401 before parsing, so an anonymous caller learns nothing about the schema", async () => {
    const { response, statusSpy } = createResponseStub();

    await createProblemReport(createRequestStub({ body: VALID_REPORT_BODY }), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(401);
    expect(checkCategoryUsableMock).not.toHaveBeenCalled();
  });

  it("responds 202 with a receipt, never a cluster or a score", async () => {
    checkCategoryUsableMock.mockResolvedValue({ usable: true });
    createProblemSubmissionMock.mockResolvedValue({
      submissionId: "sub-1",
      clusteringStatus: "queued",
      clusterId: null,
      submittedAt: "2026-07-21T00:00:00.000Z",
    });
    sendJobMock.mockResolvedValue({ success: true, value: { jobId: "job-1" } });

    const { response, statusSpy, jsonSpy } = createResponseStub();
    await createProblemReport(
      createRequestStub({ body: VALID_REPORT_BODY, user: createSessionUser("user-1") }),
      response,
    );

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(202);

    const [body] = jsonSpy.mock.calls[0] ?? [];
    const receipt = JSON.stringify(body);
    // The receipt must not carry any of the numbers that do not exist yet at 202 time —
    // returning a placeholder is exactly the fabrication §6 exists to stop.
    expect(receipt).not.toContain("opportunityScore");
    expect(receipt).not.toContain("distinctReporterCount");
    expect(receipt).not.toContain("countryCode");
  });

  it("stamps the reporter from the session, never from the body", async () => {
    checkCategoryUsableMock.mockResolvedValue({ usable: true });
    createProblemSubmissionMock.mockResolvedValue({
      submissionId: "sub-1",
      clusteringStatus: "queued",
      clusterId: null,
      submittedAt: "2026-07-21T00:00:00.000Z",
    });
    sendJobMock.mockResolvedValue({ success: true, value: { jobId: "job-1" } });

    const { response } = createResponseStub();
    await createProblemReport(
      createRequestStub({ body: VALID_REPORT_BODY, user: createSessionUser("session-user") }),
      response,
    );

    expect(createProblemSubmissionMock).toHaveBeenCalledExactlyOnceWith("session-user", VALID_REPORT_BODY);
  });

  it("refuses a rejected category as a 404, indistinguishable from one that never existed", async () => {
    // `research_category` has ONE rule across every writer: only `rejected` is refused, and it
    // collapses into NOT_FOUND so a rejected id cannot be told apart from a bogus one. A
    // `pending` category is deliberately accepted — it is a real row with a real id, and
    // blocking on it is what used to make proposing a category from a form pointless.
    checkCategoryUsableMock.mockResolvedValue({
      usable: false,
      error: { type: "CATEGORY_NOT_FOUND", categoryId: VALID_REPORT_BODY.categoryId },
    });

    const { response, statusSpy } = createResponseStub();
    await createProblemReport(
      createRequestStub({ body: VALID_REPORT_BODY, user: createSessionUser("user-1") }),
      response,
    );

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(404);
    expect(createProblemSubmissionMock).not.toHaveBeenCalled();
  });

  it("throws rather than returning 202 when the clustering job cannot be enqueued", async () => {
    // A 202 would promise processing that is not going to happen, leaving the reporter
    // polling "queued" forever with no error anywhere.
    checkCategoryUsableMock.mockResolvedValue({ usable: true });
    createProblemSubmissionMock.mockResolvedValue({
      submissionId: "sub-1",
      clusteringStatus: "queued",
      clusterId: null,
      submittedAt: "2026-07-21T00:00:00.000Z",
    });
    sendJobMock.mockResolvedValue({
      success: false,
      error: { type: "JOB_QUEUE_UNAVAILABLE", jobName: "geocode-and-cluster-submission" },
    });

    const { response } = createResponseStub();

    await expect(
      createProblemReport(createRequestStub({ body: VALID_REPORT_BODY, user: createSessionUser("user-1") }), response),
    ).rejects.toThrow(/could not be enqueued/);
  });
});

describe("listProblemClusters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a partial viewport with 422 rather than silently returning the planet", async () => {
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await listProblemClusters(createRequestStub({ query: { minLatitudeMicrodegrees: "1000" } }), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(422);
    expect(JSON.stringify(jsonSpy.mock.calls[0])).toContain("all four bounds");
    expect(listProblemClustersMock).not.toHaveBeenCalled();
  });

  it("accepts a complete viewport", async () => {
    listProblemClustersMock.mockResolvedValue({ rows: [], total: 0 });
    const { response, statusSpy } = createResponseStub();

    await listProblemClusters(
      createRequestStub({
        query: {
          minLatitudeMicrodegrees: "-1000",
          maxLatitudeMicrodegrees: "1000",
          minLongitudeMicrodegrees: "-1000",
          maxLongitudeMicrodegrees: "1000",
        },
      }),
      response,
    );

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(200);
    expect(listProblemClustersMock).toHaveBeenCalledOnce();
  });
});
