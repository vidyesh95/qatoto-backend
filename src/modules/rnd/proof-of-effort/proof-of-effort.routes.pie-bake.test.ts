import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `GET`/`POST /:projectSlug/pie-bake` — the single highest-risk
 * untested route in the repo per this session's audit. Baking is IRREVERSIBLE, ONCE EVER
 * (`pie-bake.service.ts`'s own docs), with no unbake endpoint, so the property that matters
 * most is that a second bake is refused rather than silently accepted.
 *
 * DEDUP IS A BODY FIELD HERE, not the `Idempotency-Key` header, matching §9's other two
 * deduped writes (claim submit, receipt upload) — both of which likewise carry NO
 * `idempotency()` middleware. The reason is that the middleware's generic record can only
 * answer "have I seen this key?", whereas the domain column answers "here is the bake you
 * already made", which is what a founder retrying on a dropped connection needs back.
 *
 * That replay lives in `pie-bake.service.ts` and is tested at the service tier, in
 * `pie-bake.service.test.ts` — this file's job is the wiring: that the parsed key reaches
 * the service, and that a malformed one dies at the parse boundary.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` hits the real `db` query builder; stubbed to a pass-through so
 * this suite stays about routing/wiring, per the precedent in
 * `import-intelligence.routes.test.ts`. The route still declares it in its chain.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const requireProjectRole = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRole(...args),
  PROJECT_ROLE_RANK: { founder: 4, admin: 3, maintainer: 2, contributor: 1 },
}));

const findPieBake = vi.fn<(...args: readonly unknown[]) => unknown>();
const bakePie = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/funding/pie-bake.service.js", () => ({
  findPieBake: (...args: readonly unknown[]) => findPieBake(...args),
  bakePie: (...args: readonly unknown[]) => bakePie(...args),
}));

const MEMBER_CONTEXT = {
  success: true,
  value: {
    projectId: "project_1",
    projectSlug: "solar-cold-storage",
    projectStatus: "active",
    founderUserId: "user_test_caller",
    currency: "INR",
    memberId: "member_1",
    memberRole: "founder",
  },
} as const;

const NOT_FOUND = { success: false, error: { type: "NOT_FOUND", projectRef: "solar-cold-storage" } };

const SLUG = "solar-cold-storage";
const BASE = `/research-projects/${SLUG}`;
const PATH = `${BASE}/pie-bake`;

const VALID_BAKE_BODY = {
  trigger: "priced_round",
  triggerEvidenceNote: "Series A closed at a $12M post-money valuation.",
  valuationCents: "1200000000",
  acknowledgement: "BAKE THE PIE",
  expectedSnapshotId: "11111111-1111-4111-8111-111111111111",
};

describe("proof-of-effort pie-bake routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication and membership", () => {
    it("answers 401 for a signed-out caller on GET", async () => {
      signOut();

      const response = await request(app).get(PATH);

      expect(response.status).toBe(401);
      expect(requireProjectRole).not.toHaveBeenCalled();
    });

    it("answers 401 for a signed-out caller on POST", async () => {
      signOut();

      const response = await request(app).post(PATH).send(VALID_BAKE_BODY);

      expect(response.status).toBe(401);
      expect(bakePie).not.toHaveBeenCalled();
    });

    it("answers 404 for a signed-in non-member on GET", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get(PATH);

      expect(response.status).toBe(404);
    });

    it("answers 404 for a signed-in non-member on POST", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).post(PATH).send(VALID_BAKE_BODY);

      expect(response.status).toBe(404);
      expect(bakePie).not.toHaveBeenCalled();
    });

    it("gives a non-member and an absent project byte-identical refusals on GET", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);
      const nonMember = await request(app).get(PATH);

      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "no-such-project" },
      });
      const absent = await request(app).get("/research-projects/no-such-project/pie-bake");

      expect(nonMember.status).toBe(absent.status);
      expect(nonMember.body).toEqual(absent.body);
    });
  });

  describe("GET …/pie-bake", () => {
    it("returns null while the pie is still dynamic", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      findPieBake.mockResolvedValue(null);

      const response = await request(app).get(PATH);

      expect(response.status).toBe(200);
      expect(findPieBake).toHaveBeenCalledWith("project_1");
      expect(response.body.data).toBeNull();
    });

    it("returns the frozen snapshot once baked", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      findPieBake.mockResolvedValue({
        bakeEventId: "bake_1",
        trigger: "priced_round",
        valuationCents: "1200000000",
        bakedAt: new Date("2026-03-01T00:00:00.000Z").toISOString(),
        snapshot: { id: "snapshot_1" },
      });

      const response = await request(app).get(PATH);

      expect(response.status).toBe(200);
      expect(response.body.data.bakeEventId).toBe("bake_1");
    });
  });

  describe("POST …/pie-bake", () => {
    it("asks membership for the founder floor, not a lower one — baking is founder-only", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({
        success: true,
        value: {
          bakeEventId: "bake_1",
          trigger: "priced_round",
          valuationCents: null,
          bakedAt: new Date("2026-03-01T00:00:00.000Z"),
          snapshot: { id: "snapshot_1" },
        },
      });

      await request(app).post(PATH).send(VALID_BAKE_BODY);

      expect(requireProjectRole).toHaveBeenCalledWith(SLUG, "user_test_caller", "founder");
    });

    it("bakes the pie and answers 201 with the frozen snapshot, on a typed acknowledgement", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({
        success: true,
        value: {
          bakeEventId: "bake_1",
          trigger: "priced_round",
          valuationCents: "1200000000",
          bakedAt: new Date("2026-03-01T00:00:00.000Z"),
          snapshot: { id: "snapshot_1" },
        },
      });

      const response = await request(app).post(PATH).send(VALID_BAKE_BODY);

      expect(response.status).toBe(201);
      expect(bakePie).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        expect.objectContaining({
          trigger: "priced_round",
          triggerEvidenceNote: VALID_BAKE_BODY.triggerEvidenceNote,
          valuationCents: 1_200_000_000n,
          acknowledgement: "BAKE THE PIE",
          expectedSnapshotId: VALID_BAKE_BODY.expectedSnapshotId,
        }),
        "user_test_caller",
        "founder",
      );
      expect(response.body.data.bakeEventId).toBe("bake_1");
    });

    it("rejects a body missing the acknowledgement", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      const { acknowledgement: _acknowledgement, ...withoutAck } = VALID_BAKE_BODY;

      const response = await request(app).post(PATH).send(withoutAck);

      expect(response.status).toBe(422);
      expect(bakePie).not.toHaveBeenCalled();
    });

    it("rejects a body with no expectedSnapshotId", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      const { expectedSnapshotId: _expectedSnapshotId, ...withoutSnapshot } = VALID_BAKE_BODY;

      const response = await request(app).post(PATH).send(withoutSnapshot);

      expect(response.status).toBe(422);
      expect(bakePie).not.toHaveBeenCalled();
    });

    it("maps ACKNOWLEDGEMENT_MISMATCH to 422", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({
        success: false,
        error: { type: "ACKNOWLEDGEMENT_MISMATCH", expected: "BAKE THE PIE" },
      });

      const response = await request(app)
        .post(PATH)
        .send({ ...VALID_BAKE_BODY, acknowledgement: "bake the pie" });

      expect(response.status).toBe(422);
    });

    it("maps SNAPSHOT_STALE to 409 — a founder must not bake a cap table they have not seen", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({
        success: false,
        error: { type: "SNAPSHOT_STALE", latestSnapshotId: "snapshot_2" },
      });

      const response = await request(app).post(PATH).send(VALID_BAKE_BODY);

      expect(response.status).toBe(409);
    });

    it("maps SNAPSHOT_NOT_FOUND to 404", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({
        success: false,
        error: { type: "SNAPSHOT_NOT_FOUND", snapshotId: VALID_BAKE_BODY.expectedSnapshotId },
      });

      const response = await request(app).post(PATH).send(VALID_BAKE_BODY);

      expect(response.status).toBe(404);
    });

    it("maps UNSETTLED_ALLOCATIONS to 409 — a live allocation window blocks the freeze", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({
        success: false,
        error: { type: "UNSETTLED_ALLOCATIONS", openCount: 2, disputedCount: 1 },
      });

      const response = await request(app).post(PATH).send(VALID_BAKE_BODY);

      expect(response.status).toBe(409);
    });

    /**
     * THE property that matters most about this endpoint: baking is irreversible and
     * once-ever, and a SECOND attempt — even with a perfectly valid body — must be refused,
     * never silently re-applied or treated as a no-op success.
     *
     * This is the answer for someone who is NOT retrying. A caller replaying their own
     * request gets their bake back instead; that branch is `pie-bake.service.test.ts`.
     */
    it("refuses a second bake attempt with 409 PIE_ALREADY_BAKED, never a silent success", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({ success: false, error: { type: "PIE_ALREADY_BAKED" } });

      const response = await request(app).post(PATH).send(VALID_BAKE_BODY);

      expect(response.status).toBe(409);
      expect(response.body.status).toBe("error");
    });

    it("passes a body-carried idempotencyKey through to the service", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({
        success: true,
        value: {
          bakeEventId: "bake_1",
          trigger: "priced_round",
          valuationCents: "1200000000",
          bakedAt: new Date("2026-03-01T00:00:00.000Z"),
          snapshot: { id: "snapshot_1" },
        },
      });

      const response = await request(app)
        .post(PATH)
        .send({ ...VALID_BAKE_BODY, idempotencyKey: "bake-key-0001" });

      expect(response.status).toBe(201);
      expect(bakePie).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        expect.objectContaining({ idempotencyKey: "bake-key-0001" }),
        "user_test_caller",
        "founder",
      );
    });

    /**
     * Omitted is still valid — the field is optional until the frontend ships it, and the
     * key must be ABSENT rather than `undefined` so the service's "did this caller send
     * one?" check is a real question.
     */
    it("omits idempotencyKey entirely when the caller sends none", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      bakePie.mockResolvedValue({
        success: true,
        value: {
          bakeEventId: "bake_1",
          trigger: "priced_round",
          valuationCents: "1200000000",
          bakedAt: new Date("2026-03-01T00:00:00.000Z"),
          snapshot: { id: "snapshot_1" },
        },
      });

      await request(app).post(PATH).send(VALID_BAKE_BODY);

      const [, passedInput] = bakePie.mock.calls[0] ?? [];
      expect(passedInput).not.toHaveProperty("idempotencyKey");
    });

    it("rejects an idempotencyKey below the 8-character floor at the parse boundary", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app)
        .post(PATH)
        .send({ ...VALID_BAKE_BODY, idempotencyKey: "short" });

      expect(response.status).toBe(422);
      expect(bakePie).not.toHaveBeenCalled();
    });
  });
});
