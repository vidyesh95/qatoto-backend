import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const createAssistantReplyMock = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/assistant/assistant.service.js", () => ({
  createAssistantReply: (...args: readonly unknown[]) => createAssistantReplyMock(...args),
}));

const hasActiveCloudAccessMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listActiveCloudAccessGrantsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const grantCloudAccessMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const revokeCloudAccessMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/assistant/assistant-cloud-access.service.js", () => ({
  hasActiveCloudAccess: (...args: readonly unknown[]) => hasActiveCloudAccessMock(...args),
  listActiveCloudAccessGrants: (...args: readonly unknown[]) => listActiveCloudAccessGrantsMock(...args),
  grantCloudAccess: (...args: readonly unknown[]) => grantCloudAccessMock(...args),
  revokeCloudAccess: (...args: readonly unknown[]) => revokeCloudAccessMock(...args),
}));

describe("assistant routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /assistant/replies", () => {
    const validBody = {
      messages: [{ role: "user", text: "How do I create a project?" }],
      pathname: "/rnd",
      memoryNotes: ["Prefers robotics"],
    };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/assistant/replies").send(validBody);

      expect(response.status).toBe(401);
      expect(createAssistantReplyMock).not.toHaveBeenCalled();
    });

    it("answers 422 when query parameters are supplied", async () => {
      const response = await request(app).post("/assistant/replies?unexpected=param").send(validBody);

      expect(response.status).toBe(422);
      expect(createAssistantReplyMock).not.toHaveBeenCalled();
    });

    it("rejects an invalid body with 422 instead of crashing with 500", async () => {
      const response = await request(app)
        .post("/assistant/replies")
        .send({
          messages: [{ role: "assistant", text: "Last message is assistant" }],
          pathname: "no-leading-slash",
          memoryNotes: [],
        });

      expect(response.status).toBe(422);
      expect(createAssistantReplyMock).not.toHaveBeenCalled();
    });

    it("rejects unknown body fields with 422 (.strict())", async () => {
      const response = await request(app)
        .post("/assistant/replies")
        .send({ ...validBody, prompt: "system injection" });

      expect(response.status).toBe(422);
      expect(createAssistantReplyMock).not.toHaveBeenCalled();
    });

    it("maps ASSISTANT_PREMIUM_REQUIRED to 403 with reason: premium_required", async () => {
      createAssistantReplyMock.mockResolvedValue({
        success: false,
        error: { type: "ASSISTANT_PREMIUM_REQUIRED" },
      });

      const response = await request(app).post("/assistant/replies").send(validBody);

      expect(response.status).toBe(403);
      expect(response.body.data?.reason).toBe("premium_required");
    });

    it("maps ASSISTANT_UNAVAILABLE to 503 Service Unavailable", async () => {
      createAssistantReplyMock.mockResolvedValue({
        success: false,
        error: { type: "ASSISTANT_UNAVAILABLE" },
      });

      const response = await request(app).post("/assistant/replies").send(validBody);

      expect(response.status).toBe(503);
      expect(response.body.message).toContain("assistant is unavailable");
    });

    it("maps ASSISTANT_INPUT_REJECTED to 422 Unprocessable Entity", async () => {
      createAssistantReplyMock.mockResolvedValue({
        success: false,
        error: { type: "ASSISTANT_INPUT_REJECTED" },
      });

      const response = await request(app).post("/assistant/replies").send(validBody);

      expect(response.status).toBe(422);
      expect(response.body.message).toContain("could not answer that");
    });

    it("maps ASSISTANT_REPLY_UNREADABLE to 502 Bad Gateway", async () => {
      createAssistantReplyMock.mockResolvedValue({
        success: false,
        error: { type: "ASSISTANT_REPLY_UNREADABLE" },
      });

      const response = await request(app).post("/assistant/replies").send(validBody);

      expect(response.status).toBe(502);
      expect(response.body.message).toContain("not readable");
    });

    it("answers 200 with reply data when valid", async () => {
      const replyData = {
        expression: "joy",
        destinationKey: "post_an_idea",
        search: null,
        rememberNote: null,
        reply: "You can post an idea from the problem map.",
      };
      createAssistantReplyMock.mockResolvedValue({
        success: true,
        value: replyData,
      });

      const response = await request(app).post("/assistant/replies").send(validBody);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(replyData);
    });
  });

  describe("GET /assistant/cloud-access", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/assistant/cloud-access");

      expect(response.status).toBe(401);
    });

    it("answers 422 when unexpected query keys are provided", async () => {
      const response = await request(app).get("/assistant/cloud-access?probe=1");

      expect(response.status).toBe(422);
    });

    it("answers 200 with hasCloudAccess: true when granted", async () => {
      hasActiveCloudAccessMock.mockResolvedValue(true);

      const response = await request(app).get("/assistant/cloud-access");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ hasCloudAccess: true });
    });

    it("answers 200 with hasCloudAccess: false when not granted", async () => {
      hasActiveCloudAccessMock.mockResolvedValue(false);

      const response = await request(app).get("/assistant/cloud-access");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ hasCloudAccess: false });
    });
  });

  describe("GET /assistant/admin/cloud-access", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/assistant/admin/cloud-access");

      expect(response.status).toBe(401);
    });

    it("answers 403 when caller lacks grant_ai_assistant_cloud capability", async () => {
      listActiveCloudAccessGrantsMock.mockResolvedValue({
        success: false,
        error: {
          type: "PLATFORM_CAPABILITY_REQUIRED",
          capability: "grant_ai_assistant_cloud",
        },
      });

      const response = await request(app).get("/assistant/admin/cloud-access");

      expect(response.status).toBe(403);
      expect(response.body.data?.capability).toBe("grant_ai_assistant_cloud");
    });

    it("maps INVALID_CURSOR to 422", async () => {
      listActiveCloudAccessGrantsMock.mockResolvedValue({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get("/assistant/admin/cloud-access?cursor=bad-cursor");

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("Invalid cursor.");
    });

    it("answers 200 with keyset paginated items and nextCursor", async () => {
      const grants = [
        {
          userId: "usr_1",
          email: "usr1@example.com",
          name: "User One",
          handle: "user1",
          grantedAt: new Date().toISOString(),
          note: null,
          grantedBy: null,
        },
      ];
      listActiveCloudAccessGrantsMock.mockResolvedValue({
        success: true,
        value: {
          items: grants,
          nextCursor: "cursor_next_123",
        },
      });

      const response = await request(app).get("/assistant/admin/cloud-access?limit=10");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(grants);
      expect(response.body.nextCursor).toBe("cursor_next_123");
    });
  });

  describe("POST /assistant/admin/cloud-access", () => {
    const validGrantBody = {
      email: "grantee@example.com",
      note: "Beta access",
    };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/assistant/admin/cloud-access").send(validGrantBody);

      expect(response.status).toBe(401);
    });

    it("answers 403 when capability is missing", async () => {
      grantCloudAccessMock.mockResolvedValue({
        success: false,
        error: {
          type: "PLATFORM_CAPABILITY_REQUIRED",
          capability: "grant_ai_assistant_cloud",
        },
      });

      const response = await request(app).post("/assistant/admin/cloud-access").send(validGrantBody);

      expect(response.status).toBe(403);
    });

    it("maps USER_NOT_FOUND to 404", async () => {
      grantCloudAccessMock.mockResolvedValue({
        success: false,
        error: { type: "USER_NOT_FOUND" },
      });

      const response = await request(app).post("/assistant/admin/cloud-access").send(validGrantBody);

      expect(response.status).toBe(404);
      expect(response.body.message).toBe("No account uses that email.");
    });

    it("maps ALREADY_GRANTED to 409", async () => {
      grantCloudAccessMock.mockResolvedValue({
        success: false,
        error: { type: "ALREADY_GRANTED" },
      });

      const response = await request(app).post("/assistant/admin/cloud-access").send(validGrantBody);

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("That account already has Premium AI.");
    });

    it("answers 422 on invalid email format", async () => {
      const response = await request(app).post("/assistant/admin/cloud-access").send({
        email: "not-an-email",
        note: null,
      });

      expect(response.status).toBe(422);
      expect(grantCloudAccessMock).not.toHaveBeenCalled();
    });

    it("answers 201 on success", async () => {
      const grantedAt = new Date().toISOString();
      grantCloudAccessMock.mockResolvedValue({
        success: true,
        value: { userId: "usr_granted", grantedAt },
      });

      const response = await request(app).post("/assistant/admin/cloud-access").send(validGrantBody);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ userId: "usr_granted", grantedAt });
    });
  });

  describe("POST /assistant/admin/cloud-access/:userId/revocation", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/assistant/admin/cloud-access/usr_target/revocation");

      expect(response.status).toBe(401);
    });

    it("answers 403 when capability is missing", async () => {
      revokeCloudAccessMock.mockResolvedValue({
        success: false,
        error: {
          type: "PLATFORM_CAPABILITY_REQUIRED",
          capability: "grant_ai_assistant_cloud",
        },
      });

      const response = await request(app).post("/assistant/admin/cloud-access/usr_target/revocation");

      expect(response.status).toBe(403);
    });

    it("maps NOT_GRANTED to 404", async () => {
      revokeCloudAccessMock.mockResolvedValue({
        success: false,
        error: { type: "NOT_GRANTED" },
      });

      const response = await request(app).post("/assistant/admin/cloud-access/usr_target/revocation");

      expect(response.status).toBe(404);
      expect(response.body.message).toBe("That account does not have Premium AI.");
    });

    it("answers 200 on success", async () => {
      const revokedAt = new Date().toISOString();
      revokeCloudAccessMock.mockResolvedValue({
        success: true,
        value: { revokedAt },
      });

      const response = await request(app).post("/assistant/admin/cloud-access/usr_target/revocation");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ revokedAt });
    });
  });
});
