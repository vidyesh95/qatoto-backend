import { describe, expect, it, vi } from "vitest";

// The controllers import their services, which pull in the db pool at module scope. Stub
// the modules so the schemas can be parsed without a configured environment — nothing
// here calls a handler.
vi.mock("#src/services/workshop-board.service.js", () => ({}));
vi.mock("#src/services/workshop-chat.service.js", () => ({}));
vi.mock("#src/services/workshop-files.service.js", () => ({}));
vi.mock("#src/services/daily-logs.service.js", () => ({}));
vi.mock("#src/services/project-membership.service.js", () => ({}));

const {
  AddFileLinkSchema,
  CreateColumnSchema,
  CreateTaskSchema,
  ListChatQuerySchema,
  MarkChatReadSchema,
  MoveTaskSchema,
  PostChatMessageSchema,
  ReorderColumnsSchema,
  UpdateTaskSchema,
} = await import("#src/controllers/workshop.controller.js");

const { CreateDailyLogSchema, SubmitDailyLogSchema, UpdateDailyLogSchema } =
  await import("#src/controllers/daily-logs.controller.js");

/**
 * THE ZERO-TRUST SWEEP FOR §8 (R_AND_D_BACKEND_STRUCTURE.md §13, step 7 of §17).
 *
 * Every field probed below is server-owned or §9-owned. `.strict()` is what turns each one
 * into a 422 instead of a silent overwrite, and this suite is what stops a later refactor
 * from quietly widening a schema — the failure mode nobody notices in review because the
 * diff looks like it adds a feature.
 *
 * A rejected key surfaces under `errors.form`, not `errors.<field>`: Zod reports
 * `unrecognized_keys` as an object-level issue, which is why project-error-response.ts
 * merges `formErrors` into the response.
 */

interface ParsableSchema {
  readonly safeParse: (input: unknown) => { readonly success: boolean };
}

/**
 * Parses a body and reports only whether it was ACCEPTED.
 *
 * Returns a boolean rather than asserting, so the `expect` stays at the call site: a
 * failure then names the exact forged field instead of pointing at a shared helper.
 */
function accepts(schema: ParsableSchema, body: Record<string, unknown>): boolean {
  return schema.safeParse(body).success;
}

/** Probes a set of forged fields at once, so a failure says WHICH one slipped through. */
function acceptedFields(
  schema: ParsableSchema,
  baseBody: Record<string, unknown>,
  forgedFields: readonly Record<string, unknown>[],
): readonly string[] {
  return forgedFields
    .filter((forgedField) => accepts(schema, { ...baseBody, ...forgedField }))
    .map((forgedField) => Object.keys(forgedField).join("+"));
}

describe("board schemas refuse every server-owned field", () => {
  it("refuses a client-supplied rank everywhere it could appear", () => {
    // The §0 line for this domain: a client-supplied rank is a client-supplied sort
    // order, and one client sending the same string for every card corrupts the board.
    expect(accepts(CreateTaskSchema, { columnId: "c1", title: "Task", rank: "a" })).toBe(false);
    expect(accepts(UpdateTaskSchema, { title: "Task", rank: "zz" })).toBe(false);
    expect(accepts(MoveTaskSchema, { columnId: "c1", rank: "m" })).toBe(false);
  });

  it("refuses a client-supplied column position", () => {
    expect(accepts(CreateColumnSchema, { title: "To do", position: 0 })).toBe(false);
  });

  it("refuses id, attribution and timestamp fields", () => {
    expect(
      acceptedFields(CreateTaskSchema, { columnId: "c1", title: "T" }, [
        { id: "forged" },
        { createdAt: "2026-07-24" },
        { updatedAt: "2026-07-24" },
        { projectId: "another-project" },
        { createdByUserId: "someone-else" },
      ]),
    ).toStrictEqual([]);
  });

  it("accepts the fields a member legitimately sends", () => {
    expect(
      accepts(CreateTaskSchema, {
        columnId: "c1",
        title: "Calibrate the rig",
        description: "Multispectral camera",
        assigneeMemberId: "m1",
        priority: "high",
        labels: ["Prototype"],
        dueDate: "2026-07-30",
      }),
    ).toBe(true);
  });

  it("requires a date-only dueDate, never an instant", () => {
    // §1: a calendar day is `YYYY-MM-DD`. An instant here carries a zone nobody agreed on.
    expect(accepts(CreateTaskSchema, { columnId: "c1", title: "T", dueDate: "2026-07-30" })).toBe(true);
    expect(accepts(CreateTaskSchema, { columnId: "c1", title: "T", dueDate: "2026-07-30T00:00:00Z" })).toBe(false);
  });

  it("lets a PATCH clear a nullable field without touching the others", () => {
    const parsed = UpdateTaskSchema.parse({ dueDate: null });

    // Exactly one key: the products data-loss regression, applied to this domain. A
    // title-only PATCH must not assert a priority, and a dueDate-only PATCH must not
    // erase labels.
    expect(Object.keys(parsed)).toStrictEqual(["dueDate"]);
    expect(parsed.dueDate).toBeNull();
    expect(parsed.priority).toBeUndefined();
    expect(parsed.labels).toBeUndefined();
  });

  it("bounds a reorder to a real board's worth of columns", () => {
    expect(accepts(ReorderColumnsSchema, { columnIds: [] })).toBe(false);
    expect(
      accepts(ReorderColumnsSchema, {
        columnIds: Array.from({ length: 13 }, (_unused, index) => `c${index}`),
      }),
    ).toBe(false);
    expect(accepts(ReorderColumnsSchema, { columnIds: ["c1", "c2", "c3"] })).toBe(true);
  });
});

describe("file-link schema refuses every measured and deferred-path field", () => {
  const validLink = {
    fileName: "spec.pdf",
    fileKind: "document",
    externalUrl: "https://drive.google.com/file/d/abc/view",
  };

  it("refuses sizeBytes, which is NULL by construction on this path", () => {
    // The rule survives as a null rather than as a number nobody verified (§8).
    expect(accepts(AddFileLinkSchema, { ...validLink, sizeBytes: 1024 })).toBe(false);
  });

  it("refuses the server-derived columns and the Appendix A seam", () => {
    expect(
      acceptedFields(AddFileLinkSchema, validLink, [
        { externalHost: "drive.google.com" },
        { contentSha256: "0".repeat(64) },
        { storageProvider: "s3_compatible" },
        { objectKey: "projects/1/spec.pdf" },
        { uploadedByMemberId: "someone-else" },
        { source: "hosted" },
        { removedAt: null },
      ]),
    ).toStrictEqual([]);
  });

  it("refuses a file kind outside the enum", () => {
    // The frontend's kebab-case union becomes snake_case in the DB (§4d, §15).
    expect(accepts(AddFileLinkSchema, { ...validLink, fileKind: "cad-model" })).toBe(false);
    expect(accepts(AddFileLinkSchema, { ...validLink, fileKind: "cad_model" })).toBe(true);
  });
});

describe("chat schemas refuse authorship and timing", () => {
  it("refuses authorship and client-set timestamps", () => {
    // Nobody posts as somebody else: the author is the caller's own membership row.
    expect(
      acceptedFields(PostChatMessageSchema, { messageText: "hi" }, [
        { authorMemberId: "someone-else" },
        { sentAt: "2026-07-24T00:00:00Z" },
        { editedAt: "2026-07-24T00:00:00Z" },
        { deletedAt: null },
      ]),
    ).toStrictEqual([]);
  });

  it("bounds the page size a client can ask for", () => {
    expect(accepts(ListChatQuerySchema, { limit: "50" })).toBe(true);
    expect(accepts(ListChatQuerySchema, { limit: "500" })).toBe(false);
  });

  it("takes a message id to mark read, and nothing else", () => {
    expect(accepts(MarkChatReadSchema, { throughMessageId: "m1" })).toBe(true);
    expect(accepts(MarkChatReadSchema, { throughMessageId: "m1", readAt: "2026-07-24T00:00:00Z" })).toBe(false);
  });
});

describe("daily-log schemas refuse every pipeline and verdict field", () => {
  const validBody = { logDate: "2026-07-24", narrative: "Bench-tested the pump." };

  it("refuses the §9 verdict in both its forms", () => {
    // The single most important rejection in this file: a client that could set either of
    // these could award itself equity once §9 reads them.
    expect(
      acceptedFields(CreateDailyLogSchema, validBody, [
        { effortVerificationStatus: "verified" },
        { isEffortVerified: true },
      ]),
    ).toStrictEqual([]);
    expect(accepts(UpdateDailyLogSchema, { effortVerificationStatus: "verified" })).toBe(false);
  });

  it("refuses every analysis-pipeline output", () => {
    expect(
      acceptedFields(CreateDailyLogSchema, validBody, [
        { analysisStatus: "succeeded" },
        { analysisModelName: "gemini-2.5-flash" },
        { analysisPromptVersion: "daily-log-analysis-v1" },
        { aiSummaryChips: [{ kind: "progress", label: "Done" }] },
        { transcriptSegments: [{ startOffsetSeconds: 0, segmentText: "hi" }] },
        { extractedClaims: [{ claimKind: "time_spent", extractedMinutes: 480 }] },
        { extractedMinutes: 480 },
      ]),
    ).toStrictEqual([]);
  });

  it("refuses every server-derived video fact — the client sends a URL, not the facts", () => {
    expect(
      acceptedFields(CreateDailyLogSchema, validBody, [
        { videoSource: "youtube" },
        { youtubeVideoId: "dQw4w9WgXcQ" },
        { youtubeThumbnailUrl: "https://i.ytimg.com/vi/x/0.jpg" },
        { videoVerifiedAt: "2026-07-24T00:00:00Z" },
      ]),
    ).toStrictEqual([]);
  });

  it("refuses status, authorship and the streak counter", () => {
    expect(
      acceptedFields(CreateDailyLogSchema, validBody, [
        { status: "submitted" },
        { submittedAt: "2026-07-24T00:00:00Z" },
        { authorMemberId: "someone-else" },
        { authorUserId: "someone-else" },
        { dailyLogStreakDays: 99 },
      ]),
    ).toStrictEqual([]);
  });

  it("accepts a text-only log and a video log alike", () => {
    expect(accepts(CreateDailyLogSchema, validBody)).toBe(true);
    expect(
      accepts(CreateDailyLogSchema, {
        ...validBody,
        youtubeUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    ).toBe(true);
  });

  it("accepts a bare video id and a schemeless link, which z.url() would have rejected", () => {
    // src/lib/youtube.ts accepts both, and so does the frontend's mirrored parser. A
    // z.url() here would 422 a link the browser just showed a green checkmark for.
    expect(accepts(CreateDailyLogSchema, { ...validBody, youtubeUrl: "dQw4w9WgXcQ" })).toBe(true);
    expect(accepts(CreateDailyLogSchema, { ...validBody, youtubeUrl: "youtu.be/dQw4w9WgXcQ" })).toBe(true);
  });

  it("distinguishes an absent youtubeUrl from an explicit null on a PATCH", () => {
    // Absent leaves the video alone; null detaches it. Collapsing the two makes a
    // narrative-only edit silently drop a member's video.
    const narrativeOnly = UpdateDailyLogSchema.parse({ narrative: "Updated." });
    expect(Object.keys(narrativeOnly)).toStrictEqual(["narrative"]);
    expect(narrativeOnly.youtubeUrl).toBeUndefined();

    expect(UpdateDailyLogSchema.parse({ youtubeUrl: null }).youtubeUrl).toBeNull();
  });

  it("requires a date-only logDate", () => {
    expect(accepts(CreateDailyLogSchema, { logDate: "2026-07-24" })).toBe(true);
    expect(accepts(CreateDailyLogSchema, { logDate: "2026-07-24T09:00:00Z" })).toBe(false);
    expect(accepts(CreateDailyLogSchema, { logDate: "24-07-2026" })).toBe(false);
  });

  it("requires an idempotency key long enough to actually be unique", () => {
    // A retried submit on a flaky connection must return the first receipt, and a
    // two-character "key" collides across members (§14).
    expect(accepts(SubmitDailyLogSchema, { idempotencyKey: "a".repeat(16) })).toBe(true);
    expect(accepts(SubmitDailyLogSchema, { idempotencyKey: "ab" })).toBe(false);
    expect(
      accepts(SubmitDailyLogSchema, {
        idempotencyKey: "a".repeat(16),
        analysisStatus: "succeeded",
      }),
    ).toBe(false);
  });
});
