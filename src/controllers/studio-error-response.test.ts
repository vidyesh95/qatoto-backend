import { describe, expect, it, vi } from "vitest";

// The mapper imports the service modules only for their TYPES, but the module graph is
// still evaluated at runtime — and those services pull in the db pool and env config.
vi.mock("#src/db/index.js", () => ({ db: {} }));
vi.mock("#src/config/index.js", () => ({ config: { YOUTUBE_OEMBED_TIMEOUT_MS: 3_000 } }));

const { mapStudioErrorToResponse } = await import("#src/controllers/studio-error-response.js");
type StudioDomainError = Parameters<typeof mapStudioErrorToResponse>[0];

/**
 * The mapper is the one place a domain error becomes an HTTP status, so these cases are
 * the contract. Two of them are invariants rather than examples — see the bottom.
 */
const CASES: ReadonlyArray<{ readonly error: StudioDomainError; readonly statusCode: number }> = [
  // 404 — every ownership and lookup failure.
  { error: { type: "VIDEO_NOT_FOUND", videoId: "v1" }, statusCode: 404 },
  { error: { type: "PLAYLIST_NOT_FOUND", playlistId: "p1" }, statusCode: 404 },
  { error: { type: "SERIES_NOT_FOUND", seriesId: "s1" }, statusCode: 404 },
  { error: { type: "SEASON_NOT_FOUND", seasonId: "sn1" }, statusCode: 404 },
  { error: { type: "EPISODE_NOT_FOUND", episodeId: "e1" }, statusCode: 404 },

  // 403 — the only one.
  { error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" }, statusCode: 403 },

  // 422 — the creator's link, or a rule a schema cannot express.
  { error: { type: "INVALID_YOUTUBE_URL" }, statusCode: 422 },
  { error: { type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId: "dQw4w9WgXcQ" }, statusCode: 422 },
  { error: { type: "GATING_UNSUPPORTED_FOR_SOURCE", videoSource: "youtube" }, statusCode: 422 },
  { error: { type: "INCOMPLETE_FOR_PUBLISH", missing: ["isMadeForKids"] }, statusCode: 422 },
  { error: { type: "NOT_READY", uploadStatus: "failed" }, statusCode: 422 },
  { error: { type: "INVALID_CHAPTERS", reason: "TOO_FEW", index: null }, statusCode: 422 },
  { error: { type: "INVALID_CHAPTERS", reason: "NOT_ASCENDING", index: 2 }, statusCode: 422 },
  { error: { type: "PRODUCT_NOT_OWNED", productIds: ["a", "b"] }, statusCode: 422 },
  { error: { type: "PLAYLIST_NOT_OWNED", playlistIds: ["a"] }, statusCode: 422 },
  { error: { type: "VIDEO_NOT_OWNED", videoIds: ["a"] }, statusCode: 422 },
  { error: { type: "ANIME_SERIES_NOT_FOUND", seriesId: "s1" }, statusCode: 422 },
  { error: { type: "ANIME_SEASON_NOT_FOUND", seasonId: "sn1" }, statusCode: 422 },
  { error: { type: "NOT_AN_ANIME_EPISODE" }, statusCode: 422 },
  { error: { type: "NOT_AN_IMAGE" }, statusCode: 422 },
  { error: { type: "UNSUPPORTED_FORMAT", detected: { kind: "other", format: "gif" } }, statusCode: 422 },
  { error: { type: "UNSUPPORTED_FORMAT", detected: { kind: "heic" } }, statusCode: 422 },
  {
    error: { type: "UNSUPPORTED_FORMAT", detected: { kind: "animated", format: "webp" } },
    statusCode: 422,
  },
  { error: { type: "DIMENSIONS_TOO_SMALL", width: 10, height: 10 }, statusCode: 422 },
  { error: { type: "DIMENSIONS_TOO_LARGE", width: 99_999, height: 99_999 }, statusCode: 422 },

  // 409 — lifecycle conflicts.
  { error: { type: "NO_TOKEN_REQUIRED" }, statusCode: 409 },
  { error: { type: "REVIEW_NOT_PENDING", reviewStatus: "approved" }, statusCode: 409 },
  { error: { type: "EPISODE_NUMBER_TAKEN", episodeNumber: 3 }, statusCode: 409 },
  { error: { type: "SEASON_LABEL_TAKEN", seasonLabel: "Season 1" }, statusCode: 409 },

  // 502 / 503 — the other side failed, or is not configured here.
  { error: { type: "YOUTUBE_VERIFY_FAILED" }, statusCode: 502 },
  { error: { type: "UPLOAD_FAILED", cause: "boom" }, statusCode: 502 },
  { error: { type: "DELETE_FAILED", cause: "boom" }, statusCode: 502 },
  { error: { type: "NOT_CONFIGURED" }, statusCode: 503 },
];

describe("mapStudioErrorToResponse", () => {
  it.each(CASES)("maps $error.type to $statusCode", ({ error, statusCode }) => {
    const mapped = mapStudioErrorToResponse(error);
    expect(mapped.statusCode).toBe(statusCode);
    expect(mapped.message.length).toBeGreaterThan(0);
  });

  it("throws on an unhandled variant rather than inventing a status", () => {
    // The `never` default. In production this is unreachable — TypeScript fails the build
    // first — but the throw is what makes that guarantee load-bearing at runtime too.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const unknownError = { type: "SOMETHING_NEW" } as unknown as StudioDomainError;
    expect(() => mapStudioErrorToResponse(unknownError)).toThrow(/Unhandled studio error/);
  });

  describe("invariants", () => {
    it("returns 403 for the capability refusal and NOTHING else", () => {
      // 403 anywhere else would make a route an id oracle: a stranger could tell a real
      // id from a garbage one by the status alone.
      const typesMappedTo403 = CASES.filter(({ error }) => mapStudioErrorToResponse(error).statusCode === 403).map(
        ({ error }) => error.type,
      );

      expect(typesMappedTo403).toEqual(["PLATFORM_CAPABILITY_REQUIRED"]);
    });

    it("never leaks an id into a 404 message", () => {
      // "Video 7f3a… not found" would confirm the id exists in someone else's account.
      const notFoundCases: readonly StudioDomainError[] = [
        { type: "VIDEO_NOT_FOUND", videoId: "SECRET_ID" },
        { type: "PLAYLIST_NOT_FOUND", playlistId: "SECRET_ID" },
        { type: "SERIES_NOT_FOUND", seriesId: "SECRET_ID" },
        { type: "SEASON_NOT_FOUND", seasonId: "SECRET_ID" },
        { type: "EPISODE_NOT_FOUND", episodeId: "SECRET_ID" },
      ];
      for (const error of notFoundCases) {
        const mapped = mapStudioErrorToResponse(error);
        expect(mapped.statusCode).toBe(404);
        expect(JSON.stringify(mapped)).not.toContain("SECRET_ID");
      }
    });

    it("keeps the two YouTube failures on different statuses", () => {
      // Collapsing these would tell a creator to fix a link that was fine.
      expect(mapStudioErrorToResponse({ type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId: "x" }).statusCode).toBe(422);
      expect(mapStudioErrorToResponse({ type: "YOUTUBE_VERIFY_FAILED" }).statusCode).toBe(502);
    });

    it("lists EVERY offending id, not just the first", () => {
      const mapped = mapStudioErrorToResponse({
        type: "PRODUCT_NOT_OWNED",
        productIds: ["a", "b", "c"],
      });
      expect(mapped.errors?.productIds).toEqual(["a", "b", "c"]);
    });
  });
});
