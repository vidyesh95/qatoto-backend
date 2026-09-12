import { describe, expect, it, vi } from "vitest";

import {
  mapTeardownWriteErrorToResponse,
  respondTeardownWriteError,
  type TeardownWriteError,
} from "#src/modules/home/blueprints/teardown-write-error-response.js";

/**
 * The pure mapper for the teardown write path.
 *
 * ⚠️ THE VARIANT TABLE IS EXHAUSTIVE BY CONSTRUCTION. It is typed as a record keyed by the union's
 * own `type`, so adding an arm to `TeardownWriteError` without adding it here is a compile error
 * rather than a case nobody wrote — and the count assertion catches the other direction, a table
 * that silently empties out under a refactor.
 */

const EVERY_TEARDOWN_WRITE_ERROR: Readonly<Record<TeardownWriteError["type"], TeardownWriteError>> = {
  PLATFORM_CAPABILITY_REQUIRED: {
    type: "PLATFORM_CAPABILITY_REQUIRED",
    capability: "moderate_content",
  },
  TEARDOWN_SELF_MODERATION_FORBIDDEN: { type: "TEARDOWN_SELF_MODERATION_FORBIDDEN" },
  TEARDOWN_SUBMISSION_NOT_FOUND: { type: "TEARDOWN_SUBMISSION_NOT_FOUND" },
  TEARDOWN_SUBJECT_ALREADY_SURVEYED: {
    type: "TEARDOWN_SUBJECT_ALREADY_SURVEYED",
    existingTitle: "Inside a supermarket cordless drill",
  },
  TEARDOWN_ALREADY_DECIDED: { type: "TEARDOWN_ALREADY_DECIDED", moderationState: "published" },
  TEARDOWN_SUBMISSION_UNPARSEABLE: {
    type: "TEARDOWN_SUBMISSION_UNPARSEABLE",
    schemaVersion: 1,
    issues: ["parts.0.label: Required"],
  },
};

describe("mapTeardownWriteErrorToResponse", () => {
  it("refuses a caller without the capability with 403", () => {
    const mapped = mapTeardownWriteErrorToResponse(EVERY_TEARDOWN_WRITE_ERROR.PLATFORM_CAPABILITY_REQUIRED);

    expect(mapped.statusCode).toBe(403);
  });

  /**
   * ⚠️ 403, NOT 404, AND THE ASYMMETRY IS DELIBERATE. By the time this arm is reachable the caller
   * has already proven `moderate_content`, so naming the conflict discloses nothing they did not
   * have standing to learn. Every OTHER miss on this surface is a 404.
   */
  it("refuses self-moderation with 403 rather than 404", () => {
    const mapped = mapTeardownWriteErrorToResponse(EVERY_TEARDOWN_WRITE_ERROR.TEARDOWN_SELF_MODERATION_FORBIDDEN);

    expect(mapped.statusCode).toBe(403);
  });

  it("answers a missing submission with 404", () => {
    const mapped = mapTeardownWriteErrorToResponse(EVERY_TEARDOWN_WRITE_ERROR.TEARDOWN_SUBMISSION_NOT_FOUND);

    expect(mapped.statusCode).toBe(404);
  });

  it("answers a duplicate unit with 409 and the field key", () => {
    const mapped = mapTeardownWriteErrorToResponse(EVERY_TEARDOWN_WRITE_ERROR.TEARDOWN_SUBJECT_ALREADY_SURVEYED);

    expect(mapped.statusCode).toBe(409);
    expect(mapped.errors).toHaveProperty("provenance.subjectProductName");
    expect(mapped.message).toContain("Inside a supermarket cordless drill");
  });

  /**
   * ⚠️ THE OTHER HALF OF THE ORACLE RULE. The service hands this mapper `null` when the clashing
   * row is somebody else's unpublished submission, and the refusal must then name NOTHING — a
   * stranger must not be able to enumerate unpublished work by guessing product names.
   */
  it("names no row when the clashing survey is not public", () => {
    const mapped = mapTeardownWriteErrorToResponse({
      type: "TEARDOWN_SUBJECT_ALREADY_SURVEYED",
      existingTitle: null,
    });

    expect(mapped.statusCode).toBe(409);
    expect(mapped.message).toContain("already under review");
    expect(mapped.message).not.toContain("Inside a supermarket");
  });

  it("answers an already-decided submission with 409", () => {
    const mapped = mapTeardownWriteErrorToResponse(EVERY_TEARDOWN_WRITE_ERROR.TEARDOWN_ALREADY_DECIDED);

    expect(mapped.statusCode).toBe(409);
  });

  it("answers an unreadable stored document with 422 and its issues", () => {
    const mapped = mapTeardownWriteErrorToResponse(EVERY_TEARDOWN_WRITE_ERROR.TEARDOWN_SUBMISSION_UNPARSEABLE);

    expect(mapped.statusCode).toBe(422);
    expect(mapped.errors?.document).toEqual(["parts.0.label: Required"]);
  });

  describe("totality", () => {
    it("maps every variant the union declares without throwing", () => {
      const everyError = Object.values(EVERY_TEARDOWN_WRITE_ERROR);

      expect(everyError, "the variant table must not silently empty out").toHaveLength(6);
      for (const error of everyError) {
        const mapped = mapTeardownWriteErrorToResponse(error);

        expect(mapped.statusCode, `${error.type} must map to a client-class status`).toBeGreaterThanOrEqual(400);
        expect(mapped.statusCode, `${error.type} must never map to a 500`).not.toBe(500);
        expect(mapped.message.length, `${error.type} must carry a message`).toBeGreaterThan(0);
      }
    });

    /**
     * NO MESSAGE MAY CARRY A CALLER-SUPPLIED VALUE. The one echo on this surface is a stored row's
     * title, and only when the service has already cleared it; a URL or a note a caller sent is a
     * value to refuse, never one to reflect.
     */
    it("reflects nothing a caller sent", () => {
      for (const error of Object.values(EVERY_TEARDOWN_WRITE_ERROR)) {
        const mapped = mapTeardownWriteErrorToResponse(error);

        expect(mapped.message, `${error.type} must not echo a URL`).not.toContain("http");
      }
    });
  });
});

describe("respondTeardownWriteError", () => {
  it("writes the mapped status and body onto the response", () => {
    const json = vi.fn<(body: unknown) => void>();
    const status = vi.fn<(statusCode: number) => { json: typeof json }>(() => ({ json }));
    const response = { status } as unknown as Parameters<typeof respondTeardownWriteError>[0];

    respondTeardownWriteError(response, EVERY_TEARDOWN_WRITE_ERROR.TEARDOWN_SUBMISSION_NOT_FOUND);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: "error", statusCode: 404 }));
  });
});
