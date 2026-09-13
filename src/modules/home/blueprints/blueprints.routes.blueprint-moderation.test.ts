import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the three verbs that act on a PUBLISHED blueprint.
 *
 * ⚠️ TWO OF THESE CASES ARE SECURITY PROPERTIES RATHER THAN BEHAVIOUR, and both come straight from
 * blueprints doc §3.6:
 *
 *   1. THE ORDERING PROOF. The capability is resolved BEFORE `req.params` is read and before the
 *      body is parsed. A non-moderator sends a request that is ALSO malformed and must receive
 *      403, NOT 422 — a 422 would mean the parse ran first, and a 403 that only arrives for rows
 *      that exist is an existence oracle over other people's unpublished work.
 *   2. THE ID-ORACLE PROOF. A non-moderator gets a byte-identical answer for a real-looking id and
 *      a garbage one — same status AND same message.
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

const applyTeardownModerationVerb = vi.fn<(...args: readonly unknown[]) => unknown>();
const applyCaseStudyModerationVerb = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/blueprint-moderation.service.js", () => ({
  applyTeardownModerationVerb: (...args: readonly unknown[]) => applyTeardownModerationVerb(...args),
  applyCaseStudyModerationVerb: (...args: readonly unknown[]) => applyCaseStudyModerationVerb(...args),
}));

const MODERATOR_CONTEXT = {
  success: true,
  value: { staffUserId: "user_test_caller", platformRole: "admin" },
} as const;

const CAPABILITY_REFUSED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

const DECIDED_AT = new Date("2026-04-01T09:00:00.000Z");

const FLAG_APPLIED = {
  success: true,
  value: {
    targetId: "td_1",
    targetKind: "teardown",
    moderationState: "flagged",
    decidedAt: DECIDED_AT,
  },
} as const;

describe("the blueprint moderation verbs", () => {
  let app: Express;
  const teardownPath = "/blueprints/admin/teardowns/td_1/moderation-state";

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    signOut();
    vi.clearAllMocks();
    idempotencyResponses.clear();
    await resetRateLimiters();
  });

  it("refuses a signed-out caller with 401, without resolving any capability", async () => {
    const response = await request(app)
      .post(teardownPath)
      .set("Idempotency-Key", "key-signed-out")
      .send({ verb: "flag", reasonNote: "Because." });

    expect(response.status).toBe(401);
    expect(requirePlatformCapability).not.toHaveBeenCalled();
    expect(applyTeardownModerationVerb).not.toHaveBeenCalled();
  });

  it("refuses a caller without moderate_content with 403", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

    const response = await request(app)
      .post(teardownPath)
      .set("Idempotency-Key", "key-no-capability")
      .send({ verb: "flag", reasonNote: "Because." });

    expect(response.status).toBe(403);
    expect(applyTeardownModerationVerb).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ THE ORDERING PROOF. See contract 1 in the file docblock. A 422 here would mean the body was
   * parsed before the capability was resolved.
   */
  it("answers 403 — NOT 422 — when the caller lacks the capability AND the body is malformed", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

    const response = await request(app)
      .post(teardownPath)
      .set("Idempotency-Key", "key-ordering")
      .send({ verb: "sideways", reasonNote: "" });

    expect(response.status).toBe(403);
    expect(applyTeardownModerationVerb).not.toHaveBeenCalled();
  });

  /** ⚠️ THE ID-ORACLE PROOF. See contract 2. */
  it("answers byte-identically for a real-looking id and a garbage one", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

    const realLooking = await request(app)
      .post("/blueprints/admin/teardowns/td_probably_real/moderation-state")
      .set("Idempotency-Key", "key-oracle-a")
      .send({ verb: "flag", reasonNote: "Because." });
    const garbage = await request(app)
      .post("/blueprints/admin/teardowns/%20%20/moderation-state")
      .set("Idempotency-Key", "key-oracle-b")
      .send({ verb: "flag", reasonNote: "Because." });

    expect(realLooking.status).toBe(garbage.status);
    expect(realLooking.body.message).toBe(garbage.body.message);
  });

  it("applies a verb and answers the resulting state", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
    applyTeardownModerationVerb.mockResolvedValue(FLAG_APPLIED);

    const response = await request(app)
      .post(teardownPath)
      .set("Idempotency-Key", "key-applied")
      .send({ verb: "flag", reasonNote: "A reader reported a fabricated figure." });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ moderationState: "flagged" });
    expect(applyTeardownModerationVerb.mock.calls[0]?.[0]).toMatchObject({
      targetId: "td_1",
      verb: "flag",
      reasonNote: "A reader reported a fabricated figure.",
    });
  });

  /** ⚠️ REQUIRED ON ALL THREE VERBS, INCLUDING `restore` — a restore overturns a colleague. */
  it("refuses every verb with no reason note, restore included", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

    for (const verb of ["flag", "quarantine", "restore"]) {
      const response = await request(app)
        .post(teardownPath)
        .set("Idempotency-Key", `key-no-note-${verb}`)
        .send({ verb, reasonNote: "   " });

      expect(response.status, `${verb} must require a reason note`).toBe(422);
    }
    expect(applyTeardownModerationVerb).not.toHaveBeenCalled();
  });

  it("refuses an unknown verb with 422", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

    const response = await request(app)
      .post(teardownPath)
      .set("Idempotency-Key", "key-unknown-verb")
      .send({ verb: "delete", reasonNote: "Because." });

    expect(response.status).toBe(422);
    expect(applyTeardownModerationVerb).not.toHaveBeenCalled();
  });

  it("refuses an unknown body key with 422 — the schema is .strict()", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

    const response = await request(app)
      .post(teardownPath)
      .set("Idempotency-Key", "key-unknown-key")
      .send({ verb: "flag", reasonNote: "Because.", moderatorUserId: "user_someone_else" });

    expect(response.status).toBe(422);
    expect(applyTeardownModerationVerb).not.toHaveBeenCalled();
  });

  it("maps each domain refusal to its status", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

    const cases = [
      { error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" }, status: 404 },
      { error: { type: "BLUEPRINT_SELF_MODERATION_FORBIDDEN" }, status: 403 },
      { error: { type: "BLUEPRINT_ALREADY_IN_STATE", moderationState: "flagged" }, status: 409 },
      { error: { type: "BLUEPRINT_NOT_PUBLIC_YET", moderationState: "pending_review" }, status: 409 },
      {
        error: {
          type: "BLUEPRINT_TRANSITION_NOT_AVAILABLE",
          verb: "flag",
          arm: "teardown",
          moderationState: "quarantined",
        },
        status: 409,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      applyTeardownModerationVerb.mockResolvedValue({ success: false, error: testCase.error });
      const response = await request(app)
        .post(teardownPath)
        .set("Idempotency-Key", `key-error-${String(index)}`)
        .send({ verb: "flag", reasonNote: "Because." });

      // The error type rides in the assertion's SUBJECT rather than in a message, because the
      // lint rule requires a literal there — and pairing them this way names the failing case in
      // the diff without a message at all.
      expect({ errorType: testCase.error.type, status: response.status }).toEqual({
        errorType: testCase.error.type,
        status: testCase.status,
      });
    }
  });

  /**
   * ⚠️ THE CASE-STUDY ARM ACCEPTS `quarantine` AT THE PARSE BOUNDARY AND REFUSES IT WITH A 409.
   * Not a 404 and not a 422: the route exists and the body is well-formed. What does not exist is
   * the STATE — `case_study_moderation_state_ck` has no `quarantined` label, because a case study
   * has no files to withhold. A moderator working two queues is better served by a sentence than
   * by a missing route.
   */
  it("refuses quarantine on the case-study arm with 409, not 404", async () => {
    signInAs();
    requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
    applyCaseStudyModerationVerb.mockResolvedValue({
      success: false,
      error: {
        type: "BLUEPRINT_TRANSITION_NOT_AVAILABLE",
        verb: "quarantine",
        arm: "case_study",
        moderationState: "published",
      },
    });

    const response = await request(app)
      .post("/blueprints/admin/case-studies/cs_1/moderation-state")
      .set("Idempotency-Key", "key-cs-quarantine")
      .send({ verb: "quarantine", reasonNote: "Trying it on." });

    expect(response.status).toBe(409);
    expect(applyCaseStudyModerationVerb).toHaveBeenCalledTimes(1);
  });
});
