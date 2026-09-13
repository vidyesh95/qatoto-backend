import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the blueprint comment threads.
 *
 * ⚠️ FOUR CONTRACTS, each with its own case:
 *
 *   1. A REPLY-TO-A-REPLY IS 409, NOT 422. Nothing in the body is wrong — the thread shape is.
 *   2. A STRANGER'S EDIT IS 403, NOT 404. The caller has already SEEN this comment and its author
 *      in the public listing, so refusing tells them nothing they did not know.
 *   3. A TOMBSTONE CARRIES `body: null` AND `author: null`. An empty string reads as "they wrote
 *      nothing"; null reads as "there is nothing to read". And naming who wrote a removed comment
 *      publishes the very fact the deletion retired.
 *   4. CASE STUDIES HAVE NO COMMENT ROUTES AT ALL. `case_study_stats` has no `comment_count`, and
 *      that arm is "a numbered lesson with no discussion surface" — the absence is the contract.
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

/** Pass-through: the comment create route declares `idempotency()` UNREQUIRED, so there is no 400. */
vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency: () => (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

const listBlueprintComments = vi.fn<(...args: readonly unknown[]) => unknown>();
const createBlueprintComment = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateBlueprintComment = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteBlueprintComment = vi.fn<(...args: readonly unknown[]) => unknown>();
const setBlueprintCommentLike = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/blueprint-comments.service.js", () => ({
  listBlueprintComments: (...args: readonly unknown[]) => listBlueprintComments(...args),
  createBlueprintComment: (...args: readonly unknown[]) => createBlueprintComment(...args),
  updateBlueprintComment: (...args: readonly unknown[]) => updateBlueprintComment(...args),
  deleteBlueprintComment: (...args: readonly unknown[]) => deleteBlueprintComment(...args),
  setBlueprintCommentLike: (...args: readonly unknown[]) => setBlueprintCommentLike(...args),
}));

const CREATED_AT = new Date("2026-03-01T10:00:00.000Z");

const LIVE_COMMENT = {
  commentId: "c_live",
  parentCommentId: null,
  body: "The gearbox comes out in one piece.",
  isDeleted: false,
  author: { displayName: "Ada", handle: "ada", avatarUrl: null },
  likeCount: 0,
  replyCount: 0,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  viewerState: { hasLiked: false },
};

/** ⚠️ BOTH `body` AND `author` ARE NULL. See contract 3 in the file docblock. */
const TOMBSTONE_COMMENT = {
  ...LIVE_COMMENT,
  commentId: "c_gone",
  body: null,
  isDeleted: true,
  author: null,
};

describe("blueprint comment routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    signOut();
    vi.clearAllMocks();
    await resetRateLimiters();
  });

  describe("GET /blueprints/<arm>/:slug/comments", () => {
    it("serves a thread to a signed-out reader", async () => {
      listBlueprintComments.mockResolvedValue({
        success: true,
        value: { rows: [LIVE_COMMENT], nextCursor: null },
      });

      const response = await request(app).get("/blueprints/teardowns/some-teardown/comments");

      expect(response.status).toBe(200);
      expect(response.body.data.rows).toHaveLength(1);
      expect(listBlueprintComments.mock.calls[0]?.[0]).toMatchObject({ viewerUserId: null });
    });

    it("carries a tombstone with body null AND author null", async () => {
      listBlueprintComments.mockResolvedValue({
        success: true,
        value: { rows: [TOMBSTONE_COMMENT], nextCursor: null },
      });

      const response = await request(app).get("/blueprints/showcases/some-launch/comments");

      expect(response.body.data.rows[0]).toMatchObject({
        body: null,
        author: null,
        isDeleted: true,
      });
    });

    it("answers 422 for a malformed cursor rather than silently serving page one", async () => {
      listBlueprintComments.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_CURSOR_MALFORMED" },
      });

      const response = await request(app)
        .get("/blueprints/teardowns/some-teardown/comments")
        .query({ cursor: "not-a-cursor" });

      expect(response.status).toBe(422);
    });

    it("refuses a limit above the page cap with 422", async () => {
      const response = await request(app).get("/blueprints/teardowns/some-teardown/comments").query({ limit: "500" });

      expect(response.status).toBe(422);
      expect(listBlueprintComments).not.toHaveBeenCalled();
    });
  });

  describe("POST /blueprints/<arm>/:slug/comments", () => {
    it("refuses a signed-out caller with 401", async () => {
      const response = await request(app)
        .post("/blueprints/teardowns/some-teardown/comments")
        .send({ body: "Nice work.", parentCommentId: null });

      expect(response.status).toBe(401);
      expect(createBlueprintComment).not.toHaveBeenCalled();
    });

    it("answers 201 with the created comment", async () => {
      signInAs();
      createBlueprintComment.mockResolvedValue({ success: true, value: LIVE_COMMENT });

      const response = await request(app)
        .post("/blueprints/teardowns/some-teardown/comments")
        .send({ body: "Nice work.", parentCommentId: null });

      expect(response.status).toBe(201);
      expect(response.body.data.commentId).toBe("c_live");
    });

    it("refuses an empty body with 422", async () => {
      signInAs();

      const response = await request(app)
        .post("/blueprints/teardowns/some-teardown/comments")
        .send({ body: "   ", parentCommentId: null });

      expect(response.status).toBe(422);
      expect(createBlueprintComment).not.toHaveBeenCalled();
    });

    it("refuses an unknown key with 422 — the body schema is .strict()", async () => {
      signInAs();

      const response = await request(app)
        .post("/blueprints/teardowns/some-teardown/comments")
        .send({ body: "Nice work.", parentCommentId: null, authorUserId: "u_someone_else" });

      expect(response.status).toBe(422);
      expect(createBlueprintComment).not.toHaveBeenCalled();
    });

    it("answers 409 for a reply-to-a-reply — the body is fine, the thread shape is not", async () => {
      signInAs();
      createBlueprintComment.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_REPLY_DEPTH_EXCEEDED", parentCommentId: "c_reply" },
      });

      const response = await request(app)
        .post("/blueprints/teardowns/some-teardown/comments")
        .send({ body: "Replying to a reply.", parentCommentId: "c_reply" });

      expect(response.status).toBe(409);
    });
  });

  describe("PATCH | DELETE /blueprints/comments/:commentId", () => {
    it("answers 403 — not 404 — when the caller is not the author", async () => {
      signInAs();
      updateBlueprintComment.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_COMMENT_NOT_AUTHOR", commentId: "c_live" },
      });

      const response = await request(app)
        .patch("/blueprints/comments/c_live")
        .send({ body: "Rewritten by a stranger." });

      expect(response.status).toBe(403);
    });

    it("answers 409 for a repeat tombstone", async () => {
      signInAs();
      deleteBlueprintComment.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_COMMENT_ALREADY_DELETED", commentId: "c_gone" },
      });

      const response = await request(app).delete("/blueprints/comments/c_gone");

      expect(response.status).toBe(409);
    });

    it("answers 404 for a comment under a blueprint the caller cannot see", async () => {
      signInAs();
      updateBlueprintComment.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_COMMENT_NOT_FOUND", commentId: "c_hidden" },
      });

      const response = await request(app).patch("/blueprints/comments/c_hidden").send({ body: "Probing." });

      expect(response.status).toBe(404);
    });
  });

  describe("PUT | DELETE /blueprints/comments/:commentId/like", () => {
    it("reads the direction from the METHOD", async () => {
      signInAs();
      setBlueprintCommentLike.mockResolvedValue({
        success: true,
        value: { isSet: true, likeCount: 3 },
      });

      await request(app).put("/blueprints/comments/c_live/like");
      expect(setBlueprintCommentLike.mock.calls[0]?.[0]).toMatchObject({ isSet: true });

      setBlueprintCommentLike.mockResolvedValue({
        success: true,
        value: { isSet: false, likeCount: 2 },
      });
      await request(app).delete("/blueprints/comments/c_live/like");
      expect(setBlueprintCommentLike.mock.calls[1]?.[0]).toMatchObject({ isSet: false });
    });
  });

  describe("the case-study arm", () => {
    it("has NO comment routes at all — the absence is the contract", async () => {
      signInAs();

      expect((await request(app).get("/blueprints/case-studies/a/comments")).status).toBe(404);
      expect(
        (await request(app).post("/blueprints/case-studies/a/comments").send({ body: "x", parentCommentId: null }))
          .status,
      ).toBe(404);
      expect(listBlueprintComments).not.toHaveBeenCalled();
      expect(createBlueprintComment).not.toHaveBeenCalled();
    });
  });
});
