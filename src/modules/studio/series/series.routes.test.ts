import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the anime catalog CRUD surface (docs/STUDIO_BACKEND_STRUCTURE.md
 * §6) — previously untested at any tier. Not money/RBAC-related; the property worth
 * pinning here is ownership: per `studio-error-response.ts`'s own status policy, "no such
 * series" and "not yours" are indistinguishable 404s, so a stranger cannot probe which
 * series/season/episode ids exist.
 *
 * `POST /:seriesId/poster` (multipart) is covered separately in
 * `series.routes.poster-upload.test.ts`.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const createSeries = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMySeries = vi.fn<(...args: readonly unknown[]) => unknown>();
const getSeries = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateSeries = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteSeries = vi.fn<(...args: readonly unknown[]) => unknown>();
const createSeason = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateSeason = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteSeason = vi.fn<(...args: readonly unknown[]) => unknown>();
const createEpisode = vi.fn<(...args: readonly unknown[]) => unknown>();
const updateEpisode = vi.fn<(...args: readonly unknown[]) => unknown>();
const deleteEpisode = vi.fn<(...args: readonly unknown[]) => unknown>();
const replaceSeriesPoster = vi.fn<(...args: readonly unknown[]) => unknown>();
const removeSeriesPoster = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/studio/series/series.service.js", () => ({
  createSeries: (...args: readonly unknown[]) => createSeries(...args),
  listMySeries: (...args: readonly unknown[]) => listMySeries(...args),
  getSeries: (...args: readonly unknown[]) => getSeries(...args),
  updateSeries: (...args: readonly unknown[]) => updateSeries(...args),
  deleteSeries: (...args: readonly unknown[]) => deleteSeries(...args),
  createSeason: (...args: readonly unknown[]) => createSeason(...args),
  updateSeason: (...args: readonly unknown[]) => updateSeason(...args),
  deleteSeason: (...args: readonly unknown[]) => deleteSeason(...args),
  createEpisode: (...args: readonly unknown[]) => createEpisode(...args),
  updateEpisode: (...args: readonly unknown[]) => updateEpisode(...args),
  deleteEpisode: (...args: readonly unknown[]) => deleteEpisode(...args),
  replaceSeriesPoster: (...args: readonly unknown[]) => replaceSeriesPoster(...args),
  removeSeriesPoster: (...args: readonly unknown[]) => removeSeriesPoster(...args),
}));

const SERIES_NOT_FOUND = { success: false, error: { type: "SERIES_NOT_FOUND" } } as const;
const SEASON_NOT_FOUND = { success: false, error: { type: "SEASON_NOT_FOUND" } } as const;
const EPISODE_NOT_FOUND = { success: false, error: { type: "EPISODE_NOT_FOUND" } } as const;

describe("series routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /series", () => {
    const validBody = { title: "Solar Drifters", genreTags: ["sci-fi"], status: "ongoing" };

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).post("/series").send(validBody);

      expect(response.status).toBe(401);
      expect(createSeries).not.toHaveBeenCalled();
    });

    it("creates the series and answers 201", async () => {
      createSeries.mockResolvedValue({ success: true, value: { id: "series_1", title: "Solar Drifters" } });

      const response = await request(app).post("/series").send(validBody);

      expect(response.status).toBe(201);
      expect(createSeries).toHaveBeenCalledWith(
        "user_test_caller",
        expect.objectContaining({ title: "Solar Drifters", status: "ongoing" }),
      );
    });

    it("rejects a missing title with 422", async () => {
      const response = await request(app).post("/series").send({ status: "ongoing" });

      expect(response.status).toBe(422);
      expect(createSeries).not.toHaveBeenCalled();
    });

    it("rejects an unknown body field with 422", async () => {
      const response = await request(app)
        .post("/series")
        .send({ ...validBody, ownerId: "someone-else" });

      expect(response.status).toBe(422);
      expect(createSeries).not.toHaveBeenCalled();
    });
  });

  describe("GET /series/mine", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/series/mine");

      expect(response.status).toBe(401);
      expect(listMySeries).not.toHaveBeenCalled();
    });

    it("lists the caller's own series with the default page and limit", async () => {
      listMySeries.mockResolvedValue({ rows: [{ id: "series_1" }], total: 1 });

      const response = await request(app).get("/series/mine");

      expect(response.status).toBe(200);
      expect(listMySeries).toHaveBeenCalledWith("user_test_caller", 1, 20);
      expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it("passes an explicit page and limit through", async () => {
      listMySeries.mockResolvedValue({ rows: [], total: 0 });

      const response = await request(app).get("/series/mine?page=2&limit=5");

      expect(response.status).toBe(200);
      expect(listMySeries).toHaveBeenCalledWith("user_test_caller", 2, 5);
    });

    it("rejects an unknown query key with 422", async () => {
      const response = await request(app).get("/series/mine?ownerId=someone-else");

      expect(response.status).toBe(422);
      expect(listMySeries).not.toHaveBeenCalled();
    });
  });

  describe("GET /series/:seriesId", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get("/series/series_1");

      expect(response.status).toBe(401);
      expect(getSeries).not.toHaveBeenCalled();
    });

    it("loads the series tree", async () => {
      getSeries.mockResolvedValue({ success: true, value: { id: "series_1", seasons: [] } });

      const response = await request(app).get("/series/series_1");

      expect(response.status).toBe(200);
      expect(getSeries).toHaveBeenCalledWith("user_test_caller", "series_1");
      expect(response.body.data).toEqual({ id: "series_1", seasons: [] });
    });

    it("answers 404 for a series that is not the caller's, indistinguishable from a nonexistent one", async () => {
      getSeries.mockResolvedValue(SERIES_NOT_FOUND);

      const response = await request(app).get("/series/series_not_mine");

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /series/:seriesId", () => {
    it("updates the series", async () => {
      updateSeries.mockResolvedValue({ success: true, value: { id: "series_1", title: "New Title" } });

      const response = await request(app).patch("/series/series_1").send({ title: "New Title" });

      expect(response.status).toBe(200);
      expect(updateSeries).toHaveBeenCalledWith("user_test_caller", "series_1", { title: "New Title" });
    });

    it("answers 404 for a foreign series id", async () => {
      updateSeries.mockResolvedValue(SERIES_NOT_FOUND);

      const response = await request(app).patch("/series/series_not_mine").send({ title: "New Title" });

      expect(response.status).toBe(404);
    });

    it("rejects an invalid status value with 422", async () => {
      const response = await request(app).patch("/series/series_1").send({ status: "cancelled" });

      expect(response.status).toBe(422);
      expect(updateSeries).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /series/:seriesId", () => {
    it("deletes the series", async () => {
      deleteSeries.mockResolvedValue({ success: true, value: { id: "series_1" } });

      const response = await request(app).delete("/series/series_1");

      expect(response.status).toBe(200);
      expect(deleteSeries).toHaveBeenCalledWith("user_test_caller", "series_1");
    });

    it("answers 404 for a foreign series id", async () => {
      deleteSeries.mockResolvedValue(SERIES_NOT_FOUND);

      const response = await request(app).delete("/series/series_not_mine");

      expect(response.status).toBe(404);
    });
  });

  describe("POST /series/:seriesId/seasons", () => {
    const path = "/series/series_1/seasons";

    it("creates the season", async () => {
      createSeason.mockResolvedValue({ success: true, value: { id: "season_1", seasonLabel: "Season 1" } });

      const response = await request(app).post(path).send({ seasonLabel: "Season 1" });

      expect(response.status).toBe(201);
      expect(createSeason).toHaveBeenCalledWith(
        "user_test_caller",
        "series_1",
        expect.objectContaining({ seasonLabel: "Season 1" }),
      );
    });

    it("answers 404 for a foreign series id", async () => {
      createSeason.mockResolvedValue(SERIES_NOT_FOUND);

      const response = await request(app).post("/series/series_not_mine/seasons").send({ seasonLabel: "Season 1" });

      expect(response.status).toBe(404);
    });

    it("maps SEASON_LABEL_TAKEN to 409", async () => {
      createSeason.mockResolvedValue({
        success: false,
        error: { type: "SEASON_LABEL_TAKEN", seasonLabel: "Season 1" },
      });

      const response = await request(app).post(path).send({ seasonLabel: "Season 1" });

      expect(response.status).toBe(409);
    });

    it("rejects a missing seasonLabel with 422", async () => {
      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(createSeason).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /series/:seriesId/seasons/:seasonId", () => {
    const path = "/series/series_1/seasons/season_1";

    it("updates the season", async () => {
      updateSeason.mockResolvedValue({ success: true, value: { id: "season_1", seasonLabel: "Season One" } });

      const response = await request(app).patch(path).send({ seasonLabel: "Season One" });

      expect(response.status).toBe(200);
      expect(updateSeason).toHaveBeenCalledWith("user_test_caller", "series_1", "season_1", {
        seasonLabel: "Season One",
      });
    });

    it("answers 404 for a season belonging to another series", async () => {
      updateSeason.mockResolvedValue(SEASON_NOT_FOUND);

      const response = await request(app).patch(path).send({ seasonLabel: "Season One" });

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /series/:seriesId/seasons/:seasonId", () => {
    const path = "/series/series_1/seasons/season_1";

    it("deletes the season", async () => {
      deleteSeason.mockResolvedValue({ success: true, value: { id: "season_1" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(deleteSeason).toHaveBeenCalledWith("user_test_caller", "series_1", "season_1");
    });

    it("answers 404 for a season belonging to another series", async () => {
      deleteSeason.mockResolvedValue(SEASON_NOT_FOUND);

      const response = await request(app).delete(path);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /series/:seriesId/seasons/:seasonId/episodes", () => {
    const path = "/series/series_1/seasons/season_1/episodes";
    const validBody = { episodeNumber: 1, episodeTitle: "Pilot" };

    it("creates the episode", async () => {
      createEpisode.mockResolvedValue({ success: true, value: { id: "episode_1", episodeNumber: 1 } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(createEpisode).toHaveBeenCalledWith(
        "user_test_caller",
        "series_1",
        "season_1",
        expect.objectContaining({ episodeNumber: 1, episodeTitle: "Pilot", isPremium: false }),
      );
    });

    it("answers 404 for a season belonging to another series", async () => {
      createEpisode.mockResolvedValue(SEASON_NOT_FOUND);

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(404);
    });

    it("maps EPISODE_NUMBER_TAKEN to 409", async () => {
      createEpisode.mockResolvedValue({
        success: false,
        error: { type: "EPISODE_NUMBER_TAKEN", episodeNumber: 1 },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(409);
    });

    it("rejects a negative episode number with 422", async () => {
      const response = await request(app).post(path).send({ episodeNumber: -1, episodeTitle: "Pilot" });

      expect(response.status).toBe(422);
      expect(createEpisode).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /series/:seriesId/seasons/:seasonId/episodes/:episodeId", () => {
    const path = "/series/series_1/seasons/season_1/episodes/episode_1";

    it("updates the episode", async () => {
      updateEpisode.mockResolvedValue({ success: true, value: { id: "episode_1", episodeTitle: "Pilot (Extended)" } });

      const response = await request(app).patch(path).send({ episodeTitle: "Pilot (Extended)" });

      expect(response.status).toBe(200);
      expect(updateEpisode).toHaveBeenCalledWith("user_test_caller", "series_1", "season_1", "episode_1", {
        episodeTitle: "Pilot (Extended)",
      });
    });

    it("answers 404 for an episode belonging to another season", async () => {
      updateEpisode.mockResolvedValue(EPISODE_NOT_FOUND);

      const response = await request(app).patch(path).send({ episodeTitle: "Pilot (Extended)" });

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /series/:seriesId/seasons/:seasonId/episodes/:episodeId", () => {
    const path = "/series/series_1/seasons/season_1/episodes/episode_1";

    it("deletes the episode", async () => {
      deleteEpisode.mockResolvedValue({ success: true, value: { id: "episode_1" } });

      const response = await request(app).delete(path);

      expect(response.status).toBe(200);
      expect(deleteEpisode).toHaveBeenCalledWith("user_test_caller", "series_1", "season_1", "episode_1");
    });

    it("answers 404 for an episode belonging to another season", async () => {
      deleteEpisode.mockResolvedValue(EPISODE_NOT_FOUND);

      const response = await request(app).delete(path);

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /series/:seriesId/poster", () => {
    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).delete("/series/series_1/poster");

      expect(response.status).toBe(401);
      expect(removeSeriesPoster).not.toHaveBeenCalled();
    });

    it("removes the poster", async () => {
      removeSeriesPoster.mockResolvedValue({ success: true, value: { id: "series_1", posterUrl: null } });

      const response = await request(app).delete("/series/series_1/poster");

      expect(response.status).toBe(200);
      expect(removeSeriesPoster).toHaveBeenCalledWith("user_test_caller", "series_1");
    });

    it("answers 404 for a foreign series id", async () => {
      removeSeriesPoster.mockResolvedValue(SERIES_NOT_FOUND);

      const response = await request(app).delete("/series/series_not_mine/poster");

      expect(response.status).toBe(404);
    });
  });
});
