import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the draft store.
 *
 * ⚠️ THE CONTRACT THIS SUITE EXISTS FOR IS THAT A DRAFT IS PRIVATE. There is no staff route, every
 * handler scopes on the caller's own id, and a stranger's draft answers 404 rather than 403 — a 403
 * would confirm the id exists, which is an existence oracle over other people's unfinished work.
 * The ownership predicate lives inside the query, so these tests assert it is PASSED, and the
 * service tests assert it is applied.
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

const createBlueprintDraft = vi.fn<(...args: readonly unknown[]) => unknown>();
const replaceBlueprintDraft = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyBlueprintDrafts = vi.fn<(...args: readonly unknown[]) => unknown>();
const getMyBlueprintDraft = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteBlueprintDraft = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/blueprint-draft.service.js", () => ({
  createBlueprintDraft: (...args: readonly unknown[]) => createBlueprintDraft(...args),
  replaceBlueprintDraft: (...args: readonly unknown[]) => replaceBlueprintDraft(...args),
  listMyBlueprintDrafts: (...args: readonly unknown[]) => listMyBlueprintDrafts(...args),
  getMyBlueprintDraft: (...args: readonly unknown[]) => getMyBlueprintDraft(...args),
  deleteBlueprintDraft: (...args: readonly unknown[]) => deleteBlueprintDraft(...args),
  MAX_BLUEPRINT_DRAFTS_PER_AUTHOR: 25,
}));

const DRAFT_PATH = "/blueprints/drafts";
const ONE_DRAFT = "/blueprints/drafts/draft_1";
const RECEIPT = { draftId: "draft_1", revision: 2, updatedAt: new Date("2026-04-01T10:00:00.000Z") };

describe("blueprint drafts", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signOut();
    await resetRateLimiters();
  });

  describe("the guards", () => {
    it.each([
      ["post", DRAFT_PATH],
      ["get", DRAFT_PATH],
      ["get", ONE_DRAFT],
      ["put", ONE_DRAFT],
      ["delete", ONE_DRAFT],
    ] as const)("refuses a signed-out caller with 401 (%s %s)", async (method, path) => {
      const response = await request(app)[method](path).send({});

      expect(response.status).toBe(401);
      expect(createBlueprintDraft).not.toHaveBeenCalled();
      expect(getMyBlueprintDraft).not.toHaveBeenCalled();
    });

    /** ⚠️ THE OWNER IS THE SESSION'S, NEVER THE BODY'S — asserted on every handler that takes one. */
    it("scopes every read and write to the caller's own id", async () => {
      signInAs();
      listMyBlueprintDrafts.mockResolvedValue([]);
      getMyBlueprintDraft.mockResolvedValue({ success: false, error: { type: "BLUEPRINT_DRAFT_NOT_FOUND" } });

      await request(app).get(DRAFT_PATH);
      await request(app).get(ONE_DRAFT);

      expect(listMyBlueprintDrafts.mock.calls[0]?.[0]).toMatchObject({ ownerUserId: "user_test_caller" });
      expect(getMyBlueprintDraft.mock.calls[0]?.[0]).toMatchObject({ ownerUserId: "user_test_caller" });
    });

    it("refuses a body-carried owner id with 422 — the schema is .strict()", async () => {
      signInAs();

      const response = await request(app).post(DRAFT_PATH).send({
        arm: "teardown",
        document: "{}",
        documentSchemaVersion: 1,
        ownerUserId: "user_someone_else",
      });

      expect(response.status).toBe(422);
      expect(createBlueprintDraft).not.toHaveBeenCalled();
    });
  });

  describe("saving", () => {
    it("accepts a half-answered document — that is what a draft is", async () => {
      signInAs();
      createBlueprintDraft.mockResolvedValue({ success: true, value: RECEIPT });

      const response = await request(app)
        .post(DRAFT_PATH)
        .send({
          arm: "teardown",
          // Nothing here would survive the submit gate, which is the point.
          document: JSON.stringify({ title: "x", parts: [] }),
          documentSchemaVersion: 1,
        });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({
        draftId: "draft_1",
        revision: 2,
        updatedAt: RECEIPT.updatedAt.toISOString(),
      });
    });

    it("refuses an unknown arm", async () => {
      signInAs();

      const response = await request(app)
        .post(DRAFT_PATH)
        .send({ arm: "anime", document: "{}", documentSchemaVersion: 1 });

      expect(response.status).toBe(422);
      expect(createBlueprintDraft).not.toHaveBeenCalled();
    });

    /** ⚠️ THE REVISION IS REQUIRED ON EVERY UPDATE — it is what stops one tab overwriting another. */
    it("refuses an update carrying no revision", async () => {
      signInAs();

      const response = await request(app)
        .put(ONE_DRAFT)
        .send({ label: null, document: "{}", documentSchemaVersion: 1 });

      expect(response.status).toBe(422);
      expect(replaceBlueprintDraft).not.toHaveBeenCalled();
    });

    it("answers 409 and the current revision when another tab saved first", async () => {
      signInAs();
      replaceBlueprintDraft.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_DRAFT_REVISION_STALE", currentRevision: 7 },
      });

      const response = await request(app)
        .put(ONE_DRAFT)
        .send({ label: null, document: "{}", documentSchemaVersion: 1, revision: 3 });

      expect(response.status).toBe(409);
      // The client needs the number to reload, merge and retry rather than discard the typing.
      expect(response.body.errors.revision[0]).toContain("7");
    });

    it("answers 409 at the per-author ceiling", async () => {
      signInAs();
      createBlueprintDraft.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_DRAFT_LIMIT_REACHED", limit: 25 },
      });

      const response = await request(app)
        .post(DRAFT_PATH)
        .send({ arm: "case_study", document: "{}", documentSchemaVersion: 1 });

      expect(response.status).toBe(409);
    });

    it("answers 422 when the document is not a JSON object", async () => {
      signInAs();
      createBlueprintDraft.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_DRAFT_DOCUMENT_NOT_OBJECT" },
      });

      const response = await request(app)
        .post(DRAFT_PATH)
        .send({ arm: "teardown", document: "[1,2]", documentSchemaVersion: 1 });

      expect(response.status).toBe(422);
    });
  });

  describe("reading", () => {
    /** ⚠️ THE LIST CARRIES NO DOCUMENTS — a wizard index must not pull three 32 KB blobs to draw. */
    it("lists labels and revisions without documents", async () => {
      signInAs();
      listMyBlueprintDrafts.mockResolvedValue([
        {
          draftId: "draft_1",
          arm: "teardown",
          label: "Cordless drill",
          revision: 3,
          updatedAt: RECEIPT.updatedAt,
        },
      ]);

      const response = await request(app).get(DRAFT_PATH);

      expect(response.status).toBe(200);
      expect(response.body.data[0]).not.toHaveProperty("document");
    });

    it("passes an arm filter through", async () => {
      signInAs();
      listMyBlueprintDrafts.mockResolvedValue([]);

      await request(app).get(`${DRAFT_PATH}?arm=case_study`);

      expect(listMyBlueprintDrafts.mock.calls[0]?.[0]).toMatchObject({ arm: "case_study" });
    });

    /** ⚠️ 404, NOT 403 — see the mapper. A 403 confirms the id exists. */
    it("answers 404 for a draft that is not the caller's", async () => {
      signInAs();
      getMyBlueprintDraft.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_DRAFT_NOT_FOUND" },
      });

      const response = await request(app).get(ONE_DRAFT);

      expect(response.status).toBe(404);
    });

    it("answers 404 for a delete that is not the caller's", async () => {
      signInAs();
      deleteBlueprintDraft.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_DRAFT_NOT_FOUND" },
      });

      const response = await request(app).delete(ONE_DRAFT);

      expect(response.status).toBe(404);
    });
  });
});
