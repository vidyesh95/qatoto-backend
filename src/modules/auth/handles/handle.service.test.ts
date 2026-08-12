import { describe, expect, it, vi } from "vitest";

// handle.service.ts imports #src/db/index.js at module scope, which pulls in the
// config env parser and a pg Pool. normalizeHandle is pure, so stub the db module
// out entirely rather than requiring a test environment.
vi.mock("#src/db/index.js", () => ({ db: {} }));

const { normalizeHandle, validateHandle } = await import("#src/modules/auth/handles/handle.service.js");

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

  describe("whitespace variants", () => {
    it("trims each ASCII whitespace character individually", () => {
      expect(normalizeHandle("\tvidyesh\t")).toBe("vidyesh"); // tab
      expect(normalizeHandle("\nvidyesh\n")).toBe("vidyesh"); // line feed
      expect(normalizeHandle("\rvidyesh\r")).toBe("vidyesh"); // carriage return
      expect(normalizeHandle("\vvidyesh\v")).toBe("vidyesh"); // vertical tab
      expect(normalizeHandle("\fvidyesh\f")).toBe("vidyesh"); // form feed
    });

    it("trims CRLF sequences", () => {
      expect(normalizeHandle("\r\nvidyesh\r\n")).toBe("vidyesh");
    });

    it("trims Unicode whitespace characters", () => {
      // \u escapes keep the invisible characters visible to reviewers.
      expect(normalizeHandle("\u00A0vidyesh\u00A0")).toBe("vidyesh"); // no-break space
      expect(normalizeHandle("\u2003vidyesh\u2003")).toBe("vidyesh"); // em space
      expect(normalizeHandle("\u3000vidyesh\u3000")).toBe("vidyesh"); // ideographic space
      expect(normalizeHandle("\u2028vidyesh\u2028")).toBe("vidyesh"); // line separator
      expect(normalizeHandle("\u2029vidyesh\u2029")).toBe("vidyesh"); // paragraph separator
      expect(normalizeHandle("\uFEFFvidyesh\uFEFF")).toBe("vidyesh"); // BOM / ZWNBSP — WhiteSpace per spec
    });

    it("trims a mix of whitespace types composed with @-strip and lowercasing", () => {
      expect(normalizeHandle("\t \n @Vidyesh\r\n ")).toBe("vidyesh");
    });

    it("normalizes whitespace-only input of any type to an empty string", () => {
      expect(normalizeHandle("\t\n\r")).toBe("");
      expect(normalizeHandle("\u00A0\u3000")).toBe("");
    });

    it("does not trim a zero-width space (not WhiteSpace per spec) — the regex rejects it later", () => {
      // Documents current behavior: U+200B passes through untouched rather than
      // being silently stripped; validateHandle's charset regex is the gate.
      expect(normalizeHandle("\u200Bvidyesh")).toBe("\u200Bvidyesh");
    });

    it("preserves internal whitespace of every type (trim only touches the ends)", () => {
      expect(normalizeHandle("vid\tyesh")).toBe("vid\tyesh");
      expect(normalizeHandle("vid\nyesh")).toBe("vid\nyesh");
      expect(normalizeHandle("vid\u2003yesh")).toBe("vid\u2003yesh");
    });
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
