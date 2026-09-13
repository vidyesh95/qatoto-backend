import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the blueprint engagement writes.
 *
 * WHAT THIS FILE OWNS: the status codes, the middleware ordering, and the shape of what comes back.
 * The services are mocked, so a case asserting a gate or a counter would be asserting the mock —
 * `blueprint-engagement-gate.ts` owns the gate and `db:verify-blueprint-engagement-constraints`
 * owns everything that is a claim about Postgres.
 *
 * ⚠️ FOUR GUARANTEES HERE ARE CONTRACTS RATHER THAN INCIDENTAL BEHAVIOUR, each with its own case:
 *
 *   1. THE BEACON ANSWERS 202 WITH AN EMPTY BODY. Echoing the resulting count back would hand an
 *      attacker a live readout to tune against.
 *   2. THE BEACON ACCEPTS AN ANONYMOUS CALLER. It is the only write on this surface that does, and
 *      a regression to `requireAuth` would silently stop counting most real traffic.
 *   3. THE TOGGLE VERBS ARE PUT/DELETE AND CARRY NO BODY. The method is the verb's direction; a
 *      route that started reading `{ isSet }` from a body would make a double-tap meaningful again.
 *   4. A VERB THE ARM DOES NOT OFFER IS A 409, NOT A 404. A teardown cannot be upvoted, but it
 *      exists and the caller may be looking at it — a 404 would say "no such teardown", which is
 *      false. The arm asymmetry is stated as contract in three schema comments.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const recordBlueprintView = vi.fn<(...args: readonly unknown[]) => unknown>();
const setBlueprintToggle = vi.fn<(...args: readonly unknown[]) => unknown>();
const readBlueprintViewerState = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/blueprint-engagement.service.js", () => ({
  recordBlueprintView: (...args: readonly unknown[]) => recordBlueprintView(...args),
  setBlueprintToggle: (...args: readonly unknown[]) => setBlueprintToggle(...args),
  readBlueprintViewerState: (...args: readonly unknown[]) => readBlueprintViewerState(...args),
}));

const ACCEPTED_BEACON = { success: true, value: null } as const;
const ACCEPTED_TOGGLE = { success: true, value: { isSet: true, count: 12 } } as const;

describe("blueprint engagement routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    signOut();
    vi.clearAllMocks();
    await resetRateLimiters();
  });

  describe("POST /blueprints/<arm>/:slug/view-beacon", () => {
    it("answers 202 with an EMPTY body — a count here would be a live readout to tune against", async () => {
      recordBlueprintView.mockResolvedValue(ACCEPTED_BEACON);

      const response = await request(app).post("/blueprints/teardowns/some-teardown/view-beacon");

      expect(response.status).toBe(202);
      expect(response.text).toBe("");
    });

    it("accepts an ANONYMOUS caller — the only write on this surface that does", async () => {
      recordBlueprintView.mockResolvedValue(ACCEPTED_BEACON);

      const response = await request(app).post("/blueprints/showcases/some-launch/view-beacon");

      expect(response.status).toBe(202);
      expect(recordBlueprintView).toHaveBeenCalledTimes(1);
      const [call] = recordBlueprintView.mock.calls;
      expect(call?.[0]).toMatchObject({ arm: "showcase", viewerUserId: null });
    });

    it("derives ONE fingerprint and day bucket, and they agree", async () => {
      recordBlueprintView.mockResolvedValue(ACCEPTED_BEACON);

      await request(app).post("/blueprints/case-studies/some-lesson/view-beacon");

      // 64 hex characters, matching `*_view_session_fingerprint_ck`, and a UTC day string that
      // is the SAME value the hash consumed. Asserted through `toMatchObject` rather than a cast,
      // because a cast here would let the shape drift without the test noticing.
      expect(recordBlueprintView.mock.calls[0]?.[0]).toMatchObject({
        viewerFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        viewDayBucket: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown,
      });
    });

    it("answers 404 for a blueprint that is not viewable", async () => {
      recordBlueprintView.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_CONTENT_NOT_FOUND" },
      });

      const response = await request(app).post("/blueprints/teardowns/nope/view-beacon");

      expect(response.status).toBe(404);
    });
  });

  describe("PUT | DELETE /blueprints/<arm>/:slug/like", () => {
    it("refuses a signed-out caller with 401", async () => {
      const response = await request(app).put("/blueprints/teardowns/some-teardown/like");

      expect(response.status).toBe(401);
      expect(setBlueprintToggle).not.toHaveBeenCalled();
    });

    it("reads the direction from the METHOD, not from a body", async () => {
      signInAs();
      setBlueprintToggle.mockResolvedValue(ACCEPTED_TOGGLE);

      await request(app).put("/blueprints/teardowns/some-teardown/like");
      expect(setBlueprintToggle.mock.calls[0]?.[0]).toMatchObject({ isSet: true });

      setBlueprintToggle.mockResolvedValue({ success: true, value: { isSet: false, count: 11 } });
      await request(app).delete("/blueprints/teardowns/some-teardown/like");
      expect(setBlueprintToggle.mock.calls[1]?.[0]).toMatchObject({ isSet: false });
    });

    it("answers the server's own count so a client renders it rather than guessing", async () => {
      signInAs();
      setBlueprintToggle.mockResolvedValue(ACCEPTED_TOGGLE);

      const response = await request(app).put("/blueprints/showcases/some-launch/like");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ isSet: true, count: 12 });
    });

    it("routes each arm to its own tables — the arm is a route-time constant", async () => {
      signInAs();
      setBlueprintToggle.mockResolvedValue(ACCEPTED_TOGGLE);

      await request(app).put("/blueprints/showcases/a/like");
      await request(app).put("/blueprints/teardowns/b/like");
      await request(app).put("/blueprints/case-studies/c/like");

      expect(setBlueprintToggle.mock.calls[0]?.[0]).toMatchObject({ arm: "showcase" });
      expect(setBlueprintToggle.mock.calls[1]?.[0]).toMatchObject({ arm: "teardown" });
      expect(setBlueprintToggle.mock.calls[2]?.[0]).toMatchObject({ arm: "case_study" });
    });
  });

  describe("the arm asymmetry", () => {
    it("answers 409 — not 404 — for a verb the arm does not offer", async () => {
      signInAs();
      setBlueprintToggle.mockResolvedValue({
        success: false,
        error: { type: "BLUEPRINT_VERB_NOT_AVAILABLE_ON_ARM", arm: "teardown" },
      });

      const response = await request(app).put("/blueprints/showcases/some-launch/upvote");

      expect(response.status).toBe(409);
    });

    it("offers upvote on showcases and save on teardowns, and neither on the other", async () => {
      signInAs();
      setBlueprintToggle.mockResolvedValue(ACCEPTED_TOGGLE);

      // These two exist.
      expect((await request(app).put("/blueprints/showcases/a/upvote")).status).toBe(200);
      expect((await request(app).put("/blueprints/teardowns/b/save")).status).toBe(200);

      // ⚠️ AND THESE TWO ARE NOT ROUTES AT ALL. A showcase has no `save_count` column and a
      // teardown has no `upvote_count`, so declaring the routes would be unverified code. A 404
      // here is Express finding no handler, which is the honest answer.
      expect((await request(app).put("/blueprints/showcases/a/save")).status).toBe(404);
      expect((await request(app).put("/blueprints/teardowns/b/upvote")).status).toBe(404);
      expect((await request(app).put("/blueprints/case-studies/c/save")).status).toBe(404);
      expect((await request(app).put("/blueprints/case-studies/c/upvote")).status).toBe(404);
    });
  });

  describe("GET /blueprints/engagement/state", () => {
    it("refuses a signed-out caller with 401 — it is per-viewer by definition", async () => {
      const response = await request(app).get("/blueprints/engagement/state");

      expect(response.status).toBe(401);
      expect(readBlueprintViewerState).not.toHaveBeenCalled();
    });

    it("parses three comma-separated slug lists", async () => {
      signInAs();
      readBlueprintViewerState.mockResolvedValue({ showcases: {}, teardowns: {}, caseStudies: {} });

      const response = await request(app)
        .get("/blueprints/engagement/state")
        .query({ showcases: "a,b", teardowns: "c", caseStudies: "" });

      expect(response.status).toBe(200);
      expect(readBlueprintViewerState.mock.calls[0]?.[0]).toMatchObject({
        showcaseSlugs: ["a", "b"],
        teardownSlugs: ["c"],
        caseStudySlugs: [],
      });
    });

    it("refuses more than 50 slugs in one arm with 422", async () => {
      signInAs();

      const response = await request(app)
        .get("/blueprints/engagement/state")
        .query({ showcases: Array.from({ length: 51 }, (_unused, index) => `s${String(index)}`).join(",") });

      expect(response.status).toBe(422);
      expect(readBlueprintViewerState).not.toHaveBeenCalled();
    });

    it("tolerates an unrelated query parameter — it is a READ, and .strip() is deliberate", async () => {
      signInAs();
      readBlueprintViewerState.mockResolvedValue({ showcases: {}, teardowns: {}, caseStudies: {} });

      const response = await request(app)
        .get("/blueprints/engagement/state")
        .query({ teardowns: "a", utm_source: "newsletter" });

      expect(response.status).toBe(200);
    });
  });
});
