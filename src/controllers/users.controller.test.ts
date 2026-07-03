import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// users.service.ts imports the db pool, Cloudinary, and sharp at module scope,
// which pull in the config env parser. getUsers only calls getAllUsers, so stub
// the whole service rather than requiring a configured test environment.
vi.mock("#src/services/users.service.js", () => ({
  getAllUsers: vi.fn<typeof import("#src/services/users.service.js").getAllUsers>(),
}));

const usersService = await import("#src/services/users.service.js");
const { getUsers } = await import("#src/controllers/users.controller.js");

const getAllUsersMock = vi.mocked(usersService.getAllUsers);

/**
 * Minimal structural stub: getUsers reads nothing off the request. The cast is
 * confined to this test boundary — a real Express Request carries hundreds of
 * members the controller never touches.
 */
function createRequestStub(): Request {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {} as unknown as Request;
}

function createResponseStub(): {
  readonly response: Response;
  readonly statusSpy: ReturnType<typeof vi.fn>;
  readonly jsonSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn<(body: unknown) => void>();
  const statusSpy = vi.fn<(code: number) => { json: typeof jsonSpy }>(() => ({ json: jsonSpy }));
  // Structural stub of the two Response members the controller touches. Cast
  // confined to this test boundary (see createRequestStub).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const response = { status: statusSpy, json: jsonSpy } as unknown as Response;
  return { response, statusSpy, jsonSpy };
}

describe("getUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("responds 200 with a success envelope wrapping the service rows", async () => {
    const rows = [
      { id: "usr_a", email: "a@example.com", created_at: new Date("2026-01-01T00:00:00.000Z") },
      { id: "usr_b", email: "b@example.com", created_at: new Date("2026-01-02T00:00:00.000Z") },
    ];
    getAllUsersMock.mockResolvedValue(rows);
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await getUsers(createRequestStub(), response);

    expect(getAllUsersMock).toHaveBeenCalledExactlyOnceWith();
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
    getAllUsersMock.mockResolvedValue(rows);
    const { response, jsonSpy } = createResponseStub();

    await getUsers(createRequestStub(), response);

    const [envelope] = jsonSpy.mock.calls[0] ?? [];
    expect(envelope.data).toBe(rows);
  });

  it("returns an empty data array when no users exist", async () => {
    getAllUsersMock.mockResolvedValue([]);
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await getUsers(createRequestStub(), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(200);
    const [envelope] = jsonSpy.mock.calls[0] ?? [];
    expect(envelope.data).toEqual([]);
  });
});
