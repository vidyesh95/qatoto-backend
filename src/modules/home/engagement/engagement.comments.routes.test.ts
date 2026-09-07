import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `commentRouter` (root-mounted, owns `/videos/:videoId/comments`
 * create and `/comments/:commentId*`) — previously untested at any behavior tier. Root
 * mount reasoning per the router file's own docblock: a comment id is globally unique and
 * a client holding one has no reason to also know its video, so re-deriving the path would
 * let a caller assert a pairing the server has to re-check regardless.
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

const createVideoComment = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateVideoComment = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteVideoComment = vi.fn<(...args: readonly unknown[]) => unknown>();
const setCommentLike = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/video-comments.service.js", () => ({
  createVideoComment: (...args: readonly unknown[]) => createVideoComment(...args),
  updateVideoComment: (...args: readonly unknown[]) => updateVideoComment(...args),
  deleteVideoComment: (...args: readonly unknown[]) => deleteVideoComment(...args),
  setCommentLike: (...args: readonly unknown[]) => setCommentLike(...args),
}));

const VIDEO_ID = "11111111-1111-4111-8111-111111111111";
const COMMENT_ID = "22222222-2222-4222-8222-222222222222";

describe("engagement commentRouter (root-mounted)", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /videos/:videoId/comments — the one route carrying an idempotency key", () => {
    const path = `/videos/${VIDEO_ID}/comments`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send({ body: "Nice video." });

      expect(response.status).toBe(401);
      expect(createVideoComment).not.toHaveBeenCalled();
    });

    it("posts the comment and answers 201", async () => {
      createVideoComment.mockResolvedValue({ success: true, value: { id: "comment_1", body: "Nice video." } });

      const response = await request(app).post(path).send({ body: "Nice video." });

      expect(response.status).toBe(201);
      expect(createVideoComment).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        authorUserId: "user_test_caller",
        bodyText: "Nice video.",
        parentCommentId: null,
      });
    });

    it("threads a reply's parentCommentId through", async () => {
      createVideoComment.mockResolvedValue({ success: true, value: { id: "comment_2" } });

      await request(app).post(path).send({ body: "Agreed.", parentCommentId: COMMENT_ID });

      expect(createVideoComment).toHaveBeenCalledWith(expect.objectContaining({ parentCommentId: COMMENT_ID }));
    });

    it("rejects an empty body with 422", async () => {
      const response = await request(app).post(path).send({ body: "" });

      expect(response.status).toBe(422);
      expect(createVideoComment).not.toHaveBeenCalled();
    });

    it("maps REPLY_DEPTH_EXCEEDED to 409", async () => {
      createVideoComment.mockResolvedValue({ success: false, error: { type: "REPLY_DEPTH_EXCEEDED" } });

      const response = await request(app).post(path).send({ body: "Too deep.", parentCommentId: COMMENT_ID });

      expect(response.status).toBe(409);
    });

    it("maps PARENT_COMMENT_NOT_ON_VIDEO to 422", async () => {
      createVideoComment.mockResolvedValue({
        success: false,
        error: { type: "PARENT_COMMENT_NOT_ON_VIDEO" },
      });

      const response = await request(app).post(path).send({ body: "Wrong thread.", parentCommentId: COMMENT_ID });

      expect(response.status).toBe(422);
    });

    it("maps COMMENTS_DISABLED to 409", async () => {
      createVideoComment.mockResolvedValue({ success: false, error: { type: "COMMENTS_DISABLED" } });

      const response = await request(app).post(path).send({ body: "Late to the party." });

      expect(response.status).toBe(409);
    });
  });

  describe("PATCH /comments/:commentId", () => {
    const path = `/comments/${COMMENT_ID}`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).patch(path).send({ body: "Edited." });

      expect(response.status).toBe(401);
      expect(updateVideoComment).not.toHaveBeenCalled();
    });

    it("updates the caller's own comment", async () => {
      updateVideoComment.mockResolvedValue({ success: true, value: { id: COMMENT_ID, body: "Edited." } });

      const response = await request(app).patch(path).send({ body: "Edited." });

      expect(response.status).toBe(200);
      expect(updateVideoComment).toHaveBeenCalledWith({
        commentId: COMMENT_ID,
        authorUserId: "user_test_caller",
        bodyText: "Edited.",
      });
    });

    /**
     * A comment is publicly readable along with its author, so this refusal discloses
     * nothing new — the module's own error-response docs draw the 403 line here rather
     * than a 404, unlike project-scoped modules where membership itself is the secret.
     */
    it("maps COMMENT_NOT_AUTHOR to 403", async () => {
      updateVideoComment.mockResolvedValue({ success: false, error: { type: "COMMENT_NOT_AUTHOR" } });

      const response = await request(app).patch(path).send({ body: "Not mine." });

      expect(response.status).toBe(403);
    });

    it("maps COMMENT_NOT_FOUND to 404", async () => {
      updateVideoComment.mockResolvedValue({ success: false, error: { type: "COMMENT_NOT_FOUND" } });

      const response = await request(app).patch(path).send({ body: "Ghost." });

      expect(response.status).toBe(404);
    });

    it("rejects an empty body with 422", async () => {
      const response = await request(app).patch(path).send({ body: "" });

      expect(response.status).toBe(422);
      expect(updateVideoComment).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /comments/:commentId — tombstone, not a row delete", () => {
    const path = `/comments/${COMMENT_ID}`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).delete(path);

      expect(response.status).toBe(401);
      expect(deleteVideoComment).not.toHaveBeenCalled();
    });

    it("deletes and passes the actor through", async () => {
      deleteVideoComment.mockResolvedValue({ success: true, value: { id: COMMENT_ID, status: "deleted" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(deleteVideoComment).toHaveBeenCalledWith({ commentId: COMMENT_ID, actorUserId: "user_test_caller" });
    });

    /** Either the author OR the video's creator may delete — both are 200, not a role split. */
    it("maps COMMENT_DELETE_FORBIDDEN to 403 for neither party", async () => {
      deleteVideoComment.mockResolvedValue({
        success: false,
        error: { type: "COMMENT_DELETE_FORBIDDEN" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(403);
    });

    it("maps COMMENT_ALREADY_DELETED to 409", async () => {
      deleteVideoComment.mockResolvedValue({
        success: false,
        error: { type: "COMMENT_ALREADY_DELETED" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(409);
    });
  });

  describe("PUT/DELETE /comments/:commentId/like", () => {
    const path = `/comments/${COMMENT_ID}/like`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(path);

      expect(response.status).toBe(401);
      expect(setCommentLike).not.toHaveBeenCalled();
    });

    it("likes and returns the resulting count", async () => {
      setCommentLike.mockResolvedValue({ success: true, value: { isSet: true, likeCount: 3 } });

      const response = await request(app).put(path);

      expect(response.status).toBe(200);
      expect(setCommentLike).toHaveBeenCalledWith({
        commentId: COMMENT_ID,
        userId: "user_test_caller",
        shouldBeSet: true,
      });
      expect(response.body.data).toEqual({ hasLiked: true, likeCount: 3 });
    });

    it("unlikes with DELETE", async () => {
      setCommentLike.mockResolvedValue({ success: true, value: { isSet: false, likeCount: 2 } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(setCommentLike).toHaveBeenCalledWith({
        commentId: COMMENT_ID,
        userId: "user_test_caller",
        shouldBeSet: false,
      });
    });

    it("maps COMMENT_NOT_FOUND to 404", async () => {
      setCommentLike.mockResolvedValue({ success: false, error: { type: "COMMENT_NOT_FOUND" } });

      const response = await request(app).put(path);

      expect(response.status).toBe(404);
    });
  });
});
