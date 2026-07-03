import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";

import { requestId } from "#src/middleware/request-id.js";

/**
 * Isolated tests for the requestId middleware: mounted on a minimal throwaway
 * Express app (no env stubbing, no DB mocks) and driven through supertest so
 * the middleware sees real Request/Response objects without type assertions.
 *
 * The Array.isArray(header) branch is deliberately untested: Node folds
 * duplicate request headers (other than set-cookie) into one comma-joined
 * string, so the array case is unreachable over real HTTP.
 */

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const buildProbeApp = (): express.Express => {
  const probeApp = express();
  probeApp.use(requestId);
  probeApp.get("/probe", (_req, res) => {
    res.status(200).json({ reached: true });
  });
  return probeApp;
};

describe("requestId middleware", () => {
  it("generates a UUID X-Request-Id when the client sends none", async () => {
    const probeResponse = await request(buildProbeApp()).get("/probe");

    expect(probeResponse.headers["x-request-id"]).toMatch(UUID_V4_PATTERN);
  });

  it("assigns a different ID to each request", async () => {
    const probeApp = buildProbeApp();

    const firstResponse = await request(probeApp).get("/probe");
    const secondResponse = await request(probeApp).get("/probe");

    expect(firstResponse.headers["x-request-id"]).toMatch(UUID_V4_PATTERN);
    expect(secondResponse.headers["x-request-id"]).toMatch(UUID_V4_PATTERN);
    expect(firstResponse.headers["x-request-id"]).not.toBe(secondResponse.headers["x-request-id"]);
  });

  it("echoes an incoming x-request-id header verbatim", async () => {
    const clientSuppliedRequestId = "client-supplied-id-123";

    const probeResponse = await request(buildProbeApp()).get("/probe").set("X-Request-Id", clientSuppliedRequestId);

    expect(probeResponse.headers["x-request-id"]).toBe(clientSuppliedRequestId);
  });

  it("calls next() so the request reaches downstream handlers", async () => {
    const probeResponse = await request(buildProbeApp()).get("/probe");

    expect(probeResponse.status).toBe(200);
    expect(probeResponse.body).toEqual({ reached: true });
  });

  it("sets X-Request-Id even on unmatched routes (404)", async () => {
    const unmatchedResponse = await request(buildProbeApp()).get("/no-such-route");

    expect(unmatchedResponse.status).toBe(404);
    expect(unmatchedResponse.headers["x-request-id"]).toMatch(UUID_V4_PATTERN);
  });
});
