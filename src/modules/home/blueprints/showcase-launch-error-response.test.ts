import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";

import type { ExternalUrlError } from "#src/lib/external-url.js";
import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import {
  mapShowcaseLaunchErrorToResponse,
  respondShowcaseLaunchError,
  type ShowcaseLaunchError,
} from "#src/modules/home/blueprints/showcase-launch-error-response.js";

/**
 * UNIT tests for the showcase launch error mapper — a pure, total function over the union of
 * three services' error types, previously untested at any tier.
 *
 * NO MOCKS AND NO ENVIRONMENT STUB, deliberately. The module under test reaches only
 * `describeUnsupportedImageFormat` and some type-only imports; nothing here touches `config` or
 * `#src/db/index.js`, so a static import is safe and a `vi.mock` would only hide that fact.
 *
 * The cases below are the STATUS POLICY in the module's own header, turned into assertions. The
 * field keys are asserted as exactly as the statuses because the frontend renders a refusal
 * beside the input it names — a 422 under the wrong key is a message the maker never sees.
 */

/** A moderator refusal, shaped as `requirePlatformCapability` returns it. */
const CAPABILITY_REFUSAL: ShowcaseLaunchError = {
  type: "PLATFORM_CAPABILITY_REQUIRED",
  capability: "moderate_content",
};

/**
 * Every `ExternalUrlError` type, written out rather than derived.
 *
 * THE DUPLICATION IS THE POINT: `CALL_TO_ACTION_REJECTION_MESSAGES` is a total `Record` over this
 * same union, so adding a URL error breaks the build there, and this array is the second place
 * that has to be updated before the suite passes again. Deriving it from the record would make
 * both move together and prove nothing.
 */
const EVERY_EXTERNAL_URL_ERROR: readonly ExternalUrlError[] = [
  { type: "EXTERNAL_URL_EMPTY" },
  { type: "EXTERNAL_URL_TOO_LONG", length: 4096, maximum: 2048 },
  { type: "EXTERNAL_URL_HAS_ILLEGAL_CHARACTERS" },
  { type: "EXTERNAL_URL_UNPARSEABLE" },
  { type: "EXTERNAL_URL_NOT_HTTPS", scheme: "http:" },
  { type: "EXTERNAL_URL_HOST_INVALID", host: "localhost" },
  { type: "EXTERNAL_URL_HAS_CREDENTIALS" },
];

/**
 * One representative value per variant the union declares.
 *
 * TypeScript forces a new variant to be added here — the `Record` key type is the union's own
 * `type` field — so a service that grows an error cannot reach the mapper untested.
 */
const EVERY_SHOWCASE_LAUNCH_ERROR: Readonly<Record<ShowcaseLaunchError["type"], ShowcaseLaunchError>> = {
  PLATFORM_CAPABILITY_REQUIRED: CAPABILITY_REFUSAL,
  SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN: { type: "SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN" },
  SHOWCASE_LAUNCH_NOT_FOUND: { type: "SHOWCASE_LAUNCH_NOT_FOUND" },
  SHOWCASE_LAUNCH_TITLE_TAKEN: { type: "SHOWCASE_LAUNCH_TITLE_TAKEN" },
  SHOWCASE_LAUNCH_ALREADY_DECIDED: {
    type: "SHOWCASE_LAUNCH_ALREADY_DECIDED",
    moderationState: "published",
  },
  SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED: {
    type: "SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED",
    limit: 30,
  },
  SHOWCASE_LAUNCH_LINK_INVALID: {
    type: "SHOWCASE_LAUNCH_LINK_INVALID",
    reason: { type: "EXTERNAL_URL_NOT_HTTPS", scheme: "http:" },
  },
  SHOWCASE_LAUNCH_DATE_IN_FUTURE: { type: "SHOWCASE_LAUNCH_DATE_IN_FUTURE" },
  SHOWCASE_LAUNCH_WRITE_UP_TOO_MANY_IMAGES: {
    type: "SHOWCASE_LAUNCH_WRITE_UP_TOO_MANY_IMAGES",
    limit: 20,
  },
  SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE: {
    type: "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE",
  },
  SHOWCASE_HEADING_IMAGE_NOT_SQUARE: {
    type: "SHOWCASE_HEADING_IMAGE_NOT_SQUARE",
    width: 800,
    height: 600,
  },
  SHOWCASE_HEADING_IMAGE_TOO_SMALL: {
    type: "SHOWCASE_HEADING_IMAGE_TOO_SMALL",
    width: 128,
    height: 128,
    minimum: 256,
  },
  NOT_AN_IMAGE: { type: "NOT_AN_IMAGE" },
  UNSUPPORTED_FORMAT: { type: "UNSUPPORTED_FORMAT", detected: { kind: "heic" } },
  DIMENSIONS_TOO_SMALL: { type: "DIMENSIONS_TOO_SMALL", width: 32, height: 32 },
  DIMENSIONS_TOO_LARGE: { type: "DIMENSIONS_TOO_LARGE", width: 20_000, height: 20_000 },
  NOT_CONFIGURED: { type: "NOT_CONFIGURED" },
  UPLOAD_FAILED: { type: "UPLOAD_FAILED", cause: "socket hang up" },
  DELETE_FAILED: { type: "DELETE_FAILED", cause: "socket hang up" },
};

describe("mapShowcaseLaunchErrorToResponse", () => {
  describe("403 — refusals decided before any id is read", () => {
    it("names the moderator role for a capability refusal", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(CAPABILITY_REFUSAL, "headingImage");

      expect(mapped.statusCode).toBe(403);
      expect(mapped.message).toBe("Reviewing launches requires the moderator role.");
      expect(mapped.errors).toBeUndefined();
    });

    it("tells a moderator to hand their own launch to someone else", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN" },
        "headingImage",
      );

      expect(mapped.statusCode).toBe(403);
      expect(mapped.message).toContain("another moderator");
      expect(mapped.errors).toBeUndefined();
    });
  });

  describe("404", () => {
    it("answers a bare 404 with no field key", () => {
      const mapped = mapShowcaseLaunchErrorToResponse({ type: "SHOWCASE_LAUNCH_NOT_FOUND" }, "headingImage");

      expect(mapped.statusCode).toBe(404);
      expect(mapped.message).toBe("Launch not found.");
      expect(mapped.errors).toBeUndefined();
    });
  });

  describe("409 — conflicts with current state", () => {
    /**
     * THE KEY IS LOAD-BEARING, not decoration. The module header states that the frontend tells
     * this 409 apart from the idempotency middleware's bare 409 BY `errors.title`. Asserting the
     * exact key set is what stops a future refactor from adding a second key and silently
     * changing which branch the form takes.
     */
    it("keys a taken title under exactly errors.title", () => {
      const mapped = mapShowcaseLaunchErrorToResponse({ type: "SHOWCASE_LAUNCH_TITLE_TAKEN" }, "headingImage");

      expect(mapped.statusCode).toBe(409);
      expect(Object.keys(mapped.errors ?? {})).toEqual(["title"]);
      expect(mapped.errors?.title).toEqual([mapped.message]);
    });

    it("says already published when the launch was published", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "SHOWCASE_LAUNCH_ALREADY_DECIDED", moderationState: "published" },
        "headingImage",
      );

      expect(mapped.statusCode).toBe(409);
      expect(mapped.message).toBe("This launch was already published. Refresh the queue.");
      expect(mapped.errors).toBeUndefined();
    });

    it("says already decided for any other settled state", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "SHOWCASE_LAUNCH_ALREADY_DECIDED", moderationState: "rejected" },
        "headingImage",
      );

      expect(mapped.statusCode).toBe(409);
      expect(mapped.message).toBe("This launch was already decided. Refresh the queue.");
    });

    it("names the configured staging limit rather than a hard-coded sentence", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED", limit: 30 },
        "image",
      );

      expect(mapped.statusCode).toBe(409);
      expect(mapped.message).toContain("30");
    });
  });

  describe("422 — every one keyed to the field that is wrong", () => {
    it.each(EVERY_EXTERNAL_URL_ERROR.map((reason) => [reason.type, reason] as const))(
      "keys a %s call-to-action refusal under callToAction",
      (_describedType, reason) => {
        const mapped = mapShowcaseLaunchErrorToResponse(
          { type: "SHOWCASE_LAUNCH_LINK_INVALID", reason },
          "headingImage",
        );

        expect(mapped.statusCode).toBe(422);
        expect(Object.keys(mapped.errors ?? {})).toEqual(["callToAction"]);
        expect(mapped.errors?.callToAction).toEqual([mapped.message]);
        expect(mapped.message.length).toBeGreaterThan(0);
      },
    );

    it("gives every external URL error its own wording", () => {
      const messages = EVERY_EXTERNAL_URL_ERROR.map(
        (reason) =>
          mapShowcaseLaunchErrorToResponse({ type: "SHOWCASE_LAUNCH_LINK_INVALID", reason }, "headingImage").message,
      );

      expect(new Set(messages).size).toBe(EVERY_EXTERNAL_URL_ERROR.length);
    });

    it("keys a future launch date under launchedAt", () => {
      const mapped = mapShowcaseLaunchErrorToResponse({ type: "SHOWCASE_LAUNCH_DATE_IN_FUTURE" }, "headingImage");

      expect(mapped.statusCode).toBe(422);
      expect(Object.keys(mapped.errors ?? {})).toEqual(["launchedAt"]);
    });

    it("keys too many write-up images under writeUp and names the limit", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "SHOWCASE_LAUNCH_WRITE_UP_TOO_MANY_IMAGES", limit: 20 },
        "headingImage",
      );

      expect(mapped.statusCode).toBe(422);
      expect(Object.keys(mapped.errors ?? {})).toEqual(["writeUp"]);
      expect(mapped.message).toContain("20");
    });

    /**
     * The module header promises that no message echoes a URL the maker sent. There is no address
     * in this error to echo, which is exactly the design — assert the message describes the
     * problem generically so a future edit cannot start quoting one.
     */
    it("refuses an unavailable write-up image without naming an address", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE" },
        "headingImage",
      );

      expect(mapped.statusCode).toBe(422);
      expect(Object.keys(mapped.errors ?? {})).toEqual(["writeUp"]);
      expect(mapped.message).not.toContain("http");
    });

    it("reports the measured size for a non-square heading image", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "SHOWCASE_HEADING_IMAGE_NOT_SQUARE", width: 800, height: 600 },
        "headingImage",
      );

      expect(mapped.statusCode).toBe(422);
      expect(mapped.message).toContain("800x600");
    });

    it("reports both the minimum and the measured size for a small heading image", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "SHOWCASE_HEADING_IMAGE_TOO_SMALL", width: 128, height: 128, minimum: 256 },
        "headingImage",
      );

      expect(mapped.statusCode).toBe(422);
      expect(mapped.message).toContain("256x256");
      expect(mapped.message).toContain("128x128");
    });

    /**
     * The part name the route carried, not a constant. `POST /showcases` sends `headingImage` and
     * `POST /showcases/write-up-images` sends `image`; a refusal keyed to the wrong one renders
     * nowhere on the form.
     */
    it.each(["headingImage", "image"] as const)(
      "reports an undecodable file under the %s part name",
      (imageFieldKey) => {
        const mapped = mapShowcaseLaunchErrorToResponse({ type: "NOT_AN_IMAGE" }, imageFieldKey);

        expect(mapped.statusCode).toBe(422);
        expect(Object.keys(mapped.errors ?? {})).toEqual([imageFieldKey]);
      },
    );

    it("delegates unsupported-format wording to the image library", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "UNSUPPORTED_FORMAT", detected: { kind: "heic" } },
        "image",
      );

      expect(mapped.statusCode).toBe(422);
      expect(mapped.message).toBe(describeUnsupportedImageFormat({ kind: "heic" }));
    });

    it.each([
      ["DIMENSIONS_TOO_SMALL", { type: "DIMENSIONS_TOO_SMALL", width: 32, height: 32 }],
      ["DIMENSIONS_TOO_LARGE", { type: "DIMENSIONS_TOO_LARGE", width: 20_000, height: 20_000 }],
    ] as const)("reports %s under the given field key with its measurements", (_label, error) => {
      const mapped = mapShowcaseLaunchErrorToResponse(error, "image");

      expect(mapped.statusCode).toBe(422);
      expect(Object.keys(mapped.errors ?? {})).toEqual(["image"]);
      expect(mapped.message).toContain(String(error.width));
    });
  });

  describe("storage failures", () => {
    it("answers 503 when Cloudinary is not configured", () => {
      const mapped = mapShowcaseLaunchErrorToResponse({ type: "NOT_CONFIGURED" }, "headingImage");

      expect(mapped.statusCode).toBe(503);
      expect(mapped.errors).toBeUndefined();
    });

    it.each([
      ["UPLOAD_FAILED", { type: "UPLOAD_FAILED", cause: "socket hang up" }],
      ["DELETE_FAILED", { type: "DELETE_FAILED", cause: "socket hang up" }],
    ] as const)("answers 502 for %s", (_label, error) => {
      const mapped = mapShowcaseLaunchErrorToResponse(error, "headingImage");

      expect(mapped.statusCode).toBe(502);
    });

    /** A storage failure is ours, not the maker's — never echo the driver's text at them. */
    it("never leaks the storage cause into the message", () => {
      const mapped = mapShowcaseLaunchErrorToResponse(
        { type: "UPLOAD_FAILED", cause: "socket hang up" },
        "headingImage",
      );

      expect(mapped.message).not.toContain("socket hang up");
    });
  });

  describe("totality", () => {
    it("maps every variant the union declares without throwing", () => {
      const everyError = Object.values(EVERY_SHOWCASE_LAUNCH_ERROR);

      expect(everyError, "the variant table must not silently empty out").toHaveLength(19);
      for (const error of everyError) {
        const mapped = mapShowcaseLaunchErrorToResponse(error, "headingImage");

        expect(mapped.statusCode, `${error.type} must map to a client- or gateway-class status`).toBeGreaterThanOrEqual(
          400,
        );
        expect(mapped.statusCode, `${error.type} must never map to a 500`).not.toBe(500);
        expect(mapped.message.length, `${error.type} must carry a message`).toBeGreaterThan(0);
      }
    });
  });
});

describe("respondShowcaseLaunchError", () => {
  function createResponseSpy(): {
    readonly res: Response;
    readonly status: ReturnType<typeof vi.fn>;
    readonly json: ReturnType<typeof vi.fn>;
  } {
    const json = vi.fn<(body: unknown) => unknown>();
    const status = vi.fn<(statusCode: number) => { json: typeof json }>(() => ({ json }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const res = { status } as unknown as Response;
    return { res, status, json };
  }

  it("writes the mapped status and the standard error envelope", () => {
    const { res, status, json } = createResponseSpy();

    respondShowcaseLaunchError(res, { type: "SHOWCASE_LAUNCH_NOT_FOUND" }, "headingImage");

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      statusCode: 404,
      message: "Launch not found.",
      errors: undefined,
    });
  });

  /** The default exists so moderation call sites can omit it; prove it is `headingImage`. */
  it("defaults the image field key to headingImage", () => {
    const { res, json } = createResponseSpy();

    respondShowcaseLaunchError(res, { type: "NOT_AN_IMAGE" });

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        errors: { headingImage: ["The uploaded file is not a valid image."] },
      }),
    );
  });
});
