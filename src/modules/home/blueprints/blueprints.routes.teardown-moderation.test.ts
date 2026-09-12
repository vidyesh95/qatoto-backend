import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the two moderator teardown routes.
 *
 * ⚠️ THE CENTRAL CASE HERE IS AN ORDERING PROOF, not a status check. `moderate_content` is resolved
 * BEFORE `req.params.submissionId` is read and before the body is parsed. Reversed, a 403 that only
 * arrives for submissions that exist turns these routes into an existence oracle over other
 * people's unpublished surveys. It is asserted by sending a non-moderator a request that is ALSO
 * malformed and requiring **403, not 422** — a 422 would mean the parse ran first.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

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

const listTeardownReviewQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const decideTeardown = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/teardown-moderation.service.js", () => ({
  listTeardownReviewQueue: (...args: readonly unknown[]) => listTeardownReviewQueue(...args),
  decideTeardown: (...args: readonly unknown[]) => decideTeardown(...args),
}));

const MODERATOR_CONTEXT = {
  success: true,
  value: { staffUserId: "user_test_caller", platformRole: "admin" },
} as const;

const CAPABILITY_REFUSED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

const EMPTY_QUEUE = { items: [], page: { nextCursor: null, hasMore: false } } as const;

const DECIDED_AT = new Date("2026-02-12T11:00:00.000Z");

/** A publish decision the gate accepts. Every case changes exactly one thing about it. */
function buildPublishDecision(): Record<string, unknown> {
  return {
    decision: "published",
    moderatorNote: null,
    thumbnailUrl: "https://images.example.com/teardowns/drill.webp",
    difficulty: "intermediate",
    desiredSlug: null,
  };
}

describe("blueprints teardown moderation routes", () => {
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

  describe("GET /blueprints/admin/teardowns/review-queue", () => {
    const path = "/blueprints/admin/teardowns/review-queue";

    it("refuses a signed-out caller with 401", async () => {
      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });

    it("refuses a caller without moderate_content with 403", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
      expect(listTeardownReviewQueue).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ THE ORDERING PROOF. The query is malformed AND the caller lacks the capability. A 422 here
     * would mean the parse ran first, which is the shape that turns a refusal into an oracle.
     */
    it("refuses a non-moderator with 403 even when the query is also malformed", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).get(path).query({ limit: "not-a-number" });

      expect(response.status).toBe(403);
    });

    it("answers a moderator with the queue page", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      listTeardownReviewQueue.mockResolvedValue(EMPTY_QUEUE);

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(listTeardownReviewQueue).toHaveBeenCalledWith({
        staff: MODERATOR_CONTEXT.value,
        limit: 20,
        cursor: undefined,
      });
    });

    it("decodes a cursor this server minted", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      listTeardownReviewQueue.mockResolvedValue(EMPTY_QUEUE);
      const cursor = encodeInstantCursor({ instant: DECIDED_AT, id: "tsub_1" });

      await request(app).get(path).query({ cursor });

      expect(listTeardownReviewQueue).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { instant: DECIDED_AT, id: "tsub_1" } }),
      );
    });

    /** Never a silent first page: a queue that quietly restarts re-serves decided submissions. */
    it("refuses a cursor this server did not mint with 422", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await request(app).get(path).query({ cursor: "not-a-cursor" });

      expect(response.status).toBe(422);
      expect(listTeardownReviewQueue).not.toHaveBeenCalled();
    });
  });

  describe("POST /blueprints/admin/teardowns/:submissionId/moderate", () => {
    const path = "/blueprints/admin/teardowns/tsub_abc123/moderate";

    it("refuses a signed-out caller with 401", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-signed-out")
        .send(buildPublishDecision());

      expect(response.status).toBe(401);
    });

    /** The same ordering proof, on the route that also carries a body. */
    it("refuses a non-moderator with 403 even when the body is also malformed", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).post(path).set("Idempotency-Key", "key-order").send({ decision: "sideways" });

      expect(response.status).toBe(403);
      expect(decideTeardown).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ AND THE SAME 403 FOR AN ID THAT CANNOT EXIST. If the refusal differed between a plausible
     * id and a garbage one, the difference would itself be the oracle.
     */
    it("answers a non-moderator identically for a real-looking id and a garbage one", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const realLooking = await request(app).post(path).set("Idempotency-Key", "key-real").send(buildPublishDecision());
      const garbage = await request(app)
        .post("/blueprints/admin/teardowns/%20%20/moderate")
        .set("Idempotency-Key", "key-garbage")
        .send(buildPublishDecision());

      expect(realLooking.status).toBe(403);
      expect(garbage.status).toBe(403);
      expect(realLooking.body.message).toBe(garbage.body.message);
    });

    it("records a publish and answers with the minted slug", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideTeardown.mockResolvedValue({
        success: true,
        value: {
          submissionId: "tsub_abc123",
          moderationState: "published",
          publicSlug: "inside-a-supermarket-cordless-drill",
          decidedAt: DECIDED_AT,
        },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "key-publish").send(buildPublishDecision());

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        submissionId: "tsub_abc123",
        moderationState: "published",
        publicSlug: "inside-a-supermarket-cordless-drill",
        decidedAt: DECIDED_AT.toISOString(),
      });
    });

    /**
     * A rejection is terminal and there is no edit-and-resubmit flow, so the note is the author's
     * entire remedy. A noteless one is refused by the schema before the service is reached.
     */
    it("refuses a rejection with no note with 422", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-noteless")
        .send({ decision: "rejected", moderatorNote: "" });

      expect(response.status).toBe(422);
      expect(decideTeardown).not.toHaveBeenCalled();
    });

    it("refuses a publish with no thumbnail with 422", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      const { thumbnailUrl: _unused, ...decisionWithoutThumbnail } = buildPublishDecision();

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-no-thumbnail")
        .send(decisionWithoutThumbnail);

      expect(response.status).toBe(422);
      expect(decideTeardown).not.toHaveBeenCalled();
    });

    it("refuses a protocol-relative thumbnail with 422", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-protocol-relative")
        .send({ ...buildPublishDecision(), thumbnailUrl: "//images.evil.test/drill.webp" });

      expect(response.status).toBe(422);
      expect(decideTeardown).not.toHaveBeenCalled();
    });

    it("answers 404 for a submission that is not there", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideTeardown.mockResolvedValue({
        success: false,
        error: { type: "TEARDOWN_SUBMISSION_NOT_FOUND" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "key-missing").send(buildPublishDecision());

      expect(response.status).toBe(404);
    });

    it("answers 403 when a moderator decides their own submission", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideTeardown.mockResolvedValue({
        success: false,
        error: { type: "TEARDOWN_SELF_MODERATION_FORBIDDEN" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "key-self").send(buildPublishDecision());

      expect(response.status).toBe(403);
    });

    it("answers 409 for a submission that is already decided", async () => {
      signInAs();
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideTeardown.mockResolvedValue({
        success: false,
        error: { type: "TEARDOWN_ALREADY_DECIDED", moderationState: "published" },
      });

      const response = await request(app).post(path).set("Idempotency-Key", "key-decided").send(buildPublishDecision());

      expect(response.status).toBe(409);
    });
  });
});
