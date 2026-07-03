import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

// auth.controller.ts imports the db pool and the Better Auth instance at module
// scope, which pull in the config env parser and a pg Pool. getCurrentUser
// touches neither, so stub both modules out rather than requiring a configured
// test environment.
vi.mock("#src/db/index.js", () => ({ db: {} }));
vi.mock("#src/lib/auth.js", () => ({ auth: {}, sendSignupOtp: vi.fn<() => Promise<void>>() }));

const { getCurrentUser } = await import("#src/controllers/auth.controller.js");

const AUTHENTICATED_USER = {
  id: "usr_test123",
  email: "vidyesh@example.com",
  name: "Vidyesh Churi",
  emailVerified: true,
  handle: "vidyesh_churi",
} as const;

/**
 * Minimal structural stubs for the two Express members getCurrentUser touches
 * (`req.user`, `res.status().json()`). The double cast is confined to this test
 * boundary: Express's Request/Response carry hundreds of members the controller
 * never reads, and constructing real ones would require an HTTP server.
 */
function createRequestStub(sessionUser: Request["user"]): Request {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { user: sessionUser } as unknown as Request;
}

function createResponseStub(): {
  readonly response: Response;
  readonly statusSpy: ReturnType<typeof vi.fn>;
  readonly jsonSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn<(body: unknown) => void>();
  const statusSpy = vi.fn<(code: number) => { readonly json: typeof jsonSpy }>(() => ({
    json: jsonSpy,
  }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const response = { status: statusSpy, json: jsonSpy } as unknown as Response;
  return { response, statusSpy, jsonSpy };
}

describe("getCurrentUser", () => {
  it("responds 200 with a success envelope containing the session user", () => {
    const { response, statusSpy, jsonSpy } = createResponseStub();

    getCurrentUser(createRequestStub(AUTHENTICATED_USER), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(200);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "success",
      statusCode: 200,
      message: "Current user retrieved successfully",
      data: AUTHENTICATED_USER,
    });
  });

  it("passes req.user through untouched (no cloning, filtering, or mutation)", () => {
    const { response, jsonSpy } = createResponseStub();

    getCurrentUser(createRequestStub(AUTHENTICATED_USER), response);

    const [envelope] = jsonSpy.mock.calls[0] ?? [];
    expect(envelope.data).toBe(AUTHENTICATED_USER);
  });

  it("preserves a null handle on a user who has not claimed one", () => {
    const unclaimedHandleUser = { ...AUTHENTICATED_USER, handle: null };
    const { response, jsonSpy } = createResponseStub();

    getCurrentUser(createRequestStub(unclaimedHandleUser), response);

    const [envelope] = jsonSpy.mock.calls[0] ?? [];
    expect(envelope.data).toEqual(unclaimedHandleUser);
    expect(envelope.data.handle).toBeNull();
  });

  it("responds with undefined data when req.user is absent (requireAuth gap)", () => {
    // Documents current behavior: the controller assumes requireAuth ran and
    // does not guard against a missing session user itself.
    const { response, statusSpy, jsonSpy } = createResponseStub();

    getCurrentUser(createRequestStub(undefined), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(200);
    const [envelope] = jsonSpy.mock.calls[0] ?? [];
    expect(envelope.status).toBe("success");
    expect(envelope.data).toBeUndefined();
  });
});
