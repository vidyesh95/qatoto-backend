import { describe, expect, it } from "vitest";

import {
  deepestWriteUpNestingDepth,
  MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH,
} from "#src/modules/home/blueprints/showcase-write-up-nesting.js";

/**
 * UNIT tests for the write-up nesting scanner — the rule that keeps a submit from stalling this
 * server for ten seconds, and from storing a launch the reader's browser cannot render.
 *
 * NOTHING IS MOCKED; the subject is a pure string scanner.
 *
 * THE CASES ARE ORGANISED AROUND THE BYPASSES, because the first draft of this scanner scored ZERO
 * on four separate inputs that crash the renderer — a footnote definition, an escaped label, a tab
 * after a list marker, and a bare carriage return. Each of those is a named case below. A scanner
 * that under-counts does not fail loudly; it ships a hole, so these matter more than the happy path.
 */

/** A run of `marker` repeated `levels` times, as a maker's editor would emit it. */
function buildNestedRun(marker: string, levels: number): string {
  return `${marker.repeat(levels)}x`;
}

describe("deepestWriteUpNestingDepth", () => {
  describe("the container openers markdown defines", () => {
    /**
     * The full opener alphabet, which is closed: micromark's `document` construct table plus the one
     * key GFM adds. `showcase-write-up-nesting.ts` explains why that makes the scanner complete.
     */
    it.each([
      ["blockquote", ">"],
      ["dash list", "- "],
      ["star list", "* "],
      ["plus list", "+ "],
      ["ordered list with a dot", "1. "],
      ["ordered list with a paren", "1) "],
    ])("counts a %s at every level", (_label, marker) => {
      expect(deepestWriteUpNestingDepth(buildNestedRun(marker, 1))).toBe(1);
      expect(deepestWriteUpNestingDepth(buildNestedRun(marker, 7))).toBe(7);
      expect(deepestWriteUpNestingDepth(buildNestedRun(marker, MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH))).toBe(
        MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH,
      );
      expect(
        deepestWriteUpNestingDepth(buildNestedRun(marker, MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH + 1)),
      ).toBeGreaterThan(MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH);
    });

    it("counts a multi-digit ordered marker as one level", () => {
      expect(deepestWriteUpNestingDepth("1234. x")).toBe(1);
    });

    it("reports the deepest line, not the last one", () => {
      expect(deepestWriteUpNestingDepth("> one\n> > > three\n> one")).toBe(3);
    });

    it("counts markers mixed on one line", () => {
      expect(deepestWriteUpNestingDepth("> - > - x")).toBe(4);
    });
  });

  describe("the bypasses the first draft missed", () => {
    /**
     * A FOOTNOTE DEFINITION IS A CONTAINER, and the one GFM adds to micromark's table. Everything
     * after `[^1]: ` on the line is block content, so the quotes that follow nest inside it. The
     * first draft treated `[` as "some other character" and stopped, scoring 0 on an input that
     * RangeErrors the renderer.
     */
    it("counts a footnote definition and keeps counting what follows it", () => {
      expect(deepestWriteUpNestingDepth("[^1]: x")).toBe(1);
      expect(deepestWriteUpNestingDepth(`[^1]: ${">".repeat(40)}x`)).toBe(41);
    });

    /** They chain on one line, so the scan has to resume past each label rather than stop. */
    it("counts chained footnote definitions on one line", () => {
      const chained = Array.from({ length: 50 }, (_unused, index) => `[^${String(index + 1)}]: `).join("");

      expect(deepestWriteUpNestingDepth(`${chained}x`)).toBe(50);
    });

    /** A backslash escape inside the label hides the `]` from a naive scan and under-counts. */
    it("steps over an escaped bracket inside a footnote label", () => {
      expect(deepestWriteUpNestingDepth(`[^a\\]b]: ${">".repeat(40)}x`)).toBe(41);
    });

    /** Markdown lets a tab follow a list marker, and a tab nests exactly as a space does. */
    it.each([
      ["dash", "-\t"],
      ["ordered", "1.\t"],
    ])("counts a %s marker delimited by a tab", (_label, marker) => {
      expect(deepestWriteUpNestingDepth(buildNestedRun(marker, 40))).toBe(40);
    });

    /** A marker at end of line opens an empty list item — still a level. */
    it("counts a marker with nothing after it", () => {
      expect(deepestWriteUpNestingDepth("-")).toBe(1);
    });

    /**
     * micromark treats a bare `\r` as a line ending; `String.split("\n")` does not. A write-up
     * arrives as JSON and carries whatever the maker's editor produced, so the deep line hid behind
     * a carriage return and the first draft never saw it.
     */
    it.each([
      ["a line feed", "\n"],
      ["a carriage return and line feed", "\r\n"],
      ["a bare carriage return", "\r"],
    ])("splits lines on %s", (_label, lineEnding) => {
      expect(deepestWriteUpNestingDepth(`prose${lineEnding}${">".repeat(40)}x`)).toBe(40);
    });
  });

  describe("what it must NOT count", () => {
    it("scores ordinary prose zero", () => {
      expect(deepestWriteUpNestingDepth("We rebuilt the evaporator loop over one season.")).toBe(0);
    });

    it("scores an empty write-up zero", () => {
      expect(deepestWriteUpNestingDepth("")).toBe(0);
    });

    it.each([
      ["a thematic break", "---"],
      ["a star thematic break", "***"],
      ["an emphasis run with no marker delimiter", "**bold** and *italic*"],
      ["a ten-digit number, one past CommonMark's ordered-marker limit", "1234567890. x"],
      ["a bracket that opens no definition", "[just text] and more"],
    ])("scores %s zero", (_label, writeUp) => {
      expect(deepestWriteUpNestingDepth(writeUp)).toBe(0);
    });

    /**
     * INDENTATION-ONLY NESTING IS NOT COUNTED, AND DOES NOT NEED TO BE. Reaching depth d by
     * indentation alone costs about d² characters, because every level repeats every ancestor's
     * prefix — so the 10,000-character cap already bounds that route at roughly 95 levels, far under
     * the renderer's ceiling. This case records that the low score is a decision, not an oversight.
     */
    it("scores a deep indentation-only list ladder as one level", () => {
      const indentationLadder = Array.from({ length: 95 }, (_unused, level) => `${" ".repeat(level * 2)}- step`).join(
        "\n",
      );

      expect(indentationLadder.length).toBeLessThan(10_000);
      expect(deepestWriteUpNestingDepth(indentationLadder)).toBe(1);
    });
  });

  describe("real write-ups", () => {
    it.each([
      ["a build log section", "## Design\n\n- **Panel** 220W\n- **Controller** MPPT\n\n> The key insight.\n"],
      ["numbered steps with a sub-step", "1. first\n2. second\n   1. sub step\n"],
      ["a list holding a sub-list and a quote", "- item\n  - sub\n    - subsub\n      > note"],
      ["a link reference definition", "[ref]: https://cdn.test/x.avif\n\n![a][ref]"],
    ])("keeps %s well under the cap", (_label, writeUp) => {
      expect(deepestWriteUpNestingDepth(writeUp)).toBeLessThan(MAX_SHOWCASE_WRITE_UP_NESTING_DEPTH);
    });

    /** A pasted email chain is the deepest thing a real maker plausibly sends. */
    it("accepts a four-deep pasted quote chain", () => {
      expect(deepestWriteUpNestingDepth("> > > > the original message")).toBe(4);
    });
  });
});
