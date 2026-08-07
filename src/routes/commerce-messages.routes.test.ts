import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const ORGANIZATION_ID = "commerce_org_messages_1";

const idempotencyCache = vi.hoisted(() => new Map<string, { statusCode: number; body: unknown }>());

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    () =>
    (req: Request, res: Response, next: NextFunction): void => {
      const key = req.header("Idempotency-Key");
      if (!key) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "Idempotency-Key header is required.",
        });
        return;
      }
      const cached = idempotencyCache.get(key);
      if (cached) {
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          idempotencyCache.set(key, { statusCode: res.statusCode, body });
        }
        return originalJson(body);
      }) as typeof res.json;
      next();
    },
}));

vi.mock("#src/middleware/require-active-commerce-organization.js", () => ({
  // Phase 9 authoring routes attach an organization optionally, because a platform
  // merchandiser may not belong to one. Mounted through app.ts, so every suite that
  // mocks this module must provide it.
  attachOptionalSellerCommerceOrganization: (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  },
  requireActiveCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-messages",
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveSellerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-messages",
      memberRole: "seller",
      tradeState: "active",
    };
    next();
  },
  requireActiveBuyerCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-messages",
      memberRole: "buyer",
      tradeState: "active",
    };
    next();
  },
  requireActiveProviderCommerceOrganization: (req: Request, _res: Response, next: NextFunction): void => {
    req.commerceOrganization = {
      organizationId: ORGANIZATION_ID,
      memberId: "member-messages",
      memberRole: "provider_operator",
      tradeState: "active",
    };
    next();
  },
}));

const serviceStubs = vi.hoisted(() => ({
  createOrGetThread: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  listMessages: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
  appendMessage: vi.fn<(...arguments_: readonly unknown[]) => unknown>(),
}));

vi.mock("#src/services/commerce-messages.service.js", () => serviceStubs);

describe("commerce message routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
  });

  it("rejects unknown keys on thread create with 422", async () => {
    const response = await request(app).post("/commerce/threads").set("Idempotency-Key", "thread-unknown").send({
      resourceKind: "rfq",
      resourceId: "rfq-1",
      organizationId: "forged-org",
    });

    expect(response.status).toBe(422);
    expect(serviceStubs.createOrGetThread).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    signOut();

    const response = await request(app).post("/commerce/threads").set("Idempotency-Key", "thread-unauth").send({
      resourceKind: "rfq",
      resourceId: "rfq-1",
    });

    expect(response.status).toBe(401);
    expect(serviceStubs.createOrGetThread).not.toHaveBeenCalled();
  });

  it("creates or returns a thread under the active organization", async () => {
    serviceStubs.createOrGetThread.mockResolvedValue({
      success: true,
      value: {
        id: "thread-1",
        resourceKind: "rfq",
        resourceId: "rfq-1",
        createdByOrganizationId: ORGANIZATION_ID,
        createdByMemberId: "member-messages",
        createdAt: new Date("2026-08-05T12:00:00.000Z"),
        updatedAt: new Date("2026-08-05T12:00:00.000Z"),
        participants: [{ organizationId: ORGANIZATION_ID, participantRole: "buyer" }],
      },
    });

    const response = await request(app).post("/commerce/threads").set("Idempotency-Key", "thread-ok").send({
      resourceKind: "rfq",
      resourceId: "rfq-1",
    });

    expect(response.status).toBe(200);
    expect(serviceStubs.createOrGetThread).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKind: "rfq",
        resourceId: "rfq-1",
        organizationId: ORGANIZATION_ID,
        memberId: "member-messages",
      }),
    );
  });

  it("requires an idempotency key when appending a message", async () => {
    const response = await request(app).post("/commerce/threads/thread-1/messages").send({
      bodyText: "Can you revise the lead time?",
    });

    expect(response.status).toBe(400);
    expect(serviceStubs.appendMessage).not.toHaveBeenCalled();
  });
});
