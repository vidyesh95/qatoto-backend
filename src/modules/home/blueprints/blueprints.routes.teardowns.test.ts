import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the five public teardown reads.
 *
 * WHAT THIS FILE OWNS, and the service suite does not: the query parse, the status codes and the
 * fact that all five answer a SIGNED-OUT visitor. The service suite owns the gates and the
 * withholding; here the service is mocked, so a case that asserted a gate would be asserting the
 * mock. The one exception is the quarantine case below, which checks that the controller passes the
 * service's answer through untouched rather than re-deriving anything.
 *
 * ⚠️ SIGNED OUT IS THE DEFAULT POSTURE IN THIS FILE, not an edge case. All five routes are bare —
 * no auth, no optional user, no limiter — and the failure that matters is one of them quietly
 * acquiring a guard: two of the five serve a quarantined teardown's notice to whoever followed an
 * existing link, and an authenticated route would take that page away from them.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const listPublicTeardowns = vi.fn<(...args: readonly unknown[]) => unknown>();
const getPublicTeardownBySlug = vi.fn<(...args: readonly unknown[]) => unknown>();
const listPublicTeardownSlugs = vi.fn<(...args: readonly unknown[]) => unknown>();
const listTeardownOptions = vi.fn<(...args: readonly unknown[]) => unknown>();
const getTeardownClaimTargets = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/teardown-public-read.service.js", () => ({
  listPublicTeardowns: (...args: readonly unknown[]) => listPublicTeardowns(...args),
  getPublicTeardownBySlug: (...args: readonly unknown[]) => getPublicTeardownBySlug(...args),
  listPublicTeardownSlugs: (...args: readonly unknown[]) => listPublicTeardownSlugs(...args),
  listTeardownOptions: (...args: readonly unknown[]) => listTeardownOptions(...args),
  getTeardownClaimTargets: (...args: readonly unknown[]) => getTeardownClaimTargets(...args),
}));

const EMPTY_INDEX = {
  success: true,
  value: { items: [], page: { nextCursor: null, hasMore: false }, tagFacets: [] },
} as const;

const CURSOR_MALFORMED = {
  success: false,
  error: { type: "TEARDOWN_INDEX_CURSOR_MALFORMED" },
} as const;

const NOT_FOUND = { success: false, error: { type: "TEARDOWN_NOT_FOUND" } } as const;

const TEARDOWN_SLUG = "solar-cold-storage-controller-teardown";

/** What the service hands back for a quarantined teardown: the notice fields, nothing disputed. */
const QUARANTINED_TEARDOWN = {
  success: true,
  value: {
    id: "teardown_9",
    slug: TEARDOWN_SLUG,
    category: "teardown",
    title: "Solar cold storage controller teardown",
    summary: "A survey of the controller board and its housing.",
    thumbnailUrl: "/dummy/teardowns/controller.avif",
    author: { displayName: "Amara", handle: "amara-builds", avatarUrl: null },
    viewCount: 4210,
    likeCount: 96,
    commentCount: 12,
    saveCount: 31,
    difficulty: "intermediate",
    cadFormat: "STEP / Fusion 360",
    tags: ["solar"],
    partCount: 148,
    subjectKind: "existing_physical_product",
    moderationState: "quarantined",
    provenance: { kind: "community_reverse_engineered" },
    storeProductClass: { categorySlug: "cold-chain-controllers", label: "Cold-chain controllers" },
    createdAt: "2026-03-04T09:00:00.000Z",
    assembly: null,
    assemblySteps: [],
    billOfMaterialsCostRange: null,
    documents: [],
    fasteners: [],
    manufacturingFiles: [],
    materials: [],
    repairabilityIndex: null,
    simulationTelemetry: null,
    walkthroughVideo: null,
  },
} as const;

describe("blueprints teardown routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signOut();
    await resetRateLimiters();
  });

  describe("GET /blueprints/teardowns", () => {
    const path = "/blueprints/teardowns";

    it("answers a signed-out visitor with 200", async () => {
      listPublicTeardowns.mockResolvedValue(EMPTY_INDEX);

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
    });

    /** Eight is two clean rows of the four-column grid, and it byte-matches `TEARDOWNS_PAGE_LIMIT`. */
    it("defaults to an eight-teardown page with no filters applied", async () => {
      listPublicTeardowns.mockResolvedValue(EMPTY_INDEX);

      await request(app).get(path);

      expect(listPublicTeardowns).toHaveBeenCalledWith({
        difficulty: undefined,
        media: undefined,
        tag: undefined,
        limit: 8,
        cursor: undefined,
      });
    });

    it("passes each filter through to the service", async () => {
      listPublicTeardowns.mockResolvedValue(EMPTY_INDEX);

      await request(app).get(path).query({ difficulty: "advanced", media: "assembly", tag: "solar" });

      expect(listPublicTeardowns).toHaveBeenCalledWith({
        difficulty: "advanced",
        media: "assembly",
        tag: "solar",
        limit: 8,
        cursor: undefined,
      });
    });

    /**
     * ⚠️ AN UNKNOWN SORT IS DROPPED, NOT HONOURED. This surface offers no sort control, and the
     * `.strip()` that lets a shared link keep its `utm_source` is the same rule that has to make
     * `?sort=top` a no-op. Honouring it would return a page in an order the caller never got told
     * about; refusing it would break a link that works everywhere else.
     */
    it("ignores an unknown sort parameter rather than honouring it", async () => {
      listPublicTeardowns.mockResolvedValue(EMPTY_INDEX);

      const response = await request(app).get(path).query({ sort: "top" });

      expect(response.status).toBe(200);
      expect(listPublicTeardowns).toHaveBeenCalledWith(expect.not.objectContaining({ sort: "top" }));
    });

    /** A teardown link comes back from a share carrying tracking parameters nobody here added. */
    it("ignores a tracking parameter rather than refusing the request", async () => {
      listPublicTeardowns.mockResolvedValue(EMPTY_INDEX);

      const response = await request(app).get(path).query({ utm_source: "newsletter" });

      expect(response.status).toBe(200);
    });

    it("answers 422 for a limit above the maximum", async () => {
      const response = await request(app).get(path).query({ limit: "999" });

      expect(response.status).toBe(422);
      expect(listPublicTeardowns).not.toHaveBeenCalled();
    });

    it("answers 422 for a difficulty outside the enum", async () => {
      const response = await request(app).get(path).query({ difficulty: "expert" });

      expect(response.status).toBe(422);
      expect(listPublicTeardowns).not.toHaveBeenCalled();
    });

    it("answers 422 for a media filter outside the enum", async () => {
      const response = await request(app).get(path).query({ media: "audio" });

      expect(response.status).toBe(422);
      expect(listPublicTeardowns).not.toHaveBeenCalled();
    });

    /** Never a silent first page: a list that quietly restarts shows the reader duplicates. */
    it("answers 422 for a cursor the server did not mint", async () => {
      listPublicTeardowns.mockResolvedValue(CURSOR_MALFORMED);

      const response = await request(app).get(path).query({ cursor: "not-a-cursor" });

      expect(response.status).toBe(422);
    });

    it("passes a well-formed cursor through to the service", async () => {
      listPublicTeardowns.mockResolvedValue(EMPTY_INDEX);
      const cursor = encodeInstantCursor({
        instant: new Date("2026-03-04T09:00:00.000Z"),
        id: "teardown_2",
      });

      await request(app).get(path).query({ cursor });

      expect(listPublicTeardowns).toHaveBeenCalledWith(expect.objectContaining({ cursor }));
    });

    it("carries the tag facets in the same payload as the items", async () => {
      listPublicTeardowns.mockResolvedValue({
        success: true,
        value: {
          items: [],
          page: { nextCursor: null, hasMore: false },
          tagFacets: [{ value: "solar", count: 7 }],
        },
      });

      const response = await request(app).get(path);

      expect(response.body.data.tagFacets).toEqual([{ value: "solar", count: 7 }]);
    });
  });

  describe("GET /blueprints/teardowns/options", () => {
    const path = "/blueprints/teardowns/options";

    it("answers a signed-out visitor with 200 and the slug-title pairs", async () => {
      listTeardownOptions.mockResolvedValue([{ slug: TEARDOWN_SLUG, title: "Controller teardown" }]);

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ slug: TEARDOWN_SLUG, title: "Controller teardown" }]);
    });

    /** The literal must not be captured as a slug by `/teardowns/:teardownSlug`. */
    it("reaches the options handler rather than the detail one", async () => {
      listTeardownOptions.mockResolvedValue([]);

      await request(app).get(path);

      expect(listTeardownOptions).toHaveBeenCalledTimes(1);
      expect(getPublicTeardownBySlug).not.toHaveBeenCalled();
    });
  });

  describe("GET /blueprints/teardowns/slugs", () => {
    const path = "/blueprints/teardowns/slugs";

    it("answers a signed-out visitor with 200 and the slug list", async () => {
      listPublicTeardownSlugs.mockResolvedValue(["one", "two"]);

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(["one", "two"]);
    });

    it("reaches the slug handler rather than the detail one", async () => {
      listPublicTeardownSlugs.mockResolvedValue([]);

      await request(app).get(path);

      expect(listPublicTeardownSlugs).toHaveBeenCalledTimes(1);
      expect(getPublicTeardownBySlug).not.toHaveBeenCalled();
    });
  });

  describe("GET /blueprints/teardowns/:teardownSlug", () => {
    it("answers a signed-out visitor with 200", async () => {
      getPublicTeardownBySlug.mockResolvedValue({
        success: true,
        value: { slug: TEARDOWN_SLUG, moderationState: "published" },
      });

      const response = await request(app).get(`/blueprints/teardowns/${TEARDOWN_SLUG}`);

      expect(response.status).toBe(200);
      expect(getPublicTeardownBySlug).toHaveBeenCalledWith(TEARDOWN_SLUG);
    });

    /**
     * ⚠️ A MALFORMED SLUG IS A 404, AND THE DATABASE IS NEVER ASKED.
     *
     * A 422 here beside a 404 for a well-formed miss would tell a stranger which slug shapes are
     * real, one request at a time. Not calling the service is the second half: a shape refusal that
     * still hit the read would be an oracle with a timing side channel instead of a status one.
     */
    it("answers 404 without touching the service for a malformed slug", async () => {
      const response = await request(app).get("/blueprints/teardowns/Not_A_Slug");

      expect(response.status).toBe(404);
      expect(getPublicTeardownBySlug).not.toHaveBeenCalled();
    });

    it("answers 404 for a well-formed slug no readable teardown carries", async () => {
      getPublicTeardownBySlug.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get("/blueprints/teardowns/no-such-teardown");

      expect(response.status).toBe(404);
    });

    /**
     * ⚠️ THE CASE THAT PROVES THE DESIGN. A quarantined teardown answers 200 with its notice fields
     * intact and not one disputed byte — the address survives a rights claim, the files do not. A
     * 404 here would break a link that already exists in bookmarks and in search results.
     */
    it("answers 200 for a quarantined teardown with the notice fields and no files", async () => {
      getPublicTeardownBySlug.mockResolvedValue(QUARANTINED_TEARDOWN);

      const response = await request(app).get(`/blueprints/teardowns/${TEARDOWN_SLUG}`);

      expect(response.status).toBe(200);
      expect(response.body.data.moderationState).toBe("quarantined");
      expect(response.body.data.thumbnailUrl).toBe("/dummy/teardowns/controller.avif");
      expect(response.body.data.partCount).toBe(148);
      expect(response.body.data.documents).toEqual([]);
      expect(response.body.data.manufacturingFiles).toEqual([]);
      expect(response.body.data.assembly).toBeNull();
      expect(response.body.data.repairabilityIndex).toBeNull();
    });
  });

  describe("GET /blueprints/teardowns/:teardownSlug/claim-targets", () => {
    const path = `/blueprints/teardowns/${TEARDOWN_SLUG}/claim-targets`;

    /**
     * ⚠️ THE RIGHTS-CLAIM FLOW MUST WORK ON A QUARANTINED TEARDOWN, because a second rights holder
     * may have an entirely different objection from the first. Without this route that claimant
     * could only name "the whole teardown" — one quarantine blunting the control that produced it.
     */
    it("answers a signed-out visitor with ids and titles and no URL-shaped value", async () => {
      getTeardownClaimTargets.mockResolvedValue({
        success: true,
        value: {
          documents: [{ id: "doc_1", title: "Controller schematic" }],
          manufacturingFiles: [{ id: "mfg_1", title: "Housing STEP" }],
          parts: [{ id: "part_1", label: "Housing shell" }],
        },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      const serialisedBody = JSON.stringify(response.body.data);
      expect(serialisedBody, "no https link may reach the claimant").not.toContain("https:");
      expect(serialisedBody, "no site-relative asset path may reach the claimant").not.toContain("/dummy/");
      expect(response.body.data.parts).toEqual([{ id: "part_1", label: "Housing shell" }]);
    });

    it("answers 404 without touching the service for a malformed slug", async () => {
      const response = await request(app).get("/blueprints/teardowns/Not_A_Slug/claim-targets");

      expect(response.status).toBe(404);
      expect(getTeardownClaimTargets).not.toHaveBeenCalled();
    });

    it("answers 404 for a teardown no reader may reach", async () => {
      getTeardownClaimTargets.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });

    /** The extra segment must not be swallowed by the bare `:teardownSlug` route above it. */
    it("reaches the claim-target handler rather than the detail one", async () => {
      getTeardownClaimTargets.mockResolvedValue({
        success: true,
        value: { documents: [], manufacturingFiles: [], parts: [] },
      });

      await request(app).get(path);

      expect(getTeardownClaimTargets).toHaveBeenCalledTimes(1);
      expect(getPublicTeardownBySlug).not.toHaveBeenCalled();
    });
  });

  /**
   * A SIGNED-IN CALLER GETS THE SAME ANSWER, which is the other half of "no session is read". If a
   * handler ever started personalising, this case and the signed-out ones would disagree.
   */
  it("answers a signed-in caller exactly as it answers a stranger", async () => {
    listPublicTeardowns.mockResolvedValue(EMPTY_INDEX);
    signOut();
    const signedOutResponse = await request(app).get("/blueprints/teardowns");

    signInAs();
    const signedInResponse = await request(app).get("/blueprints/teardowns");

    expect(signedInResponse.status).toBe(signedOutResponse.status);
    expect(signedInResponse.body.data).toEqual(signedOutResponse.body.data);
  });
});
