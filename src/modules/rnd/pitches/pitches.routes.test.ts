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

// Mock platform-role.service
const requirePlatformCapabilityMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (...args: readonly unknown[]) => requirePlatformCapabilityMock(...args),
}));

// Mock pitches.service
const createPitchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const updatePitchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const submitPitchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const closePitchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const deletePitchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyPitchesMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPublicPitchesMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPublishedPitchSlugsMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const getPublicPitchMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const findOwnedPitchMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/pitches/pitches.service.js", () => ({
  createPitch: (...args: readonly unknown[]) => createPitchMock(...args),
  updatePitch: (...args: readonly unknown[]) => updatePitchMock(...args),
  submitPitch: (...args: readonly unknown[]) => submitPitchMock(...args),
  closePitch: (...args: readonly unknown[]) => closePitchMock(...args),
  deletePitch: (...args: readonly unknown[]) => deletePitchMock(...args),
  listMyPitches: (...args: readonly unknown[]) => listMyPitchesMock(...args),
  listPublicPitches: (...args: readonly unknown[]) => listPublicPitchesMock(...args),
  listPublishedPitchSlugs: (...args: readonly unknown[]) => listPublishedPitchSlugsMock(...args),
  getPublicPitch: (...args: readonly unknown[]) => getPublicPitchMock(...args),
  findOwnedPitch: (...args: readonly unknown[]) => findOwnedPitchMock(...args),
}));

// Mock pitch-moderation.service
const listPitchReviewQueueMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const moderatePitchMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/pitches/pitch-moderation.service.js", () => ({
  listPitchReviewQueue: (...args: readonly unknown[]) => listPitchReviewQueueMock(...args),
  moderatePitch: (...args: readonly unknown[]) => moderatePitchMock(...args),
}));

// Mock pitch-outcomes.service
const listPitchOutcomesMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const recordPitchOutcomeMock = vi.fn<(...args: readonly unknown[]) => unknown>();
const confirmPitchOutcomeMock = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/rnd/pitches/pitch-outcomes.service.js", () => ({
  listPitchOutcomes: (...args: readonly unknown[]) => listPitchOutcomesMock(...args),
  recordPitchOutcome: (...args: readonly unknown[]) => recordPitchOutcomeMock(...args),
  confirmPitchOutcome: (...args: readonly unknown[]) => confirmPitchOutcomeMock(...args),
}));

describe("pitches routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();

    requirePlatformCapabilityMock.mockResolvedValue({
      success: true,
      value: { userId: "usr_mod_1", role: "moderator" },
    });
  });

  describe("GET /pitches (public feed)", () => {
    it("answers 200 with paginated pitches", async () => {
      listPublicPitchesMock.mockResolvedValue({
        rows: [{ id: "pitch_1", title: "Drone Pitch" }],
        total: 1,
      });

      const response = await request(app).get("/pitches?page=1&limit=25");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "pitch_1", title: "Drone Pitch" }]);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 25,
        total: 1,
        totalPages: 1,
      });
    });

    it("answers 422 if invalid query parameter is sent", async () => {
      const response = await request(app).get("/pitches?status=published");

      expect(response.status).toBe(422);
    });
  });

  describe("GET /pitches/slugs", () => {
    it("answers 200 with published slugs", async () => {
      listPublishedPitchSlugsMock.mockResolvedValue(["drone-pitch", "solar-kit-pitch"]);

      const response = await request(app).get("/pitches/slugs");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(["drone-pitch", "solar-kit-pitch"]);
    });
  });

  describe("GET /pitches/mine", () => {
    it("answers 401 when signed out", async () => {
      signOut();

      const response = await request(app).get("/pitches/mine");

      expect(response.status).toBe(401);
    });

    it("answers 200 with founder's pitches", async () => {
      listMyPitchesMock.mockResolvedValue({
        rows: [{ id: "pitch_my_1", title: "My Pitch" }],
        total: 1,
      });

      const response = await request(app).get("/pitches/mine?status=draft");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "pitch_my_1", title: "My Pitch" }]);
    });
  });

  describe("GET /pitches/:pitchSlug", () => {
    it("maps PITCH_NOT_FOUND to 404", async () => {
      getPublicPitchMock.mockResolvedValue({
        success: false,
        error: { type: "PITCH_NOT_FOUND" },
      });

      const response = await request(app).get("/pitches/non-existent-pitch");

      expect(response.status).toBe(404);
      expect(response.body.message).toBe("Pitch not found.");
    });

    it("answers 200 with pitch and public outcomes", async () => {
      const pitchData = { id: "pitch_1", slug: "drone-pitch", title: "Drone Pitch" };
      getPublicPitchMock.mockResolvedValue({
        success: true,
        value: pitchData,
      });
      findOwnedPitchMock.mockResolvedValue({ success: false, error: { type: "NOT_THE_FOUNDER" } });
      listPitchOutcomesMock.mockResolvedValue([{ id: "out_1", amountInCents: "500000" }]);

      const response = await request(app).get("/pitches/drone-pitch");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        pitch: pitchData,
        outcomes: [{ id: "out_1", amountInCents: "500000" }],
      });
    });
  });

  describe("POST /research-projects/:projectSlug/pitches (create)", () => {
    const validPayload = {
      title: "Clean Water Drone Fleet",
      summary: "Autonomous drone network delivering portable water filtration pods to flood zones.",
    };

    it("answers 401 when signed out", async () => {
      signOut();

      const response = await request(app).post("/research-projects/clean-water/pitches").send(validPayload);

      expect(response.status).toBe(401);
    });

    it("rejects invalid payload with 422", async () => {
      const response = await request(app)
        .post("/research-projects/clean-water/pitches")
        .send({ ...validPayload, title: "No" });

      expect(response.status).toBe(422);
    });

    it("maps PROJECT_NOT_PUBLIC to 422", async () => {
      createPitchMock.mockResolvedValue({
        success: false,
        error: { type: "PROJECT_NOT_PUBLIC" },
      });

      const response = await request(app).post("/research-projects/clean-water/pitches").send(validPayload);

      expect(response.status).toBe(422);
      expect(response.body.message).toContain("Publish the project before submitting");
    });

    it("creates pitch draft and answers 201", async () => {
      const createdPitch = { id: "pitch_1", title: validPayload.title, status: "draft" };
      createPitchMock.mockResolvedValue({
        success: true,
        value: createdPitch,
      });

      const response = await request(app).post("/research-projects/clean-water/pitches").send(validPayload);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(createdPitch);
    });
  });

  describe("PATCH /pitches/:pitchId", () => {
    it("answers 401 when signed out", async () => {
      signOut();

      const response = await request(app).patch("/pitches/pitch_1").send({ title: "Updated Pitch Title" });

      expect(response.status).toBe(401);
    });

    it("maps PITCH_NOT_EDITABLE to 409", async () => {
      updatePitchMock.mockResolvedValue({
        success: false,
        error: { type: "PITCH_NOT_EDITABLE", status: "pending" },
      });

      const response = await request(app).patch("/pitches/pitch_1").send({ title: "Updated Pitch Title" });

      expect(response.status).toBe(409);
      expect(response.body.message).toContain("This pitch is being reviewed");
    });

    it("answers 200 on successful update", async () => {
      const updated = { id: "pitch_1", title: "Updated Pitch Title" };
      updatePitchMock.mockResolvedValue({
        success: true,
        value: updated,
      });

      const response = await request(app).patch("/pitches/pitch_1").send({ title: "Updated Pitch Title" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(updated);
    });
  });

  describe("POST /pitches/:pitchId/submit", () => {
    it("maps PITCH_INCOMPLETE to 422", async () => {
      submitPitchMock.mockResolvedValue({
        success: false,
        error: { type: "PITCH_INCOMPLETE", missingField: "externalFundingUrl" },
      });

      const response = await request(app).post("/pitches/pitch_1/submit");

      expect(response.status).toBe(422);
      expect(response.body.message).toContain("Add a funding link or a contact link");
    });

    it("maps PITCH_NOT_SUBMITTABLE to 409", async () => {
      submitPitchMock.mockResolvedValue({
        success: false,
        error: { type: "PITCH_NOT_SUBMITTABLE", status: "pending" },
      });

      const response = await request(app).post("/pitches/pitch_1/submit");

      expect(response.status).toBe(409);
    });

    it("answers 200 on submission", async () => {
      submitPitchMock.mockResolvedValue({
        success: true,
        value: { id: "pitch_1", status: "pending" },
      });

      const response = await request(app).post("/pitches/pitch_1/submit");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "pitch_1", status: "pending" });
    });
  });

  describe("POST /pitches/:pitchId/close", () => {
    it("maps PITCH_NOT_CLOSEABLE to 409", async () => {
      closePitchMock.mockResolvedValue({
        success: false,
        error: { type: "PITCH_NOT_CLOSEABLE" },
      });

      const response = await request(app).post("/pitches/pitch_1/close");

      expect(response.status).toBe(409);
      expect(response.body.message).toBe("Only a published pitch can be closed.");
    });

    it("answers 200 on successful close", async () => {
      closePitchMock.mockResolvedValue({
        success: true,
        value: { id: "pitch_1", status: "closed" },
      });

      const response = await request(app).post("/pitches/pitch_1/close");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "pitch_1", status: "closed" });
    });
  });

  describe("DELETE /pitches/:pitchId", () => {
    it("maps PITCH_NOT_DELETABLE to 409", async () => {
      deletePitchMock.mockResolvedValue({
        success: false,
        error: { type: "PITCH_NOT_DELETABLE" },
      });

      const response = await request(app).delete("/pitches/pitch_1");

      expect(response.status).toBe(409);
      expect(response.body.message).toContain("Only a draft can be deleted");
    });

    it("answers 200 on successful draft deletion", async () => {
      deletePitchMock.mockResolvedValue({
        success: true,
        value: { deletedPitchId: "pitch_1" },
      });

      const response = await request(app).delete("/pitches/pitch_1");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ deletedPitchId: "pitch_1" });
    });
  });

  describe("GET /pitches/review-queue & POST /pitches/:pitchId/moderate", () => {
    it("rejects non-moderator with 403", async () => {
      requirePlatformCapabilityMock.mockResolvedValue({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
      });

      const response = await request(app).get("/pitches/review-queue");

      expect(response.status).toBe(403);
      expect(response.body.message).toBe("This action requires a moderator.");
    });

    it("answers 200 with review queue for staff", async () => {
      listPitchReviewQueueMock.mockResolvedValue({
        rows: [{ id: "pitch_pending_1", title: "Pending Pitch" }],
        total: 1,
      });

      const response = await request(app).get("/pitches/review-queue");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: "pitch_pending_1", title: "Pending Pitch" }]);
    });

    it("moderator approves pitch and answers 200", async () => {
      moderatePitchMock.mockResolvedValue({
        success: true,
        value: { id: "pitch_1", status: "published" },
      });

      const response = await request(app).post("/pitches/pitch_1/moderate").send({ decision: "published" });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Pitch published.");
      expect(response.body.data).toEqual({ id: "pitch_1", status: "published" });
    });

    it("moderator rejects pitch with reason and answers 200", async () => {
      moderatePitchMock.mockResolvedValue({
        success: true,
        value: { id: "pitch_1", status: "rejected" },
      });

      const response = await request(app)
        .post("/pitches/pitch_1/moderate")
        .send({ decision: "rejected", reason: "The external funding link is invalid and does not resolve." });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Pitch rejected.");
      expect(response.body.data).toEqual({ id: "pitch_1", status: "rejected" });
    });
  });

  describe("POST /pitches/:pitchId/funding-outcomes & confirm", () => {
    const validOutcome = {
      amountInCents: "1000000",
      currencyCode: "USD",
      fundedOnDate: "2026-06-01",
      funderNameText: "Global Angel Syndicate",
      idempotencyKey: "unique_outcome_key_12345",
    };

    it("records new funding outcome and answers 201", async () => {
      recordPitchOutcomeMock.mockResolvedValue({
        success: true,
        value: { wasReplay: false, outcome: { id: "out_1", amountInCents: "1000000" } },
      });

      const response = await request(app).post("/pitches/pitch_1/funding-outcomes").send(validOutcome);

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ id: "out_1", amountInCents: "1000000" });
    });

    it("replays existing funding outcome and answers 200", async () => {
      recordPitchOutcomeMock.mockResolvedValue({
        success: true,
        value: { wasReplay: true, outcome: { id: "out_1", amountInCents: "1000000" } },
      });

      const response = await request(app).post("/pitches/pitch_1/funding-outcomes").send(validOutcome);

      expect(response.status).toBe(200);
      expect(response.body.message).toContain("Already recorded");
    });

    it("confirms funding outcome and answers 200", async () => {
      confirmPitchOutcomeMock.mockResolvedValue({
        success: true,
        value: { id: "out_1", confirmed: true },
      });

      const response = await request(app).post("/funding-outcomes/out_1/confirm");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ id: "out_1", confirmed: true });
    });

    it("maps CANNOT_CONFIRM_OWN_REPORT to 422", async () => {
      confirmPitchOutcomeMock.mockResolvedValue({
        success: false,
        error: { type: "CANNOT_CONFIRM_OWN_REPORT" },
      });

      const response = await request(app).post("/funding-outcomes/out_1/confirm");

      expect(response.status).toBe(422);
      expect(response.body.message).toContain("A funding record has to be confirmed by the other party");
    });
  });
});
