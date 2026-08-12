import { describe, expect, it } from "vitest";

import {
  mapWorkshopErrorToResponse,
  type WorkshopDomainError,
} from "#src/modules/rnd/workshop/workshop-error-response.js";

/**
 * The §8 status policy, asserted rather than described (§4a/§13).
 *
 * The mapper is a pure function of its input — it never touches `res` — which is what
 * makes this testable without a request, and is why studio-error-response.ts is shaped the
 * same way.
 */

/** Every variant the four §8 service unions can produce, in one place. */
const EVERY_ERROR: readonly WorkshopDomainError[] = [
  { type: "NOT_FOUND", projectRef: "solar-cold-storage" },
  { type: "COLUMN_NOT_FOUND", columnId: "c1" },
  { type: "TASK_NOT_FOUND", taskId: "t1" },
  { type: "FILE_NOT_FOUND", fileId: "f1" },
  { type: "MESSAGE_NOT_FOUND", messageId: "m1" },
  { type: "DAILY_LOG_NOT_FOUND", logId: "l1" },
  { type: "NOT_THE_AUTHOR" },
  { type: "COLUMN_NOT_EMPTY", taskCount: 3 },
  { type: "COLUMN_LIMIT_REACHED", limit: 12 },
  { type: "FILE_LINK_ALREADY_ADDED" },
  { type: "DAILY_LOG_ALREADY_EXISTS", logDate: "2026-07-24" },
  { type: "DAILY_LOG_ALREADY_SUBMITTED" },
  { type: "EDIT_WINDOW_CLOSED", windowMinutes: 15 },
  { type: "RANK_CONTENDED" },
  { type: "COLUMN_SET_MISMATCH" },
  { type: "ASSIGNEE_NOT_A_MEMBER", memberId: "m1" },
  { type: "MOVE_ANCHOR_INVALID" },
  { type: "CURSOR_MALFORMED" },
  { type: "DAILY_LOG_EMPTY" },
  { type: "LOG_DATE_IN_FUTURE", logDate: "2030-01-01" },
  { type: "LINK_UNPARSEABLE" },
  { type: "LINK_NOT_HTTPS", scheme: "http" },
  { type: "LINK_HOST_NOT_ALLOWED", host: "evil.tld" },
  { type: "LINK_TOO_LONG", length: 3000 },
  { type: "INVALID_YOUTUBE_URL" },
  { type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId: "dQw4w9WgXcQ" },
  { type: "YOUTUBE_VERIFY_FAILED" },
];

describe("mapWorkshopErrorToResponse", () => {
  it("handles every variant with a real status and message", () => {
    // If a service union gains a variant and the mapper does not, the `never` default
    // throws here — the compile error is the primary guard, and this is the runtime one.
    for (const error of EVERY_ERROR) {
      const mapped = mapWorkshopErrorToResponse(error);
      expect({
        type: error.type,
        hasStatus: mapped.statusCode >= 400 && mapped.statusCode < 600,
        hasMessage: mapped.message.length > 0,
      }).toStrictEqual({ type: error.type, hasStatus: true, hasMessage: true });
    }
  });

  it("renders EVERY authorization and lookup failure as 404, never 403", () => {
    // A stranger must not be able to distinguish "no such project", "not a member" and
    // "that column belongs to someone else" — a 403 anywhere here is that probe (§4a).
    const lookupFailures: readonly WorkshopDomainError[] = [
      { type: "NOT_FOUND", projectRef: "solar-cold-storage" },
      { type: "COLUMN_NOT_FOUND", columnId: "c1" },
      { type: "TASK_NOT_FOUND", taskId: "t1" },
      { type: "FILE_NOT_FOUND", fileId: "f1" },
      { type: "MESSAGE_NOT_FOUND", messageId: "m1" },
      { type: "DAILY_LOG_NOT_FOUND", logId: "l1" },
    ];

    for (const error of lookupFailures) {
      expect(mapWorkshopErrorToResponse(error).statusCode).toBe(404);
    }
  });

  it("uses 403 only where membership is already proven", () => {
    // NOT_THE_AUTHOR is reachable only after requireProjectRole succeeded, so naming the
    // rule reveals nothing the caller did not already know.
    expect(mapWorkshopErrorToResponse({ type: "NOT_THE_AUTHOR" }).statusCode).toBe(403);
    expect(EVERY_ERROR.filter((error) => mapWorkshopErrorToResponse(error).statusCode === 403)).toStrictEqual([
      { type: "NOT_THE_AUTHOR" },
    ]);
  });

  it("keeps the YouTube 422/502 split intact", () => {
    // The split is load-bearing: 422 means the member must fix their link, 502 means
    // YouTube did not answer. Collapsing them tells a member to fix a link that was fine.
    expect(mapWorkshopErrorToResponse({ type: "INVALID_YOUTUBE_URL" }).statusCode).toBe(422);
    expect(mapWorkshopErrorToResponse({ type: "YOUTUBE_VIDEO_UNAVAILABLE", youtubeVideoId: "x" }).statusCode).toBe(422);
    expect(mapWorkshopErrorToResponse({ type: "YOUTUBE_VERIFY_FAILED" }).statusCode).toBe(502);
  });

  it("renders a submitted log as a 409 that says why", () => {
    const mapped = mapWorkshopErrorToResponse({ type: "DAILY_LOG_ALREADY_SUBMITTED" });
    expect(mapped.statusCode).toBe(409);
    expect(mapped.message).toMatch(/no longer be changed/);
  });

  it("names the offending host when a link is refused", () => {
    // The member has to know WHICH service was rejected, or the allowlist is a wall with
    // no sign on it.
    const mapped = mapWorkshopErrorToResponse({
      type: "LINK_HOST_NOT_ALLOWED",
      host: "files.example.com",
    });
    expect(mapped.statusCode).toBe(422);
    expect(mapped.errors?.externalUrl?.[0]).toContain("files.example.com");
  });

  it("puts a field path on every 422 that names one", () => {
    const fieldScoped: readonly WorkshopDomainError[] = [
      { type: "COLUMN_SET_MISMATCH" },
      { type: "ASSIGNEE_NOT_A_MEMBER", memberId: "m1" },
      { type: "CURSOR_MALFORMED" },
      { type: "DAILY_LOG_EMPTY" },
      { type: "LOG_DATE_IN_FUTURE", logDate: "2030-01-01" },
      { type: "LINK_NOT_HTTPS", scheme: "http" },
    ];

    for (const error of fieldScoped) {
      const mapped = mapWorkshopErrorToResponse(error);
      expect({ type: error.type, status: mapped.statusCode, hasErrors: mapped.errors !== undefined }).toStrictEqual({
        type: error.type,
        status: 422,
        hasErrors: true,
      });
    }
  });
});
