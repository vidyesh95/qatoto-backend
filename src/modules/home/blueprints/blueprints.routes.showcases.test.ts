import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for the five showcase launch routes — untested at any tier before this.
 *
 * A SEPARATE FILE FROM `blueprints.routes.test.ts`, which covers the hero carousel, because this
 * surface needs four module mocks the hero suite does not: the identity guard, the idempotency
 * middleware, the platform role service, and two services instead of one. Adding them to that file
 * would change what its cases exercise; the house already splits this way
 * (`engagement.comments.routes.test.ts`, `users.routes.privacy.test.ts`).
 *
 * TWO GUARANTEES HERE ARE SECURITY PROPERTIES, not conveniences, and each has its own case below:
 *
 *   1. `moderate_content` is proven BEFORE any id or query is read. Reversed, a 403 that only
 *      arrives for launches that exist turns the moderator routes into an existence oracle for
 *      launch ids. Asserted by sending a non-moderator a request that is ALSO malformed and
 *      requiring 403 rather than 422.
 *   2. A refused field arrives under the key the form renders beside its input. A 422 keyed to the
 *      wrong field is a message the maker never sees, so the keys are asserted, not just statuses.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` reads the account's identification state from the database, which the
 * harness stubs as `{}`. Passed through so these cases test the routes rather than that guard —
 * it has its own coverage in `src/middleware/require-identified-user.test.ts`.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

/**
 * The real idempotency middleware persists a fingerprint through the database. This in-memory stand-in
 * is the same one `commerce-rfqs.routes.test.ts` uses, and it is deliberately a real implementation
 * rather than a pass-through: both showcase write routes declare `required: true`, so the 400 for a
 * missing key and the replay of a stored answer are part of their contract.
 */
const idempotencyResponses = vi.hoisted(
  () => new Map<string, { fingerprint: string; statusCode: number; body: unknown }>(),
);

vi.mock("#src/middleware/idempotency.js", () => ({
  idempotency:
    (options: { readonly required?: boolean } = {}) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const header = req.header("Idempotency-Key");
      if (!header && options.required === true) {
        res.status(400).json({
          status: "error",
          statusCode: 400,
          message: "This request requires an Idempotency-Key header.",
        });
        return;
      }
      if (!header) {
        next();
        return;
      }
      const fingerprint = JSON.stringify(req.body);
      const cached = idempotencyResponses.get(header);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          res.status(409).json({
            status: "error",
            statusCode: 409,
            message: "This Idempotency-Key was already used for a different request.",
          });
          return;
        }
        res.setHeader("Idempotency-Replayed", "true");
        res.status(cached.statusCode).json(cached.body);
        return;
      }

      const originalJson = res.json.bind(res);
      res.json = (body: unknown): Response => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          idempotencyResponses.set(header, { fingerprint, statusCode: res.statusCode, body });
        }
        return originalJson(body);
      };
      next();
    },
}));

const requirePlatformCapability = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability: (...args: readonly unknown[]) => requirePlatformCapability(...args),
}));

const uploadShowcaseWriteUpImage = vi.fn<(...args: readonly unknown[]) => unknown>();
const submitShowcaseLaunch = vi.fn<(...args: readonly unknown[]) => unknown>();
const listMyShowcaseLaunches = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/showcase-launch.service.js", () => ({
  uploadShowcaseWriteUpImage: (...args: readonly unknown[]) => uploadShowcaseWriteUpImage(...args),
  submitShowcaseLaunch: (...args: readonly unknown[]) => submitShowcaseLaunch(...args),
  listMyShowcaseLaunches: (...args: readonly unknown[]) => listMyShowcaseLaunches(...args),
}));

const listShowcaseReviewQueue = vi.fn<(...args: readonly unknown[]) => unknown>();
const decideShowcaseLaunch = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/modules/home/blueprints/showcase-launch-moderation.service.js", () => ({
  listShowcaseReviewQueue: (...args: readonly unknown[]) => listShowcaseReviewQueue(...args),
  decideShowcaseLaunch: (...args: readonly unknown[]) => decideShowcaseLaunch(...args),
}));

/** What a moderator looks like once the capability is proven. */
const MODERATOR_CONTEXT = {
  success: true,
  value: { staffUserId: "user_test_caller", platformRole: "admin" },
} as const;

const CAPABILITY_REFUSED = {
  success: false,
  error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
} as const;

/** A real PNG signature, so multer's own image sniffing has something valid to accept. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/** A draft the schema accepts, so a case can isolate the file or the service from validation. */
function buildValidDraft(): Record<string, unknown> {
  return {
    title: "Solar cold storage unit",
    tagline: "Keeps produce cold on four hours of sun.",
    summary:
      "A 200-litre evaporative store that runs off a single panel, built and field-tested over one season with two farm cooperatives.",
    writeUp: null,
    launchedAt: "2026-08-01T00:00:00.000Z",
    difficulty: "intermediate",
    billOfMaterialsCostRange: null,
    tags: ["solar"],
    team: [],
    builtFromBlueprintSlug: null,
    callToAction: null,
    acceptedLaunchStatementIds: ["built_it_ourselves", "results_are_our_own"],
  };
}

describe("blueprints showcase launch routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyResponses.clear();
    signInAs();
    await resetRateLimiters();
  });

  describe("POST /blueprints/showcases/write-up-images", () => {
    const path = "/blueprints/showcases/write-up-images";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app)
        .post(path)
        .attach("image", PNG_BYTES, { filename: "step.png", contentType: "image/png" });

      expect(response.status).toBe(401);
      expect(uploadShowcaseWriteUpImage).not.toHaveBeenCalled();
    });

    it("answers 422 keyed to image when no file is attached", async () => {
      const response = await request(app).post(path);

      expect(response.status).toBe(422);
      expect(response.body.errors.image).toEqual(["Choose an image to upload."]);
      expect(uploadShowcaseWriteUpImage).not.toHaveBeenCalled();
    });

    it("answers 201 with the stored image and passes the caller and the bytes", async () => {
      uploadShowcaseWriteUpImage.mockResolvedValue({
        success: true,
        value: {
          url: "https://cdn.test/write-up/one.avif",
          widthPx: 1200,
          heightPx: 800,
          blurDataUrl: "data:image/webp;base64,AAAA",
        },
      });

      const response = await request(app)
        .post(path)
        .attach("image", PNG_BYTES, { filename: "step.png", contentType: "image/png" });

      expect(response.status).toBe(201);
      expect(response.body.data.url).toBe("https://cdn.test/write-up/one.avif");
      expect(uploadShowcaseWriteUpImage).toHaveBeenCalledWith("user_test_caller", expect.any(Buffer));
    });

    it("answers 422 for a file that is not an image", async () => {
      const response = await request(app)
        .post(path)
        .attach("image", Buffer.from("not an image"), { filename: "step.txt", contentType: "text/plain" });

      expect(response.status).toBe(422);
      expect(uploadShowcaseWriteUpImage).not.toHaveBeenCalled();
    });

    /** This route declares `textFieldLimit: 0` — the file is the whole request. */
    it("answers 422 when a text part rides along with the image", async () => {
      const response = await request(app)
        .post(path)
        .field("launchId", "launch_1")
        .attach("image", PNG_BYTES, { filename: "step.png", contentType: "image/png" });

      expect(response.status).toBe(422);
      expect(uploadShowcaseWriteUpImage).not.toHaveBeenCalled();
    });

    it("answers 413 for a file over the 5 MB cap", async () => {
      const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);

      const response = await request(app)
        .post(path)
        .attach("image", oversized, { filename: "step.png", contentType: "image/png" });

      expect(response.status).toBe(413);
      expect(uploadShowcaseWriteUpImage).not.toHaveBeenCalled();
    });

    it("answers 409 when the maker is at the staging cap", async () => {
      uploadShowcaseWriteUpImage.mockResolvedValue({
        success: false,
        error: { type: "SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED", limit: 30 },
      });

      const response = await request(app)
        .post(path)
        .attach("image", PNG_BYTES, { filename: "step.png", contentType: "image/png" });

      expect(response.status).toBe(409);
      expect(response.body.message).toContain("30");
    });

    /**
     * THE ONLY ROUTE THAT PASSES `"image"` as the image field key. Every other showcase refusal is
     * keyed `headingImage`, so this is the one place the argument is load-bearing — keyed wrongly,
     * the refusal renders nowhere near the write-up's image picker.
     */
    it("reports an image refusal under image, not headingImage", async () => {
      uploadShowcaseWriteUpImage.mockResolvedValue({
        success: false,
        error: { type: "UNSUPPORTED_FORMAT", detected: { kind: "heic" } },
      });

      const response = await request(app)
        .post(path)
        .attach("image", PNG_BYTES, { filename: "step.png", contentType: "image/png" });

      expect(response.status).toBe(422);
      expect(Object.keys(response.body.errors)).toEqual(["image"]);
    });

    it.each([
      ["NOT_CONFIGURED", 503],
      ["UPLOAD_FAILED", 502],
    ] as const)("maps %s to %i", async (errorType, expectedStatus) => {
      uploadShowcaseWriteUpImage.mockResolvedValue({
        success: false,
        error: { type: errorType, cause: "socket hang up" },
      });

      const response = await request(app)
        .post(path)
        .attach("image", PNG_BYTES, { filename: "step.png", contentType: "image/png" });

      expect(response.status).toBe(expectedStatus);
    });
  });

  describe("POST /blueprints/showcases", () => {
    const path = "/blueprints/showcases";

    function postLaunch(options: {
      readonly draft?: string;
      readonly attachImage?: boolean;
      readonly idempotencyKey?: string | null;
    }) {
      let pending = request(app).post(path);
      const key = options.idempotencyKey === undefined ? "idem_launch_1" : options.idempotencyKey;
      if (key !== null) pending = pending.set("Idempotency-Key", key);
      if (options.draft !== undefined) pending = pending.field("draft", options.draft);
      if (options.attachImage !== false) {
        pending = pending.attach("headingImage", PNG_BYTES, {
          filename: "heading.png",
          contentType: "image/png",
        });
      }
      return pending;
    }

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await postLaunch({ draft: JSON.stringify(buildValidDraft()) });

      expect(response.status).toBe(401);
      expect(submitShowcaseLaunch).not.toHaveBeenCalled();
    });

    it("answers 400 without an Idempotency-Key", async () => {
      const response = await postLaunch({
        draft: JSON.stringify(buildValidDraft()),
        idempotencyKey: null,
      });

      expect(response.status).toBe(400);
      expect(submitShowcaseLaunch).not.toHaveBeenCalled();
    });

    it("answers 422 keyed to draft when the part is not JSON", async () => {
      const response = await postLaunch({ draft: "{not json" });

      expect(response.status).toBe(422);
      expect(response.body.errors.draft).toEqual(["The launch could not be read. Reload the page and try again."]);
      expect(submitShowcaseLaunch).not.toHaveBeenCalled();
    });

    /**
     * ONE ROUND TRIP, which is the whole reason the controller fuses these two refusals rather than
     * returning whichever it noticed first. A maker who submits a bad title AND forgets the image
     * must learn both at once, or they fix one, resubmit, and are refused again.
     */
    it("fuses a draft field error and the missing heading image into one 422", async () => {
      const response = await postLaunch({
        draft: JSON.stringify({ ...buildValidDraft(), title: "short" }),
        attachImage: false,
      });

      expect(response.status).toBe(422);
      expect(response.body.errors.title).toBeDefined();
      expect(response.body.errors.headingImage).toEqual(["Choose a square heading image."]);
      expect(submitShowcaseLaunch).not.toHaveBeenCalled();
    });

    it("answers 422 keyed to headingImage alone when the draft is valid and the file is missing", async () => {
      const response = await postLaunch({
        draft: JSON.stringify(buildValidDraft()),
        attachImage: false,
      });

      expect(response.status).toBe(422);
      expect(Object.keys(response.body.errors)).toEqual(["headingImage"]);
      expect(submitShowcaseLaunch).not.toHaveBeenCalled();
    });

    it("refuses a server-owned field in the draft with 422", async () => {
      const response = await postLaunch({
        draft: JSON.stringify({ ...buildValidDraft(), moderationState: "published" }),
      });

      expect(response.status).toBe(422);
      expect(submitShowcaseLaunch).not.toHaveBeenCalled();
    });

    it("answers 201 and hands the service the caller, the parsed draft and the bytes", async () => {
      submitShowcaseLaunch.mockResolvedValue({
        success: true,
        value: {
          submissionId: "launch_1",
          moderationState: "pending_review",
          receivedAt: new Date("2026-09-12T09:00:00.000Z"),
        },
      });

      const response = await postLaunch({ draft: JSON.stringify(buildValidDraft()) });

      expect(response.status).toBe(201);
      expect(response.body.data.moderationState).toBe("pending_review");
      expect(submitShowcaseLaunch).toHaveBeenCalledWith({
        authorUserId: "user_test_caller",
        draft: expect.objectContaining({ title: "Solar cold storage unit" }),
        rawHeadingImageBytes: expect.any(Buffer),
        receivedAt: expect.any(Date),
      });
    });

    /**
     * THE KEY IS WHAT THE FORM READS. Both this and the idempotency middleware answer 409, and the
     * form tells them apart by `errors.title` — without it a name clash renders as "you already
     * sent this".
     */
    it("answers 409 carrying errors.title when the name is taken", async () => {
      submitShowcaseLaunch.mockResolvedValue({
        success: false,
        error: { type: "SHOWCASE_LAUNCH_TITLE_TAKEN" },
      });

      const response = await postLaunch({ draft: JSON.stringify(buildValidDraft()) });

      expect(response.status).toBe(409);
      expect(response.body.errors.title).toHaveLength(1);
    });

    it.each([
      [
        "SHOWCASE_LAUNCH_LINK_INVALID",
        { type: "SHOWCASE_LAUNCH_LINK_INVALID", reason: { type: "EXTERNAL_URL_NOT_HTTPS", scheme: "http:" } },
        422,
        "callToAction",
      ],
      ["SHOWCASE_LAUNCH_DATE_IN_FUTURE", { type: "SHOWCASE_LAUNCH_DATE_IN_FUTURE" }, 422, "launchedAt"],
      [
        "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE",
        { type: "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE" },
        422,
        "writeUp",
      ],
      [
        "SHOWCASE_HEADING_IMAGE_NOT_SQUARE",
        { type: "SHOWCASE_HEADING_IMAGE_NOT_SQUARE", width: 800, height: 600 },
        422,
        "headingImage",
      ],
    ] as const)("maps %s to %i keyed to %s", async (_label, error, expectedStatus, expectedKey) => {
      submitShowcaseLaunch.mockResolvedValue({ success: false, error });

      const response = await postLaunch({ draft: JSON.stringify(buildValidDraft()) });

      expect(response.status).toBe(expectedStatus);
      expect(Object.keys(response.body.errors)).toEqual([expectedKey]);
    });

    it("replays the first answer for a repeated Idempotency-Key without calling the service twice", async () => {
      submitShowcaseLaunch.mockResolvedValue({
        success: true,
        value: {
          submissionId: "launch_1",
          moderationState: "pending_review",
          receivedAt: new Date("2026-09-12T09:00:00.000Z"),
        },
      });
      const draft = JSON.stringify(buildValidDraft());

      const first = await postLaunch({ draft });
      const replay = await postLaunch({ draft });

      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(submitShowcaseLaunch).toHaveBeenCalledTimes(1);
    });

    /**
     * ⚠️ PINS A GAP RATHER THAN ENDORSING IT. Every 422 from the same parser carries
     * `errors.headingImage`, but the 413 path in `src/middleware/upload.ts` answers with a bare
     * message and no `errors` key — so the one image refusal a maker is most likely to hit is the
     * one the form cannot render under the file picker.
     */
    it("answers 413 over the 5 MB cap, today with no field key to render", async () => {
      const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);

      const response = await request(app)
        .post(path)
        .set("Idempotency-Key", "idem_launch_oversized")
        .field("draft", JSON.stringify(buildValidDraft()))
        .attach("headingImage", oversized, { filename: "heading.png", contentType: "image/png" });

      expect(response.status).toBe(413);
      expect(response.body.errors).toBeUndefined();
      expect(submitShowcaseLaunch).not.toHaveBeenCalled();
    });
  });

  describe("GET /blueprints/showcases/mine", () => {
    const path = "/blueprints/showcases/mine";

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(listMyShowcaseLaunches).not.toHaveBeenCalled();
    });

    it("answers 200 with the caller's own launches in every state", async () => {
      listMyShowcaseLaunches.mockResolvedValue([
        { submissionId: "launch_1", title: "Solar cold storage unit", moderationState: "pending_review" },
        { submissionId: "launch_2", title: "Bike trailer", moderationState: "rejected" },
      ]);

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(listMyShowcaseLaunches).toHaveBeenCalledWith("user_test_caller");
    });

    /** A maker reading their own launches is not staff — asking would be the wrong gate entirely. */
    it("never asks for a platform capability", async () => {
      listMyShowcaseLaunches.mockResolvedValue([]);

      await request(app).get(path);

      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });
  });

  describe("GET /blueprints/admin/showcases/review-queue", () => {
    const path = "/blueprints/admin/showcases/review-queue";

    it("answers 401 for a signed-out caller without asking for a capability", async () => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });

    it("answers 403 for a caller without moderate_content", async () => {
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).get(path);

      expect(response.status).toBe(403);
      expect(requirePlatformCapability).toHaveBeenCalledWith("user_test_caller", "moderate_content");
      expect(listShowcaseReviewQueue).not.toHaveBeenCalled();
    });

    /**
     * THE CAPABILITY IS PROVEN BEFORE THE QUERY IS READ. This request is refusable two ways — the
     * caller is not a moderator AND `limit=999` is invalid — and it must come back 403. A 422 here
     * would mean the query was parsed for a caller with no business on this route, which is the
     * shape of an oracle: refusals that differ by what the server found.
     */
    it("answers 403 rather than 422 when a non-moderator also sends an invalid query", async () => {
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app).get(`${path}?limit=999&unknownKey=x`);

      expect(response.status).toBe(403);
      expect(listShowcaseReviewQueue).not.toHaveBeenCalled();
    });

    it("answers 200 with the default page size for a moderator", async () => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      listShowcaseReviewQueue.mockResolvedValue({
        items: [{ submissionId: "launch_1" }],
        page: { nextCursor: null, hasMore: false },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.body.data.items).toHaveLength(1);
      expect(listShowcaseReviewQueue).toHaveBeenCalledWith({
        staff: MODERATOR_CONTEXT.value,
        limit: 20,
        cursor: undefined,
      });
    });

    it("answers 422 for a limit over the maximum", async () => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await request(app).get(`${path}?limit=51`);

      expect(response.status).toBe(422);
      expect(listShowcaseReviewQueue).not.toHaveBeenCalled();
    });

    it("decodes a well-formed cursor into the instant and id the keyset needs", async () => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      listShowcaseReviewQueue.mockResolvedValue({ items: [], page: { nextCursor: null, hasMore: false } });
      const instant = new Date("2026-09-11T12:00:00.000Z");
      const cursor = encodeInstantCursor({ instant, id: "launch_1" });

      const response = await request(app).get(`${path}?cursor=${encodeURIComponent(cursor)}`);

      expect(response.status).toBe(200);
      expect(listShowcaseReviewQueue).toHaveBeenCalledWith({
        staff: MODERATOR_CONTEXT.value,
        limit: 20,
        cursor: { instant, id: "launch_1" },
      });
    });

    /**
     * NEVER A SILENT FIRST PAGE. A client that quietly restarts the queue shows a moderator
     * launches they already decided, so a malformed cursor is refused rather than dropped. The body
     * carries no `errors` key because there is no form field behind a cursor — it is the client's
     * own bookkeeping.
     */
    it("answers a bare 422 for a malformed cursor and never lists the first page", async () => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await request(app).get(`${path}?cursor=not-a-real-cursor`);

      expect(response.status).toBe(422);
      expect(response.body.message).toBe("Malformed cursor.");
      expect(response.body.errors).toBeUndefined();
      expect(listShowcaseReviewQueue).not.toHaveBeenCalled();
    });
  });

  describe("POST /blueprints/admin/showcases/:submissionId/moderate", () => {
    const path = "/blueprints/admin/showcases/launch_1/moderate";

    function postDecision(body: unknown, idempotencyKey: string | null = "idem_decision_1") {
      const pending = request(app).post(path);
      if (idempotencyKey !== null) pending.set("Idempotency-Key", idempotencyKey);
      return pending.send(body);
    }

    it("answers 401 for a signed-out caller", async () => {
      signOut();

      const response = await postDecision({ decision: "published", moderatorNote: null });

      expect(response.status).toBe(401);
      expect(requirePlatformCapability).not.toHaveBeenCalled();
    });

    it("answers 400 without an Idempotency-Key", async () => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await postDecision({ decision: "published", moderatorNote: null }, null);

      expect(response.status).toBe(400);
      expect(decideShowcaseLaunch).not.toHaveBeenCalled();
    });

    /** The same oracle guard as the queue: the capability is proven before the id is even read. */
    it("answers 403 for a non-moderator even with an invalid body and an unknown id", async () => {
      requirePlatformCapability.mockResolvedValue(CAPABILITY_REFUSED);

      const response = await request(app)
        .post("/blueprints/admin/showcases/launch_does_not_exist/moderate")
        .set("Idempotency-Key", "idem_decision_probe")
        .send({ decision: "nonsense" });

      expect(response.status).toBe(403);
      expect(decideShowcaseLaunch).not.toHaveBeenCalled();
    });

    it("answers 422 for a rejection with no note", async () => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);

      const response = await postDecision({ decision: "rejected" });

      expect(response.status).toBe(422);
      expect(decideShowcaseLaunch).not.toHaveBeenCalled();
    });

    it("publishes and passes the submission id from the path", async () => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideShowcaseLaunch.mockResolvedValue({
        success: true,
        value: {
          submissionId: "launch_1",
          moderationState: "published",
          publicSlug: "solar-cold-storage-unit",
          decidedAt: new Date("2026-09-12T09:00:00.000Z"),
        },
      });

      const response = await postDecision({ decision: "published", moderatorNote: null });

      expect(response.status).toBe(200);
      expect(response.body.data.publicSlug).toBe("solar-cold-storage-unit");
      expect(decideShowcaseLaunch).toHaveBeenCalledWith({
        submissionId: "launch_1",
        decision: { decision: "published", moderatorNote: null },
        staff: MODERATOR_CONTEXT.value,
      });
    });

    it("sends a launch back with the moderator's note", async () => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideShowcaseLaunch.mockResolvedValue({
        success: true,
        value: {
          submissionId: "launch_1",
          moderationState: "rejected",
          publicSlug: null,
          decidedAt: new Date("2026-09-12T09:00:00.000Z"),
        },
      });

      const response = await postDecision({ decision: "rejected", moderatorNote: "Add a build photo." });

      expect(response.status).toBe(200);
      expect(decideShowcaseLaunch).toHaveBeenCalledWith({
        submissionId: "launch_1",
        decision: { decision: "rejected", moderatorNote: "Add a build photo." },
        staff: MODERATOR_CONTEXT.value,
      });
    });

    it.each([
      ["SHOWCASE_LAUNCH_NOT_FOUND", { type: "SHOWCASE_LAUNCH_NOT_FOUND" }, 404],
      ["SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN", { type: "SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN" }, 403],
      [
        "SHOWCASE_LAUNCH_ALREADY_DECIDED",
        { type: "SHOWCASE_LAUNCH_ALREADY_DECIDED", moderationState: "published" },
        409,
      ],
    ] as const)("maps %s to %i", async (_label, error, expectedStatus) => {
      requirePlatformCapability.mockResolvedValue(MODERATOR_CONTEXT);
      decideShowcaseLaunch.mockResolvedValue({ success: false, error });

      const response = await postDecision({ decision: "published", moderatorNote: null });

      expect(response.status).toBe(expectedStatus);
    });
  });
});
