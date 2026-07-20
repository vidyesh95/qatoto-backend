import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The middleware pulls the db pool in at module scope. Stub the whole db module so
// the predicate's BRANCHING can be exercised without a live Postgres — the SQL itself
// is covered by the integration suite.
const limitMock = vi.fn<() => Promise<Array<{ id: string }>>>();

vi.mock("#src/db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: limitMock }),
      }),
    }),
  },
}));

const { requireIdentifiedUser } = await import("#src/middleware/require-identified-user.js");

function createRequestStub(user?: { readonly id: string }): Request {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { user } as unknown as Request;
}

/**
 * Express's `NextFunction` is overloaded (`deferToNext: "route" | "router"`), which a
 * plain `vi.fn` cannot satisfy structurally. Cast confined to the test boundary, as
 * the response stub below already does.
 */
function createNextStub(): {
  readonly next: NextFunction;
  readonly spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn<(error?: unknown) => void>();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { next: spy as unknown as NextFunction, spy };
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

describe("requireIdentifiedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when requireAuth has not run (no req.user) and does not call next", async () => {
    const { response, statusSpy, jsonSpy } = createResponseStub();
    const { next, spy: nextSpy } = createNextStub();

    await requireIdentifiedUser(createRequestStub(), response, next);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(401);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    expect(nextSpy).not.toHaveBeenCalled();
    // The query must not even run without an id to scope it to.
    expect(limitMock).not.toHaveBeenCalled();
  });

  it("403s — not 401 — when the caller has a session but no identity", async () => {
    // The anonymous-session case, and the orphan case. The caller HAS a session; it
    // is just not enough, so 401 ("please sign in") would be a lie.
    limitMock.mockResolvedValueOnce([]);
    const { response, statusSpy, jsonSpy } = createResponseStub();
    const { next, spy: nextSpy } = createNextStub();

    await requireIdentifiedUser(createRequestStub({ id: "usr_anon" }), response, next);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(403);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "error",
      statusCode: 403,
      message: "This action requires a full account. Please finish signing up.",
    });
    expect(nextSpy).not.toHaveBeenCalled();
  });

  it("calls next exactly once and never touches the response for an identified user", async () => {
    limitMock.mockResolvedValueOnce([{ id: "usr_real" }]);
    const { response, statusSpy, jsonSpy } = createResponseStub();
    const { next, spy: nextSpy } = createNextStub();

    await requireIdentifiedUser(createRequestStub({ id: "usr_real" }), response, next);

    expect(nextSpy).toHaveBeenCalledOnce();
    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("rejects rather than swallowing a database failure", async () => {
    // No try/catch by design: Express 5 forwards a rejected middleware promise to
    // errorHandler, which is correct for a lost connection (CLAUDE.md §3.3).
    // Swallowing it would fail OPEN on the sybil guard.
    limitMock.mockRejectedValueOnce(new Error("connection terminated"));
    const { response, statusSpy } = createResponseStub();
    const { next, spy: nextSpy } = createNextStub();

    await expect(requireIdentifiedUser(createRequestStub({ id: "usr_real" }), response, next)).rejects.toThrow(
      /connection terminated/,
    );

    expect(nextSpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
  });
});
