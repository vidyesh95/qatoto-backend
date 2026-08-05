import express from "express";
import multer from "multer";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * `Idempotency-Key` (§11l.2 item 3).
 *
 * A PROBE APP rather than the real one, deliberately, and for the reason
 * `rate-limit.test.ts` gives: the subject here IS the middleware, so mounting it alone on
 * a two-route app makes each branch reachable without a domain handler in the way.
 *
 * The four branches, and why each matters:
 *   no key           → passes through. The shipped frontend does not send one everywhere.
 *   key, first time  → runs, and the 2xx response is recorded.
 *   key, same body   → replays the ORIGINAL response and never runs the handler again.
 *   key, other body  → 409. Silently replaying would hand a caller the wrong receipt.
 */

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

const selectRows: unknown[] = [];
const insertValues = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/db/index.js", () => {
  const limit = vi.fn<(...args: readonly unknown[]) => unknown>(async () => selectRows);
  const where = vi.fn<(...args: readonly unknown[]) => unknown>(() => ({ limit }));
  const from = vi.fn<(...args: readonly unknown[]) => unknown>(() => ({ where }));
  const select = vi.fn<(...args: readonly unknown[]) => unknown>(() => ({ from }));
  const values = vi.fn<(...args: readonly unknown[]) => unknown>(async (...args) => {
    insertValues(...args);
    return [];
  });
  const insert = vi.fn<(...args: readonly unknown[]) => unknown>(() => ({ values }));
  return {
    db: { select, insert },
    pool: {
      query: vi.fn<(...args: readonly unknown[]) => unknown>(),
      end: vi.fn<() => unknown>(),
    },
    query: vi.fn<(...args: readonly unknown[]) => unknown>(),
  };
});

const handler = vi.fn<(...args: readonly unknown[]) => unknown>();

async function buildProbeApp(): Promise<express.Express> {
  const { idempotency } = await import("#src/middleware/idempotency.js");
  const app = express();
  app.use(express.json());
  // A stand-in for `requireAuth`: the middleware scopes its record to `req.user.id`, and
  // asserting that scoping matters more than exercising Better Auth again.
  app.use((req, _res, next) => {
    req.user = {
      id: "user_1",
      email: "a@b.test",
      name: "A",
      emailVerified: true,
      handle: null,
    };
    next();
  });
  app.post("/probe", idempotency(), (_req, res) => {
    handler();
    res.status(201).json({ status: "success", statusCode: 201, message: "created" });
  });
  app.post("/probe-required", idempotency({ required: true }), (_req, res) => {
    handler();
    res.status(201).json({ status: "success", statusCode: 201, message: "created" });
  });
  const upload = multer({ storage: multer.memoryStorage() });
  app.post("/multipart-probe", upload.single("evidence"), idempotency({ required: true }), (_req, res) => {
    handler();
    res.status(201).json({ status: "success", statusCode: 201, message: "created" });
  });
  app.post(
    "/commerce-probe",
    (req, _res, next) => {
      req.commerceOrganization = {
        organizationId: "organization-1",
        memberId: "member-1",
        memberRole: "owner",
        tradeState: "active",
      };
      next();
    },
    idempotency({ scope: "active_organization" }),
    (_req, res) => {
      handler();
      res.status(201).json({ status: "success", statusCode: 201, message: "created" });
    },
  );
  return app;
}

describe("idempotency middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.length = 0;
  });

  it("passes a keyless request straight through", async () => {
    const app = await buildProbeApp();

    const response = await request(app).post("/probe").send({ amountInCents: "100" });

    expect(response.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses a keyless request only where the route insists", async () => {
    const app = await buildProbeApp();

    const response = await request(app).post("/probe-required").send({ amountInCents: "100" });

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a key too short to be a real one", async () => {
    const app = await buildProbeApp();

    const response = await request(app).post("/probe").set("Idempotency-Key", "short").send({ amountInCents: "100" });

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("records the response of a first attempt", async () => {
    const app = await buildProbeApp();

    await request(app).post("/probe").set("Idempotency-Key", "attempt-0000001").send({ amountInCents: "100" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        idempotencyKey: "attempt-0000001",
        responseStatus: 201,
      }),
    );
  });

  it("derives an organization-specific key only from proven active context", async () => {
    const app = await buildProbeApp();

    await request(app)
      .post("/commerce-probe")
      .set("Idempotency-Key", "attempt-organization-1")
      .send({ amountInCents: "100" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        idempotencyKey: expect.stringMatching(/^org:[0-9a-f]{64}$/),
      }),
    );
    expect(insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "attempt-organization-1" }),
    );
  });

  it("replays the original response and does not run the handler again", async () => {
    const app = await buildProbeApp();

    // The fingerprint the middleware computes for this exact request. Captured from a
    // first pass so the replay branch is exercised against a real value rather than a
    // hand-written hash that would drift the moment the input format changes.
    await request(app).post("/probe").set("Idempotency-Key", "attempt-0000002").send({ amountInCents: "100" });
    const recorded: unknown = insertValues.mock.calls[0]?.[0];
    const recordedFingerprint =
      typeof recorded === "object" && recorded !== null && "requestFingerprint" in recorded
        ? String(recorded.requestFingerprint)
        : "";
    expect(recordedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    vi.clearAllMocks();

    selectRows.push({
      requestFingerprint: recordedFingerprint,
      responseStatus: 201,
      responseBody: JSON.stringify({ status: "success", statusCode: 201, message: "original" }),
    });

    const replay = await request(app)
      .post("/probe")
      .set("Idempotency-Key", "attempt-0000002")
      .send({ amountInCents: "100" });

    expect(replay.status).toBe(201);
    expect(replay.body.message).toBe("original");
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 409 when the same key carries a different body", async () => {
    const app = await buildProbeApp();

    selectRows.push({
      requestFingerprint: "0".repeat(64),
      responseStatus: 201,
      responseBody: JSON.stringify({ status: "success", statusCode: 201, message: "original" }),
    });

    const response = await request(app)
      .post("/probe")
      .set("Idempotency-Key", "attempt-0000003")
      .send({ amountInCents: "999999" });

    expect(response.status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
  });

  it("includes a persisted multipart filename in the request fingerprint", async () => {
    const app = await buildProbeApp();
    const evidenceBytes = Buffer.from("same evidence bytes");

    await request(app)
      .post("/multipart-probe")
      .set("Idempotency-Key", "multipart-attempt-0001")
      .attach("evidence", evidenceBytes, "registration-a.pdf");
    const recorded: unknown = insertValues.mock.calls[0]?.[0];
    const recordedFingerprint =
      typeof recorded === "object" && recorded !== null && "requestFingerprint" in recorded
        ? String(recorded.requestFingerprint)
        : "";
    expect(recordedFingerprint).toMatch(/^[0-9a-f]{64}$/);

    vi.clearAllMocks();
    selectRows.push({
      requestFingerprint: recordedFingerprint,
      responseStatus: 201,
      responseBody: JSON.stringify({ status: "success", statusCode: 201, message: "original" }),
    });

    const response = await request(app)
      .post("/multipart-probe")
      .set("Idempotency-Key", "multipart-attempt-0001")
      .attach("evidence", evidenceBytes, "registration-b.pdf");

    expect(response.status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
  });
});
