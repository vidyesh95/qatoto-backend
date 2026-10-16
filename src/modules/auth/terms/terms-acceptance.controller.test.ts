import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#src/modules/auth/terms/terms-acceptance.service.js", () => ({
  acceptCurrentTerms: vi.fn<typeof import("#src/modules/auth/terms/terms-acceptance.service.js").acceptCurrentTerms>(),
}));

vi.mock("#src/modules/rnd/projects/project-error-response.js", () => ({
  respondValidationFailed: vi.fn<typeof import("#src/modules/rnd/projects/project-error-response.js").respondValidationFailed>(),
}));

const termsService = await import("#src/modules/auth/terms/terms-acceptance.service.js");
const errorResponse = await import("#src/modules/rnd/projects/project-error-response.js");
const { acceptTerms } = await import("#src/modules/auth/terms/terms-acceptance.controller.js");

const acceptCurrentTermsMock = vi.mocked(termsService.acceptCurrentTerms);
const respondValidationFailedMock = vi.mocked(errorResponse.respondValidationFailed);

function createRequestStub(userId: string | null, body: unknown = {}): Request {
  const user = userId === null ? undefined : { id: userId };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { user, body } as unknown as Request;
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

describe("acceptTerms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses an unauthenticated caller with 401, without consulting the service", async () => {
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await acceptTerms(createRequestStub(null), response);

    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(401);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    });
    expect(acceptCurrentTermsMock).not.toHaveBeenCalled();
    expect(respondValidationFailedMock).not.toHaveBeenCalled();
  });

  it("refuses an invalid body by delegating to respondValidationFailed", async () => {
    const { response } = createResponseStub();

    // Missing acceptedTermsVersion
    await acceptTerms(createRequestStub("usr_123", {}), response);

    expect(respondValidationFailedMock).toHaveBeenCalledExactlyOnceWith(
      response,
      expect.anything() // The ZodError
    );
    expect(acceptCurrentTermsMock).not.toHaveBeenCalled();
  });

  it("refuses a stale terms version with 409", async () => {
    acceptCurrentTermsMock.mockResolvedValue({
      success: false,
      error: { type: "TERMS_VERSION_STALE", currentVersion: "v2" },
    });
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await acceptTerms(createRequestStub("usr_123", { acceptedTermsVersion: "v1" }), response);

    expect(acceptCurrentTermsMock).toHaveBeenCalledExactlyOnceWith("usr_123", "v1");
    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(409);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "error",
      statusCode: 409,
      message: "The Terms have been updated since this page loaded. Reload, read the current Terms and accept again.",
      data: { currentTermsVersion: "v2" },
    });
  });

  it("responds 200 with a success envelope wrapping the service row", async () => {
    const acceptedAt = new Date("2026-01-01T00:00:00.000Z");
    acceptCurrentTermsMock.mockResolvedValue({
      success: true,
      value: { termsVersion: "v2", termsAcceptedAt: acceptedAt },
    });
    const { response, statusSpy, jsonSpy } = createResponseStub();

    await acceptTerms(createRequestStub("usr_123", { acceptedTermsVersion: "v2" }), response);

    expect(acceptCurrentTermsMock).toHaveBeenCalledExactlyOnceWith("usr_123", "v2");
    expect(statusSpy).toHaveBeenCalledExactlyOnceWith(200);
    expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({
      status: "success",
      statusCode: 200,
      message: "Terms accepted.",
      data: { termsVersion: "v2", termsAcceptedAt: acceptedAt },
    });
  });
});
