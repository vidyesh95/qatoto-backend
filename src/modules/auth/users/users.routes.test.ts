import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the "core" `/users` routes — previously only unit-tested (calling
 * controller functions directly with hand-built req/res stubs in `users.controller.test.ts`
 * / `users.controller.photo.test.ts`), never through the real app/middleware chain. This
 * file complements those, it does not replace them.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listUsersForStaff = vi.fn<(...args: readonly unknown[]) => unknown>();
const getUserByIdForStaff = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateUserName = vi.fn<(...args: readonly unknown[]) => unknown>();
const getLinkedAccounts = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateUserPhoto = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteUserPhoto = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/auth/users/users.service.js", () => ({
  listUsersForStaff: (...args: readonly unknown[]) => listUsersForStaff(...args),
  getUserByIdForStaff: (...args: readonly unknown[]) => getUserByIdForStaff(...args),
  updateUserName: (...args: readonly unknown[]) => updateUserName(...args),
  getLinkedAccounts: (...args: readonly unknown[]) => getLinkedAccounts(...args),
  updateUserPhoto: (...args: readonly unknown[]) => updateUserPhoto(...args),
  deleteUserPhoto: (...args: readonly unknown[]) => deleteUserPhoto(...args),
}));

const getMyChannelProfile = vi.fn<(...args: readonly unknown[]) => unknown>();
const replaceMyChannelProfile = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/auth/users/channel-profile.service.js", () => ({
  getMyChannelProfile: (...args: readonly unknown[]) => getMyChannelProfile(...args),
  replaceMyChannelProfile: (...args: readonly unknown[]) => replaceMyChannelProfile(...args),
}));

const getHandleMetadata = vi.fn<(...args: readonly unknown[]) => unknown>();
const setHandle = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/auth/handles/handle.service.js", () => ({
  getHandleMetadata: (...args: readonly unknown[]) => getHandleMetadata(...args),
  setHandle: (...args: readonly unknown[]) => setHandle(...args),
  MAX_HANDLE_CHANGES_PER_WINDOW: 3,
}));

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe("users core routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("GET /users — staff only", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/users");

      expect(response.status).toBe(401);
      expect(listUsersForStaff).not.toHaveBeenCalled();
    });

    /**
     * `GET /users` USED TO BE OPEN and leaked real email addresses — the route's own
     * docblock says so. Confirmed from source (`users.controller.ts`, `getUsers`):
     * `usersService.listUsersForStaff(req.user.id)` returns a `Result`, and a `{success:
     * false}` maps to 403, so the staff check IS genuinely enforced, not just documented.
     */
    it("answers 403 for a signed-in caller who is not staff", async () => {
      listUsersForStaff.mockResolvedValue({ success: false, error: { type: "NOT_STAFF" } });

      const response = await request(app).get("/users");

      expect(response.status).toBe(403);
    });

    it("lists every account for staff", async () => {
      listUsersForStaff.mockResolvedValue({
        success: true,
        value: [{ id: "user_1", email: "a@example.test", createdAt: "2026-01-01T00:00:00.000Z" }],
      });

      const response = await request(app).get("/users");

      expect(response.status).toBe(200);
      expect(listUsersForStaff).toHaveBeenCalledWith("user_test_caller");
      expect(response.body.data).toHaveLength(1);
    });
  });

  describe("GET /users/:id — staff only", () => {
    it("answers 403 for a non-staff caller", async () => {
      getUserByIdForStaff.mockResolvedValue({ success: false, error: { type: "NOT_STAFF" } });

      const response = await request(app).get("/users/user_2");

      expect(response.status).toBe(403);
    });

    it("answers 404 when the account does not exist", async () => {
      getUserByIdForStaff.mockResolvedValue({ success: true, value: null });

      const response = await request(app).get("/users/user_missing");

      expect(response.status).toBe(404);
    });

    it("returns the account for staff", async () => {
      getUserByIdForStaff.mockResolvedValue({ success: true, value: { id: "user_2", email: "b@example.test" } });

      const response = await request(app).get("/users/user_2");

      expect(response.status).toBe(200);
      expect(getUserByIdForStaff).toHaveBeenCalledWith("user_test_caller", "user_2");
    });
  });

  describe("PATCH /users/me", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).patch("/users/me").send({ fullName: "Jane Doe" });

      expect(response.status).toBe(401);
      expect(updateUserName).not.toHaveBeenCalled();
    });

    it("renames the caller, derived from the session", async () => {
      updateUserName.mockResolvedValue({ success: true, value: { id: "user_test_caller", fullName: "Jane Doe" } });

      const response = await request(app).patch("/users/me").send({ fullName: "Jane Doe" });

      expect(response.status).toBe(200);
      expect(updateUserName).toHaveBeenCalledWith("user_test_caller", "Jane Doe");
    });

    it("rejects a name starting with punctuation", async () => {
      const response = await request(app).patch("/users/me").send({ fullName: "-Jane" });

      expect(response.status).toBe(422);
      expect(updateUserName).not.toHaveBeenCalled();
    });

    it("rejects a client-supplied id — the session is the only source", async () => {
      const response = await request(app).patch("/users/me").send({ fullName: "Jane Doe", id: "user_someone_else" });

      expect(response.status).toBe(422);
      expect(updateUserName).not.toHaveBeenCalled();
    });

    it("maps USER_NOT_FOUND to 404", async () => {
      updateUserName.mockResolvedValue({ success: false, error: { type: "USER_NOT_FOUND" } });

      const response = await request(app).patch("/users/me").send({ fullName: "Jane Doe" });

      expect(response.status).toBe(404);
    });
  });

  describe("GET /users/me/channel-profile", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/users/me/channel-profile");

      expect(response.status).toBe(401);
    });

    it("returns the caller's own channel profile", async () => {
      getMyChannelProfile.mockResolvedValue({ success: true, value: { bio: null, links: [], isChannelListed: false } });

      const response = await request(app).get("/users/me/channel-profile");

      expect(response.status).toBe(200);
      expect(getMyChannelProfile).toHaveBeenCalledWith("user_test_caller");
    });

    it("answers 404 when the account no longer exists", async () => {
      getMyChannelProfile.mockResolvedValue({ success: false, error: { type: "USER_NOT_FOUND" } });

      const response = await request(app).get("/users/me/channel-profile");

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /users/me/channel-profile", () => {
    const validBody = { bio: "A description that is at least twenty characters.", links: [], isChannelListed: true };

    it("replaces the profile with all three fields required", async () => {
      replaceMyChannelProfile.mockResolvedValue({ success: true, value: validBody });

      const response = await request(app).patch("/users/me/channel-profile").send(validBody);

      expect(response.status).toBe(200);
      expect(replaceMyChannelProfile).toHaveBeenCalledWith("user_test_caller", validBody);
    });

    it("rejects a body missing isChannelListed — omission must not silently flip consent", async () => {
      const response = await request(app).patch("/users/me/channel-profile").send({ bio: validBody.bio, links: [] });

      expect(response.status).toBe(422);
      expect(replaceMyChannelProfile).not.toHaveBeenCalled();
    });

    it("rejects a bio shorter than 20 characters", async () => {
      const response = await request(app)
        .patch("/users/me/channel-profile")
        .send({ ...validBody, bio: "too short" });

      expect(response.status).toBe(422);
    });

    it("rejects a link that is not https", async () => {
      const response = await request(app)
        .patch("/users/me/channel-profile")
        .send({ ...validBody, links: [{ label: "Site", url: "http://example.test" }] });

      expect(response.status).toBe(422);
      expect(replaceMyChannelProfile).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /users/me/photo (multipart)", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .patch("/users/me/photo")
        .attach("photo", PNG_BYTES, { filename: "avatar.png", contentType: "image/png" });

      expect(response.status).toBe(401);
    });

    it("updates the photo from the uploaded bytes", async () => {
      updateUserPhoto.mockResolvedValue({ success: true, value: { imageUrl: "https://cdn.example.test/a.png" } });

      const response = await request(app)
        .patch("/users/me/photo")
        .attach("photo", PNG_BYTES, { filename: "avatar.png", contentType: "image/png" });

      expect(response.status).toBe(200);
      expect(updateUserPhoto).toHaveBeenCalledWith("user_test_caller", expect.any(Buffer));
    });

    it("rejects a request with no file attached", async () => {
      const response = await request(app).patch("/users/me/photo");

      expect(response.status).toBe(422);
      expect(updateUserPhoto).not.toHaveBeenCalled();
    });

    it("rejects a non-image file with 422", async () => {
      const response = await request(app)
        .patch("/users/me/photo")
        .attach("photo", Buffer.from("not an image"), { filename: "notes.txt", contentType: "text/plain" });

      expect(response.status).toBe(422);
      expect(updateUserPhoto).not.toHaveBeenCalled();
    });

    it("rejects a file over the 5 MB cap with 413", async () => {
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);

      const response = await request(app)
        .patch("/users/me/photo")
        .attach("photo", oversized, { filename: "huge.png", contentType: "image/png" });

      expect(response.status).toBe(413);
      expect(updateUserPhoto).not.toHaveBeenCalled();
    });

    it("maps NOT_AN_IMAGE to 422", async () => {
      updateUserPhoto.mockResolvedValue({ success: false, error: { type: "NOT_AN_IMAGE" } });

      const response = await request(app)
        .patch("/users/me/photo")
        .attach("photo", PNG_BYTES, { filename: "avatar.png", contentType: "image/png" });

      expect(response.status).toBe(422);
    });
  });

  describe("DELETE /users/me/photo", () => {
    it("removes the caller's photo", async () => {
      deleteUserPhoto.mockResolvedValue({ success: true, value: { imageUrl: null } });

      const response = await request(app).delete("/users/me/photo");

      expect(response.status).toBe(200);
      expect(deleteUserPhoto).toHaveBeenCalledWith("user_test_caller");
    });

    it("maps DELETE_FAILED to 502", async () => {
      deleteUserPhoto.mockResolvedValue({ success: false, error: { type: "DELETE_FAILED" } });

      const response = await request(app).delete("/users/me/photo");

      expect(response.status).toBe(502);
    });
  });

  describe("GET /users/me/handle", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/users/me/handle");

      expect(response.status).toBe(401);
    });

    it("returns the caller's own handle metadata", async () => {
      getHandleMetadata.mockResolvedValue({ success: true, value: { handle: "jane", changesRemaining: 2 } });

      const response = await request(app).get("/users/me/handle");

      expect(response.status).toBe(200);
      expect(getHandleMetadata).toHaveBeenCalledWith("user_test_caller");
    });
  });

  describe("PATCH /users/me/handle", () => {
    it("sets the handle", async () => {
      setHandle.mockResolvedValue({ success: true, value: { handle: "new-handle" } });

      const response = await request(app).patch("/users/me/handle").send({ handle: "new-handle" });

      expect(response.status).toBe(200);
      expect(setHandle).toHaveBeenCalledWith("user_test_caller", "new-handle");
    });

    it("maps a TAKEN handle to a field refusal", async () => {
      setHandle.mockResolvedValue({ success: false, error: { type: "TAKEN" } });

      const response = await request(app).patch("/users/me/handle").send({ handle: "taken-handle" });

      expect(response.status).toBe(422);
    });

    it("maps RATE_LIMITED to 429", async () => {
      setHandle.mockResolvedValue({
        success: false,
        error: { type: "RATE_LIMITED", cooldownResetAt: new Date("2026-06-01T00:00:00.000Z") },
      });

      const response = await request(app).patch("/users/me/handle").send({ handle: "another-handle" });

      expect(response.status).toBe(429);
    });

    it("rejects an unknown body field with 422", async () => {
      const response = await request(app).patch("/users/me/handle").send({ handle: "new-handle", force: true });

      expect(response.status).toBe(422);
      expect(setHandle).not.toHaveBeenCalled();
    });
  });

  describe("GET /users/me/linked-accounts", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/users/me/linked-accounts");

      expect(response.status).toBe(401);
    });

    it("returns the caller's linked providers, derived from the session", async () => {
      getLinkedAccounts.mockResolvedValue([{ provider: "credential", email: "caller@example.test" }]);

      const response = await request(app).get("/users/me/linked-accounts");

      expect(response.status).toBe(200);
      expect(getLinkedAccounts).toHaveBeenCalledWith("user_test_caller", "caller@example.test");
    });
  });
});
