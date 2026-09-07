import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut, TEST_SESSION_USER } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the cofounder directory's write surface (§18.3).
 *
 * `src/modules/store/community/` had NO test files at all until this one, which is how
 * `PATCH /cofounder-profiles/mine` shipped parsing the CREATE schema: it demanded
 * `displayName` and five other fields on every edit, and the frontend's update type does
 * not even have a `displayName`, so every profile edit answered 422 in production.
 *
 * THE TWO CASES THIS FILE EXISTS FOR are in "the patch is a patch" below. The second is the
 * subtle one: the create mapper defaults every absent collection to `[]`, so reusing it on
 * a patch would silently CLEAR a profile's sectors. Absence has to survive the controller
 * as absence, and `toStrictEqual` on the service's arguments is what proves it — unlike
 * `toEqual`/`toHaveBeenCalledWith`, it distinguishes a key set to `undefined` from a key
 * that was never there, which is exactly the distinction the bug turns on.
 *
 * NO CAPABILITY MIDDLEWARE on the moderation routes: `moderate_content` is checked inside
 * the service, so the 403 here is a mocked domain error rather than a different chain.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` queries `user`/`account`/`passkey` against the real query builder,
 * which the inert `databaseModuleMock()` cannot serve. Stubbed to a pass-through so this
 * suite stays about routing, per the precedent in `import-intelligence.routes.test.ts`; the
 * guard keeps its own dedicated suite and the routes still declare it.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

/**
 * Two routes here declare `idempotency({ required: true })`, and the real middleware writes
 * its record through `db`. Same `Map`-backed stand-in the commerce suites use, so the
 * required-key branch and the replay branch behave here exactly as they do there.
 */
const idempotencyCache = vi.hoisted(() => new Map<string, { statusCode: number; body: unknown }>());

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const key = req.header("Idempotency-Key");
      if (!key) {
        if (options.required === true) {
          res.status(400).json({
            status: "error",
            statusCode: 400,
            message: "This request requires an Idempotency-Key header.",
          });
          return;
        }
        next();
        return;
      }
      const cached = idempotencyCache.get(key);
      if (cached) {
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          idempotencyCache.set(key, { statusCode: res.statusCode, body });
        }
        return originalJson(body);
      }) as typeof res.json;
      next();
    },
}));

const listCofounderProfiles = vi.fn<(...args: readonly unknown[]) => unknown>();
const getCofounderProfileBySlug = vi.fn<(...args: readonly unknown[]) => unknown>();
const createCofounderProfile = vi.fn<(...args: readonly unknown[]) => unknown>();
const getMyCofounderProfile = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateMyCofounderProfile = vi.fn<(...args: readonly unknown[]) => unknown>();
const submitMyCofounderProfile = vi.fn<(...args: readonly unknown[]) => unknown>();
const withdrawMyCofounderProfile = vi.fn<(...args: readonly unknown[]) => unknown>();
const setMyEngagementState = vi.fn<(...args: readonly unknown[]) => unknown>();
const listCofounderModerationQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const moderateCofounderProfile = vi.fn<(...args: readonly unknown[]) => unknown>();

// The public reads live on another router but share this module, so the factory has to
// carry them or that router breaks at import time.
vi.mock("#src/modules/store/community/community-cofounder.service.js", () => ({
  listCofounderProfiles: (...args: readonly unknown[]) => listCofounderProfiles(...args),
  getCofounderProfileBySlug: (...args: readonly unknown[]) => getCofounderProfileBySlug(...args),
  createCofounderProfile: (...args: readonly unknown[]) => createCofounderProfile(...args),
  getMyCofounderProfile: (...args: readonly unknown[]) => getMyCofounderProfile(...args),
  updateMyCofounderProfile: (...args: readonly unknown[]) => updateMyCofounderProfile(...args),
  submitMyCofounderProfile: (...args: readonly unknown[]) => submitMyCofounderProfile(...args),
  withdrawMyCofounderProfile: (...args: readonly unknown[]) => withdrawMyCofounderProfile(...args),
  setMyEngagementState: (...args: readonly unknown[]) => setMyEngagementState(...args),
  listCofounderModerationQueue: (...args: readonly unknown[]) => listCofounderModerationQueue(...args),
  moderateCofounderProfile: (...args: readonly unknown[]) => moderateCofounderProfile(...args),
}));

const BASE = "/community/cofounder-profiles";
const MINE = `${BASE}/mine`;

/** A complete, valid create body — every required field of `WriteCofounderProfileSchema`. */
const VALID_CREATE_BODY = {
  displayName: "Ada Lovelace",
  headline: "Building the analytical engine, looking for a co-founder",
  bio: "Twenty years of mathematics, and a working prototype nobody has financed yet.",
  lookingFor: "A commercial co-founder who can price and sell an engine.",
  countryCode: "GB",
  commitmentLevel: "full_time",
  contributionKinds: ["expertise"],
};

/** What a service call answers on the happy path. Shape is not the subject here. */
const PROFILE = { id: "profile_1", slug: "ada-lovelace", state: "draft" };
const OK = { success: true, value: PROFILE } as const;

describe("community cofounder routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyCache.clear();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication", () => {
    it.each([
      ["get", MINE] as const,
      ["get", "/community/admin/cofounder-profiles"] as const,
    ])("answers 401 for a signed-out caller on %s %s", async (method, path) => {
      signOut();

      const response = await request(app)[method](path);

      expect(response.status).toBe(401);
      expect(getMyCofounderProfile).not.toHaveBeenCalled();
      expect(listCofounderModerationQueue).not.toHaveBeenCalled();
    });

    it("answers 401 for a signed-out caller patching their profile", async () => {
      signOut();

      const response = await request(app).patch(MINE).send({ headline: "A brand new headline" });

      expect(response.status).toBe(401);
      expect(updateMyCofounderProfile).not.toHaveBeenCalled();
    });

    it("answers 401 for a signed-out caller creating a profile", async () => {
      signOut();

      const response = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "cofounder_create_signed_out")
        .send(VALID_CREATE_BODY);

      expect(response.status).toBe(401);
      expect(createCofounderProfile).not.toHaveBeenCalled();
    });
  });

  describe("GET …/cofounder-profiles/mine", () => {
    it("loads the caller's own profile, addressed only by their session", async () => {
      getMyCofounderProfile.mockResolvedValue(OK);

      const response = await request(app).get(MINE);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(PROFILE);
      expect(getMyCofounderProfile).toHaveBeenCalledWith(TEST_SESSION_USER.id);
    });

    it("maps NOT_FOUND to 404 for someone who has never made one", async () => {
      getMyCofounderProfile.mockResolvedValue({ success: false, error: { type: "NOT_FOUND" } });

      const response = await request(app).get(MINE);

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH …/cofounder-profiles/mine — the patch is a patch", () => {
    /**
     * THE REGRESSION THIS FILE EXISTS FOR. The route used to parse the create schema, so a
     * body without `displayName` — which is every body the frontend can build — was 422.
     */
    it("accepts a partial body and forwards exactly those fields", async () => {
      updateMyCofounderProfile.mockResolvedValue(OK);

      const response = await request(app)
        .patch(MINE)
        .send({ headline: "A sharper headline than before", bio: VALID_CREATE_BODY.bio });

      expect(response.status).toBe(200);
      expect(updateMyCofounderProfile).toHaveBeenCalledTimes(1);
      expect(updateMyCofounderProfile.mock.calls[0]?.[0]).toStrictEqual({
        userId: TEST_SESSION_USER.id,
        profile: { headline: "A sharper headline than before", bio: VALID_CREATE_BODY.bio },
      });
    });

    /**
     * THE SILENT-DATA-LOSS CASE. An omitted collection must reach the service as an ABSENT
     * key, never as `[]` — the create mapper defaults absent collections to empty, and
     * reusing it here would clear a profile's sectors on any edit that did not resend them.
     *
     * `toStrictEqual` is load-bearing: `toEqual` treats `{ sectors: undefined }` and `{}` as
     * equal, so it would pass against precisely the bug being guarded.
     */
    it("passes NO key at all for collections the caller omitted", async () => {
      updateMyCofounderProfile.mockResolvedValue(OK);

      await request(app).patch(MINE).send({ headline: "Only the headline changed here" });

      const payload = updateMyCofounderProfile.mock.calls[0]?.[0];
      expect(payload).toStrictEqual({
        userId: TEST_SESSION_USER.id,
        profile: { headline: "Only the headline changed here" },
      });
    });

    /**
     * The other half of the same rule: "clear my sectors" is a real intent, so an
     * EXPLICIT empty array must still be forwarded rather than treated as absence.
     */
    it("forwards an explicitly empty collection, which means clear it", async () => {
      updateMyCofounderProfile.mockResolvedValue(OK);

      await request(app).patch(MINE).send({ sectors: [], languages: [] });

      expect(updateMyCofounderProfile.mock.calls[0]?.[0]).toStrictEqual({
        userId: TEST_SESSION_USER.id,
        profile: { sectors: [], languages: [] },
      });
    });

    it("forwards an explicit null avatar, which means remove it", async () => {
      updateMyCofounderProfile.mockResolvedValue(OK);

      await request(app).patch(MINE).send({ avatarUrl: null });

      expect(updateMyCofounderProfile.mock.calls[0]?.[0]).toStrictEqual({
        userId: TEST_SESSION_USER.id,
        profile: { avatarUrl: null },
      });
    });

    it("still refuses an unknown key — .partial() did not loosen .strict()", async () => {
      const response = await request(app)
        .patch(MINE)
        .send({ headline: "A perfectly fine headline", capitalRange: "50k-100k" });

      expect(response.status).toBe(422);
      expect(updateMyCofounderProfile).not.toHaveBeenCalled();
    });

    it("refuses a headline below the minimum length", async () => {
      const response = await request(app).patch(MINE).send({ headline: "short" });

      expect(response.status).toBe(422);
      expect(updateMyCofounderProfile).not.toHaveBeenCalled();
    });

    /**
     * Only `draft` and `withdrawn` profiles are editable — everything else is content a
     * moderator already approved, and changing it has to re-enter review.
     */
    it("maps INVALID_STATE to 409 for a profile that is already published", async () => {
      updateMyCofounderProfile.mockResolvedValue({
        success: false,
        error: { type: "INVALID_STATE", message: "A profile in state published must be withdrawn." },
      });

      const response = await request(app).patch(MINE).send({ headline: "A sharper headline here" });

      expect(response.status).toBe(409);
      expect(response.body.message).toBe(
        "A profile in state published must be withdrawn.",
      );
    });
  });

  describe("POST …/cofounder-profiles/mine/submit and /withdraw", () => {
    it("queues the profile for review", async () => {
      submitMyCofounderProfile.mockResolvedValue(OK);

      const response = await request(app).post(`${MINE}/submit`);

      expect(response.status).toBe(200);
      expect(submitMyCofounderProfile).toHaveBeenCalledWith(TEST_SESSION_USER.id);
    });

    it("maps INVALID_STATE to 409 when the profile is not submittable", async () => {
      submitMyCofounderProfile.mockResolvedValue({
        success: false,
        error: { type: "INVALID_STATE", message: "Already pending review." },
      });

      const response = await request(app).post(`${MINE}/submit`);

      expect(response.status).toBe(409);
    });

    it("withdraws the profile from the directory", async () => {
      withdrawMyCofounderProfile.mockResolvedValue(OK);

      const response = await request(app).post(`${MINE}/withdraw`);

      expect(response.status).toBe(200);
      expect(withdrawMyCofounderProfile).toHaveBeenCalledWith(TEST_SESSION_USER.id);
    });
  });

  describe("PATCH …/cofounder-profiles/mine/engagement-state", () => {
    it("updates availability, the one edit a published profile may make", async () => {
      setMyEngagementState.mockResolvedValue(OK);

      const response = await request(app)
        .patch(`${MINE}/engagement-state`)
        .send({ engagementState: "in_conversation" });

      expect(response.status).toBe(200);
      expect(setMyEngagementState).toHaveBeenCalledWith({
        userId: TEST_SESSION_USER.id,
        engagementState: "in_conversation",
      });
    });

    it("refuses an engagement state outside the enum", async () => {
      const response = await request(app)
        .patch(`${MINE}/engagement-state`)
        .send({ engagementState: "ghosting" });

      expect(response.status).toBe(422);
      expect(setMyEngagementState).not.toHaveBeenCalled();
    });
  });

  describe("POST /community/cofounder-profiles", () => {
    it("requires an Idempotency-Key — a retry without one is a duplicate person", async () => {
      const response = await request(app).post(BASE).send(VALID_CREATE_BODY);

      expect(response.status).toBe(400);
      expect(createCofounderProfile).not.toHaveBeenCalled();
    });

    /**
     * 201 AND THE MESSAGE SAYS DRAFT. Nothing on this path may read as "you are listed":
     * the profile is visible to nobody until a moderator publishes it.
     */
    it("creates a draft and answers 201, defaulting the absent collections", async () => {
      createCofounderProfile.mockResolvedValue(OK);

      const response = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "cofounder_create_1")
        .send(VALID_CREATE_BODY);

      expect(response.status).toBe(201);
      expect(response.body.message).toContain("Draft");
      // The CREATE mapper does fill absent collections in — that is correct here, and is
      // exactly what the patch above must not do.
      expect(createCofounderProfile.mock.calls[0]?.[0]).toStrictEqual({
        userId: TEST_SESSION_USER.id,
        profile: {
          displayName: VALID_CREATE_BODY.displayName,
          headline: VALID_CREATE_BODY.headline,
          bio: VALID_CREATE_BODY.bio,
          lookingFor: VALID_CREATE_BODY.lookingFor,
          countryCode: VALID_CREATE_BODY.countryCode,
          avatarUrl: null,
          commitmentLevel: VALID_CREATE_BODY.commitmentLevel,
          contributionKinds: VALID_CREATE_BODY.contributionKinds,
          sectors: [],
          languages: [],
          priorVentures: [],
        },
      });
    });

    it("replays the first answer for a repeated key rather than making a second profile", async () => {
      createCofounderProfile.mockResolvedValue(OK);

      const first = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "cofounder_create_2")
        .send(VALID_CREATE_BODY);
      const retry = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "cofounder_create_2")
        .send(VALID_CREATE_BODY);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.headers["idempotency-replayed"]).toBe("true");
      expect(createCofounderProfile).toHaveBeenCalledTimes(1);
    });

    it("refuses a create missing the required contributionKinds", async () => {
      const { contributionKinds: _contributionKinds, ...withoutKinds } = VALID_CREATE_BODY;

      const response = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "cofounder_create_3")
        .send(withoutKinds);

      expect(response.status).toBe(422);
      expect(createCofounderProfile).not.toHaveBeenCalled();
    });

    /**
     * §18's capital fields are absent from the write schema on purpose, and `.strict()` is
     * the enforcement: refusing the number is honest, silently dropping it is not.
     */
    it("refuses a self-declared capital range rather than discarding it", async () => {
      const response = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "cofounder_create_4")
        .send({ ...VALID_CREATE_BODY, capitalRange: "50k-100k" });

      expect(response.status).toBe(422);
      expect(createCofounderProfile).not.toHaveBeenCalled();
    });

    it("maps PROFILE_EXISTS to 409, not 422 — the request was fine, the state is not", async () => {
      createCofounderProfile.mockResolvedValue({
        success: false,
        error: { type: "PROFILE_EXISTS" },
      });

      const response = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "cofounder_create_5")
        .send(VALID_CREATE_BODY);

      expect(response.status).toBe(409);
    });

    it("maps NAME_UNUSABLE to 422 with the field named", async () => {
      createCofounderProfile.mockResolvedValue({
        success: false,
        error: { type: "NAME_UNUSABLE" },
      });

      const response = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "cofounder_create_6")
        .send(VALID_CREATE_BODY);

      expect(response.status).toBe(422);
      expect(response.body.errors.displayName).toBeDefined();
    });
  });

  describe("GET /community/admin/cofounder-profiles", () => {
    it("loads the moderation queue for the calling moderator", async () => {
      listCofounderModerationQueue.mockResolvedValue({ success: true, value: { items: [] } });

      const response = await request(app).get("/community/admin/cofounder-profiles?limit=5");

      expect(response.status).toBe(200);
      expect(listCofounderModerationQueue).toHaveBeenCalledWith({
        moderatorUserId: TEST_SESSION_USER.id,
        limit: 5,
        cursor: undefined,
      });
    });

    it("maps PLATFORM_CAPABILITY_REQUIRED to 403 and names the capability", async () => {
      listCofounderModerationQueue.mockResolvedValue({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
      });

      const response = await request(app).get("/community/admin/cofounder-profiles");

      expect(response.status).toBe(403);
      expect(response.body.data.capability).toBe("moderate_content");
    });

    it("maps INVALID_CURSOR to 422", async () => {
      listCofounderModerationQueue.mockResolvedValue({
        success: false,
        error: { type: "INVALID_CURSOR" },
      });

      const response = await request(app).get("/community/admin/cofounder-profiles?cursor=nonsense");

      expect(response.status).toBe(422);
    });

    it("refuses an unknown query key", async () => {
      const response = await request(app).get("/community/admin/cofounder-profiles?state=pending");

      expect(response.status).toBe(422);
      expect(listCofounderModerationQueue).not.toHaveBeenCalled();
    });
  });

  describe("POST /community/admin/cofounder-profiles/:profileId/moderate", () => {
    const path = "/community/admin/cofounder-profiles/profile_1/moderate";

    it("requires an Idempotency-Key", async () => {
      const response = await request(app)
        .post(path)
        .send({ decision: "publish", reasonNote: "Reads well and the links check out." });

      expect(response.status).toBe(400);
      expect(moderateCofounderProfile).not.toHaveBeenCalled();
    });

    it("records the decision with the moderator and the profile from the path", async () => {
      moderateCofounderProfile.mockResolvedValue(OK);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "cofounder_moderate_1")
        .send({ decision: "publish", reasonNote: "Reads well and the links check out." });

      expect(response.status).toBe(200);
      expect(moderateCofounderProfile).toHaveBeenCalledWith({
        moderatorUserId: TEST_SESSION_USER.id,
        profileId: "profile_1",
        decision: "publish",
        reasonNote: "Reads well and the links check out.",
      });
    });

    /** Every decision carries a reason, a publish included — the queue's log is read by peers. */
    it("refuses a decision with no reasonNote", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "cofounder_moderate_2")
        .send({ decision: "publish" });

      expect(response.status).toBe(422);
      expect(moderateCofounderProfile).not.toHaveBeenCalled();
    });

    it("refuses a decision outside the enum", async () => {
      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "cofounder_moderate_3")
        .send({ decision: "shadowban", reasonNote: "No such verb." });

      expect(response.status).toBe(422);
      expect(moderateCofounderProfile).not.toHaveBeenCalled();
    });

    it("maps PLATFORM_CAPABILITY_REQUIRED to 403", async () => {
      moderateCofounderProfile.mockResolvedValue({
        success: false,
        error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
      });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "cofounder_moderate_4")
        .send({ decision: "reject", reasonNote: "Not enough detail to publish." });

      expect(response.status).toBe(403);
    });

    it("maps NOT_FOUND to 404 for a profile id that is not in the queue", async () => {
      moderateCofounderProfile.mockResolvedValue({ success: false, error: { type: "NOT_FOUND" } });

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "cofounder_moderate_5")
        .send({ decision: "publish", reasonNote: "Looks good to me." });

      expect(response.status).toBe(404);
    });
  });
});
