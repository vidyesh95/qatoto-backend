import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `POST /blueprints/admin/showcases/:launchId/moderation-state`.
 *
 * ⚠️ THE CENTRAL CASE IS AN ORDERING PROOF, not a status check. `moderate_content` is resolved
 * BEFORE `req.params.launchId` is read and before the body is parsed. Reversed, a 403 that only
 * arrives for launches that exist turns this route into an existence oracle over other people's
 * unpublished work. It is asserted by sending a non-moderator a request that is ALSO malformed and
 * requiring **403, not 422** — a 422 would mean the parse ran first.
 *
 * ⚠️ THE SECOND CASE IS THAT `quarantine` IS REFUSED ON THIS ARM. It is refused in three
 * independent places and this suite covers the one a client can observe: the service answers
 * `not_available_on_arm`, which the mapper turns into a 409 naming the arm. The other two —
 * `showcase_launch_moderation_state_ck` and `blueprint_moderation_action_quarantine_arm_ck` — are
 * SQL and belong to `db:verify-showcase-launch-constraints`, because vitest mocks the database
 * wholesale and no test in this file can prove anything about Postgres.
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

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      if (!req.header("Idempotency-Key") && options.required === true) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "This request requires an Idempotency-Key header.",
        });
        return;
      }
      next();
    },
}));

const requirePlatformCapability = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (...args: readonly unknown[]) => requirePlatformCapability(...args),
}));

const applyShowcaseLaunchModerationVerb = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/blueprints/blueprint-moderation.service.js", () => ({
  applyShowcaseLaunchModerationVerb: (...args: readonly unknown[]) => applyShowcaseLaunchModerationVerb(...args),
}));

const MODERATOR_CONTEXT = {
  success: true,
  value: { staffUserId: "user_test_caller", platformRole: "admin" },
} as const;

const CAPABILITY_REFUSED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

const LAUNCH_ID = "launch_0001";
const path = `/blueprints/admin/showcases/${LAUNCH_ID}/moderation-state`;

describe("blueprints showcase moderation routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signOut();
    await resetRateLimiters();
  });

  it("refuses a signed-out caller with 401", async () => {
    const response = await request(app)
      .post(path)
      .set("Idempotency-Key", "key-1")
      .send({ verb: "flag", reasonNote: "A reader reported fabricated results." });

    expect(response.status).toBe(401);
    expect(requirePlatformCapability).not.toHaveBeenCalled();
  });

  it("refuses a caller without moderate_content with 403", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

    const response = await request(app)
      .post(path)
      .set("Idempotency-Key", "key-2")
      .send({ verb: "flag", reasonNote: "A reader reported fabricated results." });

    expect(response.status).toBe(403);
    expect(applyShowcaseLaunchModerationVerb).not.toHaveBeenCalled();
  });

  /** ⚠️ THE ORDERING PROOF. A 422 here would mean the body was parsed before the capability. */
  it("answers 403 rather than 422 when the caller is BOTH unauthorized and malformed", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

    const response = await request(app).post(path).set("Idempotency-Key", "key-3").send({ verb: "not_a_verb" });

    expect(response.status).toBe(403);
    expect(applyShowcaseLaunchModerationVerb).not.toHaveBeenCalled();
  });

  it("answers 422 for a malformed body once the caller holds the capability", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

    const response = await request(app).post(path).set("Idempotency-Key", "key-4").send({ verb: "flag" });

    expect(response.status).toBe(422);
    expect(applyShowcaseLaunchModerationVerb).not.toHaveBeenCalled();
  });

  it("passes the launch id, the verb and the note through to the service", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
    applyShowcaseLaunchModerationVerb.mockResolvedValue({
      success: true,
      value: {
        targetId: LAUNCH_ID,
        targetKind: "showcase",
        moderationState: "flagged",
        decidedAt: new Date("2026-03-01T10:00:00.000Z"),
      },
    });

    const response = await request(app)
      .post(path)
      .set("Idempotency-Key", "key-5")
      .send({ verb: "flag", reasonNote: "A reader reported fabricated results." });

    expect(response.status).toBe(200);
    expect(applyShowcaseLaunchModerationVerb).toHaveBeenCalledWith({
      targetId: LAUNCH_ID,
      verb: "flag",
      reasonNote: "A reader reported fabricated results.",
      // ⚠️ NULL, NOT ABSENT. `.default(null)` means the service never sees `undefined`.
      reportId: null,
      staff: MODERATOR_CONTEXT.value,
    });
  });

  /** ⚠️ QUARANTINE IS NOT AVAILABLE ON THIS ARM — a 409 naming the arm, not a 404 or a 422. */
  it("answers 409 when the service refuses quarantine on this arm", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
    applyShowcaseLaunchModerationVerb.mockResolvedValue({
      success: false,
      error: {
        type: "BLUEPRINT_TRANSITION_NOT_AVAILABLE",
        verb: "quarantine",
        arm: "showcase",
        moderationState: "published",
      },
    });

    const response = await request(app)
      .post(path)
      .set("Idempotency-Key", "key-6")
      .send({ verb: "quarantine", reasonNote: "A rights holder emailed about the hero image." });

    expect(response.status).toBe(409);
    /*
     * The message must name this arm. The mapper used to pick between two literals with a ternary,
     * which would have called a showcase launch a teardown in the one sentence a moderator reads
     * to understand the refusal.
     */
    expect(response.body.message).toContain("showcase launch");
  });

  /**
   * ⚠️ THE REPORT ID IS OPTIONAL ON THE WIRE AND NEVER `undefined` IN THE SERVICE. A moderator
   * acting on an emailed rights claim sends no id at all, which is the ORDINARY case — see the
   * command schema. This pair asserts both halves of that contract.
   */
  it("passes a supplied report id through, so the reporter's list can stop saying open", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
    applyShowcaseLaunchModerationVerb.mockResolvedValue({
      success: true,
      value: {
        targetId: LAUNCH_ID,
        targetKind: "showcase",
        moderationState: "flagged",
        decidedAt: new Date("2026-03-01T10:00:00.000Z"),
      },
    });

    const reportId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const response = await request(app)
      .post(path)
      .set("Idempotency-Key", "key-8")
      .send({ verb: "flag", reasonNote: "Answering the report.", reportId });

    expect(response.status).toBe(200);
    expect(applyShowcaseLaunchModerationVerb.mock.calls[0]?.[0]).toMatchObject({ reportId });
  });

  it("refuses a malformed report id with 422", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

    const response = await request(app)
      .post(path)
      .set("Idempotency-Key", "key-9")
      .send({ verb: "flag", reasonNote: "Answering the report.", reportId: "not-a-uuid" });

    expect(response.status).toBe(422);
    expect(applyShowcaseLaunchModerationVerb).not.toHaveBeenCalled();
  });

  /** ⚠️ A REPORT ABOUT A DIFFERENT ROW ANSWERS 404 — the same bytes as one that does not exist. */
  it("answers 404 when the report names a different blueprint", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
    applyShowcaseLaunchModerationVerb.mockResolvedValue({
      success: false,
      error: { type: "BLUEPRINT_REPORT_NOT_FOUND" },
    });

    const response = await request(app).post(path).set("Idempotency-Key", "key-10").send({
      verb: "flag",
      reasonNote: "Answering the report.",
      reportId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    });

    expect(response.status).toBe(404);
  });

  it("answers 409 when another moderator already resolved the report", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
    applyShowcaseLaunchModerationVerb.mockResolvedValue({
      success: false,
      error: { type: "BLUEPRINT_REPORT_ALREADY_RESOLVED" },
    });

    const response = await request(app).post(path).set("Idempotency-Key", "key-11").send({
      verb: "flag",
      reasonNote: "Answering the report.",
      reportId: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
    });

    expect(response.status).toBe(409);
  });

  it("answers 404 when the launch does not exist", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
    applyShowcaseLaunchModerationVerb.mockResolvedValue({
      success: false,
      error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" },
    });

    const response = await request(app)
      .post(path)
      .set("Idempotency-Key", "key-7")
      .send({ verb: "flag", reasonNote: "A reader reported fabricated results." });

    expect(response.status).toBe(404);
  });

  it("requires an Idempotency-Key", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

    const response = await request(app)
      .post(path)
      .send({ verb: "flag", reasonNote: "A reader reported fabricated results." });

    expect(response.status).toBe(400);
    expect(applyShowcaseLaunchModerationVerb).not.toHaveBeenCalled();
  });
});
