import { describe, expect, it, vi } from "vitest";

// handle.service.ts imports #src/db/index.js at module scope, which pulls in the
// config env parser and a pg Pool. normalizeHandle is pure, so stub the db module
// out entirely rather than requiring a test environment.
vi.mock("#src/db/index.js", () => ({ db: {} }));

const { normalizeHandle, validateHandle } = await import("#src/services/handle.service.js");

const HANDLE_LENGTH_ERROR = {
  success: false,
  error: { type: "INVALID", reason: "Handle must be 3–30 characters." },
} as const;

describe("normalizeHandle", () => {
  it("returns an already-canonical handle unchanged", () => {
    expect(normalizeHandle("vidyesh_churi")).toBe("vidyesh_churi");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHandle("  vidyesh  ")).toBe("vidyesh");
    expect(normalizeHandle("\tvidyesh\n")).toBe("vidyesh");
  });

  it("strips a single leading @", () => {
    expect(normalizeHandle("@vidyesh")).toBe("vidyesh");
  });

  it("strips only the first leading @, keeping any that follow", () => {
    expect(normalizeHandle("@@vidyesh")).toBe("@vidyesh");
  });

  it("does not strip an @ that is not leading", () => {
    expect(normalizeHandle("vid@yesh")).toBe("vid@yesh");
  });

  it("strips the leading @ after trimming whitespace", () => {
    expect(normalizeHandle("  @vidyesh  ")).toBe("vidyesh");
  });

  it("lowercases the handle", () => {
    expect(normalizeHandle("VidYesh")).toBe("vidyesh");
    expect(normalizeHandle("@VIDYESH")).toBe("vidyesh");
  });

  it("applies trim, @-strip and lowercase together", () => {
    expect(normalizeHandle("  @Vidyesh_Churi  ")).toBe("vidyesh_churi");
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(normalizeHandle("")).toBe("");
    expect(normalizeHandle("   ")).toBe("");
  });

  it("returns an empty string for a lone @", () => {
    expect(normalizeHandle("@")).toBe("");
  });

  it("preserves internal whitespace (validation is the regex's job)", () => {
    expect(normalizeHandle("vid yesh")).toBe("vid yesh");
  });
});

describe("validateHandle — length edge cases", () => {
  it("rejects an empty handle", () => {
    expect(validateHandle("")).toEqual(HANDLE_LENGTH_ERROR);
  });

  it("rejects a 1-character handle", () => {
    expect(validateHandle("v")).toEqual(HANDLE_LENGTH_ERROR);
  });

  it("rejects a 2-character handle", () => {
    expect(validateHandle("vi")).toEqual(HANDLE_LENGTH_ERROR);
  });

  it("accepts a 3-character handle (lower boundary)", () => {
    expect(validateHandle("vid")).toEqual({ success: true, value: "vid" });
  });

  it("accepts a 30-character handle (upper boundary)", () => {
    const thirtyCharHandle = "a".repeat(30);
    expect(validateHandle(thirtyCharHandle)).toEqual({ success: true, value: thirtyCharHandle });
  });

  it("rejects a 31-character handle", () => {
    expect(validateHandle("a".repeat(31))).toEqual(HANDLE_LENGTH_ERROR);
  });

  it("rejects a far-too-long handle", () => {
    expect(validateHandle("a".repeat(100))).toEqual(HANDLE_LENGTH_ERROR);
  });

  it("measures length after normalization: padding does not rescue a short handle", () => {
    // "  ab  " trims to "ab" (2 chars) — whitespace must not count toward length.
    expect(validateHandle("  ab  ")).toEqual(HANDLE_LENGTH_ERROR);
  });

  it("measures length after normalization: a leading @ does not count", () => {
    // "@ab" normalizes to "ab" (2 chars).
    expect(validateHandle("@ab")).toEqual(HANDLE_LENGTH_ERROR);
    // "@abc" normalizes to "abc" (3 chars) and passes.
    expect(validateHandle("@abc")).toEqual({ success: true, value: "abc" });
  });

  it("rejects a whitespace-only handle (normalizes to empty)", () => {
    expect(validateHandle("   ")).toEqual(HANDLE_LENGTH_ERROR);
  });

  it("accepts a 31-character raw handle that trims to 30 — trimmed length wins", () => {
    const thirtyCharHandle = "b".repeat(30);
    expect(validateHandle(` ${thirtyCharHandle}`)).toEqual({
      success: true,
      value: thirtyCharHandle,
    });
  });
});
