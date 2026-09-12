import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the eight case-study routes.
 *
 * WHAT THIS FILE OWNS: the query and body parses, the status codes, the four bare reads answering a
 * stranger, and the four guarded ones refusing one. The services are mocked here, so a case that
 * asserted a visibility gate or the withheld name would be asserting the mock —
 * `case-study-public-read.service.test.ts` owns the gate and
 * `case-study-withheld-name.test.ts` owns the name, and that one deliberately mocks the DATABASE
 * instead so the real serializer runs.
 *
 * ⚠️ TWO GUARANTEES HERE ARE SECURITY PROPERTIES, each with its own case:
 *
 *   1. `moderate_content` is proven BEFORE any submission id or query is read. Reversed, a 403 that
 *      only arrives for case studies that exist turns the moderator routes into an existence oracle
 *      over pending submissions — other people's unpublished work. Asserted by sending a
 *      non-moderator a request that is ALSO malformed and requiring 403 rather than 422.
 *   2. A duplicate-title 409 names the FIELD and no byte of the clashing row, for the same reason.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` reads the account's identification state from the database, which the
 * harness stubs as `{}`. Passed through so these cases test the routes rather than that guard — it
 * has its own coverage in `src/middleware/require-identified-user.test.ts`.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

/**
 * A real in-memory idempotency implementation rather than a pass-through, because both write routes
 * declare `required: true` — the 400 for a missing key is part of their contract.
 */
const idempotencyResponses = vi.hoisted(
  () => new Map<string, { fingerprint: string; statusCode: number; body: unknown }>(),
);

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const header = req.header("Idempotency-Key");
      if (!header && options.required === true) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "This request requires an Idempotency-Key header.",
        });
        return;
      }
      if (!header) {
        next();
        return;
      }
      const fingerprint = JSON.stringify(req.body);
      const cached = idempotencyResponses.get(header);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          res.status(409).json({
            status: "error",
            statusCode: 409,
            message: "This Idempotency-Key was already used for a different request.",
          });
          return;
        }
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }

      const originalJson = res.json.bind(res);
      res.json = (body: unknown): Response => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          idempotencyResponses.set(header, { fingerprint, statusCode: res.statusCode, body });
        }
        return originalJson(body);
      };
      next();
    },
}));

const requirePlatformCapability = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (...args: readonly unknown[]) => requirePlatformCapability(...args),
}));

const listPublicCaseStudies = vi.fn<(...args: readonly unknown[]) => unknown>();
const getPublicCaseStudyBySlug = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPublicCaseStudySlugs = vi.fn<(...args: readonly unknown[]) => unknown>();
const listCaseStudyOptions = vi.fn<(...args: readonly unknown[]) => unknown>();
const findUnresolvableRelatedSlugs = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/case-study-public-read.service.js", () => ({
  listPublicCaseStudies: (...args: readonly unknown[]) => listPublicCaseStudies(...args),
  getPublicCaseStudyBySlug: (...args: readonly unknown[]) => getPublicCaseStudyBySlug(...args),
  listPublicCaseStudySlugs: (...args: readonly unknown[]) => listPublicCaseStudySlugs(...args),
  listCaseStudyOptions: (...args: readonly unknown[]) => listCaseStudyOptions(...args),
  findUnresolvableRelatedSlugs: (...args: readonly unknown[]) => findUnresolvableRelatedSlugs(...args),
}));

const submitCaseStudy = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyCaseStudies = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/case-study-submission.service.js", () => ({
  submitCaseStudy: (...args: readonly unknown[]) => submitCaseStudy(...args),
  listMyCaseStudies: (...args: readonly unknown[]) => listMyCaseStudies(...args),
}));

const listCaseStudyReviewQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const decideCaseStudy = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/case-study-moderation.service.js", () => ({
  listCaseStudyReviewQueue: (...args: readonly unknown[]) => listCaseStudyReviewQueue(...args),
  decideCaseStudy: (...args: readonly unknown[]) => decideCaseStudy(...args),
}));

const MODERATOR_CONTEXT = {
  success: true,
  value: { staffUserId: "user_test_caller", platformRole: "admin" },
} as const;

const CAPABILITY_REFUSED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

const EMPTY_INDEX = {
  success: true,
  value: { items: [], page: { nextCursor: null, hasMore: false } },
} as const;

const CASE_STUDY_SLUG = "budget-for-the-second-mould";

/** A submission the gate accepts. Every write case changes exactly one thing about it. */
function buildValidSubmission(): Record<string, unknown> {
  return {
    title: "Budget for the second mould before the first one ships",
    oneLineAction: "Put the bridge tool in the schedule before committing to steel.",
    discipline: "tooling",
    sector: "Industrial components",
    outcomeSummary: null,
    authorRelationship: "first_hand",
    summary:
      "A cable bracket had eleven mounting variants and no way to know which the market wanted before parts existed.",
    problem: "Committing to steel meant committing to a variant list nobody had tested.",
    context: "A three-person spin-out working with a local mould shop.",
    actionSteps: ["Quoted a bridge tool"],
    pitfalls: [],
    evidenceCompanies: [],
    timelineLabel: null,
    capitalRaised: null,
    outcomeMetrics: [],
    sources: [],
    relatedLessonSlugs: [],
    tags: [],
    acceptedStatementIds: ["was_part_of_it", "figures_from_records"],
  };
}

describe("blueprints case-study routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyResponses.clear();
    signOut();
    await resetRateLimiters();
  });

  describe("GET /blueprints/case-studies", () => {
    const path = "/blueprints/case-studies";

    it("answers a signed-out visitor with 200", async () => {
      listPublicCaseStudies.mockResolvedValue(EMPTY_INDEX);

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
    });

    /** Six, because ten fixtures at six per page is two pages and the paging control renders. */
    it("defaults to a six-case-study page with no filter", async () => {
      listPublicCaseStudies.mockResolvedValue(EMPTY_INDEX);

      await request(app).get(path);

      expect(listPublicCaseStudies).toHaveBeenCalledWith({
        discipline: undefined,
        limit: 6,
        cursor: undefined,
      });
    });

    it("passes the discipline filter through", async () => {
      listPublicCaseStudies.mockResolvedValue(EMPTY_INDEX);

      await request(app).get(path).query({ discipline: "quality" });

      expect(listPublicCaseStudies).toHaveBeenCalledWith(expect.objectContaining({ discipline: "quality" }));
    });

    /**
     * ⚠️ THIS SURFACE OFFERS NO SORT CONTROL, so `?sort=` must be DROPPED rather than honoured —
     * honouring it would return a page in an order the caller was never shown. The same `.strip()`
     * is what lets a shared link keep its tracking parameters.
     */
    it("ignores an unknown sort parameter rather than honouring it", async () => {
      listPublicCaseStudies.mockResolvedValue(EMPTY_INDEX);

      const response = await request(app).get(path).query({ sort: "top" });

      expect(response.status).toBe(200);
      expect(listPublicCaseStudies).toHaveBeenCalledWith(expect.not.objectContaining({ sort: "top" }));
    });

    it("ignores a tracking parameter rather than refusing the request", async () => {
      listPublicCaseStudies.mockResolvedValue(EMPTY_INDEX);

      const response = await request(app).get(path).query({ utm_source: "newsletter" });

      expect(response.status).toBe(200);
    });

    it("answers 422 for a limit above the maximum", async () => {
      const response = await request(app).get(path).query({ limit: "999" });

      expect(response.status).toBe(422);
      expect(listPublicCaseStudies).not.toHaveBeenCalled();
    });

    it("answers 422 for a discipline outside the enum", async () => {
      const response = await request(app).get(path).query({ discipline: "vibes" });

      expect(response.status).toBe(422);
      expect(listPublicCaseStudies).not.toHaveBeenCalled();
    });

    /** Refused, never a silent first page: a list that quietly restarts shows duplicates. */
    it("answers 422 for a cursor the server did not mint", async () => {
      listPublicCaseStudies.mockResolvedValue({
        success: false,
        error: { type: "CASE_STUDY_INDEX_CURSOR_MALFORMED" },
      });

      const response = await request(app).get(path).query({ cursor: "not-a-cursor" });

      expect(response.status).toBe(422);
    });

    it("passes a well-formed cursor through", async () => {
      listPublicCaseStudies.mockResolvedValue(EMPTY_INDEX);
      const cursor = encodeInstantCursor({
        instant: new Date("2026-03-04T09:00:00.000Z"),
        id: "case_study_2",
      });

      await request(app).get(path).query({ cursor });

      expect(listPublicCaseStudies).toHaveBeenCalledWith(expect.objectContaining({ cursor }));
    });
  });

  describe("the two literal reads", () => {
    it("answers options with 200 and the slug-title pairs", async () => {
      listCaseStudyOptions.mockResolvedValue([{ slug: CASE_STUDY_SLUG, title: "Budget for one" }]);

      const response = await request(app).get("/blueprints/case-studies/options");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ slug: CASE_STUDY_SLUG, title: "Budget for one" }]);
      expect(getPublicCaseStudyBySlug, "options must not be captured as a slug").not.toHaveBeenCalled();
    });

    it("answers slugs with 200 and the slug list", async () => {
      listPublicCaseStudySlugs.mockResolvedValue(["one-a", "two-b"]);

      const response = await request(app).get("/blueprints/case-studies/slugs");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(["one-a", "two-b"]);
      expect(getPublicCaseStudyBySlug, "slugs must not be captured as a slug").not.toHaveBeenCalled();
    });
  });

  describe("GET /blueprints/case-studies/:caseStudySlug", () => {
    it("answers a signed-out visitor with 200 and an envelope", async () => {
      getPublicCaseStudyBySlug.mockResolvedValue({
        success: true,
        value: {
          caseStudy: { slug: CASE_STUDY_SLUG, title: "Budget for one" },
          relatedLessons: [{ slug: "read-the-returns-first", title: "Read the returns first" }],
        },
      });

      const response = await request(app).get(`/blueprints/case-studies/${CASE_STUDY_SLUG}`);

      expect(response.status).toBe(200);
      expect(response.body.data.caseStudy.slug).toBe(CASE_STUDY_SLUG);
      expect(response.body.data.relatedLessons).toHaveLength(1);
      expect(getPublicCaseStudyBySlug).toHaveBeenCalledWith(CASE_STUDY_SLUG);
    });

    /**
     * ⚠️ A MALFORMED SLUG IS A 404, AND THE DATABASE IS NEVER ASKED. A 422 here beside a 404 for a
     * well-formed miss would tell a stranger which slug shapes are real. Not calling the service is
     * the second half: a shape refusal that still hit the read would be an oracle with a timing
     * side channel instead of a status one.
     */
    it("answers 404 without touching the service for a malformed slug", async () => {
      const response = await request(app).get("/blueprints/case-studies/Not_A_Slug");

      expect(response.status).toBe(404);
      expect(getPublicCaseStudyBySlug).not.toHaveBeenCalled();
    });

    it("answers 404 for a well-formed slug nothing visible carries", async () => {
      getPublicCaseStudyBySlug.mockResolvedValue({
        success: false,
        error: { type: "CASE_STUDY_NOT_FOUND" },
      });

      const response = await request(app).get("/blueprints/case-studies/no-such-lesson");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /blueprints/case-studies", () => {
    const path = "/blueprints/case-studies";

    it("answers 401 for a signed-out caller", async () => {
      const response = await request(app).post(path).set("Idempotency-Key", "key-1").send(buildValidSubmission());

      expect(response.status).toBe(401);
      expect(submitCaseStudy).not.toHaveBeenCalled();
    });

    it("answers 400 without an Idempotency-Key", async () => {
      signInAs();

      const response = await request(app).post(path).send(buildValidSubmission());

      expect(response.status).toBe(400);
      expect(submitCaseStudy).not.toHaveBeenCalled();
    });

    /** A 202 is a receipt, not a row: no slug and no public URL, because neither exists yet. */
    it("answers 202 with a receipt carrying no slug", async () => {
      signInAs();
      submitCaseStudy.mockResolvedValue({
        success: true,
        value: {
          submissionId: "case_study_1",
          moderationState: "pending_review",
          receivedAt: new Date("2026-09-12T10:00:00.000Z"),
        },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "key-1").send(buildValidSubmission());

      expect(response.status).toBe(202);
      expect(response.body.data).toEqual({
        submissionId: "case_study_1",
        moderationState: "pending_review",
        receivedAt: "2026-09-12T10:00:00.000Z",
      });
    });

    /**
     * ⚠️ THE RECEIPT MUST NOT ECHO THE SUBMISSION. `idempotency.ts` stores whole 2xx bodies for
     * replay, so a handler that returned what it was sent would put a company name — possibly a
     * withheld one — into a cache keyed by a header the client chose.
     */
    it("echoes no part of the submission back", async () => {
      signInAs();
      submitCaseStudy.mockResolvedValue({
        success: true,
        value: {
          submissionId: "case_study_1",
          moderationState: "pending_review",
          receivedAt: new Date("2026-09-12T10:00:00.000Z"),
        },
      });
      const submission = {
        ...buildValidSubmission(),
        evidenceCompanies: [
          {
            name: "Zarquon Precision Toolroom",
            isNameWithheld: true,
            locationLabel: "Bergen",
            yearLabel: "2024",
          },
        ],
      };

      const response = await request(app).post(path).set("Idempotency-Key", "key-1").send(submission);

      const rawBody = JSON.stringify(response.body);
      expect(rawBody, "no company name may come back").not.toContain("Zarquon");
      expect(rawBody, "not even the title").not.toContain("Budget for the second mould");
    });

    it("answers 422 for a submission the gate refuses, keyed to the field", async () => {
      signInAs();

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-1")
        .send({ ...buildValidSubmission(), title: "Too short" });

      expect(response.status).toBe(422);
      expect(response.body.errors).toHaveProperty("title");
      expect(submitCaseStudy).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ THE 409 NAMES THE FIELD AND NO BYTE OF THE CLASHING ROW. Echoing the other case study's
     * title, author or slug would make a duplicate-title probe an existence oracle over pending
     * submissions — which are other people's unpublished work.
     */
    it("answers 409 for a taken title without disclosing the clashing row", async () => {
      signInAs();
      submitCaseStudy.mockResolvedValue({
        success: false,
        error: { type: "CASE_STUDY_TITLE_TAKEN" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "key-1").send(buildValidSubmission());

      expect(response.status).toBe(409);
      expect(response.body.errors).toHaveProperty("title");
      const rawBody = JSON.stringify(response.body);
      expect(rawBody, "no author").not.toContain("user_");
      expect(rawBody, "no slug").not.toContain("case-stud");
    });

    it("answers 422 naming the related lessons it could not resolve", async () => {
      signInAs();
      submitCaseStudy.mockResolvedValue({
        success: false,
        error: {
          type: "CASE_STUDY_RELATED_LESSON_UNRESOLVABLE",
          slugs: ["no-such-lesson"],
        },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "key-1").send(buildValidSubmission());

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.errors)).toContain("no-such-lesson");
    });
  });

  describe("GET /blueprints/case-studies/mine", () => {
    const path = "/blueprints/case-studies/mine";

    it("answers 401 for a signed-out caller", async () => {
      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listMyCaseStudies).not.toHaveBeenCalled();
    });

    it("answers 200 scoped to the caller", async () => {
      signInAs();
      listMyCaseStudies.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listMyCaseStudies).toHaveBeenCalledWith(expect.objectContaining({ authorUserId: "user_test_caller" }));
    });

    /** A writer reading their own submissions is not staff — asking would be the wrong gate. */
    it("never asks for a platform capability", async () => {
      signInAs();
      listMyCaseStudies.mockResolvedValue({
        success: true,
        value: { items: [], page: { nextCursor: null, hasMore: false } },
      });

      await request(app).get(path);

      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });
  });

  describe("GET /blueprints/admin/case-studies/review-queue", () => {
    const path = "/blueprints/admin/case-studies/review-queue";

    it("answers 401 for a signed-out caller without asking for a capability", async () => {
      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });

    it("answers 403 for a caller without moderate_content", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
      expect(requirePlatformCapability).toHaveBeenCalledWith("user_test_caller", "moderate_content");
      expect(listCaseStudyReviewQueue).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ THE CAPABILITY IS PROVEN BEFORE THE QUERY IS READ. This request is refusable two ways — the
     * caller is not a moderator AND `limit=999` is invalid — and it must come back 403. A 422 would
     * mean the query was parsed for a caller with no business on this route, and the same ordering
     * mistake on the decide route below would turn it into an existence oracle for submission ids.
     */
    it("answers 403 rather than 422 when the caller is refused AND the query is malformed", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).get(path).query({ limit: "999" });

      expect(response.status).toBe(403);
    });

    it("answers 200 for a moderator", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      listCaseStudyReviewQueue.mockResolvedValue({
        items: [],
        page: { nextCursor: null, hasMore: false },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
    });

    it("answers 422 for a malformed cursor rather than serving the first page", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await request(app).get(path).query({ cursor: "not-a-cursor" });

      expect(response.status).toBe(422);
      expect(listCaseStudyReviewQueue).not.toHaveBeenCalled();
    });
  });

  describe("POST /blueprints/admin/case-studies/:submissionId/moderate", () => {
    const path = "/blueprints/admin/case-studies/case_study_1/moderate";

    it("answers 401 for a signed-out caller without asking for a capability", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-1")
        .send({ decision: "published", moderatorNote: null });

      expect(response.status).toBe(401);
      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });

    /** The existence-oracle case, on the route where an id is in the path. */
    it("answers 403 rather than 422 when the caller is refused AND the body is malformed", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).post(path).set("Idempotency-Key", "key-1").send({ decision: "banana" });

      expect(response.status).toBe(403);
      expect(decideCaseStudy).not.toHaveBeenCalled();
    });

    it("answers 200 and records the decision", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideCaseStudy.mockResolvedValue({
        success: true,
        value: {
          submissionId: "case_study_1",
          moderationState: "published",
          publicSlug: CASE_STUDY_SLUG,
          decidedAt: new Date("2026-09-12T10:00:00.000Z"),
        },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-1")
        .send({ decision: "published", moderatorNote: null });

      expect(response.status).toBe(200);
      expect(response.body.data.publicSlug).toBe(CASE_STUDY_SLUG);
    });

    /** A send-back must say why: the note is the only thing the writer sees. */
    it("answers 422 for a rejection with no note", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-1")
        .send({ decision: "rejected", moderatorNote: "" });

      expect(response.status).toBe(422);
      expect(decideCaseStudy).not.toHaveBeenCalled();
    });

    it("answers 403 when the moderator wrote it", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideCaseStudy.mockResolvedValue({
        success: false,
        error: { type: "CASE_STUDY_SELF_MODERATION_FORBIDDEN" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-1")
        .send({ decision: "published", moderatorNote: null });

      expect(response.status).toBe(403);
    });

    it("answers 409 when the case study is already decided", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideCaseStudy.mockResolvedValue({
        success: false,
        error: { type: "CASE_STUDY_ALREADY_DECIDED", moderationState: "published" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-1")
        .send({ decision: "published", moderatorNote: null });

      expect(response.status).toBe(409);
    });

    it("answers 404 for a submission id nothing carries", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideCaseStudy.mockResolvedValue({
        success: false,
        error: { type: "CASE_STUDY_NOT_FOUND" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-1")
        .send({ decision: "published", moderatorNote: null });

      expect(response.status).toBe(404);
    });
  });
});
