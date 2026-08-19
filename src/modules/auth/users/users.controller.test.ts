import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// users.service.ts imports the db pool, Cloudinary, and sharp at module scope, which pull in
// the config env parser. `getUsers` only calls `listUsersForStaff`, so stub the whole service
// rather than requiring a configured test environment.
vi.mock("#src/modules/auth/users/users.service.js", () => ({
  listUsersForStaff: vi.fn<typeof import("#src/modules/auth/users/users.service.js").listUsersForStaff>(),
}));

const usersService = await import("#src/modules/auth/users/users.service.js");
const { getUsers } = await import("#src/modules/auth/users/users.controller.js");

const listUsersForStaffMock = vi.mocked(usersService.listUsersForStaff);

/**
 * `getUsers` reads exactly one thing off the request: `req.user`. The cast is confined to
 * this test boundary — a real Express Request carries hundreds of members it never touches.
 */
function createRequestStub(userId: string | null): Request {
  const user = userId === null ? undefined : { id: userId };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { user } as unknown as Request;
}

function createResponseStub(): {
  readonly response: Response;
  readonly statusSpy: ReturnType<typeof vi.fn>;
  readonly jsonSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn<(body: unknown) => void>();
  const statusSpy = vi.fn<(code: number) => { json: typeof jsonSpy }>(() => ({ json: jsonSpy }));
  // Structural stub of the two Response members the controller touches. Cast confined to
  // this test boundary (see createRequestStub).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const response = { status: statusSpy, json: jsonSpy } as unknown as Response;
  return { response, statusSpy, jsonSpy };
}

describe("getUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * ⚠️ THE TWO REFUSAL CASES COME FIRST, because this route used to have neither.
   *
   * `GET /users` was unauthenticated and answered with a hundred real email addresses. The
   * three happy-path assertions below were all passing while that was true — they only ever
   * checked the envelope. These two are the ones that would have caught it.
   */
  it("refuses an unauthenticated caller with 401, without consulting the service", async () => {
    const { response, statusSpy } = createResponseStub();

    await getUsers(createRequestStub(null), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(401);
    expect(listUsersForStaffMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-staff caller with 403 and no rows", async () => {
    listUsersForStaffMock.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "view_platform_metrics" },
    });
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await getUsers(createRequestStub("usr_not_staff"), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(403);
    const [envelope] = jsonSpy.mock.calls[0] ?? [];
    // The refusal must not carry a `data` key at all — an empty array would read as "there
    // are no users", which is a different and untrue answer.
    expect(envelope).not.toHaveProperty("data");
  });

  it("responds 200 with a success envelope wrapping the service rows", async () => {
    const rows = [
      { id: "usr_a", email: "a@example.com", created_at: new Date("2026-01-01T00:00:00.000Z") },
      { id: "usr_b", email: "b@example.com", created_at: new Date("2026-01-02T00:00:00.000Z") },
    ];
    listUsersForStaffMock.mockResolvedValue({ success: true, value: rows });
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await getUsers(createRequestStub("usr_admin"), response);

    expect(listUsersForStaffMock).toHaveBeenCalledExactlyOnceWith("usr_admin");
    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(200);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "success",
      statusCode: 200,
      message: "Users retrieved successfully",
      data: rows,
    });
  });

  it("passes the service rows through untouched (no filtering or reshaping)", async () => {
    const rows = [{ id: "usr_a", email: "a@example.com", created_at: new Date("2026-01-01T00:00:00.000Z") }];
    listUsersForStaffMock.mockResolvedValue({ success: true, value: rows });
    const { response, jsonSpy } = createResponseStub();

    await getUsers(createRequestStub("usr_admin"), response);

    const [envelope] = jsonSpy.mock.calls[0] ?? [];
    expect(envelope.data).toBe(rows);
  });

  it("returns an empty data array when no users exist", async () => {
    listUsersForStaffMock.mockResolvedValue({ success: true, value: [] });
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await getUsers(createRequestStub("usr_admin"), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(200);
    const [envelope] = jsonSpy.mock.calls[0] ?? [];
    expect(envelope.data).toEqual([]);
  });
});
