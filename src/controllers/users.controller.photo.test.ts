import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeleteUserPhotoError, UpdateUserPhotoError } from "#src/services/users.service.js";

// The service pulls in the db pool, Cloudinary, and sharp at module scope. Stub
// the whole module so the photo handlers can be exercised without a configured
// environment; only the two photo mutations are needed here.
vi.mock("#src/services/users.service.js", () => ({
  updateUserPhoto: vi.fn<typeof import("#src/services/users.service.js").updateUserPhoto>(),
  deleteUserPhoto: vi.fn<typeof import("#src/services/users.service.js").deleteUserPhoto>(),
}));

const usersService = await import("#src/services/users.service.js");
const { updateMyPhoto, deleteMyPhoto } = await import("#src/controllers/users.controller.js");

const updateUserPhotoMock = vi.mocked(usersService.updateUserPhoto);
const deleteUserPhotoMock = vi.mocked(usersService.deleteUserPhoto);

/**
 * Authenticated caller with a buffered upload — the state both handlers see once
 * requireAuth + uploadAvatarPhoto have run. Cast confined to the test boundary.
 */
function createAuthedRequestStub(): Request {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    user: { id: "usr_x" },
    file: { buffer: Buffer.from([0x00]) },
  } as unknown as Request;
}

function createResponseStub(): {
  readonly response: Response;
  readonly statusSpy: ReturnType<typeof vi.fn>;
  readonly jsonSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn<(body: unknown) => void>();
  const statusSpy = vi.fn<(code: number) => { json: typeof jsonSpy }>(() => ({ json: jsonSpy }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const response = { status: statusSpy, json: jsonSpy } as unknown as Response;
  return { response, statusSpy, jsonSpy };
}

/**
 * Each row is the exact (statusCode, message) the pre-refactor switch produced.
 * If the extracted mapper drifts, one of these fails.
 */
const UPDATE_CASES: ReadonlyArray<{
  readonly error: UpdateUserPhotoError;
  readonly statusCode: number;
  readonly message: string;
}> = [
  { error: { type: "NOT_AN_IMAGE" }, statusCode: 422, message: "The uploaded file is not a valid image." },
  {
    error: { type: "UNSUPPORTED_FORMAT", detected: { kind: "other", format: "gif" } },
    statusCode: 422,
    message: "GIF images aren't supported. Use a JPEG, PNG, WebP or AVIF image.",
  },
  {
    // The one refusal a user can act on, so the message says how rather than naming a codec.
    error: { type: "UNSUPPORTED_FORMAT", detected: { kind: "heic" } },
    statusCode: 422,
    message:
      "iPhone HEIC photos aren't supported. On iPhone: Settings → Camera → Formats → " +
      "Most Compatible, or export the photo as JPEG. Use a JPEG, PNG, WebP or AVIF image.",
  },
  {
    error: { type: "DIMENSIONS_TOO_SMALL", width: 10, height: 10 },
    statusCode: 422,
    message: "Photo must be at least 64x64 pixels.",
  },
  {
    error: { type: "DIMENSIONS_TOO_LARGE", width: 99999, height: 99999 },
    statusCode: 422,
    message: "Photo dimensions are too large.",
  },
  { error: { type: "NOT_CONFIGURED" }, statusCode: 503, message: "Photo uploads are not available right now." },
  {
    error: { type: "UPLOAD_FAILED", cause: "boom" },
    statusCode: 502,
    message: "Could not store the photo. Please try again.",
  },
  {
    error: { type: "DELETE_FAILED", cause: "boom" },
    statusCode: 502,
    message: "Could not store the photo. Please try again.",
  },
  { error: { type: "USER_NOT_FOUND", userId: "usr_x" }, statusCode: 404, message: "Your account no longer exists." },
];

const DELETE_CASES: ReadonlyArray<{
  readonly error: DeleteUserPhotoError;
  readonly statusCode: number;
  readonly message: string;
}> = [
  { error: { type: "NOT_CONFIGURED" }, statusCode: 503, message: "Photo uploads are not available right now." },
  {
    error: { type: "UPLOAD_FAILED", cause: "boom" },
    statusCode: 502,
    message: "Could not remove the photo. Please try again.",
  },
  {
    error: { type: "DELETE_FAILED", cause: "boom" },
    statusCode: 502,
    message: "Could not remove the photo. Please try again.",
  },
  { error: { type: "USER_NOT_FOUND", userId: "usr_x" }, statusCode: 404, message: "Your account no longer exists." },
];

describe("updateMyPhoto error mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(UPDATE_CASES)(
    "$error.type → $statusCode with the exact error envelope",
    async ({ error, statusCode, message }) => {
      updateUserPhotoMock.mockResolvedValue({ success: false, error });
      const { response, statusSpy, jsonSpy } = createResponseStub();

      await updateMyPhoto(createAuthedRequestStub(), response);

      expect(statusSpy).toHaveBeenCalledExactlyOnceWith(statusCode);
      expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({ status: "error", statusCode, message });
    },
  );
});

describe("deleteMyPhoto error mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(DELETE_CASES)(
    "$error.type → $statusCode with the exact error envelope",
    async ({ error, statusCode, message }) => {
      deleteUserPhotoMock.mockResolvedValue({ success: false, error });
      const { response, statusSpy, jsonSpy } = createResponseStub();

      await deleteMyPhoto(createAuthedRequestStub(), response);

      expect(statusSpy).toHaveBeenCalledExactlyOnceWith(statusCode);
      expect(jsonSpy).toHaveBeenCalledExactlyOnceWith({ status: "error", statusCode, message });
    },
  );
});
