import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the Creator Studio video CRUD surface
 * (`docs/STUDIO_BACKEND_STRUCTURE.md` §6) — previously untested at any tier above
 * `videos.service.ts`'s own unit suite. `videos.service.js` is mocked wholesale, so this
 * suite is about routing/auth/validation wiring, not the service's own business rules.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` (on `respondToCollaboration` only) hits a real `db` query
 * builder; it has its own dedicated suite. Stubbed to a pass-through here, matching the
 * precedent in `import-intelligence.routes.test.ts` — the route still declares it, so a
 * dropped guard is caught elsewhere.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const createVideo = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyVideos = vi.fn<(...args: readonly unknown[]) => unknown>();
const getVideo = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateVideo = vi.fn<(...args: readonly unknown[]) => unknown>();
const replaceVideoThumbnail = vi.fn<(...args: readonly unknown[]) => unknown>();
const replaceChapters = vi.fn<(...args: readonly unknown[]) => unknown>();
const replaceAttachedProducts = vi.fn<(...args: readonly unknown[]) => unknown>();
const setVideoPlaylists = vi.fn<(...args: readonly unknown[]) => unknown>();
const publishVideo = vi.fn<(...args: readonly unknown[]) => unknown>();
const unpublishVideo = vi.fn<(...args: readonly unknown[]) => unknown>();
const issuePlaybackToken = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteVideo = vi.fn<(...args: readonly unknown[]) => unknown>();
const attachVideoDocument = vi.fn<(...args: readonly unknown[]) => unknown>();
const detachVideoDocument = vi.fn<(...args: readonly unknown[]) => unknown>();
const resolveVideoDocumentDownload = vi.fn<(...args: readonly unknown[]) => unknown>();
const respondToCollaborationInvite = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/studio/videos/videos.service.js", () => ({
  createVideo: (...args: readonly unknown[]) => createVideo(...args),
  listMyVideos: (...args: readonly unknown[]) => listMyVideos(...args),
  getVideo: (...args: readonly unknown[]) => getVideo(...args),
  updateVideo: (...args: readonly unknown[]) => updateVideo(...args),
  replaceVideoThumbnail: (...args: readonly unknown[]) => replaceVideoThumbnail(...args),
  replaceChapters: (...args: readonly unknown[]) => replaceChapters(...args),
  replaceAttachedProducts: (...args: readonly unknown[]) => replaceAttachedProducts(...args),
  setVideoPlaylists: (...args: readonly unknown[]) => setVideoPlaylists(...args),
  publishVideo: (...args: readonly unknown[]) => publishVideo(...args),
  unpublishVideo: (...args: readonly unknown[]) => unpublishVideo(...args),
  issuePlaybackToken: (...args: readonly unknown[]) => issuePlaybackToken(...args),
  deleteVideo: (...args: readonly unknown[]) => deleteVideo(...args),
  attachVideoDocument: (...args: readonly unknown[]) => attachVideoDocument(...args),
  detachVideoDocument: (...args: readonly unknown[]) => detachVideoDocument(...args),
  resolveVideoDocumentDownload: (...args: readonly unknown[]) => resolveVideoDocumentDownload(...args),
  respondToCollaborationInvite: (...args: readonly unknown[]) => respondToCollaborationInvite(...args),
  // Read routes mounted elsewhere (`/users/me/collaborations` etc.) reuse this same
  // service module; stub them too so importing it doesn't throw on an undefined export.
  listMyCollaborationInvites: vi.fn(),
  listMyVideoCollaborators: vi.fn(),
  listMyVideoModerationNotices: vi.fn(),
}));

const VALID_CREATE_BODY = {
  youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "My Demo Video",
};

/** A real PNG signature, matching the idiom in `commerce-documents.routes.test.ts`. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/** Not a real PDF, but has a `.pdf`-ish content type so it clears multer's mimetype gate. */
const FAKE_PDF_BYTES = Buffer.from("%PDF-1.4 fake bytes for a mocked-service upload test", "utf8");

describe("videos routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /videos", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/videos").send(VALID_CREATE_BODY);

      expect(response.status).toBe(401);
      expect(createVideo).not.toHaveBeenCalled();
    });

    it("creates the video and answers 201", async () => {
      createVideo.mockResolvedValue({ success: true, value: { id: "video_1", title: "My Demo Video" } });

      const response = await request(app).post("/videos").send(VALID_CREATE_BODY);

      expect(response.status).toBe(201);
      expect(createVideo).toHaveBeenCalledWith("user_test_caller", expect.objectContaining({ title: "My Demo Video" }));
    });

    it("rejects a non-YouTube link with 422", async () => {
      const response = await request(app)
        .post("/videos")
        .send({ ...VALID_CREATE_BODY, youtubeUrl: "https://example.com/not-youtube" });

      expect(response.status).toBe(422);
      expect(createVideo).not.toHaveBeenCalled();
    });

    it("maps YOUTUBE_VIDEO_UNAVAILABLE to 422", async () => {
      createVideo.mockResolvedValue({ success: false, error: { type: "YOUTUBE_VIDEO_UNAVAILABLE" } });

      const response = await request(app).post("/videos").send(VALID_CREATE_BODY);

      expect(response.status).toBe(422);
    });

    it("maps YOUTUBE_VERIFY_FAILED to 502", async () => {
      createVideo.mockResolvedValue({ success: false, error: { type: "YOUTUBE_VERIFY_FAILED" } });

      const response = await request(app).post("/videos").send(VALID_CREATE_BODY);

      expect(response.status).toBe(502);
    });
  });

  describe("GET /videos/mine", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/videos/mine");

      expect(response.status).toBe(401);
      expect(listMyVideos).not.toHaveBeenCalled();
    });

    it("lists the caller's own videos with default pagination", async () => {
      listMyVideos.mockResolvedValue({ rows: [{ id: "video_1" }], total: 1 });

      const response = await request(app).get("/videos/mine");

      expect(response.status).toBe(200);
      expect(listMyVideos).toHaveBeenCalledWith("user_test_caller", { page: 1, limit: 20 });
      expect(response.body.data).toEqual([{ id: "video_1" }]);
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/videos/mine?ownerId=other");

      expect(response.status).toBe(422);
      expect(listMyVideos).not.toHaveBeenCalled();
    });
  });

  describe("GET /videos/:videoId", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/videos/video_1");

      expect(response.status).toBe(401);
      expect(getVideo).not.toHaveBeenCalled();
    });

    it("loads the video, owner only", async () => {
      getVideo.mockResolvedValue({ success: true, value: { id: "video_1" } });

      const response = await request(app).get("/videos/video_1");

      expect(response.status).toBe(200);
      expect(getVideo).toHaveBeenCalledWith("user_test_caller", "video_1");
    });

    it("answers 404, never 403, for someone else's video", async () => {
      getVideo.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).get("/videos/video_owned_by_another_creator");

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /videos/:videoId", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).patch("/videos/video_1").send({ title: "New title" });

      expect(response.status).toBe(401);
      expect(updateVideo).not.toHaveBeenCalled();
    });

    it("updates and passes the parsed patch through", async () => {
      updateVideo.mockResolvedValue({ success: true, value: { id: "video_1", title: "New title" } });

      const response = await request(app).patch("/videos/video_1").send({ title: "New title" });

      expect(response.status).toBe(200);
      expect(updateVideo).toHaveBeenCalledWith("user_test_caller", "video_1", { title: "New title" });
    });

    it("rejects an unknown field with 422", async () => {
      const response = await request(app).patch("/videos/video_1").send({ ownerId: "someone_else" });

      expect(response.status).toBe(422);
      expect(updateVideo).not.toHaveBeenCalled();
    });

    it("maps VIDEO_NOT_FOUND to 404", async () => {
      updateVideo.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).patch("/videos/video_1").send({ title: "New title" });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /videos/:videoId/thumbnail", () => {
    const path = "/videos/video_1/thumbnail";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .post(path)
        .attach("image", PNG_BYTES, { filename: "thumb.png", contentType: "image/png" });

      expect(response.status).toBe(401);
      expect(replaceVideoThumbnail).not.toHaveBeenCalled();
    });

    it("replaces the thumbnail with a valid image", async () => {
      replaceVideoThumbnail.mockResolvedValue({
        success: true,
        value: { id: "video_1", thumbnailUrl: "https://cdn.example/thumb.png" },
      });

      const response = await request(app)
        .post(path)
        .attach("image", PNG_BYTES, { filename: "thumb.png", contentType: "image/png" });

      expect(response.status).toBe(200);
      expect(replaceVideoThumbnail).toHaveBeenCalledWith("user_test_caller", "video_1", expect.any(Buffer));
    });

    it("rejects a missing file with 422", async () => {
      const response = await request(app).post(path);

      expect(response.status).toBe(422);
      expect(replaceVideoThumbnail).not.toHaveBeenCalled();
    });

    it("rejects a non-image file with 422", async () => {
      const response = await request(app)
        .post(path)
        .attach("image", Buffer.from("not an image"), { filename: "note.txt", contentType: "text/plain" });

      expect(response.status).toBe(422);
      expect(replaceVideoThumbnail).not.toHaveBeenCalled();
    });
  });

  describe("PUT /videos/:videoId/chapters", () => {
    const path = "/videos/video_1/chapters";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(path).send({ chapters: [] });

      expect(response.status).toBe(401);
      expect(replaceChapters).not.toHaveBeenCalled();
    });

    it("replaces the chapter set", async () => {
      const chapters = [
        { startSeconds: 0, title: "Intro" },
        { startSeconds: 30, title: "Demo" },
      ];
      replaceChapters.mockResolvedValue({ success: true, value: { id: "video_1", chapters } });

      const response = await request(app).put(path).send({ chapters });

      expect(response.status).toBe(200);
      expect(replaceChapters).toHaveBeenCalledWith("user_test_caller", "video_1", chapters);
    });

    it("maps INVALID_CHAPTERS to 422", async () => {
      replaceChapters.mockResolvedValue({
        success: false,
        error: { type: "INVALID_CHAPTERS", reason: "FIRST_NOT_ZERO", index: 0 },
      });

      const response = await request(app)
        .put(path)
        .send({ chapters: [{ startSeconds: 5, title: "Intro" }] });

      expect(response.status).toBe(422);
    });
  });

  describe("PUT /videos/:videoId/products", () => {
    const path = "/videos/video_1/products";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(path).send({ productIds: [] });

      expect(response.status).toBe(401);
      expect(replaceAttachedProducts).not.toHaveBeenCalled();
    });

    it("replaces the attached product set", async () => {
      replaceAttachedProducts.mockResolvedValue({ success: true, value: { id: "video_1", productIds: ["prd_1"] } });

      const response = await request(app)
        .put(path)
        .send({ productIds: ["prd_1"] });

      expect(response.status).toBe(200);
      expect(replaceAttachedProducts).toHaveBeenCalledWith("user_test_caller", "video_1", ["prd_1"]);
    });

    it("maps PRODUCT_NOT_OWNED to 422 with every offending id", async () => {
      replaceAttachedProducts.mockResolvedValue({
        success: false,
        error: { type: "PRODUCT_NOT_OWNED", productIds: ["prd_not_mine"] },
      });

      const response = await request(app)
        .put(path)
        .send({ productIds: ["prd_not_mine"] });

      expect(response.status).toBe(422);
      expect(response.body.errors.productIds).toEqual(["prd_not_mine"]);
    });
  });

  describe("PUT /videos/:videoId/playlists", () => {
    const path = "/videos/video_1/playlists";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).put(path).send({ playlistIds: [] });

      expect(response.status).toBe(401);
      expect(setVideoPlaylists).not.toHaveBeenCalled();
    });

    it("sets the video's playlists", async () => {
      setVideoPlaylists.mockResolvedValue({ success: true, value: { id: "video_1", playlistIds: ["pl_1"] } });

      const response = await request(app)
        .put(path)
        .send({ playlistIds: ["pl_1"] });

      expect(response.status).toBe(200);
      expect(setVideoPlaylists).toHaveBeenCalledWith("user_test_caller", "video_1", ["pl_1"]);
    });

    it("maps PLAYLIST_NOT_OWNED to 422", async () => {
      setVideoPlaylists.mockResolvedValue({
        success: false,
        error: { type: "PLAYLIST_NOT_OWNED", playlistIds: ["pl_not_mine"] },
      });

      const response = await request(app)
        .put(path)
        .send({ playlistIds: ["pl_not_mine"] });

      expect(response.status).toBe(422);
    });
  });

  describe("POST /videos/:videoId/publish", () => {
    const path = "/videos/video_1/publish";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path);

      expect(response.status).toBe(401);
      expect(publishVideo).not.toHaveBeenCalled();
    });

    it("publishes a normal video", async () => {
      publishVideo.mockResolvedValue({ success: true, value: { id: "video_1", reviewStatus: "not_required" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(publishVideo).toHaveBeenCalledWith("user_test_caller", "video_1");
      expect(response.body.message).toBe("Video published successfully");
    });

    it("says 'submitted for review' for an anime episode, never 'published'", async () => {
      publishVideo.mockResolvedValue({ success: true, value: { id: "video_1", reviewStatus: "pending" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Episode submitted for review");
    });

    it("maps INCOMPLETE_FOR_PUBLISH to 422", async () => {
      publishVideo.mockResolvedValue({
        success: false,
        error: { type: "INCOMPLETE_FOR_PUBLISH", missing: ["thumbnailUrl"] },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(422);
    });

    it("maps NOT_READY to 422", async () => {
      publishVideo.mockResolvedValue({
        success: false,
        error: { type: "NOT_READY", uploadStatus: "processing" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(422);
    });
  });

  describe("POST /videos/:videoId/unpublish", () => {
    const path = "/videos/video_1/unpublish";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path);

      expect(response.status).toBe(401);
      expect(unpublishVideo).not.toHaveBeenCalled();
    });

    it("unpublishes back to draft", async () => {
      unpublishVideo.mockResolvedValue({ success: true, value: { id: "video_1", publishStatus: "draft" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(unpublishVideo).toHaveBeenCalledWith("user_test_caller", "video_1");
    });

    it("maps VIDEO_NOT_FOUND to 404", async () => {
      unpublishVideo.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(404);
    });
  });

  describe("GET /videos/:videoId/playback-token — deferred, always refuses", () => {
    const path = "/videos/video_1/playback-token";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(issuePlaybackToken).not.toHaveBeenCalled();
    });

    it("answers 404 for a stranger to the video, before the deferred check", async () => {
      issuePlaybackToken.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });

    it("answers 409 NO_TOKEN_REQUIRED for the owner of a YouTube-hosted video", async () => {
      issuePlaybackToken.mockResolvedValue({ success: false, error: { type: "NO_TOKEN_REQUIRED" } });

      const response = await request(app).get(path);

      expect(response.status).toBe(409);
      expect(issuePlaybackToken).toHaveBeenCalledWith("user_test_caller", "video_1");
    });
  });

  describe("DELETE /videos/:videoId", () => {
    const path = "/videos/video_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).delete(path);

      expect(response.status).toBe(401);
      expect(deleteVideo).not.toHaveBeenCalled();
    });

    it("deletes the owner's video", async () => {
      deleteVideo.mockResolvedValue({ success: true, value: { id: "video_1" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(deleteVideo).toHaveBeenCalledWith("user_test_caller", "video_1");
    });

    it("answers 404 for a stranger's video, never 403", async () => {
      deleteVideo.mockResolvedValue({ success: false, error: { type: "VIDEO_NOT_FOUND" } });

      const response = await request(app).delete("/videos/video_owned_by_another_creator");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /videos/:videoId/documents", () => {
    const path = "/videos/video_1/documents";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .post(path)
        .attach("document", FAKE_PDF_BYTES, { filename: "deck.pdf", contentType: "application/pdf" });

      expect(response.status).toBe(401);
      expect(attachVideoDocument).not.toHaveBeenCalled();
    });

    it("attaches a PDF and answers 201", async () => {
      attachVideoDocument.mockResolvedValue({
        success: true,
        value: { id: "doc_1", fileName: "deck.pdf" },
      });

      const response = await request(app)
        .post(path)
        .attach("document", FAKE_PDF_BYTES, { filename: "deck.pdf", contentType: "application/pdf" });

      expect(response.status).toBe(201);
      expect(attachVideoDocument).toHaveBeenCalledWith("user_test_caller", "video_1", {
        fileName: "deck.pdf",
        bytes: expect.any(Buffer),
      });
    });

    it("rejects a missing file with 422", async () => {
      const response = await request(app).post(path);

      expect(response.status).toBe(422);
      expect(attachVideoDocument).not.toHaveBeenCalled();
    });

    it("rejects a non-PDF content type with 422", async () => {
      const response = await request(app)
        .post(path)
        .attach("document", Buffer.from("plain text"), { filename: "notes.txt", contentType: "text/plain" });

      expect(response.status).toBe(422);
      expect(attachVideoDocument).not.toHaveBeenCalled();
    });

    it("maps TOO_MANY_VIDEO_DOCUMENTS to 422", async () => {
      attachVideoDocument.mockResolvedValue({
        success: false,
        error: { type: "TOO_MANY_VIDEO_DOCUMENTS", limit: 10 },
      });

      const response = await request(app)
        .post(path)
        .attach("document", FAKE_PDF_BYTES, { filename: "deck.pdf", contentType: "application/pdf" });

      expect(response.status).toBe(422);
    });
  });

  describe("DELETE /videos/:videoId/documents/:documentId", () => {
    const path = "/videos/video_1/documents/doc_1";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).delete(path);

      expect(response.status).toBe(401);
      expect(detachVideoDocument).not.toHaveBeenCalled();
    });

    it("detaches the document", async () => {
      detachVideoDocument.mockResolvedValue({ success: true, value: { id: "doc_1" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(detachVideoDocument).toHaveBeenCalledWith("user_test_caller", "video_1", "doc_1");
    });

    it("maps VIDEO_DOCUMENT_NOT_FOUND to 404 — indistinguishable from 'not yours'", async () => {
      detachVideoDocument.mockResolvedValue({
        success: false,
        error: { type: "VIDEO_DOCUMENT_NOT_FOUND" },
      });

      const response = await request(app).delete(path);

      expect(response.status).toBe(404);
    });
  });

  /**
   * The ONE public route on this router: `attachOptionalUser`, not `requireAuth`, because a
   * document attached to a public video must download for a signed-out reader. No 401 case
   * belongs here by design — both a signed-in and a signed-out caller reach the handler, and
   * the gate is the video's own publicness inside the service.
   */
  describe("GET /videos/:videoId/documents/:documentId/file", () => {
    const path = "/videos/video_1/documents/doc_1/file";

    it("redirects to a presigned URL for a signed-in caller", async () => {
      resolveVideoDocumentDownload.mockResolvedValue({
        success: true,
        value: { downloadUrl: "https://storage.example/signed?sig=abc" },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(302);
      expect(resolveVideoDocumentDownload).toHaveBeenCalledWith("video_1", "doc_1", "user_test_caller");
      expect(response.headers.location).toBe("https://storage.example/signed?sig=abc");
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("redirects for a signed-out caller too, when the video is public", async () => {
      signOut();
      resolveVideoDocumentDownload.mockResolvedValue({
        success: true,
        value: { downloadUrl: "https://storage.example/signed?sig=def" },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(302);
      expect(resolveVideoDocumentDownload).toHaveBeenCalledWith("video_1", "doc_1", null);
    });

    it("maps VIDEO_DOCUMENT_NOT_FOUND to 404 for a private video's document, signed out", async () => {
      signOut();
      resolveVideoDocumentDownload.mockResolvedValue({
        success: false,
        error: { type: "VIDEO_DOCUMENT_NOT_FOUND" },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /videos/:videoId/collaborators/respond", () => {
    const path = "/videos/video_1/collaborators/respond";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post(path).send({ response: "accepted" });

      expect(response.status).toBe(401);
      expect(respondToCollaborationInvite).not.toHaveBeenCalled();
    });

    it("rejects an unknown response value with 422", async () => {
      const response = await request(app).post(path).send({ response: "maybe" });

      expect(response.status).toBe(422);
      expect(respondToCollaborationInvite).not.toHaveBeenCalled();
    });

    it("accepts, and the response echoes the resulting status", async () => {
      respondToCollaborationInvite.mockResolvedValue({ success: true, value: { status: "accepted" } });

      const response = await request(app).post(path).send({ response: "accepted" });

      expect(response.status).toBe(200);
      expect(respondToCollaborationInvite).toHaveBeenCalledWith("user_test_caller", "video_1", "accepted");
      expect(response.body.message).toBe("Collaboration accepted.");
    });

    /**
     * The invitee is a stranger to the video by definition — the service's own predicate
     * (invited email = caller) IS the authorization, so an uninvited caller gets the same
     * 404 an absent video gives, never a distinguishing 403.
     */
    it("answers 404 for a caller who was never invited, same as an absent video", async () => {
      respondToCollaborationInvite.mockResolvedValue({
        success: false,
        error: { type: "VIDEO_NOT_FOUND" },
      });

      const response = await request(app).post(path).send({ response: "declined" });

      expect(response.status).toBe(404);
    });
  });
});
