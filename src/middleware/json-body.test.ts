import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  COMPACT_JSON_BODY_BYTES,
  bodyLimitOf,
  compactBody,
  limitBodyBytes,
  longFormBody,
  parseJsonBodyOnce,
} from "#src/middleware/json-body.js";

/**
 * The parse-once / check-per-route mechanism (§11l.4).
 *
 * A PROBE APP rather than the real one, for the reason `idempotency.test.ts` gives: the
 * subject here IS the middleware, so mounting it alone makes each branch reachable without a
 * domain handler in the way. `json-body-budget.test.ts` covers the other half — that every
 * real route declares a cap, and that no cap sits below its schema's worst case.
 *
 * The case that matters most is "bytes, not characters". That distinction is the entire
 * original bug: `limit` counts BYTES while `z.string().max(n)` counts UTF-16 code units, so a
 * cap that measured characters would pass every ASCII test and reject real payloads from
 * anyone writing Devanagari or CJK.
 */

/** Mounts the global parser, then a route guarded by `limiter`. */
function buildProbeApp(limiter: express.RequestHandler): express.Express {
  const app = express();
  app.use(parseJsonBodyOnce);
  app.post("/probe", limiter, (req, res) => {
    res.status(200).json({ status: "success", statusCode: 200, message: "ok" });
  });
  // A route with NO limiter, to show the ceiling still applies on its own.
  app.post("/uncapped", (_req, res) => {
    res.status(200).json({ status: "success", statusCode: 200, message: "ok" });
  });
  return app;
}

describe("limitBodyBytes", () => {
  it("passes a body inside the cap", async () => {
    const response = await request(buildProbeApp(compactBody))
      .post("/probe")
      .send({ note: "a".repeat(100) });

    expect(response.status).toBe(200);
  });

  it("rejects a body over the cap and NAMES the cap", async () => {
    const response = await request(buildProbeApp(compactBody))
      .post("/probe")
      .send({ note: "a".repeat(COMPACT_JSON_BODY_BYTES + 1) });

    expect(response.status).toBe(413);
    // The named cap is the only way a client learns what the limit is. body-parser's own
    // wording — "request entity too large" — never says.
    expect(response.body).toEqual({
      status: "error",
      statusCode: 413,
      message: "Request body exceeds the 16 KB size limit.",
    });
  });

  it("measures BYTES, not characters — the whole original bug in one case", async () => {
    // 6,000 characters. In ASCII that is ~6 kb and must pass; the same count of three-byte
    // characters is ~18 kb and must not. A cap that counted `.length` would accept both, which
    // is exactly how the old arrangement rejected non-English payloads Zod accepted.
    const ascii = await request(buildProbeApp(compactBody))
      .post("/probe")
      .send({ note: "a".repeat(6_000) });
    const devanagari = await request(buildProbeApp(compactBody))
      .post("/probe")
      .send({ note: "क".repeat(6_000) });

    expect(ascii.status).toBe(200);
    expect(devanagari.status).toBe(413);
  });

  it("lets a long-form route take what a compact one refuses", async () => {
    const body = { note: "a".repeat(COMPACT_JSON_BODY_BYTES + 1) };

    expect((await request(buildProbeApp(compactBody)).post("/probe").send(body)).status).toBe(413);
    expect((await request(buildProbeApp(longFormBody)).post("/probe").send(body)).status).toBe(200);
  });

  it("passes a request the JSON parser never touched", async () => {
    // No JSON body means `rawBodyBytes` is undefined, which is "nothing to check" rather than
    // "a body of size zero". Multipart routes depend on this: multer owns their body and the
    // JSON parser's `verify` never fires for them.
    const response = await request(buildProbeApp(compactBody))
      .post("/probe")
      .set("Content-Type", "text/plain")
      .send("not json at all");

    expect(response.status).toBe(200);
  });

  it("refuses at module load to promise a cap above the parser ceiling", () => {
    // A cap the parser cannot honour would read as a guarantee that is never kept — the 413
    // would come from the ceiling, with the wrong number in it.
    expect(() => limitBodyBytes(256 * 1024, "256 KB")).toThrow(/ceiling/);
  });
});

describe("parseJsonBodyOnce", () => {
  it("enforces the ceiling on a route that declares no cap of its own", async () => {
    const response = await request(buildProbeApp(compactBody))
      .post("/uncapped")
      .send({ note: "a".repeat(200 * 1024) });

    expect(response.status).toBe(413);
    expect(response.body.message).toBe("Request body exceeds the 128 KB size limit.");
  });

  it("still parses the body into req.body", async () => {
    // The parser has one other job, and swapping it out for a `verify`-carrying instance must
    // not have cost it: supplying `verify` puts raw-body in Buffer mode, and body-parser has
    // to decode afterwards itself.
    const app = express();
    app.use(parseJsonBodyOnce);
    app.post("/echo", (req, res) => {
      res.status(200).json(req.body);
    });

    const response = await request(app).post("/echo").send({ hello: "wörld", n: 42 });

    expect(response.body).toEqual({ hello: "wörld", n: 42 });
  });
});

describe("bodyLimitOf", () => {
  it("reports the cap a handler enforces", () => {
    // This is how the route sweep asks "what cap does this route carry?". Both tiers are
    // closures from the same factory, so `.name` cannot tell them apart.
    expect(bodyLimitOf(compactBody)).toBe(COMPACT_JSON_BODY_BYTES);
    expect(bodyLimitOf(longFormBody)).toBe(128 * 1024);
  });

  it("reports nothing for a handler it did not create", () => {
    expect(bodyLimitOf(parseJsonBodyOnce)).toBeUndefined();
    expect(bodyLimitOf("not a function")).toBeUndefined();
  });
});
