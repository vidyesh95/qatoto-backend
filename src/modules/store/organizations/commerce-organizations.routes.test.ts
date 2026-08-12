import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, TEST_SESSION_USER } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const serviceStubs = vi.hoisted(() => ({
  createOrganization: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listMyOrganizations: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  activateOrganization: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateOrganization: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  createMember: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateMember: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listAddresses: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  createAddress: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  updateAddress: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  submitVerificationEvidence: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listVerifications: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  downloadVerificationEvidence: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  recordDocumentScannerVerdict: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  decideVerification: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  transitionTradeState: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/modules/store/organizations/commerce-organizations.service.js", () => serviceStubs);

interface CachedResponse {
  readonly fingerprint: string;
  readonly statusCode: number;
  readonly body: unknown;
}
const idempotencyResponses = vi.hoisted(() => new Map<string, CachedResponse>());

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
          idempotencyResponses.set(header, {
            fingerprint,
            statusCode: res.statusCode,
            body,
          });
        }
        return originalJson(body);
      };
      next();
    },
}));

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-000000000002";
const CREATE_BODY = {
  slug: "acme-tools",
  legalName: "Acme Tools Limited",
  displayName: "Acme Tools",
  organizationType: "company",
  countryCode: "IN",
};

describe("commerce organization routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyResponses.clear();
    signInAs();
    await resetRateLimiters();
  });

  it("requires and replays Idempotency-Key for organization creation", async () => {
    serviceStubs.createOrganization.mockResolvedValue({
      success: true,
      value: { id: ORGANIZATION_ID, tradeState: "pending" },
    });

    expect((await request(app).post("/commerce/organizations").send(CREATE_BODY)).status).toBe(400);

    const firstResponse = await request(app)
      .post("/commerce/organizations")
      .set("Idempotency-Key", "create-acme-001")
      .send(CREATE_BODY);
    const replayResponse = await request(app)
      .post("/commerce/organizations")
      .set("Idempotency-Key", "create-acme-001")
      .send(CREATE_BODY);

    expect(firstResponse.status).toBe(201);
    expect(replayResponse.status).toBe(201);
    expect(replayResponse.header["idempotency-replayed"]).toBe("true");
    expect(serviceStubs.createOrganization).toHaveBeenCalledTimes(1);
    expect(serviceStubs.createOrganization).toHaveBeenCalledWith(TEST_SESSION_USER.id, CREATE_BODY);
  });

  it("strictly rejects ownership and trade-state claims", async () => {
    const response = await request(app)
      .post("/commerce/organizations")
      .set("Idempotency-Key", "create-acme-002")
      .send({ ...CREATE_BODY, ownerUserId: "attacker", tradeState: "active" });

    expect(response.status).toBe(422);
    expect(serviceStubs.createOrganization).not.toHaveBeenCalled();
  });

  it("masks inaccessible cross-tenant organization ids as 404", async () => {
    serviceStubs.updateOrganization.mockResolvedValue({
      success: false,
      error: { type: "NOT_FOUND" },
    });

    const response = await request(app)
      .patch(`/commerce/organizations/${ORGANIZATION_ID}`)
      .set("Idempotency-Key", "update-org-001")
      .send({ displayName: "Probe" });

    expect(response.status).toBe(404);
    expect(response.body.message).not.toContain(ORGANIZATION_ID);
  });

  it("does not expose role escalation failures as resource details", async () => {
    serviceStubs.createMember.mockResolvedValue({
      success: false,
      error: { type: "ROLE_ESCALATION_FORBIDDEN" },
    });

    const response = await request(app)
      .post(`/commerce/organizations/${ORGANIZATION_ID}/members`)
      .set("Idempotency-Key", "invite-member-001")
      .send({ userId: "target-user", role: "administrator" });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe("This commerce organization action is not permitted.");
  });

  it("switches the current Better Auth session using only the path organization", async () => {
    serviceStubs.activateOrganization.mockResolvedValue({
      success: true,
      value: { activeOrganizationId: ORGANIZATION_ID },
    });

    const response = await request(app)
      .post(`/commerce/organizations/${ORGANIZATION_ID}/activate`)
      .set("Idempotency-Key", "activate-org-001");

    expect(response.status).toBe(200);
    expect(serviceStubs.activateOrganization).toHaveBeenCalledWith({
      userId: TEST_SESSION_USER.id,
      sessionId: "session_test",
      organizationId: ORGANIZATION_ID,
    });
  });

  it("accepts deterministic opaque migrated organization ids", async () => {
    const migratedOrganizationId = "commerce_org_legacy_0123456789abcdef";
    serviceStubs.activateOrganization.mockResolvedValue({
      success: true,
      value: { activeOrganizationId: migratedOrganizationId },
    });

    const response = await request(app)
      .post(`/commerce/organizations/${migratedOrganizationId}/activate`)
      .set("Idempotency-Key", "activate-org-002");

    expect(response.status).toBe(200);
    expect(serviceStubs.activateOrganization).toHaveBeenCalledWith({
      userId: TEST_SESSION_USER.id,
      sessionId: "session_test",
      organizationId: migratedOrganizationId,
    });
  });

  it("strictly rejects unknown member patch fields", async () => {
    const response = await request(app)
      .patch(`/commerce/organizations/${ORGANIZATION_ID}/members/${MEMBER_ID}`)
      .set("Idempotency-Key", "update-member-001")
      .send({ role: "viewer", organizationId: "another-tenant" });

    expect(response.status).toBe(422);
    expect(serviceStubs.updateMember).not.toHaveBeenCalled();
  });

  it("requires role and state changes to be audited in separate requests", async () => {
    const response = await request(app)
      .patch(`/commerce/organizations/${ORGANIZATION_ID}/members/${MEMBER_ID}`)
      .set("Idempotency-Key", "update-member-002")
      .send({ role: "viewer", state: "suspended" });

    expect(response.status).toBe(422);
    expect(serviceStubs.updateMember).not.toHaveBeenCalled();
  });

  it("strictly rejects unexpected query parameters", async () => {
    const response = await request(app).get("/commerce/organizations/mine?userId=attacker");

    expect(response.status).toBe(422);
    expect(serviceStubs.listMyOrganizations).not.toHaveBeenCalled();
  });

  it("maps the commerce moderation capability failure before disclosing verification ids", async () => {
    serviceStubs.decideVerification.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED" },
    });

    const response = await request(app)
      .post(`/commerce/organizations/${ORGANIZATION_ID}/verifications/00000000-0000-4000-8000-000000000003/decision`)
      .set("Idempotency-Key", "decide-verification-001")
      .send({ decision: "approved" });

    expect(response.status).toBe(403);
    expect(response.body.message).toBe("This action requires a platform staff role.");
  });

  it("routes trade-state transitions through the moderator service path", async () => {
    serviceStubs.transitionTradeState.mockResolvedValue({
      success: true,
      value: { id: ORGANIZATION_ID, tradeState: "active" },
    });

    const response = await request(app)
      .post(`/commerce/admin/organizations/${ORGANIZATION_ID}/trade-state`)
      .set("Idempotency-Key", "trade-state-001")
      .send({ tradeState: "active", reason: "Business registration verified." });

    expect(response.status).toBe(200);
    expect(serviceStubs.transitionTradeState).toHaveBeenCalledWith({
      moderatorUserId: TEST_SESSION_USER.id,
      organizationId: ORGANIZATION_ID,
      tradeState: "active",
      reason: "Business registration verified.",
    });
  });

  it("rejects client-asserted pending trade-state reopen", async () => {
    const response = await request(app)
      .post(`/commerce/admin/organizations/${ORGANIZATION_ID}/trade-state`)
      .set("Idempotency-Key", "trade-state-002")
      .send({ tradeState: "pending" });

    expect(response.status).toBe(422);
    expect(serviceStubs.transitionTradeState).not.toHaveBeenCalled();
  });

  it("records an explicit scanner verdict using only path-scoped identifiers", async () => {
    const documentId = "00000000-0000-4000-8000-000000000004";
    serviceStubs.recordDocumentScannerVerdict.mockResolvedValue({
      success: true,
      value: { documentId, state: "quarantined" },
    });

    const response = await request(app)
      .post(`/commerce/organizations/${ORGANIZATION_ID}/documents/${documentId}/scanner-verdict`)
      .set("Idempotency-Key", "scanner-verdict-001")
      .send({ verdict: "quarantined" });

    expect(response.status).toBe(200);
    expect(serviceStubs.recordDocumentScannerVerdict).toHaveBeenCalledWith({
      scannerUserId: TEST_SESSION_USER.id,
      organizationId: ORGANIZATION_ID,
      documentId,
      verdict: "quarantined",
    });
  });

  it("rejects scanner claims that try to cross organization scope", async () => {
    const response = await request(app)
      .post(`/commerce/organizations/${ORGANIZATION_ID}/documents/00000000-0000-4000-8000-000000000004/scanner-verdict`)
      .set("Idempotency-Key", "scanner-verdict-002")
      .send({ verdict: "available", organizationId: "another-tenant", scanned: true });

    expect(response.status).toBe(422);
    expect(serviceStubs.recordDocumentScannerVerdict).not.toHaveBeenCalled();
  });
});
