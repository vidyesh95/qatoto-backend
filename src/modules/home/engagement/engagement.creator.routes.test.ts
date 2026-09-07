import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for `creatorRouter` (root-mounted, owns `/creators/:creatorId/*`) —
 * previously untested at any behavior tier. `subscribe` requires `requireIdentifiedUser`
 * (subscriberCount is public social proof, farmable by throwaway anonymous sessions);
 * `mute` deliberately does not (it moves no counter — see the route file's own docblock).
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

const setCreatorSubscription = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/creator-subscriptions.service.js", () => ({
  setCreatorSubscription: (...args: readonly unknown[]) => setCreatorSubscription(...args),
}));

const setCreatorMute = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/home/engagement/feed-preferences.service.js", () => ({
  setCreatorMute: (...args: readonly unknown[]) => setCreatorMute(...args),
}));

const CREATOR_ID = "creator_handle_1";

describe("engagement creatorRouter (root-mounted)", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("PUT/DELETE /creators/:creatorId/subscribe", () => {
    const path = `/creators/${CREATOR_ID}/subscribe`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(path);

      expect(response.status).toBe(401);
      expect(setCreatorSubscription).not.toHaveBeenCalled();
    });

    it("subscribes and returns the service's result", async () => {
      setCreatorSubscription.mockResolvedValue({
        success: true,
        value: { isSubscribed: true, subscriberCount: 42 },
      });

      const response = await request(app).put(path);

      expect(response.status).toBe(200);
      expect(setCreatorSubscription).toHaveBeenCalledWith({
        subscriberId: "user_test_caller",
        creatorId: CREATOR_ID,
        shouldBeSubscribed: true,
      });
      expect(response.body.data).toEqual({ isSubscribed: true, subscriberCount: 42 });
    });

    it("unsubscribes with DELETE", async () => {
      setCreatorSubscription.mockResolvedValue({
        success: true,
        value: { isSubscribed: false, subscriberCount: 41 },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(setCreatorSubscription).toHaveBeenCalledWith({
        subscriberId: "user_test_caller",
        creatorId: CREATOR_ID,
        shouldBeSubscribed: false,
      });
    });

    /** The self-dealing prevention rule: subscriberCount is public social proof, worth farming. */
    it("maps SELF_SUBSCRIPTION_FORBIDDEN to 403", async () => {
      setCreatorSubscription.mockResolvedValue({
        success: false,
        error: { type: "SELF_SUBSCRIPTION_FORBIDDEN" },
      });

      const response = await request(app).put(path);

      expect(response.status).toBe(403);
    });

    it("maps CREATOR_NOT_FOUND to 404", async () => {
      setCreatorSubscription.mockResolvedValue({ success: false, error: { type: "CREATOR_NOT_FOUND" } });

      const response = await request(app).put(path);

      expect(response.status).toBe(404);
    });
  });

  describe("PUT/DELETE /creators/:creatorId/mute — no requireIdentifiedUser, deliberately", () => {
    const path = `/creators/${CREATOR_ID}/mute`;

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(path);

      expect(response.status).toBe(401);
      expect(setCreatorMute).not.toHaveBeenCalled();
    });

    it("mutes for any signed-in caller — mute moves no counter, so there is nothing to farm", async () => {
      setCreatorMute.mockResolvedValue({ success: true, value: { isMuted: true } });

      const response = await request(app).put(path);

      expect(response.status).toBe(200);
      expect(setCreatorMute).toHaveBeenCalledWith({
        muterId: "user_test_caller",
        creatorId: CREATOR_ID,
        shouldBeSet: true,
      });
    });

    it("unmutes with DELETE", async () => {
      setCreatorMute.mockResolvedValue({ success: true, value: { isMuted: false } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(setCreatorMute).toHaveBeenCalledWith({
        muterId: "user_test_caller",
        creatorId: CREATOR_ID,
        shouldBeSet: false,
      });
    });

    /**
     * Not a silent success either: the feed's own creator self-exclusion already keeps a
     * creator's uploads out of their own feed, so this is refused rather than accepted as
     * a preference that could never be observed to do anything.
     */
    it("maps SELF_MUTE_FORBIDDEN to 403", async () => {
      setCreatorMute.mockResolvedValue({ success: false, error: { type: "SELF_MUTE_FORBIDDEN" } });

      const response = await request(app).put(path);

      expect(response.status).toBe(403);
    });
  });
});
