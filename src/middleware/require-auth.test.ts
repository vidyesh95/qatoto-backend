import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();

vi.mock("#src/lib/auth.js", () => ({
  auth: {
    api: {
      getSession: getSessionMock,
    },
  },
}));

vi.mock("better-auth/node", () => ({
  fromNodeHeaders: vi.fn(),
}));

const { requireAuth } = await import("#src/middleware/require-auth.js");

function createRequestStub(): Request {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { headers: {} } as unknown as Request;
}

function createNextStub(): {
  readonly next: NextFunction;
  readonly spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn<(error?: unknown) => void>();
  return { next: spy, spy };
}

function createResponseStub(): {
  readonly response: Response;
  readonly statusSpy: ReturnType<typeof vi.fn>;
  readonly jsonSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn<(body: unknown) => void>();
  const statusSpy = vi.fn<(code: number) => { json: typeof jsonSpy }>(() => ({ json: jsonSpy }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const response = { status: statusSpy, json: jsonSpy } as unknown as Response;
  return { response, statusSpy, jsonSpy };
}

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when there is no session and does not call next", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const { response, statusSpy, jsonSpy } = createResponseStub();
    const { next, spy: nextSpy } = createNextStub();

    await requireAuth(createRequestStub(), response, next);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(401);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    expect(nextSpy).not.toHaveBeenCalled();
  });

  it("403s when the session user is deactivated and does not call next", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { deactivatedAt: new Date() },
    });
    const { response, statusSpy, jsonSpy } = createResponseStub();
    const { next, spy: nextSpy } = createNextStub();

    await requireAuth(createRequestStub(), response, next);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(403);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "error",
      statusCode: 403,
      message: "This account is deactivated. Sign in again to restore it.",
    });
    expect(nextSpy).not.toHaveBeenCalled();
  });

  it("attaches req.user and req.authSession and calls next for a valid session", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: {
        id: "usr_123",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        handle: "testuser",
      },
      session: {
        id: "sess_456",
        activeOrganizationId: "org_789",
      },
    });

    const request = createRequestStub();
    const { response, statusSpy, jsonSpy } = createResponseStub();
    const { next, spy: nextSpy } = createNextStub();

    await requireAuth(request, response, next);

    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(nextSpy).toHaveBeenCalledExactlyOnceWith();

    expect(request.user).toEqual({
      id: "usr_123",
      email: "test@example.com",
      name: "Test User",
      emailVerified: true,
      handle: "testuser",
    });

    expect(request.authSession).toEqual({
      id: "sess_456",
      activeOrganizationId: "org_789",
    });
  });

  it("handles null handle and activeOrganizationId correctly", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: {
        id: "usr_123",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        // missing handle
      },
      session: {
        id: "sess_456",
        // missing activeOrganizationId
      },
    });

    const request = createRequestStub();
    const { response, statusSpy, jsonSpy } = createResponseStub();
    const { next, spy: nextSpy } = createNextStub();

    await requireAuth(request, response, next);

    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(nextSpy).toHaveBeenCalledExactlyOnceWith();

    expect(request.user).toEqual({
      id: "usr_123",
      email: "test@example.com",
      name: "Test User",
      emailVerified: true,
      handle: null,
    });

    expect(request.authSession).toEqual({
      id: "sess_456",
      activeOrganizationId: null,
    });
  });
});
