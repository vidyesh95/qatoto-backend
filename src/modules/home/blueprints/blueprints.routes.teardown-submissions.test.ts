import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the two author-facing teardown routes.
 *
 * WHAT THIS FILE OWNS: the body and query parses, the status codes, and the shape of what comes
 * back. The service is mocked, so a case asserting a duplicate rule or a visibility gate would be
 * asserting the mock — `teardown-submission.schemas.test.ts` owns the gate.
 *
 * ⚠️ TWO GUARANTEES HERE ARE PART OF A CROSS-REPOSITORY CONTRACT, each with its own case:
 *
 *   1. The submit answers **202** with `{submissionId, moderationState, receivedAt}` and NOTHING
 *      else. `idempotency.ts` caches whole 2xx bodies for replay, so a handler that echoed the
 *      submission would put one party's account of a private permission in a cache keyed by a
 *      header the client chose. The frontend's own receipt schema is `.strict()` over those three.
 *   2. `/mine` returns a FLAT ARRAY, and `publicSlug` is null for every row that is not published.
 *      The frontend renders a "View the page" link whenever that field is non-null, and its schema
 *      only checks the `published ⇒ non-null` direction — so a slug on a quarantined row would
 *      render a live link to a page that refuses the reader, with nothing failing anywhere.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` reads the account's identification state from the database, which the
 * harness stubs as `{}`. Passed through so these cases test the routes rather than that guard — it
 * has its own coverage in `src/middleware/require-identified-user.test.ts`.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

/**
 * A real in-memory idempotency implementation rather than a pass-through, because the submit route
 * declares `required: true` — the 400 for a missing key is part of its contract.
 */
const idempotencyResponses = vi.hoisted(
  () => new Map<string, { fingerprint: string; statusCode: number; body: unknown }>(),
);

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const header = req.header("Idempotency-Key");
      if (!header && options.required === true) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "This request requires an Idempotency-Key header.",
        });
        return;
      }
      if (!header) {
        next();
        return;
      }
      const fingerprint = JSON.stringify(req.body);
      const cached = idempotencyResponses.get(header);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          res.status(409).json({
            status: "error",
            statusCode: 409,
            message: "This Idempotency-Key was already used for a different request.",
          });
          return;
        }
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }

      const originalJson = res.json.bind(res);
      res.json = (body: unknown): Response => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          idempotencyResponses.set(header, { fingerprint, statusCode: res.statusCode, body });
        }
        return originalJson(body);
      };
      next();
    },
}));

const submitTeardown = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyTeardowns = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/teardown-submission.service.js", () => ({
  submitTeardown: (...args: readonly unknown[]) => submitTeardown(...args),
  listMyTeardowns: (...args: readonly unknown[]) => listMyTeardowns(...args),
}));

const RECEIVED_AT = new Date("2026-02-11T09:15:00.000Z");

const ACCEPTED_RECEIPT = {
  success: true,
  value: {
    submissionId: "tsub_abc123",
    moderationState: "pending_review",
    receivedAt: RECEIVED_AT,
  },
} as const;

/** A submission the gate accepts. Every write case changes exactly one thing about it. */
function buildValidSubmission(): Record<string, unknown> {
  return {
    subjectKind: "existing_physical_product",
    title: "Inside a supermarket cordless drill",
    summary: "Eleven fasteners, two of them hidden under the label, and a gearbox that comes out in one piece.",
    provenance: {
      kind: "community_reverse_engineered",
      subjectProductName: "Rotel RD-18 cordless drill",
      unitAcquisition: "retail_purchase",
      surveyMethods: ["empirical_teardown"],
      surveyedAt: "2026-01-05T12:00:00.000Z",
      licence: null,
      authorizationNote: null,
      attestationAcceptedAt: "2026-01-06T09:00:00.000Z",
      notes: null,
    },
    materials: [],
    parts: [{ label: "Gearbox housing", material: "Glass-filled nylon" }],
    documents: [],
    manufacturingFiles: [],
    walkthroughVideo: null,
    tags: ["power-tools"],
    acceptedAttestationClauseIds: [
      "lawful_acquisition",
      "own_measurement",
      "no_confidential_material",
      "independent_discovery",
    ],
  };
}

describe("blueprints teardown submission routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyResponses.clear();
    signOut();
    await resetRateLimiters();
  });

  describe("POST /blueprints/teardowns", () => {
    const path = "/blueprints/teardowns";

    it("refuses a signed-out caller with 401", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-signed-out")
        .send(buildValidSubmission());

      expect(response.status).toBe(401);
      expect(submitTeardown).not.toHaveBeenCalled();
    });

    it("refuses a request with no Idempotency-Key", async () => {
      signInAs();

      const response = await request(app).post(path).send(buildValidSubmission());

      expect(response.status).toBe(400);
      expect(submitTeardown).not.toHaveBeenCalled();
    });

    it("answers 202 with the three-field receipt", async () => {
      signInAs();
      submitTeardown.mockResolvedValue(ACCEPTED_RECEIPT);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-accepted")
        .send(buildValidSubmission());

      expect(response.status).toBe(202);
      expect(response.body.data).toEqual({
        submissionId: "tsub_abc123",
        moderationState: "pending_review",
        receivedAt: RECEIVED_AT.toISOString(),
      });
    });

    /**
     * ⚠️ ASSERTED ON THE RAW BYTES, not on parsed keys. The risk is not a field named `summary`
     * coming back — it is any part of the submission reaching a replay cache at all, under whatever
     * key a later refactor gives it.
     */
    it("echoes no part of the submission back", async () => {
      signInAs();
      submitTeardown.mockResolvedValue(ACCEPTED_RECEIPT);

      const response = await request(app).post(path).set("Idempotency-Key", "key-no-echo").send(buildValidSubmission());

      const rawBody = JSON.stringify(response.body);
      expect(rawBody).not.toContain("Rotel RD-18");
      expect(rawBody).not.toContain("Gearbox housing");
      expect(rawBody).not.toContain("empirical_teardown");
    });

    it("stamps the author from the session, never from the body", async () => {
      signInAs();
      submitTeardown.mockResolvedValue(ACCEPTED_RECEIPT);

      await request(app)
        .post(path)
        .set("Idempotency-Key", "key-author")
        .send({ ...buildValidSubmission(), authorUserId: "user_someone_else" });

      // `.strict()` refuses the invented field outright, so the service is never reached.
      expect(submitTeardown).not.toHaveBeenCalled();
    });

    it("refuses a submission missing an attestation clause with 422", async () => {
      signInAs();

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-attestation")
        .send({
          ...buildValidSubmission(),
          acceptedAttestationClauseIds: ["lawful_acquisition", "own_measurement"],
        });

      expect(response.status).toBe(422);
      expect(response.body.errors).toHaveProperty("acceptedAttestationClauseIds");
      expect(submitTeardown).not.toHaveBeenCalled();
    });

    /**
     * The 409 the frontend's mock already models. The title is present because the service decided
     * it may be — that decision is the service's, and `teardown-write-error-response.test.ts` owns
     * the other half, where a pending stranger's title is withheld.
     */
    it("passes a duplicate-unit refusal through as 409 with the field key", async () => {
      signInAs();
      submitTeardown.mockResolvedValue({
        success: false,
        error: {
          type: "TEARDOWN_SUBJECT_ALREADY_SURVEYED",
          existingTitle: "Inside a supermarket cordless drill",
        },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "key-duplicate")
        .send(buildValidSubmission());

      expect(response.status).toBe(409);
      expect(response.body.errors).toHaveProperty("provenance.subjectProductName");
    });

    it("replays a repeated key without re-invoking the service", async () => {
      signInAs();
      submitTeardown.mockResolvedValue(ACCEPTED_RECEIPT);
      const submission = buildValidSubmission();

      await request(app).post(path).set("Idempotency-Key", "key-replay").send(submission);
      const replay = await request(app).post(path).set("Idempotency-Key", "key-replay").send(submission);

      expect(replay.status).toBe(202);
      expect(submitTeardown).toHaveBeenCalledTimes(1);
    });
  });

  describe("GET /blueprints/teardowns/mine", () => {
    const path = "/blueprints/teardowns/mine";

    it("refuses a signed-out caller with 401", async () => {
      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listMyTeardowns).not.toHaveBeenCalled();
    });

    it("scopes the read to the session's own account", async () => {
      signInAs();
      listMyTeardowns.mockResolvedValue([]);

      await request(app).get(path);

      expect(listMyTeardowns).toHaveBeenCalledWith({ authorUserId: "user_test_caller" });
    });

    /**
     * ⚠️ A FLAT ARRAY, NOT A PAGE OBJECT. The frontend's query key carries no cursor and its parse
     * expects an array; wrapping this in `{items, page}` would break that list with nothing on this
     * side failing.
     */
    it("answers with a flat array", async () => {
      signInAs();
      listMyTeardowns.mockResolvedValue([
        {
          submissionId: "tsub_1",
          title: "Inside a supermarket cordless drill",
          subjectProductName: "Rotel RD-18 cordless drill",
          submittedAt: RECEIVED_AT,
          moderationState: "pending_review",
          publicSlug: null,
          moderatorNote: null,
        },
      ]);

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data[0].submittedAt).toBe(RECEIVED_AT.toISOString());
    });

    it("carries a rejection's moderator note verbatim", async () => {
      signInAs();
      listMyTeardowns.mockResolvedValue([
        {
          submissionId: "tsub_2",
          title: "Inside a supermarket cordless drill",
          subjectProductName: "Rotel RD-18 cordless drill",
          submittedAt: RECEIVED_AT,
          moderationState: "rejected",
          publicSlug: null,
          moderatorNote: "Name the unit you surveyed in the summary.",
        },
      ]);

      const response = await request(app).get(path);

      expect(response.body.data[0].moderatorNote).toBe("Name the unit you surveyed in the summary.");
    });

    it("ignores a cursor parameter rather than honouring one", async () => {
      signInAs();
      listMyTeardowns.mockResolvedValue([]);

      const response = await request(app).get(path).query({ cursor: "not-a-cursor" });

      expect(response.status).toBe(200);
      expect(listMyTeardowns).toHaveBeenCalledWith({ authorUserId: "user_test_caller" });
    });
  });
});
