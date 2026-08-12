import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut, TEST_SESSION_USER } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * The platform moderation log, at the route level (§11l.2 item 2).
 *
 * TWO PROPERTIES WORTH PINNING, and both are about how a refusal reads:
 *
 *   1. A non-staff caller gets **403**, not 404 — and that is the 404-never-403 rule
 *      applied correctly rather than an exception to it. The refusal is decided before any
 *      id is read, so it discloses only the caller's own staff status (§4a Layer 3).
 *   2. A broken chain is **409**, never `200 { valid: false }`. A 200 saying the audit log
 *      does not verify is a response a monitoring system reads as healthy.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listPlatformAuditTrail = vi.fn<(...args: readonly unknown[]) => unknown>();
const verifyPlatformAuditChain = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/platform/audit/platform-audit.service.js", () => ({
  listPlatformAuditTrail: (...args: readonly unknown[]) => listPlatformAuditTrail(...args),
  verifyPlatformAuditChain: (...args: readonly unknown[]) => verifyPlatformAuditChain(...args),
}));

const CAPABILITY_REQUIRED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
};

describe("platform audit routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  it("answers 401 for a signed-out caller", async () => {
    signOut();

    expect((await request(app).get("/admin/audit-trail")).status).toBe(401);
    expect(listPlatformAuditTrail).not.toHaveBeenCalled();
  });

  it("answers 403 — not 404 — for a signed-in non-moderator", async () => {
    listPlatformAuditTrail.mockResolvedValue(CAPABILITY_REQUIRED);

    const response = await request(app).get("/admin/audit-trail");

    expect(response.status).toBe(403);
    // The message names no id and no capability: telling a caller which role they would
    // need is free reconnaissance.
    expect(response.body.message).toBe("This action requires a platform staff role.");
  });

  it("passes the parsed keyset cursor and filter through", async () => {
    listPlatformAuditTrail.mockResolvedValue({
      success: true,
      value: { rows: [], total: 0, nextSequence: null },
    });

    const response = await request(app).get("/admin/audit-trail?fromSequence=12&eventKind=cluster_merge_approved");

    // Asserted so a 401 or 422 short-circuit names itself rather than surfacing as an
    // uncalled spy — see `vitest.config.ts`'s `testTimeout` note.
    expect(response.status).toBe(200);
    expect(listPlatformAuditTrail).toHaveBeenCalledWith(TEST_SESSION_USER.id, {
      fromSequence: 12,
      eventKind: "cluster_merge_approved",
      limit: 50,
    });
  });

  it("rejects a page parameter — this log is keyset, not offset", async () => {
    const response = await request(app).get("/admin/audit-trail?page=2");

    expect(response.status).toBe(422);
    expect(listPlatformAuditTrail).not.toHaveBeenCalled();
  });

  it("answers 409 for a broken chain, never 200", async () => {
    verifyPlatformAuditChain.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CHAIN_BROKEN", sequenceNumber: 7, reason: "hash_mismatch" },
    });

    const response = await request(app).get("/admin/audit-trail/verify");

    expect(response.status).toBe(409);
    expect(response.body.data).toEqual({ sequenceNumber: 7, reason: "hash_mismatch" });
  });

  it("routes /verify to the verifier, not to the list", async () => {
    // `/verify` is a LITERAL under `/admin/audit-trail`. If a `/:entryId` route is ever
    // added above it, this request resolves as "the entry whose id is verify".
    verifyPlatformAuditChain.mockResolvedValue({
      success: true,
      value: { entriesChecked: 3, firstSequence: 1, lastSequence: 3, headEntryHash: "a".repeat(64) },
    });

    const response = await request(app).get("/admin/audit-trail/verify");

    expect(response.status).toBe(200);
    expect(verifyPlatformAuditChain).toHaveBeenCalledWith(TEST_SESSION_USER.id);
    expect(listPlatformAuditTrail).not.toHaveBeenCalled();
  });
});
