import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the business forum's write surface (STORE_BACKEND_STRUCTURE.md §17),
 * mounted at `/community`. This module had NO test files of any kind until now.
 *
 * WHAT THE GAP COST, and why the dismissal route below is covered from both directions: the
 * frontend sent `{ note }` to `POST /admin/content-reports/:reportId/decisions` while
 * `DismissCommunityReportSchema` is `.strict()` and declares `reasonNote`. Every dismissal
 * in production answered 422. Nothing on either side of the wire noticed, because the
 * backend tests asserted against the backend's own schema and the frontend mocked the API —
 * a contract mismatch is invisible to both unless something drives the real route.
 *
 * NO CAPABILITY MIDDLEWARE on `/admin/*` (the routes file says so at length): `moderate_content`
 * is checked INSIDE the service before any id is read, so every 403 here is a mocked domain
 * error rather than a different middleware chain — and it is byte-identical for a real id
 * and a garbage one, which is the property that stops the route being an existence probe.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` queries `user`/`account`/`passkey` to prove the caller is not an
 * anonymous throwaway. Stubbed to a pass-through so this suite stays about routing, per the
 * precedent in `import-intelligence.routes.test.ts`; the guard has its own dedicated suite,
 * and `rate-limit-coverage.test.ts` still catches a route that drops it.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

/**
 * The real `idempotency` middleware records through `db`, which `databaseModuleMock()`
 * leaves inert — so a request actually carrying a key would 500 on the mock rather than on
 * anything this suite is about. Same `Map`-backed stand-in the commerce suites use.
 */
const idempotencyCache = vi.hoisted(() => new Map<string, { statusCode: number; body: unknown }>());

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const key = req.header("Idempotency-Key");
      if (!key) {
        if (options.required === true) {
          res.status(400).json({
            status: "error",
            statusCode: 400,
            message: "This request requires an Idempotency-Key header.",
          });
          return;
        }
        next();
        return;
      }
      const cached = idempotencyCache.get(key);
      if (cached) {
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          idempotencyCache.set(key, { statusCode: res.statusCode, body });
        }
        return originalJson(body);
      }) as typeof res.json;
      next();
    },
}));

const listForumThreads = vi.fn<(...args: readonly unknown[]) => unknown>();
const getForumThreadBySlug = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyForumThreads = vi.fn<(...args: readonly unknown[]) => unknown>();
const createForumThread = vi.fn<(...args: readonly unknown[]) => unknown>();
const createForumReply = vi.fn<(...args: readonly unknown[]) => unknown>();
const setAcceptedReply = vi.fn<(...args: readonly unknown[]) => unknown>();
const setReplyHelpfulVote = vi.fn<(...args: readonly unknown[]) => unknown>();
const createCommunityContentReport = vi.fn<(...args: readonly unknown[]) => unknown>();
const listForumModerationQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const moderateForumThread = vi.fn<(...args: readonly unknown[]) => unknown>();
const moderateForumReply = vi.fn<(...args: readonly unknown[]) => unknown>();
const listCommunityContentReports = vi.fn<(...args: readonly unknown[]) => unknown>();
const dismissCommunityContentReport = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/store/community/community-forum.service.js", () => ({
  // The two public reads live on `/store` rather than this router; included so the mocked
  // module still satisfies every import the controller makes.
  listForumThreads: (...args: readonly unknown[]) => listForumThreads(...args),
  getForumThreadBySlug: (...args: readonly unknown[]) => getForumThreadBySlug(...args),
  listMyForumThreads: (...args: readonly unknown[]) => listMyForumThreads(...args),
  createForumThread: (...args: readonly unknown[]) => createForumThread(...args),
  createForumReply: (...args: readonly unknown[]) => createForumReply(...args),
  setAcceptedReply: (...args: readonly unknown[]) => setAcceptedReply(...args),
  setReplyHelpfulVote: (...args: readonly unknown[]) => setReplyHelpfulVote(...args),
  createCommunityContentReport: (...args: readonly unknown[]) => createCommunityContentReport(...args),
  listForumModerationQueue: (...args: readonly unknown[]) => listForumModerationQueue(...args),
  moderateForumThread: (...args: readonly unknown[]) => moderateForumThread(...args),
  moderateForumReply: (...args: readonly unknown[]) => moderateForumReply(...args),
  listCommunityContentReports: (...args: readonly unknown[]) => listCommunityContentReports(...args),
  dismissCommunityContentReport: (...args: readonly unknown[]) => dismissCommunityContentReport(...args),
}));

const CALLER_ID = "user_test_caller";

/** `moderate_content` refused inside the service — the only shape a 403 takes here. */
const CAPABILITY_REQUIRED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

const NOT_FOUND = { success: false, error: { type: "NOT_FOUND" } } as const;

const EMPTY_PAGE = { items: [], nextCursor: null } as const;

const VALID_THREAD_BODY = {
  board: "sourcing",
  title: "Sourcing a CE-marked pump",
  body: "We need a supplier who can certify to EN 809 and ship to Rotterdam within eight weeks.",
};

describe("community forum routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication", () => {
    it.each([
      ["get", "/community/forum/threads/mine"],
      ["get", "/community/admin/forum/threads"],
      ["get", "/community/admin/content-reports"],
    ] as const)("answers 401 for a signed-out caller on %s %s", async (method, path) => {
      signOut();

      const response = await request(app)[method](path);

      expect(response.status).toBe(401);
      expect(listMyForumThreads).not.toHaveBeenCalled();
      expect(listForumModerationQueue).not.toHaveBeenCalled();
      expect(listCommunityContentReports).not.toHaveBeenCalled();
    });

    it("answers 401 for a signed-out caller creating a thread", async () => {
      signOut();

      const response = await request(app)
        .post("/community/forum/threads")
        .set("Idempotency-Key", "forum_thread_signed_out")
        .send(VALID_THREAD_BODY);

      expect(response.status).toBe(401);
      expect(createForumThread).not.toHaveBeenCalled();
    });

    it("answers 401 for a signed-out caller reporting content", async () => {
      signOut();

      const response = await request(app)
        .post("/community/reports")
        .send({ targetKind: "forum_thread", targetId: "thread_1", reason: "spam" });

      expect(response.status).toBe(401);
      expect(createCommunityContentReport).not.toHaveBeenCalled();
    });
  });

  describe("GET /community/forum/threads/mine", () => {
    const path = "/community/forum/threads/mine";

    it("passes the session author id and the default limit to the service", async () => {
      listMyForumThreads.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listMyForumThreads).toHaveBeenCalledWith({
        authorUserId: CALLER_ID,
        board: undefined,
        threadState: undefined,
        limit: 20,
        cursor: undefined,
      });
    });

    /**
     * `pending_review` is filterable HERE and nowhere else — it is exactly what an author
     * opens this list to find, and the public read omits it.
     */
    it("accepts pending_review as a threadState, unlike the public read", async () => {
      listMyForumThreads.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const response = await request(app).get(`${path}?threadState=pending_review&limit=5`);

      expect(response.status).toBe(200);
      expect(listMyForumThreads).toHaveBeenCalledWith(
        expect.objectContaining({ threadState: "pending_review", limit: 5 }),
      );
    });

    it("rejects a client-supplied authorUserId with 422 — the caller comes from the session", async () => {
      const response = await request(app).get(`${path}?authorUserId=someone_else`);

      expect(response.status).toBe(422);
      expect(listMyForumThreads).not.toHaveBeenCalled();
    });

    it("maps INVALID_CURSOR to 422", async () => {
      listMyForumThreads.mockResolvedValue({ success: false, error: { type: "INVALID_CURSOR" } });

      const response = await request(app).get(`${path}?cursor=nonsense`);

      expect(response.status).toBe(422);
    });
  });

  describe("POST /community/forum/threads", () => {
    const path = "/community/forum/threads";

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(VALID_THREAD_BODY);

      expect(response.status).toBe(400);
      expect(createForumThread).not.toHaveBeenCalled();
    });

    /**
     * 201 and the message says QUEUED, never "posted" or "live". `pending_review` is the
     * design, and a success message that overstated it would be the whole A10 problem again.
     */
    it("queues the thread for review and answers 201", async () => {
      createForumThread.mockResolvedValue({
        success: true,
        value: { id: "thread_1", threadState: "pending_review" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "forum_thread_1").send(VALID_THREAD_BODY);

      expect(response.status).toBe(201);
      expect(createForumThread).toHaveBeenCalledWith({
        authorUserId: CALLER_ID,
        activeOrganizationId: null,
        board: "sourcing",
        title: VALID_THREAD_BODY.title,
        body: VALID_THREAD_BODY.body,
      });
      expect(response.body.message).toBe("Thread queued for review.");
    });

    it("replays the cached response for a repeated Idempotency-Key", async () => {
      createForumThread.mockResolvedValue({ success: true, value: { id: "thread_1" } });

      const first = await request(app).post(path).set("Idempotency-Key", "forum_thread_retry").send(VALID_THREAD_BODY);
      const retry = await request(app).post(path).set("Idempotency-Key", "forum_thread_retry").send(VALID_THREAD_BODY);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.headers["idempotency-replayed"]).toBe("true");
      expect(createForumThread).toHaveBeenCalledTimes(1);
    });

    it("rejects a title below the eight-character floor with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "forum_thread_short_title")
        .send({ ...VALID_THREAD_BODY, title: "Pumps" });

      expect(response.status).toBe(422);
      expect(createForumThread).not.toHaveBeenCalled();
    });

    it("rejects a client-supplied authorUserId with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "forum_thread_injected_author")
        .send({ ...VALID_THREAD_BODY, authorUserId: "someone_else" });

      expect(response.status).toBe(422);
      expect(createForumThread).not.toHaveBeenCalled();
    });

    it("maps TITLE_UNUSABLE to 422 with the field named", async () => {
      createForumThread.mockResolvedValue({ success: false, error: { type: "TITLE_UNUSABLE" } });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "forum_thread_unusable")
        .send({ ...VALID_THREAD_BODY, title: "!!!!!!!!!!" });

      expect(response.status).toBe(422);
      expect(response.body.errors.title).toBeDefined();
    });
  });

  describe("POST /community/forum/threads/:threadId/replies", () => {
    const path = "/community/forum/threads/thread_1/replies";
    const validReply = { body: "EN 809 certification is the one to ask for." };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validReply);

      expect(response.status).toBe(400);
      expect(createForumReply).not.toHaveBeenCalled();
    });

    it("posts the reply against the path's thread and answers 201", async () => {
      createForumReply.mockResolvedValue({ success: true, value: { id: "reply_1" } });

      const response = await request(app).post(path).set("Idempotency-Key", "forum_reply_1").send(validReply);

      expect(response.status).toBe(201);
      expect(createForumReply).toHaveBeenCalledWith({
        threadId: "thread_1",
        authorUserId: CALLER_ID,
        activeOrganizationId: null,
        body: validReply.body,
      });
    });

    it("maps NOT_FOUND to 404 for a thread that does not exist", async () => {
      createForumReply.mockResolvedValue(NOT_FOUND);

      const response = await request(app).post(path).set("Idempotency-Key", "forum_reply_missing").send(validReply);

      expect(response.status).toBe(404);
    });

    it("maps INVALID_STATE to 409 and carries the service's own sentence", async () => {
      createForumReply.mockResolvedValue({
        success: false,
        error: { type: "INVALID_STATE", message: "This thread is locked." },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "forum_reply_locked").send(validReply);

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("This thread is locked.");
    });

    it("rejects an unknown body field with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "forum_reply_extra")
        .send({ ...validReply, threadId: "thread_elsewhere" });

      expect(response.status).toBe(422);
      expect(createForumReply).not.toHaveBeenCalled();
    });
  });

  describe("POST and DELETE /community/forum/threads/:threadId/accepted-reply", () => {
    const path = "/community/forum/threads/thread_1/accepted-reply";

    it("sets the accepted reply from the body", async () => {
      setAcceptedReply.mockResolvedValue({ success: true, value: { acceptedReplyId: "reply_1" } });

      const response = await request(app).post(path).send({ replyId: "reply_1" });

      expect(response.status).toBe(200);
      expect(setAcceptedReply).toHaveBeenCalledWith({
        threadId: "thread_1",
        authorUserId: CALLER_ID,
        replyId: "reply_1",
      });
    });

    /**
     * DELETE is the same service call with a null reply — the clearing verb has no body of
     * its own, so `null` is what distinguishes it.
     */
    it("clears the accepted reply by passing a null replyId", async () => {
      setAcceptedReply.mockResolvedValue({ success: true, value: { acceptedReplyId: null } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(setAcceptedReply).toHaveBeenCalledWith({
        threadId: "thread_1",
        authorUserId: CALLER_ID,
        replyId: null,
      });
    });

    it("maps FORBIDDEN to 403 when the caller does not own the thread", async () => {
      setAcceptedReply.mockResolvedValue({ success: false, error: { type: "FORBIDDEN" } });

      const response = await request(app).post(path).send({ replyId: "reply_1" });

      expect(response.status).toBe(403);
    });

    it("rejects a body with no replyId with 422", async () => {
      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(setAcceptedReply).not.toHaveBeenCalled();
    });
  });

  describe("PUT and DELETE /community/forum/replies/:replyId/helpful", () => {
    const path = "/community/forum/replies/reply_1/helpful";

    it("endorses on PUT, passing isHelpful true", async () => {
      setReplyHelpfulVote.mockResolvedValue({ success: true, value: { helpfulCount: 3 } });

      const response = await request(app).put(path);

      expect(response.status).toBe(200);
      expect(setReplyHelpfulVote).toHaveBeenCalledWith({
        replyId: "reply_1",
        userId: CALLER_ID,
        isHelpful: true,
      });
      expect(response.body.message).toBe("Reply endorsed.");
    });

    it("withdraws on DELETE, passing isHelpful false", async () => {
      setReplyHelpfulVote.mockResolvedValue({ success: true, value: { helpfulCount: 2 } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(setReplyHelpfulVote).toHaveBeenCalledWith({
        replyId: "reply_1",
        userId: CALLER_ID,
        isHelpful: false,
      });
      expect(response.body.message).toBe("Endorsement withdrawn.");
    });

    it("maps NOT_FOUND to 404", async () => {
      setReplyHelpfulVote.mockResolvedValue(NOT_FOUND);

      const response = await request(app).put(path);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /community/reports", () => {
    const path = "/community/reports";
    const validReport = {
      targetKind: "forum_thread",
      targetId: "thread_1",
      reason: "spam",
      detailText: "Repeated supplier advertising.",
    };

    it("records the report against the session reporter and answers 201", async () => {
      createCommunityContentReport.mockResolvedValue({ success: true, value: { id: "report_1" } });

      const response = await request(app).post(path).send(validReport);

      expect(response.status).toBe(201);
      expect(createCommunityContentReport).toHaveBeenCalledWith({
        targetKind: "forum_thread",
        targetId: "thread_1",
        reason: "spam",
        detailText: "Repeated supplier advertising.",
        reporterUserId: CALLER_ID,
      });
    });

    it("defaults an omitted detailText to null rather than undefined", async () => {
      createCommunityContentReport.mockResolvedValue({ success: true, value: { id: "report_1" } });

      const { detailText: _detailText, ...withoutDetail } = validReport;
      await request(app).post(path).send(withoutDetail);

      expect(createCommunityContentReport).toHaveBeenCalledWith(expect.objectContaining({ detailText: null }));
    });

    it("rejects a reason outside the enum with 422", async () => {
      const response = await request(app)
        .post(path)
        .send({ ...validReport, reason: "i_dislike_it" });

      expect(response.status).toBe(422);
      expect(createCommunityContentReport).not.toHaveBeenCalled();
    });

    it("rejects a client-supplied reporterUserId with 422", async () => {
      const response = await request(app)
        .post(path)
        .send({ ...validReport, reporterUserId: "someone_else" });

      expect(response.status).toBe(422);
      expect(createCommunityContentReport).not.toHaveBeenCalled();
    });

    /**
     * A second report of the same target by the same reporter is a 409 from the partial
     * unique index, which is why this route carries no idempotency key.
     */
    it("maps CONFLICT to 409 for a duplicate report", async () => {
      createCommunityContentReport.mockResolvedValue({
        success: false,
        error: { type: "CONFLICT", message: "You have already reported this." },
      });

      const response = await request(app).post(path).send(validReport);

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("You have already reported this.");
    });
  });

  describe("GET /community/admin/forum/threads", () => {
    const path = "/community/admin/forum/threads";

    it("requires moderate_content, refused inside the service as a 403", async () => {
      listForumModerationQueue.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
      expect(response.body.data.capability).toBe("moderate_content");
    });

    it("loads the queue for a moderator", async () => {
      listForumModerationQueue.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const response = await request(app).get(`${path}?limit=10`);

      expect(response.status).toBe(200);
      expect(listForumModerationQueue).toHaveBeenCalledWith({
        moderatorUserId: CALLER_ID,
        limit: 10,
        cursor: undefined,
      });
    });

    /**
     * No `state` filter exists, by design — `reject` leaves a thread `pending_review`, so a
     * state filter would surface every past rejection forever and the queue would never empty.
     */
    it("rejects a state filter with 422 rather than quietly changing what the queue means", async () => {
      const response = await request(app).get(`${path}?state=pending_review`);

      expect(response.status).toBe(422);
      expect(listForumModerationQueue).not.toHaveBeenCalled();
    });
  });

  describe("POST /community/admin/forum/threads/:threadId/moderate", () => {
    const path = "/community/admin/forum/threads/thread_1/moderate";
    const validDecision = { decision: "publish", reasonNote: "On topic and well sourced." };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validDecision);

      expect(response.status).toBe(400);
      expect(moderateForumThread).not.toHaveBeenCalled();
    });

    it("requires moderate_content, refused inside the service as a 403", async () => {
      moderateForumThread.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "moderate_thread_forbidden")
        .send(validDecision);

      expect(response.status).toBe(403);
    });

    it("records the decision with the moderator from the session", async () => {
      moderateForumThread.mockResolvedValue({ success: true, value: { threadState: "open" } });

      const response = await request(app).post(path).set("Idempotency-Key", "moderate_thread_1").send(validDecision);

      expect(response.status).toBe(200);
      expect(moderateForumThread).toHaveBeenCalledWith({
        moderatorUserId: CALLER_ID,
        threadId: "thread_1",
        decision: "publish",
        reasonNote: validDecision.reasonNote,
      });
    });

    /**
     * Every decision carries a reason, INCLUDING a publish — stricter than the DB CHECK, and
     * deliberately so: the next moderator reads this log before reversing a colleague.
     */
    it("rejects a decision with no reasonNote with 422, even for a publish", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "moderate_thread_no_note")
        .send({ decision: "publish" });

      expect(response.status).toBe(422);
      expect(moderateForumThread).not.toHaveBeenCalled();
    });

    it("rejects a decision outside the enum with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "moderate_thread_bad_decision")
        .send({ ...validDecision, decision: "delete" });

      expect(response.status).toBe(422);
      expect(moderateForumThread).not.toHaveBeenCalled();
    });
  });

  describe("POST /community/admin/forum/replies/:replyId/moderate", () => {
    const path = "/community/admin/forum/replies/reply_1/moderate";
    const validDecision = { decision: "hidden", reasonNote: "Personal attack." };

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send(validDecision);

      expect(response.status).toBe(400);
      expect(moderateForumReply).not.toHaveBeenCalled();
    });

    it("records the decision against the path's reply", async () => {
      moderateForumReply.mockResolvedValue({ success: true, value: { replyState: "hidden" } });

      const response = await request(app).post(path).set("Idempotency-Key", "moderate_reply_1").send(validDecision);

      expect(response.status).toBe(200);
      expect(moderateForumReply).toHaveBeenCalledWith({
        moderatorUserId: CALLER_ID,
        replyId: "reply_1",
        decision: "hidden",
        reasonNote: validDecision.reasonNote,
      });
    });

    it("requires moderate_content, refused inside the service as a 403", async () => {
      moderateForumReply.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "moderate_reply_forbidden")
        .send(validDecision);

      expect(response.status).toBe(403);
    });

    it("rejects a decision outside the two-value enum with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "moderate_reply_bad")
        .send({ ...validDecision, decision: "publish" });

      expect(response.status).toBe(422);
      expect(moderateForumReply).not.toHaveBeenCalled();
    });
  });

  describe("GET /community/admin/content-reports", () => {
    const path = "/community/admin/content-reports";

    it("requires moderate_content, refused inside the service as a 403", async () => {
      listCommunityContentReports.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
    });

    it("passes the status filter and default limit through", async () => {
      listCommunityContentReports.mockResolvedValue({ success: true, value: EMPTY_PAGE });

      const response = await request(app).get(`${path}?status=open`);

      expect(response.status).toBe(200);
      expect(listCommunityContentReports).toHaveBeenCalledWith({
        moderatorUserId: CALLER_ID,
        status: "open",
        limit: 20,
        cursor: undefined,
      });
    });

    it("rejects a status outside the enum with 422", async () => {
      const response = await request(app).get(`${path}?status=escalated`);

      expect(response.status).toBe(422);
      expect(listCommunityContentReports).not.toHaveBeenCalled();
    });
  });

  /**
   * THE ROUTE THAT WAS BROKEN IN PRODUCTION. The frontend sent `{ note }`; the schema is
   * `.strict()` and declares `reasonNote`, so every dismissal answered 422. Both directions
   * are asserted here so neither side can drift back.
   */
  describe("POST /community/admin/content-reports/:reportId/decisions", () => {
    const path = "/community/admin/content-reports/report_1/decisions";

    it("requires an Idempotency-Key header", async () => {
      const response = await request(app).post(path).send({ reasonNote: "Not a violation." });

      expect(response.status).toBe(400);
      expect(dismissCommunityContentReport).not.toHaveBeenCalled();
    });

    it("accepts reasonNote and passes it to the service", async () => {
      dismissCommunityContentReport.mockResolvedValue({
        success: true,
        value: { id: "report_1", status: "dismissed" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "dismiss_report_1")
        .send({ reasonNote: "Not a violation." });

      expect(response.status).toBe(200);
      expect(dismissCommunityContentReport).toHaveBeenCalledWith({
        moderatorUserId: CALLER_ID,
        reportId: "report_1",
        reasonNote: "Not a violation.",
      });
    });

    /** The exact body the frontend used to send. It must stay refused. */
    it("rejects a body sending note instead of reasonNote with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "dismiss_report_wrong_field")
        .send({ note: "Not a violation." });

      expect(response.status).toBe(422);
      expect(dismissCommunityContentReport).not.toHaveBeenCalled();
    });

    it("rejects an empty reasonNote with 422", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "dismiss_report_empty")
        .send({ reasonNote: "" });

      expect(response.status).toBe(422);
      expect(dismissCommunityContentReport).not.toHaveBeenCalled();
    });

    it("requires moderate_content, refused inside the service as a 403", async () => {
      dismissCommunityContentReport.mockResolvedValue(CAPABILITY_REQUIRED);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "dismiss_report_forbidden")
        .send({ reasonNote: "Not a violation." });

      expect(response.status).toBe(403);
    });

    it("maps NOT_FOUND to 404 for a report that does not exist", async () => {
      dismissCommunityContentReport.mockResolvedValue(NOT_FOUND);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "dismiss_report_missing")
        .send({ reasonNote: "Not a violation." });

      expect(response.status).toBe(404);
    });

    it("maps INVALID_STATE to 409 for a report already decided", async () => {
      dismissCommunityContentReport.mockResolvedValue({
        success: false,
        error: { type: "INVALID_STATE", message: "This report was already actioned." },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "dismiss_report_decided")
        .send({ reasonNote: "Not a violation." });

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("This report was already actioned.");
    });
  });
});
