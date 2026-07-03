import { describe, expect, it, vi } from "vitest";

// handle.service.ts imports #src/db/index.js at module scope, which pulls in the
// config env parser and a pg Pool. normalizeHandle is pure, so stub the db module
// out entirely rather than requiring a test environment.
vi.mock("#src/db/index.js", () => ({ db: {} }));

const { normalizeHandle } = await import("#src/services/handle.service.js");

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
