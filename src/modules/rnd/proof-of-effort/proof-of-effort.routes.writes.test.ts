import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for §9's WRITE surface — `proof-of-effort.routes.test.ts` covers reads
 * only (its own docstring says so); every mutation below (claim submission, re-verification,
 * the one hand-edit in the domain, and physical-receipt upload/delete) had zero coverage
 * above the pure schema/error-map unit tests before this file.
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

const requireProjectRole = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRole(...args),
  PROJECT_ROLE_RANK: { founder: 4, admin: 3, maintainer: 2, contributor: 1 },
}));

const submitEffortClaim = vi.fn<(...args: readonly unknown[]) => unknown>();
const requestReverification = vi.fn<(...args: readonly unknown[]) => unknown>();
const overrideVerificationStep = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/proof-of-effort/effort-claims.service.js", () => ({
  submitEffortClaim: (...args: readonly unknown[]) => submitEffortClaim(...args),
  requestReverification: (...args: readonly unknown[]) => requestReverification(...args),
  overrideVerificationStep: (...args: readonly unknown[]) => overrideVerificationStep(...args),
}));

const uploadReceipt = vi.fn<(...args: readonly unknown[]) => unknown>();
const listUnclaimedReceipts = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteReceipt = vi.fn<(...args: readonly unknown[]) => unknown>();
const findOwnReceipt = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/proof-of-effort/physical-receipts.service.js", () => ({
  uploadReceipt: (...args: readonly unknown[]) => uploadReceipt(...args),
  listUnclaimedReceipts: (...args: readonly unknown[]) => listUnclaimedReceipts(...args),
  deleteReceipt: (...args: readonly unknown[]) => deleteReceipt(...args),
  findOwnReceipt: (...args: readonly unknown[]) => findOwnReceipt(...args),
}));

const MEMBER_CONTEXT = {
  success: true,
  value: {
    projectId: "project_1",
    projectSlug: "solar-cold-storage",
    projectStatus: "active",
    founderUserId: "user_founder",
    currency: "INR",
    memberId: "member_1",
    memberRole: "maintainer",
  },
} as const;

const NOT_FOUND = { success: false, error: { type: "NOT_FOUND", projectRef: "solar-cold-storage" } };

const SLUG = "solar-cold-storage";
const BASE = `/research-projects/${SLUG}`;

/** A minimal valid 1x1 PNG, so the receipt upload's decoded-byte check has something to pass. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

describe("proof-of-effort write routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST …/effort-claims", () => {
    const path = `${BASE}/effort-claims`;
    const validBody = {
      sourceKind: "daily_log",
      dailyLogId: "11111111-1111-4111-8111-111111111111",
      claimedForDate: "2026-03-01",
      idempotencyKey: "claim_key_12345",
    };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(401);
      expect(submitEffortClaim).not.toHaveBeenCalled();
    });

    it("answers 404 for a signed-in non-member", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(404);
      expect(submitEffortClaim).not.toHaveBeenCalled();
    });

    it("submits the claim scoped to the caller's own membership row, and answers 202", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      submitEffortClaim.mockResolvedValue({ success: true, value: { claimId: "claim_1" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(202);
      expect(submitEffortClaim).toHaveBeenCalledWith(
        { projectId: "project_1", memberId: "member_1" },
        "user_test_caller",
        "maintainer",
        expect.objectContaining({
          sourceKind: "daily_log",
          dailyLogId: validBody.dailyLogId,
          claimedForDate: "2026-03-01",
          idempotencyKey: "claim_key_12345",
        }),
      );
    });

    it("rejects an idempotency key shorter than the minimum", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app)
        .post(path)
        .send({ ...validBody, idempotencyKey: "short" });

      expect(response.status).toBe(422);
      expect(submitEffortClaim).not.toHaveBeenCalled();
    });

    it("maps CLAIM_ALREADY_EXISTS to 409 — re-verify instead of double-claiming", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      submitEffortClaim.mockResolvedValue({
        success: false,
        error: { type: "CLAIM_ALREADY_EXISTS", claimId: "claim_1" },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("maps NOT_THE_AUTHOR to 403", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      submitEffortClaim.mockResolvedValue({ success: false, error: { type: "NOT_THE_AUTHOR" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(403);
    });

    it("maps PIE_ALREADY_BAKED to 409 — no more claims once equity is frozen", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      submitEffortClaim.mockResolvedValue({ success: false, error: { type: "PIE_ALREADY_BAKED" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });
  });

  describe("POST …/effort-claims/:claimId/reverify", () => {
    const path = `${BASE}/effort-claims/claim_1/reverify`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send({ reason: "New evidence attached." });

      expect(response.status).toBe(401);
      expect(requestReverification).not.toHaveBeenCalled();
    });

    it("requeues a NEW run and answers 202, never editing the existing one", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      requestReverification.mockResolvedValue({ success: true, value: { runId: "run_2" } });

      const response = await request(app).post(path).send({ reason: "New evidence attached." });

      expect(response.status).toBe(202);
      expect(requestReverification).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "claim_1",
        "New evidence attached.",
        "user_test_caller",
        "maintainer",
      );
    });

    it("rejects a body with no reason", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(requestReverification).not.toHaveBeenCalled();
    });

    it("maps CLAIM_NOT_FOUND to 404", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      requestReverification.mockResolvedValue({
        success: false,
        error: { type: "CLAIM_NOT_FOUND", claimId: "claim_missing" },
      });

      const response = await request(app).post(path).send({ reason: "Retry." });

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH …/effort-claims/:claimId/steps/:stepId/override — the one hand-edit in the domain", () => {
    const path = `${BASE}/effort-claims/claim_1/steps/step_1/override`;
    const validBody = { overriddenStatus: "passed", overrideReason: "Video clearly shows the milestone." };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).patch(path).send(validBody);

      expect(response.status).toBe(401);
      expect(overrideVerificationStep).not.toHaveBeenCalled();
    });

    it("asks membership for the maintainer floor, not a lower one", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      overrideVerificationStep.mockResolvedValue({ success: true, value: { stepId: "step_1" } });

      await request(app).patch(path).send(validBody);

      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "maintainer");
    });

    it("overrides the step and passes the typed verdict through", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      overrideVerificationStep.mockResolvedValue({
        success: true,
        value: { stepId: "step_1", overriddenStatus: "passed" },
      });

      const response = await request(app).patch(path).send(validBody);

      expect(response.status).toBe(200);
      expect(overrideVerificationStep).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "claim_1",
        "step_1",
        { overriddenStatus: "passed", overrideReason: "Video clearly shows the milestone." },
        "user_test_caller",
        "maintainer",
      );
    });

    it("rejects overriddenStatus: pending — an override cannot un-decide a step", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app)
        .patch(path)
        .send({ ...validBody, overriddenStatus: "pending" });

      expect(response.status).toBe(422);
      expect(overrideVerificationStep).not.toHaveBeenCalled();
    });

    it("rejects a body with no overrideReason", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).patch(path).send({ overriddenStatus: "flagged" });

      expect(response.status).toBe(422);
      expect(overrideVerificationStep).not.toHaveBeenCalled();
    });

    it("maps STEP_NOT_FOUND to 404", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      overrideVerificationStep.mockResolvedValue({
        success: false,
        error: { type: "STEP_NOT_FOUND", stepId: "step_missing" },
      });

      const response = await request(app).patch(path).send(validBody);

      expect(response.status).toBe(404);
    });
  });

  describe("physical receipts", () => {
    describe("GET …/physical-receipts", () => {
      it("answers 401 for a signed-out caller", async () => {
        signOut();

        const response = await request(app).get(`${BASE}/physical-receipts`);

        expect(response.status).toBe(401);
      });

      it("lists only the caller's own unclaimed receipts", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
        listUnclaimedReceipts.mockResolvedValue([{ id: "receipt_1" }]);

        const response = await request(app).get(`${BASE}/physical-receipts`);

        expect(response.status).toBe(200);
        expect(listUnclaimedReceipts).toHaveBeenCalledWith("project_1", "member_1");
        expect(response.body.data).toEqual([{ id: "receipt_1" }]);
      });
    });

    describe("GET …/physical-receipts/:receiptId", () => {
      it("answers 404 for another member's receipt — indistinguishable from absent", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
        findOwnReceipt.mockResolvedValue(null);

        const response = await request(app).get(`${BASE}/physical-receipts/receipt_elsewhere`);

        expect(response.status).toBe(404);
      });

      it("returns the caller's own receipt", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
        findOwnReceipt.mockResolvedValue({ id: "receipt_1" });

        const response = await request(app).get(`${BASE}/physical-receipts/receipt_1`);

        expect(response.status).toBe(200);
        expect(findOwnReceipt).toHaveBeenCalledWith("project_1", "member_1", "receipt_1");
      });
    });

    describe("DELETE …/physical-receipts/:receiptId", () => {
      it("deletes the caller's own receipt", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
        deleteReceipt.mockResolvedValue({ success: true, value: { id: "receipt_1" } });

        const response = await request(app).delete(`${BASE}/physical-receipts/receipt_1`);

        expect(response.status).toBe(200);
        expect(deleteReceipt).toHaveBeenCalledWith("project_1", "member_1", "receipt_1");
      });

      it("maps RECEIPT_CITED to 409 — evidence already attached to a claim cannot be deleted", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
        deleteReceipt.mockResolvedValue({
          success: false,
          error: { type: "RECEIPT_CITED", claimId: "claim_1" },
        });

        const response = await request(app).delete(`${BASE}/physical-receipts/receipt_1`);

        expect(response.status).toBe(409);
      });

      it("maps RECEIPT_NOT_FOUND to 404", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
        deleteReceipt.mockResolvedValue({
          success: false,
          error: { type: "RECEIPT_NOT_FOUND", receiptId: "receipt_missing" },
        });

        const response = await request(app).delete(`${BASE}/physical-receipts/receipt_missing`);

        expect(response.status).toBe(404);
      });
    });

    describe("POST …/physical-receipts — the only multipart route in this router", () => {
      const path = `${BASE}/physical-receipts`;

      it("answers 401 for a signed-out caller", async () => {
        signOut();

        const response = await request(app)
          .post(path)
          .field("receiptKind", "photo_of_work")
          .field("idempotencyKey", "receipt_key_12345")
          .attach("receipt", PNG_BYTES, { filename: "work.png", contentType: "image/png" });

        expect(response.status).toBe(401);
        expect(uploadReceipt).not.toHaveBeenCalled();
      });

      it("stores the upload and answers 202 — evidence awaiting a claim, not a claim itself", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
        uploadReceipt.mockResolvedValue({
          success: true,
          value: { id: "receipt_1", contentSha256: "abc123" },
        });

        const response = await request(app)
          .post(path)
          .field("receiptKind", "photo_of_work")
          .field("idempotencyKey", "receipt_key_12345")
          .attach("receipt", PNG_BYTES, { filename: "work.png", contentType: "image/png" });

        expect(response.status).toBe(202);
        expect(uploadReceipt).toHaveBeenCalledWith(
          { projectId: "project_1", memberId: "member_1" },
          expect.any(Buffer),
          expect.objectContaining({ receiptKind: "photo_of_work", idempotencyKey: "receipt_key_12345" }),
        );
      });

      it("answers 422 RECEIPT_FILE_MISSING when no file is attached", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

        const response = await request(app)
          .post(path)
          .field("receiptKind", "photo_of_work")
          .field("idempotencyKey", "receipt_key_12345");

        expect(response.status).toBe(422);
        expect(uploadReceipt).not.toHaveBeenCalled();
      });

      it("maps DUPLICATE_RECEIPT to 409 — the same bytes cannot fund two receipts", async () => {
        requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
        uploadReceipt.mockResolvedValue({
          success: false,
          error: { type: "DUPLICATE_RECEIPT", contentSha256: "abc123" },
        });

        const response = await request(app)
          .post(path)
          .field("receiptKind", "photo_of_work")
          .field("idempotencyKey", "receipt_key_12345")
          .attach("receipt", PNG_BYTES, { filename: "work.png", contentType: "image/png" });

        expect(response.status).toBe(409);
      });
    });
  });
});
