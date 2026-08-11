import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut, TEST_SESSION_USER } from "#src/test-support/auth-mock.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * The notification inbox, at the route level (§11l.2 item 1).
 *
 * THE PROPERTY WORTH ASSERTING HERE is that the recipient is never a client input. Every
 * route resolves it from the session, and a test that passed a `?userId=` and got somebody
 * else's inbox would be the whole security story of this surface failing at once.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listNotifications = vi.fn<(...args: readonly unknown[]) => unknown>();
const countUnread = vi.fn<(...args: readonly unknown[]) => unknown>();
const markReadThrough = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/services/notifications.service.js", () => ({
  listNotifications: (...args: readonly unknown[]) => listNotifications(...args),
  countUnread: (...args: readonly unknown[]) => countUnread(...args),
  markReadThrough: (...args: readonly unknown[]) => markReadThrough(...args),
}));

const EMPTY_PAGE = {
  success: true,
  value: { notifications: [], nextCursor: null, unreadCount: 0 },
};

describe("notification routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signInAs();
  });

  it.each(["/notifications", "/notifications/unread-count"])(
    "answers 401 for a signed-out caller on %s",
    async (path) => {
      signOut();

      expect((await request(app).get(path)).status).toBe(401);
    },
  );

  it("resolves the recipient from the session, never from the query", async () => {
    listNotifications.mockResolvedValue(EMPTY_PAGE);

    // A client asserting an identity. `.strict()` must refuse it outright rather than
    // ignoring it — an ignored key is one a client believes worked.
    const response = await request(app).get("/notifications?userId=someone-else");

    expect(response.status).toBe(422);
    expect(listNotifications).not.toHaveBeenCalled();
  });

  it("passes the session user id and the parsed cursor through", async () => {
    listNotifications.mockResolvedValue(EMPTY_PAGE);

    const response = await request(app).get("/notifications?cursor=1773479700123_notification_1&limit=5");

    /**
     * ASSERTED FIRST, and it was missing. Without it EVERY short-circuit — a 401 from
     * `requireAuth`, a 422 from the query schema — surfaced as "spy not called with…", which
     * names the wrong cause. This test was the one that flaked under `--sequence.shuffle`, and
     * it took two investigations to establish that the answer had simply been a 401, because
     * the assertion never said so. See `vitest.config.ts`'s `testTimeout` note for the
     * mechanism.
     */
    expect(response.status).toBe(200);
    expect(listNotifications).toHaveBeenCalledWith(TEST_SESSION_USER.id, {
      cursor: "1773479700123_notification_1",
      limit: 5,
    });
  });

  it("answers 422 for a malformed cursor rather than a silent first page", async () => {
    listNotifications.mockResolvedValue({
      success: false,
      error: { type: "CURSOR_MALFORMED" },
    });

    const response = await request(app).get("/notifications?cursor=nonsense");

    expect(response.status).toBe(422);
    expect(response.body.message).toBe("Malformed cursor.");
  });

  it("returns the badge count on its own route", async () => {
    countUnread.mockResolvedValue(7);

    const response = await request(app).get("/notifications/unread-count");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ unreadCount: 7 });
    expect(countUnread).toHaveBeenCalledWith(TEST_SESSION_USER.id);
  });

  it("declares /notifications/unread-count before anything parameterised", async () => {
    // The badge is a LITERAL under `/notifications`. There is no
    // `/notifications/:notificationId` today; if one is ever added below this route it
    // resolves as "the notification whose id is unread-count" and returns a plausible 404.
    countUnread.mockResolvedValue(0);

    expect((await request(app).get("/notifications/unread-count")).status).toBe(200);
    expect(countUnread).toHaveBeenCalled();
  });

  describe("POST /notifications/read", () => {
    it("marks through an id and reports how many moved", async () => {
      markReadThrough.mockResolvedValue({ success: true, value: { markedCount: 3 } });

      const response = await request(app)
        .post("/notifications/read")
        .send({ throughNotificationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ markedCount: 3 });
      expect(markReadThrough).toHaveBeenCalledWith(TEST_SESSION_USER.id, "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    });

    it("answers 404 for another person's notification id", async () => {
      // The service scopes the lookup to the caller, so somebody else's id is
      // indistinguishable from one that never existed — never a 403 (§0).
      markReadThrough.mockResolvedValue({
        success: false,
        error: { type: "NOTIFICATION_NOT_FOUND", notificationId: "x" },
      });

      const response = await request(app)
        .post("/notifications/read")
        .send({ throughNotificationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });

      expect(response.status).toBe(404);
    });

    it("rejects a body that names a recipient", async () => {
      const response = await request(app).post("/notifications/read").send({
        throughNotificationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        recipientUserId: "someone-else",
      });

      expect(response.status).toBe(422);
      expect(markReadThrough).not.toHaveBeenCalled();
    });
  });
});
