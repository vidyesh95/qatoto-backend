import type { NextFunction, Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

const { config } = await import("#src/config/index.js");
const { logger } = await import("#src/lib/logger.js");
const { errorHandler } = await import("#src/middleware/error-handler.js");
const { createResponseSpy } = await import("#src/test-support/response-spy.js");

function createMockRequest(overrides?: Partial<Request>): Request {
  const req = {
    method: "GET",
    originalUrl: "/api/test?query=1",
    requestId: "req_test_12345",
    ...overrides,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return req as unknown as Request;
}

const noopNext: NextFunction = () => {};

describe("errorHandler middleware", () => {
  beforeEach(() => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  it("masks internal 5xx error messages with standard copy when expose is not set", () => {
    const { res, status, json } = createResponseSpy();
    const req = createMockRequest();
    const sensitiveError = new Error('relation "secret_table" does not exist');

    errorHandler(sensitiveError, req, res, noopNext);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        statusCode: 500,
        message: "Something went wrong on our side. Please try again.",
        data: expect.objectContaining({
          requestId: "req_test_12345",
        }),
      }),
    );
  });

  it("exposes the error message if err.expose is true even on 5xx status", () => {
    const { res, status, json } = createResponseSpy();
    const req = createMockRequest();
    const exposableError = Object.assign(new Error("Database connection timed out."), {
      status: 503,
      expose: true,
    });

    errorHandler(exposableError, req, res, noopNext);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        statusCode: 503,
        message: "Database connection timed out.",
      }),
    );
  });

  it("preserves status code and message for 4xx client errors", () => {
    const { res, status, json } = createResponseSpy();
    const req = createMockRequest({ method: "POST", originalUrl: "/orders" });
    const clientError = Object.assign(new Error("Cart is empty."), {
      statusCode: 400,
    });

    errorHandler(clientError, req, res, noopNext);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        statusCode: 400,
        message: "Cart is empty.",
        data: expect.objectContaining({
          requestId: "req_test_12345",
        }),
      }),
    );
  });

  it("logs the error with requestId, path without query, and error fields", () => {
    const loggerSpy = vi.spyOn(logger, "error");
    const { res } = createResponseSpy();
    const req = createMockRequest({ method: "DELETE", originalUrl: "/items/123?force=true" });
    const errorWithCode = Object.assign(new Error("Foreign key violation"), {
      code: "23503",
      status: 500,
    });

    errorHandler(errorWithCode, req, res, noopNext);

    expect(loggerSpy).toHaveBeenCalledWith(
      "unhandled request error",
      expect.objectContaining({
        requestId: "req_test_12345",
        method: "DELETE",
        path: "/items/123",
        status: 500,
        errorName: "Error",
        errorMessage: "Foreign key violation",
        errorCode: "23503",
      }),
    );
  });

  it("falls back to 500 if neither status nor statusCode is defined", () => {
    const { res, status } = createResponseSpy();
    const req = createMockRequest();
    const errorWithoutStatus = new Error("Unexpected crash");

    errorHandler(errorWithoutStatus, req, res, noopNext);

    expect(status).toHaveBeenCalledWith(500);
  });

  it("falls back to internal message if err.message is empty", () => {
    const { res, json } = createResponseSpy();
    const req = createMockRequest();
    const emptyMessageError = Object.assign(new Error(""), { status: 404 });

    errorHandler(emptyMessageError, req, res, noopNext);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Something went wrong on our side. Please try again.",
      }),
    );
  });

  it("controls stack trace exposure based on NODE_ENV", () => {
    const { res: devRes, json: devJson } = createResponseSpy();
    const req = createMockRequest();
    const sampleError = new Error("Boom");

    const originalNodeEnv = config.NODE_ENV;

    // Test development: stack trace present
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    (config as { NODE_ENV: string }).NODE_ENV = "development";
    errorHandler(sampleError, req, devRes, noopNext);
    expect(devJson).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stack: expect.any(String),
        }),
      }),
    );

    // Test production: stack trace omitted
    const { res: prodRes, json: prodJson } = createResponseSpy();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    (config as { NODE_ENV: string }).NODE_ENV = "production";
    errorHandler(sampleError, req, prodRes, noopNext);
    expect(prodJson).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          requestId: "req_test_12345",
        },
      }),
    );

    // Restore
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    (config as { NODE_ENV: string }).NODE_ENV = originalNodeEnv;
  });
});
