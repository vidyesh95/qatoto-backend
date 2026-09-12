import { describe, expect, it } from "vitest";

import { extractWriteUpImageAddresses } from "#src/modules/home/blueprints/showcase-launch-markdown.js";

/**
 * UNIT tests for the write-up image extractor — the gate that decides whether an image a maker
 * embedded is one of their own uploads.
 *
 * NOTHING IS MOCKED, AND mdast/micromark ARE DELIBERATELY REAL. The rule this function feeds is
 * only a rule if the server and the frontend's `react-markdown` + `remark-gfm` agree on what an
 * image IS; stubbing the parser would test a different agreement than the one that ships. Every
 * case below is one half of that agreement:
 *
 *   * the "a regex MISSES this" cases (reference images, angle brackets, escapes) are the ways
 *     past the check that would make every reader's browser call a host nobody approved;
 *   * the "a regex FINDS this" cases (code spans, fenced blocks) are the write-ups a regex would
 *     wrongly refuse — a maker documenting Markdown syntax.
 */

describe("extractWriteUpImageAddresses", () => {
  it("returns nothing for a write-up with no images", () => {
    expect(extractWriteUpImageAddresses("Just a paragraph about a solar dryer.")).toEqual([]);
  });

  it("returns nothing for an empty write-up", () => {
    expect(extractWriteUpImageAddresses("")).toEqual([]);
  });

  it("finds a plain inline image address", () => {
    expect(extractWriteUpImageAddresses("![The dryer](https://cdn.test/dryer.avif)")).toEqual([
      "https://cdn.test/dryer.avif",
    ]);
  });

  it("keeps inline images in source order", () => {
    const writeUp = [
      "![One](https://cdn.test/one.avif)",
      "",
      "Some prose in between.",
      "",
      "![Two](https://cdn.test/two.avif)",
      "",
      "![Three](https://cdn.test/three.avif)",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual([
      "https://cdn.test/one.avif",
      "https://cdn.test/two.avif",
      "https://cdn.test/three.avif",
    ]);
  });

  it("de-duplicates a repeated address", () => {
    const writeUp = "![First](https://cdn.test/one.avif)\n\n![Again](https://cdn.test/one.avif)";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/one.avif"]);
  });

  /**
   * The first way past a regex. `![alt][label]` carries no address at all — it is somewhere else
   * in the document, possibly far below the image.
   */
  it("resolves a reference-style image through its definition", () => {
    const writeUp = "![The dryer][dryer]\n\n[dryer]: https://elsewhere.test/dryer.png";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://elsewhere.test/dryer.png"]);
  });

  it("matches a reference label case-insensitively, as CommonMark does", () => {
    const writeUp = "![The dryer][Dryer]\n\n[dryer]: https://elsewhere.test/dryer.png";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://elsewhere.test/dryer.png"]);
  });

  /** CommonMark: the FIRST definition of a label wins and later duplicates are ignored. */
  it("takes the first definition when a label is defined twice", () => {
    const writeUp = [
      "![The dryer][dryer]",
      "",
      "[dryer]: https://cdn.test/mine.avif",
      "[dryer]: https://elsewhere.test/theirs.png",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/mine.avif"]);
  });

  /** No definition means the renderer shows literal text, so there is no address to vet. */
  it("returns nothing for a reference with no matching definition", () => {
    expect(extractWriteUpImageAddresses("![The dryer][missing]")).toEqual([]);
  });

  /**
   * REFERENCE ADDRESSES ARRIVE AFTER THE INLINE ONES, not in source order.
   *
   * The walk collects `image` nodes as it goes and resolves `imageReference` identifiers in a
   * second pass after the loop, so the returned order is "every inline address, then every
   * referenced address". This CONTRADICTS the function's own docblock, which promises source
   * order. Pinned rather than fixed because the only caller compares a count and a set, where
   * order cannot matter — but a future caller rendering a gallery from this list would be wrong,
   * and this case is what will tell them.
   */
  it("returns reference-resolved addresses after the inline ones, not in source order", () => {
    const writeUp = [
      "![Reference first][ref]",
      "",
      "![Inline second](https://cdn.test/inline.avif)",
      "",
      "[ref]: https://cdn.test/referenced.avif",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual([
      "https://cdn.test/inline.avif",
      "https://cdn.test/referenced.avif",
    ]);
  });

  /** The second way past a regex: an address the parser unwraps and a pattern would not. */
  it("reads an angle-bracketed address", () => {
    const writeUp = "![The dryer](<https://cdn.test/dryer build.avif>)";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/dryer build.avif"]);
  });

  /** The third way: an entity or numeric escape the parser decodes before the address is real. */
  it("decodes an entity escape inside an address", () => {
    const writeUp = "![The dryer](https://cdn.test/dryer&#x2E;avif)";

    expect(extractWriteUpImageAddresses(writeUp)).toEqual(["https://cdn.test/dryer.avif"]);
  });

  /** The first way a regex over-refuses: syntax a maker is documenting, not rendering. */
  it("ignores an image inside a code span", () => {
    expect(extractWriteUpImageAddresses("Write `![alt](https://elsewhere.test/x.png)` for an image.")).toEqual([]);
  });

  it("ignores an image inside a fenced block", () => {
    const writeUp = ["```markdown", "![alt](https://elsewhere.test/x.png)", "```"].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual([]);
  });

  /** The renderer runs with `skipHtml`, so refusing this would refuse something nobody sees. */
  it("ignores a raw HTML img tag, which the renderer never shows", () => {
    expect(extractWriteUpImageAddresses('<img src="https://elsewhere.test/x.png" alt="x">')).toEqual([]);
  });

  /** Proves the walk is total and the gfm extension is actually wired in. */
  it("finds an image nested in a list inside a blockquote inside a GFM table cell", () => {
    const writeUp = [
      "| Step | Evidence |",
      "| --- | --- |",
      "| Dry run | ![Run](https://cdn.test/run.avif) |",
      "",
      "> - A note",
      ">   - ![Nested](https://cdn.test/nested.avif)",
    ].join("\n");

    expect(extractWriteUpImageAddresses(writeUp)).toEqual([
      "https://cdn.test/run.avif",
      "https://cdn.test/nested.avif",
    ]);
  });

  /**
   * THE REASON THE WALK IS ITERATIVE RATHER THAN RECURSIVE, asserted rather than only claimed.
   * Three thousand `>` characters is a blockquote three thousand deep, inside the 10,000-character
   * write-up cap, and it would overflow a recursive walk's call stack.
   *
   * ⚠️ THE DOCBLOCK'S "ten thousand" FIGURE DOES NOT HOLD, AND THE WALK IS NOT WHY.
   * `fromMarkdown` with NO extensions parses 10,000-deep input fine, and this function's own loop
   * is iterative as advertised — but `gfmFromMarkdown()`'s transform walks the tree RECURSIVELY
   * (`mdast-util-gfm-autolink-literal` -> `mdast-util-find-and-replace` -> `unist-util-visit-parents`)
   * and throws `RangeError: Maximum call stack size exceeded` first. Measured on this machine: the
   * smallest overflowing input is 5,630 nested blockquotes, a write-up of 5,658 characters, which
   * is UNDER the 10,000-character cap and therefore reaches the service through the route. The
   * throw is not caught anywhere, so `POST /blueprints/showcases` answers 500 rather than refusing
   * the write-up.
   *
   * The depth here is 3,000 — comfortably below that threshold on any stack size — so this case
   * proves the claim it can prove and stays deterministic. Raising it to the documented ten
   * thousand would make the suite assert the bug instead of the contract.
   */
  it("walks three thousand nested blockquotes without overflowing the stack", () => {
    const deeplyNestedWriteUp = `${">".repeat(3_000)} ![Deep](https://cdn.test/deep.avif)`;

    expect(extractWriteUpImageAddresses(deeplyNestedWriteUp)).toEqual(["https://cdn.test/deep.avif"]);
  });
});
