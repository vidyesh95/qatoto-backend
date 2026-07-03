import type { Request, Response, NextFunction } from "express";
import express from "express";
import createError from "http-errors";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { notFoundHandler } from "#src/middleware/not-found.js";

/**
 * Isolated tests for the notFoundHandler middleware, following the
 * request-id.test.ts pattern: a minimal throwaway Express app driven through
 * supertest so the middleware sees real Request/Response objects without type
 * assertions.
 *
 * The real errorHandler is deliberately not mounted (it imports the config env
 * parser); a capture middleware records the error notFoundHandler forwards and
 * renders its properties so each response can be asserted directly.
 */

interface CapturedForwardedError {
  readonly forwardedError: Error | undefined;
}

const buildProbeApp = (errorCapture: { forwardedError: Error | undefined }): express.Express => {
  const probeApp = express();
  probeApp.get("/registered-route", (_req, res) => {
    res.status(200).json({ reached: true });
  });
  probeApp.use(notFoundHandler);
  probeApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    errorCapture.forwardedError = err;
    const forwardedStatus = createError.isHttpError(err) ? err.status : 500;
    res.status(forwardedStatus).json({ message: err.message });
  });
  return probeApp;
};

const probeUnmatchedRoute = async (
  httpMethod: "get" | "post" | "put" | "patch" | "delete",
  unmatchedPath: string,
): Promise<{ probeResponse: request.Response } & CapturedForwardedError> => {
  const errorCapture: { forwardedError: Error | undefined } = { forwardedError: undefined };
  const probeResponse = await request(buildProbeApp(errorCapture))[httpMethod](unmatchedPath);
  return { probeResponse, forwardedError: errorCapture.forwardedError };
};

describe("notFoundHandler", () => {
  it("forwards an HttpError with status 404 to the error handler", async () => {
    const { probeResponse, forwardedError } = await probeUnmatchedRoute("get", "/no-such-route");

    expect(forwardedError).toBeInstanceOf(createError.HttpError);
    expect(createError.isHttpError(forwardedError) && forwardedError.status).toBe(404);
    expect(probeResponse.status).toBe(404);
  });

  it("marks the error as exposable so clients may see the message", async () => {
    const { forwardedError } = await probeUnmatchedRoute("get", "/no-such-route");

    expect(createError.isHttpError(forwardedError) && forwardedError.expose).toBe(true);
  });

  it("includes the request method and original URL in the error message", async () => {
    const { probeResponse } = await probeUnmatchedRoute("post", "/api/v1/unknown");

    expect(probeResponse.body).toEqual({ message: "Route not found: POST /api/v1/unknown" });
  });

  it("preserves the query string in the reported URL", async () => {
    const { probeResponse } = await probeUnmatchedRoute("get", "/missing?page=2&sort=asc");

    expect(probeResponse.body).toEqual({
      message: "Route not found: GET /missing?page=2&sort=asc",
    });
  });

  it("reflects each HTTP method in the message", async () => {
    for (const httpMethod of ["get", "post", "put", "patch", "delete"] as const) {
      const { probeResponse } = await probeUnmatchedRoute(httpMethod, "/nowhere");

      expect(probeResponse.status).toBe(404);
      expect(probeResponse.body).toEqual({
        message: `Route not found: ${httpMethod.toUpperCase()} /nowhere`,
      });
    }
  });

  it("does not intercept requests that match a registered route", async () => {
    const errorCapture: { forwardedError: Error | undefined } = { forwardedError: undefined };
    const probeResponse = await request(buildProbeApp(errorCapture)).get("/registered-route");

    expect(probeResponse.status).toBe(200);
    expect(probeResponse.body).toEqual({ reached: true });
    expect(errorCapture.forwardedError).toBeUndefined();
  });
});
